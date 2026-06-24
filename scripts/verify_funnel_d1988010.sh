#!/usr/bin/env bash
# verify_funnel_d1988010.sh
#
# End-to-end verification for the fix that:
#   1. Wires the Temporal funnel to project terminal state into
#      `funnel_state` (was stuck at `indexing` after the workflow finished).
#   2. Teaches the Temporal `runChangelogActivity` how to read
#      foundry-bridged CSV/JSON/TSV backing datasources (was emitting
#      0 rows for wizard-created OTs, hence `objects_indexed = 0`).
#
# Usage:
#   ./scripts/verify_funnel_d1988010.sh                # default OT (the bug)
#   OBJECT_TYPE_ID=... ./scripts/verify_funnel_d1988010.sh
#
# Exit codes:
#   0  funnel_state.status='indexed' AND objects_indexed > 0
#   1  Postgres unreachable or query failed
#   2  status did not flip to 'indexed' within timeout
#   3  objects_indexed did not match expected non-zero CSV row count
#
# All output is plain text — no colour codes, no spinners — so it runs
# cleanly under CI and `tee`.

set -euo pipefail

OBJECT_TYPE_ID="${OBJECT_TYPE_ID:-d1988010-4950-45b3-9304-00a63dc4b282}"
PG_CONTAINER="${PG_CONTAINER:-tellus-postgres-1}"
PG_USER="${PG_USER:-tellus}"
PG_DB="${PG_DB:-tellus_db}"
API_BASE="${API_BASE:-http://localhost:3000}"
POLL_TIMEOUT_S="${POLL_TIMEOUT_S:-300}"
POLL_INTERVAL_S="${POLL_INTERVAL_S:-2}"
# Bearer JWT for the protected /api/v1/funnel/signals endpoint. Caller (or
# CI) sets BEARER_TOKEN directly OR provides KC_* env vars; we mint via
# Keycloak's direct-grant flow if BEARER_TOKEN is empty.
BEARER_TOKEN="${BEARER_TOKEN:-}"
KC_BASE="${KC_BASE:-http://localhost:8086}"
KC_REALM="${KC_REALM:-tellus}"
KC_CLIENT_ID="${KC_CLIENT_ID:-tellus-frontend}"
KC_USERNAME="${KC_USERNAME:-habimanaolivier6@gmail.com}"
KC_PASSWORD="${KC_PASSWORD:-VerifyTellus123!}"

psql() {
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -At "$@"
}

log() { printf '[verify] %s\n' "$*"; }

mint_bearer_token() {
  if [[ -n "$BEARER_TOKEN" ]]; then return 0; fi
  log "minting Keycloak token (realm=$KC_REALM client=$KC_CLIENT_ID user=$KC_USERNAME)"
  BEARER_TOKEN="$(curl -fsS -X POST "$KC_BASE/realms/$KC_REALM/protocol/openid-connect/token" \
    -d "grant_type=password&client_id=$KC_CLIENT_ID&username=$KC_USERNAME&password=$KC_PASSWORD" \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('access_token',''))" \
    2>/dev/null || true)"
  if [[ -z "$BEARER_TOKEN" ]]; then
    log "FATAL: could not mint Keycloak token; set BEARER_TOKEN or KC_USERNAME/KC_PASSWORD"
    exit 1
  fi
}

# -----------------------------------------------------------------------
# Step 1 — capture the baseline so the diff at the end is unambiguous.
# -----------------------------------------------------------------------

log "object_type_id = $OBJECT_TYPE_ID"
API_NAME="$(psql -c "SELECT api_name FROM object_type WHERE object_type_id = '$OBJECT_TYPE_ID'")"
ONTOLOGY_ID="$(psql -c "SELECT ontology_id FROM object_type WHERE object_type_id = '$OBJECT_TYPE_ID'")"
if [[ -z "$API_NAME" ]]; then
  log "FATAL: no object_type row for $OBJECT_TYPE_ID"
  exit 1
fi
log "api_name    = $API_NAME"
log "ontology_id = $ONTOLOGY_ID"

BEFORE_STATE="$(psql -c "SELECT status || '|' || COALESCE(objects_indexed::text,'NULL') FROM funnel_state WHERE object_type_id = '$OBJECT_TYPE_ID'")"
log "BEFORE funnel_state = $BEFORE_STATE"

BACKING_FILE_PATH="$(psql -c "SELECT file_path FROM backing_datasource WHERE object_type_id = '$OBJECT_TYPE_ID' LIMIT 1")"
if [[ -z "$BACKING_FILE_PATH" ]]; then
  log "FATAL: no backing_datasource row for $OBJECT_TYPE_ID — nothing to index"
  exit 1
fi
log "backing file_path = $BACKING_FILE_PATH"

# -----------------------------------------------------------------------
# Step 2 — fire an editBatchPending signal so the Temporal worker drives
# the four-stage pipeline. We POST through the public API exactly the way
# the FE Save button does; this guarantees the test exercises the same
# code path the bug originally surfaced on.
# -----------------------------------------------------------------------

mint_bearer_token
log "POST $API_BASE/api/v1/funnel/signals"
SIGNAL_RES="$(curl -fsS -X POST "$API_BASE/api/v1/funnel/signals" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $BEARER_TOKEN" \
  -d "{\"ontologyId\":\"$ONTOLOGY_ID\",\"objectTypeApiName\":\"$API_NAME\",\"signalType\":\"editBatchPending\",\"payload\":{\"verify\":true,\"ts\":$(date +%s)}}" \
  || echo '__CURL_FAIL__')"
log "signal response = $SIGNAL_RES"
if [[ "$SIGNAL_RES" == "__CURL_FAIL__" ]]; then
  log "FATAL: /api/v1/funnel/signals unreachable. Is the API server up on $API_BASE?"
  exit 1
fi
# Capture the moment we fired the signal so the polling loop below can
# distinguish a fresh terminal projection from a stale one. Without this
# guard, a leftover 'failed' row from a previous run would pass the
# terminal check immediately and we'd report success on stale data.
SIGNAL_AT_EPOCH="$(date +%s)"

# -----------------------------------------------------------------------
# Step 3 — poll funnel_state until terminal. Watch for BOTH the happy and
# sad paths so a regression doesn't silently sit on 'indexing' forever.
# -----------------------------------------------------------------------

START="$(date +%s)"
LAST_STATUS=""
while :; do
  ROW="$(psql -c "SELECT status || '|' || COALESCE(objects_indexed::text,'NULL') || '|' || COALESCE(error_message,'') || '|' || EXTRACT(EPOCH FROM updated_at)::bigint FROM funnel_state WHERE object_type_id = '$OBJECT_TYPE_ID'")"
  STATUS="${ROW%%|*}"
  REST="${ROW#*|}"
  OBJECTS="$(echo "$REST" | awk -F'|' '{print $1}')"
  ERR="$(echo "$REST" | awk -F'|' '{print $2}')"

  if [[ "$STATUS" != "$LAST_STATUS" ]]; then
    log "status=$STATUS objects=$OBJECTS err=${ERR:-(none)}"
    LAST_STATUS="$STATUS"
  fi

  # Distinguish a terminal projection FROM THIS RUN from a stale one
  # left over by a previous failure. Compare updated_at against the
  # moment we POSTed the signal.
  UPDATED_EPOCH="$(echo "$REST" | awk -F'|' '{print $3}')"
  IS_FRESH=0
  if [[ -n "$UPDATED_EPOCH" && "$UPDATED_EPOCH" -ge "$SIGNAL_AT_EPOCH" ]]; then
    IS_FRESH=1
  fi

  if [[ "$STATUS" == "indexed" && "$IS_FRESH" == "1" ]]; then
    break
  fi
  if [[ "$STATUS" == "failed" && "$IS_FRESH" == "1" ]]; then
    log "FATAL: funnel reported failure: $ERR"
    exit 2
  fi

  NOW="$(date +%s)"
  if (( NOW - START >= POLL_TIMEOUT_S )); then
    log "FATAL: timed out after ${POLL_TIMEOUT_S}s waiting for funnel_state to leave '$STATUS'"
    psql -c "SELECT run_id, workflow_type, status, started_at, completed_at, objects_indexed FROM funnel_run WHERE object_type_api_name='$API_NAME' ORDER BY started_at DESC LIMIT 5"
    exit 2
  fi
  sleep "$POLL_INTERVAL_S"
done

# -----------------------------------------------------------------------
# Step 4 — verify objects_indexed matches what's actually in the CSV.
# We tolerate a small delta (≤ 5%) so a CSV with duplicate primary keys
# still passes — the funnel de-dupes on PK with last-wins semantics.
# -----------------------------------------------------------------------

FINAL_OBJECTS="$(psql -c "SELECT objects_indexed FROM funnel_state WHERE object_type_id = '$OBJECT_TYPE_ID'")"
log "AFTER funnel_state status=indexed objects_indexed=$FINAL_OBJECTS"
if [[ -z "$FINAL_OBJECTS" || "$FINAL_OBJECTS" -le 0 ]]; then
  log "FATAL: indexed but objects_indexed is $FINAL_OBJECTS — backing datasource not read"
  exit 3
fi

# Optional: cross-check against the actual CSV row count if S3 reachable.
# Use the same path the funnel just exercised so any path-resolution bug
# manifests as a count mismatch here, not silently.
if command -v node >/dev/null 2>&1; then
  CSV_KEY="${BACKING_FILE_PATH%%#foundry-dataset:*}"
  CSV_ROWS="$(node -e "
    const {S3Client,GetObjectCommand}=require('@aws-sdk/client-s3');
    const c=new S3Client({endpoint:'http://localhost:9000',region:'us-east-1',credentials:{accessKeyId:'minioadmin',secretAccessKey:'minioadmin'},forcePathStyle:true});
    (async()=>{
      try{
        const r=await c.send(new GetObjectCommand({Bucket:'tellus-uploads',Key:'$CSV_KEY'}));
        let n=0;
        for await (const chunk of r.Body) for (const b of chunk) if (b===10) n++;
        console.log(n-1); // -1 for header line
      } catch(e) { console.log('-1'); }
    })();
  " 2>/dev/null || echo "-1")"
  log "CSV data rows (newlines - header) = $CSV_ROWS"
  if [[ "$CSV_ROWS" =~ ^[0-9]+$ && "$CSV_ROWS" -gt 0 ]]; then
    DELTA=$(( FINAL_OBJECTS > CSV_ROWS ? FINAL_OBJECTS - CSV_ROWS : CSV_ROWS - FINAL_OBJECTS ))
    PCT=$(( CSV_ROWS == 0 ? 100 : (DELTA * 100) / CSV_ROWS ))
    log "delta = $DELTA rows ($PCT%)"
    if (( PCT > 5 )); then
      log "FATAL: indexed object count ($FINAL_OBJECTS) drifts more than 5% from CSV ($CSV_ROWS)"
      exit 3
    fi
  fi
fi

log "PASS — funnel_state.status='indexed' AND objects_indexed=$FINAL_OBJECTS for $API_NAME"
exit 0
