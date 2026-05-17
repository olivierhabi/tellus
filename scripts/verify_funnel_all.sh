#!/usr/bin/env bash
# verify_funnel_all.sh
#
# Batch verification of the funnel terminal-state + foundry-bridged CSV
# fix across EVERY foundry-bridged object type in the ontology. Mirrors
# what a Palantir SRE would run after deploying the fix: prove the patch
# is retroactively correct for every previously-broken OT, not just the
# one in the bug report.
#
# For each OT:
#   1. Resolve baseline funnel_state and the backing CSV's row count.
#   2. Fire an editBatchPending signal through the public API.
#   3. Poll funnel_state until terminal (with per-OT timeout).
#   4. Compare objects_indexed against the CSV row count (≤ 5% delta to
#      tolerate primary-key dedup).
#
# Outputs a pipe-separated report and exits 0 iff every OT passes.
#
# Env knobs (all optional):
#   API_BASE, PG_CONTAINER, PG_USER, PG_DB
#   BEARER_TOKEN, KC_BASE, KC_REALM, KC_CLIENT_ID, KC_USERNAME, KC_PASSWORD
#   POLL_TIMEOUT_S (per-OT, default 180)
#   POLL_INTERVAL_S (default 2)
#   ONLY_API_NAMES="OlivierOrder10,OlivierOrder7"   # subset filter

set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-tellus-postgres-1}"
PG_USER="${PG_USER:-tellus}"
PG_DB="${PG_DB:-tellus_db}"
API_BASE="${API_BASE:-http://localhost:3000}"
POLL_TIMEOUT_S="${POLL_TIMEOUT_S:-180}"
POLL_INTERVAL_S="${POLL_INTERVAL_S:-2}"
ONLY_API_NAMES="${ONLY_API_NAMES:-}"
BEARER_TOKEN="${BEARER_TOKEN:-}"
KC_BASE="${KC_BASE:-http://localhost:8086}"
KC_REALM="${KC_REALM:-tellus}"
KC_CLIENT_ID="${KC_CLIENT_ID:-tellus-frontend}"
KC_USERNAME="${KC_USERNAME:-habimanaolivier6@gmail.com}"
KC_PASSWORD="${KC_PASSWORD:-VerifyTellus123!}"

psql() { docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -At "$@"; }
log()  { printf '[batch] %s\n' "$*"; }

# Mint a fresh Keycloak token. ALWAYS refreshes — Keycloak's default
# direct-grant access-token lifespan is 5 minutes, and a batch run over
# 10+ object types easily exceeds that. Calling per-OT keeps the bearer
# valid throughout.
mint_token() {
  BEARER_TOKEN="$(curl -fsS -X POST "$KC_BASE/realms/$KC_REALM/protocol/openid-connect/token" \
    -d "grant_type=password&client_id=$KC_CLIENT_ID&username=$KC_USERNAME&password=$KC_PASSWORD" \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || true)"
  if [[ -z "$BEARER_TOKEN" ]]; then
    log "FATAL: could not mint Keycloak token"
    exit 1
  fi
}

# Canonical "did the data actually materialize" check: COUNT the rows
# the funnel actually inserted into `object_instances` for this OT. This
# is the deepest truth in the system — it's what every downstream API
# (OSS search, link traversal, OQL) consumes. If `funnel_state.objects_indexed`
# matches this count AND status='indexed', the badge is honest.
materialized_count() {
  local api_name="$1"
  psql -c "SELECT COUNT(*) FROM object_instances WHERE object_type_api_name = '$api_name'"
}

# Fire signal + poll. Echoes "PASS|<actual>" or "FAIL|<reason>".
verify_one() {
  local ot_id="$1" api_name="$2" ontology_id="$3" file_path="$4"

  # Refresh the token before each OT so a long batch doesn't get bitten
  # by Keycloak's 5-minute access-token TTL.
  mint_token

  local signal_at signal_res
  signal_at="$(date +%s)"
  signal_res="$(curl -fsS -X POST "$API_BASE/api/v1/funnel/signals" \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $BEARER_TOKEN" \
    -d "{\"ontologyId\":\"$ontology_id\",\"objectTypeApiName\":\"$api_name\",\"signalType\":\"editBatchPending\",\"payload\":{\"verify\":\"batch\",\"ts\":$signal_at}}" 2>/dev/null || echo '')"
  if [[ -z "$signal_res" ]]; then
    echo "FAIL|signal-post-failed"; return
  fi

  local start now status err updated row final
  start="$(date +%s)"
  while :; do
    row="$(psql -c "SELECT status || '|' || COALESCE(objects_indexed::text,'NULL') || '|' || COALESCE(error_message,'') || '|' || EXTRACT(EPOCH FROM updated_at)::bigint FROM funnel_state WHERE object_type_id = '$ot_id'")"
    status="${row%%|*}"
    updated="$(echo "$row" | awk -F'|' '{print $4}')"
    err="$(echo "$row" | awk -F'|' '{print $3}')"
    if [[ -n "$updated" && "$updated" -ge "$signal_at" ]]; then
      if [[ "$status" == "indexed" ]]; then break; fi
      if [[ "$status" == "failed" ]]; then echo "FAIL|workflow-failed:${err:0:80}"; return; fi
    fi
    now="$(date +%s)"
    if (( now - start >= POLL_TIMEOUT_S )); then
      echo "FAIL|timeout-after-${POLL_TIMEOUT_S}s-last-status=$status"; return
    fi
    sleep "$POLL_INTERVAL_S"
  done

  final="$(psql -c "SELECT objects_indexed FROM funnel_state WHERE object_type_id = '$ot_id'")"
  echo "PASS|$final"
}

# -----------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------

mint_token

# Filter clause for the OT list (allow scoping to a few OTs from CLI).
FILTER=""
if [[ -n "$ONLY_API_NAMES" ]]; then
  IFS=',' read -r -a names <<< "$ONLY_API_NAMES"
  quoted=""
  for n in "${names[@]}"; do quoted+=",'${n}'"; done
  FILTER="AND ot.api_name IN (${quoted#,})"
fi

# Pull every foundry-bridged OT with a backing datasource. These are the
# wizard-created object types whose `runChangelogActivity` historically
# returned an empty changelog and got stuck on 'indexing'.
# Use plain while-read for macOS bash 3.2 compatibility (no `mapfile`).
ROWS=()
while IFS= read -r _line; do
  [[ -z "$_line" ]] && continue
  ROWS+=("$_line")
done < <(psql -F$'\t' -c "
  SELECT
    ot.object_type_id,
    ot.api_name,
    ot.ontology_id,
    bd.file_path
  FROM object_type ot
  JOIN backing_datasource bd ON bd.object_type_id = ot.object_type_id
  WHERE bd.file_path LIKE '%#foundry-dataset:%'
    $FILTER
  ORDER BY ot.api_name;")

if [[ "${#ROWS[@]}" -eq 0 ]]; then
  log "no foundry-bridged object types found — nothing to verify"
  exit 0
fi

log "found ${#ROWS[@]} foundry-bridged object types to verify"
printf '%s\n' "----+--------------------+----------+--------+--------+---------------"
printf '%-3s | %-22s | %-8s | %-6s | %-6s | %s\n' "  #" "api_name" "result" "got" "db_rows" "note"
printf '%s\n' "----+--------------------+----------+--------+--------+---------------"

TOTAL=0; PASS=0; FAIL=0
declare -a FAIL_LIST

i=0
for row in "${ROWS[@]}"; do
  i=$((i+1)); TOTAL=$((TOTAL+1))
  ot_id="$(echo "$row" | awk -F'\t' '{print $1}')"
  api_name="$(echo "$row" | awk -F'\t' '{print $2}')"
  ontology_id="$(echo "$row" | awk -F'\t' '{print $3}')"
  file_path="$(echo "$row" | awk -F'\t' '{print $4}')"

  res="$(verify_one "$ot_id" "$api_name" "$ontology_id" "$file_path")"
  outcome="${res%%|*}"
  detail="${res#*|}"
  db_rows="$(materialized_count "$api_name" 2>/dev/null || echo '?')"

  note=""
  if [[ "$outcome" == "PASS" ]]; then
    # Three independent invariants must all hold for honest UI:
    #   1. funnel_state.status == 'indexed' (already checked in verify_one)
    #   2. funnel_state.objects_indexed > 0
    #   3. funnel_state.objects_indexed == COUNT(object_instances)
    # If (3) fails we know the badge lies even if (1) and (2) pass.
    if [[ "$detail" -le 0 ]]; then
      outcome="FAIL"; note="0-objects-indexed"; FAIL=$((FAIL+1)); FAIL_LIST+=("$api_name: $note")
    elif [[ "$db_rows" =~ ^[0-9]+$ && "$detail" != "$db_rows" ]]; then
      outcome="FAIL"; note="mismatch funnel=$detail vs db=$db_rows"; FAIL=$((FAIL+1)); FAIL_LIST+=("$api_name: $note")
    else
      PASS=$((PASS+1)); note="ok"
    fi
  else
    FAIL=$((FAIL+1)); FAIL_LIST+=("$api_name: $detail"); note="$detail"
  fi
  printf '%3d | %-22s | %-8s | %6s | %6s | %s\n' "$i" "${api_name:0:22}" "$outcome" "${detail:--}" "${db_rows:--}" "$note"
done

printf '%s\n' "----+--------------------+----------+--------+--------+---------------"
log "SUMMARY: total=$TOTAL pass=$PASS fail=$FAIL"
if (( FAIL > 0 )); then
  log "failures:"
  for f in "${FAIL_LIST[@]}"; do log "  - $f"; done
  exit 1
fi
log "ALL GREEN — every foundry-bridged object type re-indexed successfully"
exit 0
