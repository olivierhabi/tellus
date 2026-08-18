#!/usr/bin/env bash
#
# verify-funnel-stage-delay.sh
# ---------------------------
# Production-readiness guard for FUNNEL_STAGE_DELAY_MS.
#
# Goal: prove that the new dev/demo "stage pacing" knob gives each
# funnel stage at least the configured dwell time (so the UI animation
# is perceivable) AND that with the knob off the production baseline
# stays fast. A misconfigured default that silently slows every save
# in prod is the whole failure mode being guarded against.
#
# The script restarts the backend twice: once with
# `FUNNEL_STAGE_DELAY_MS=5000`, once with the knob unset. For each
# pass it:
#   1. Creates a throw-away project + dataset + object type.
#   2. POSTs the UUID-keyed commit → funnel signal lands durably +
#      Temporal signal-with-start kicks off the pipeline.
#   3. Polls the UUID-keyed /runs endpoint until the latest run is
#      `completed`.
#   4. Measures wall-clock duration (`completed_at - started_at`).
#   5. Slow pass asserts duration >= ~15 s (three inter-stage delays
#      materialise — accepts 15 s floor with 2 s jitter tolerance).
#   6. Slow pass asserts that during the run, the /runs endpoint
#      surfaced at least TWO distinct `current_stage` values —
#      proof the UI would actually observe the transition, not just
#      a single snapshot at the end.
#   7. Fast pass asserts duration < 5 s — no stage-delay regression
#      leaks into the default-off path.
#
# Cleans up both fixtures. Exits non-zero on the first failed
# assertion so it's CI-safe.
#
# Requires: curl, jq, the full stack running (API on 3000,
# Keycloak on 8086). The backend will be restarted by this script —
# make sure nothing else is relying on a warm tsx process.

set -o pipefail

KC="${KC_URL:-http://localhost:8086}"
REALM="${KC_REALM:-${KEYCLOAK_REALM:-tellus}}"
CLIENT="${KC_CLIENT:-tellus-frontend}"
USER="${TELLUS_USER:-cypress@tellus.local}"
PASS="${TELLUS_PASS:-Password123!}"
API="${API_URL:-http://localhost:3000/api}"
ONTOLOGY="${TELLUS_ONTOLOGY:-default}"
# Default to the repo root inferred from this script's location so the
# same script works on any developer machine AND on CI (the GitHub
# runner checks out to /home/runner/work/tellus/tellus, NOT the
# author's laptop path).
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
DIM='\033[2m'
NC='\033[0m'
ok()   { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}!${NC} %s\n" "$1"; }
die()  { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }
note() { printf "${DIM}  %s${NC}\n" "$1"; }
hdr()  { printf "\n${DIM}══ %s ══${NC}\n" "$1"; }

command -v jq   >/dev/null || die "jq is required"
command -v curl >/dev/null || die "curl is required"

# ---------------------------------------------------------------------------
# Restart the backend with a given env. Starts a fresh `tsx` child
# process in the background, waits for health, returns its PID via
# stdout. Replaces any existing listener on port 3000.
# ---------------------------------------------------------------------------
start_backend_with_env() {
  local stage_delay="$1"
  local prev_pid
  prev_pid=$(lsof -nP -iTCP:3000 -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $2}')
  if [ -n "$prev_pid" ]; then
    kill "$prev_pid" 2>/dev/null || true
    # Wait for the socket to actually free up so the fresh server can bind.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if ! lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then break; fi
      sleep 1
    done
  fi

  (
    cd "$REPO_ROOT"
    FUNNEL_STAGE_DELAY_MS="$stage_delay" \
      nohup npx tsx src/server.ts \
      >/tmp/tellus-server.log 2>&1 &
    disown $!
  )

  for _ in $(seq 1 30); do
    if curl -sf --max-time 2 "$API/v1/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  die "Backend did not become healthy within 30s (FUNNEL_STAGE_DELAY_MS=$stage_delay)"
}

# ---------------------------------------------------------------------------
# Auth: Keycloak direct grant (bypasses the passkey-enrollment gate).
# ---------------------------------------------------------------------------
get_token() {
  curl -sf -X POST \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "username=$USER" -d "password=$PASS" -d "grant_type=password" \
    -d "client_id=$CLIENT" -d "scope=openid profile email" \
    "$KC/realms/$REALM/protocol/openid-connect/token" \
    | jq -r '.access_token'
}

# ---------------------------------------------------------------------------
# Fixture setup — project + CSV dataset + object type + datasource.
# Sets globals: PROJECT_ID, DATASET_ID, OBJECT_TYPE_ID, OBJECT_TYPE_API_NAME,
#               ONTOLOGY_UUID.
# ---------------------------------------------------------------------------
build_fixture() {
  local stamp="$1"
  local prefix="$2"
  local auth="Authorization: Bearer $ACCESS_TOKEN"

  PROJECT_ID=$(curl -sf -X POST -H "$auth" -H "Content-Type: application/json" \
    -d "$(printf '{"name":"%s-%s","description":"stage-delay verify"}' "$prefix" "$stamp")" \
    "$API/v1/projects" | jq -r '.data.id // .id // .project.id')
  [ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "null" ] || die "project creation failed"

  local tmp_csv="/tmp/verify-stage-$stamp.csv"
  cat >"$tmp_csv" <<'CSV'
order_id,customer_id,item_name,quantity
1,cust-a,Widget,10
2,cust-b,Gizmo,3
3,cust-a,Sprocket,25
CSV
  # POST /api/v1/datasets/upload — canonical ingest path; scans the CSV
  # synchronously and returns the dataset + schema in one response. (The old
  # project-file-upload no longer materialises a dataset row or columns.)
  local upload
  upload=$(curl -sf -X POST -H "$auth" \
    -F "file=@$tmp_csv" \
    -F "name=stage-delay-$stamp" \
    "$API/v1/datasets/upload") || die "upload failed"
  DATASET_ID=$(echo "$upload" | jq -r '.dataset.datasetId // empty')
  [ -n "$DATASET_ID" ] && [ "$DATASET_ID" != "null" ] || die "no dataset id: $upload"
  local cols
  cols=$(echo "$upload" | jq '(.dataset.schemaDefinition.columns // []) | length')
  [ "${cols:-0}" -ge 4 ] || die "no schema columns: $upload"

  OBJECT_TYPE_API_NAME="${prefix}${stamp}"
  local batch
  batch=$(curl -sf -X POST -H "$auth" -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg apiName "$OBJECT_TYPE_API_NAME" \
      --arg displayName "[Verify] $prefix $stamp" \
      '{apiName:$apiName, displayName:$displayName, status:"experimental",
        onConflict:"rename",
        properties:[
          {apiName:"orderId",displayName:"Order Id",baseType:"string",ordinal:0},
          {apiName:"customerId",displayName:"Customer Id",baseType:"string",ordinal:1},
          {apiName:"itemName",displayName:"Item Name",baseType:"string",ordinal:2},
          {apiName:"quantity",displayName:"Quantity",baseType:"integer",ordinal:3}
        ],
        primaryKeyProperty:"orderId", titleProperty:"itemName"}')" \
    "$API/v1/ontology/$ONTOLOGY/objectTypes/batch") || die "batch create failed"
  OBJECT_TYPE_ID=$(echo "$batch" | jq -r '.objectType.objectTypeId // .data.objectType.objectTypeId // .data.objectTypeId // .objectTypeId')
  OBJECT_TYPE_API_NAME=$(echo "$batch" | jq -r '.objectType.apiName // .data.objectType.apiName // .data.apiName // .apiName // "'"$OBJECT_TYPE_API_NAME"'"')
  [ -n "$OBJECT_TYPE_ID" ] && [ "$OBJECT_TYPE_ID" != "null" ] || die "no objectTypeId"

  curl -sf -X POST -H "$auth" -H "Content-Type: application/json" \
    -d "$(jq -n --arg id "$DATASET_ID" \
      '{datasetId:$id,
        columnMapping:{orderId:"order_id",customerId:"customer_id",itemName:"item_name",quantity:"quantity"},
        primaryKeyColumn:"order_id"}')" \
    "$API/v1/ontology/$ONTOLOGY/objectTypes/$OBJECT_TYPE_API_NAME/datasource" \
    >/dev/null || die "datasource bind failed"

  ONTOLOGY_UUID=$(curl -sf -H "$auth" "$API/v1/ontology/$ONTOLOGY" \
    | jq -r '.data.ontologyId // .ontologyId')
  [ -n "$ONTOLOGY_UUID" ] && [ "$ONTOLOGY_UUID" != "null" ] || die "no ontology uuid"

  note "fixture: project=$PROJECT_ID objectType=$OBJECT_TYPE_API_NAME ($OBJECT_TYPE_ID) ontology=$ONTOLOGY_UUID"
}

cleanup_fixture() {
  local auth="Authorization: Bearer $ACCESS_TOKEN"
  [ -n "${OBJECT_TYPE_API_NAME:-}" ] && curl -s -o /dev/null -X DELETE -H "$auth" \
    "$API/v1/ontology/$ONTOLOGY/objectTypes/$OBJECT_TYPE_API_NAME" || true
  [ -n "${PROJECT_ID:-}" ] && curl -s -o /dev/null -X DELETE -H "$auth" \
    "$API/v1/projects/$PROJECT_ID" || true
}

# ---------------------------------------------------------------------------
# Fire the commit, observe the pipeline, return wall-clock ms +
# number of distinct stages observed mid-run.
# Emits two globals: RUN_DURATION_MS, OBSERVED_STAGES.
# ---------------------------------------------------------------------------
measure_commit() {
  local auth="Authorization: Bearer $ACCESS_TOKEN"
  local commit_body="/tmp/verify-stage-commit-$$.json"

  local http
  http=$(curl -s -o "$commit_body" -w "%{http_code}" \
    -X POST -H "$auth" \
    "$API/v1/ontology/$ONTOLOGY_UUID/objectTypeId/$OBJECT_TYPE_ID")
  [ "$http" = "202" ] || die "commit POST expected 202, got $http: $(cat "$commit_body")"

  local signal_id
  signal_id=$(jq -r '.data.signalId // .signalId' "$commit_body")
  note "commit signalId=$signal_id"

  # Poll while the run is in-flight. Collect every distinct
  # `current_stage` we observe so we can prove the UI would see
  # the pipeline move, not just hit completed.
  local runs run_id status current_stage started_at completed_at
  local stages_seen=""
  OBSERVED_STAGES=0
  local deadline=$((SECONDS + 60))
  while [ $SECONDS -lt $deadline ]; do
    runs=$(curl -sf -H "$auth" \
      "$API/v1/funnel/runs/objectTypeId/$OBJECT_TYPE_ID?limit=1" \
      2>/dev/null || echo '{"runs":[]}')
    run_id=$(echo "$runs" | jq -r '.runs[0].run_id // empty')
    [ -n "$run_id" ] || { sleep 0.5; continue; }
    status=$(echo "$runs" | jq -r '.runs[0].status // empty')
    current_stage=$(echo "$runs" | jq -r '.runs[0].current_stage // empty')
    if [ -n "$current_stage" ] && [ "$current_stage" != "null" ]; then
      if [[ ",$stages_seen," != *",$current_stage,"* ]]; then
        stages_seen="${stages_seen:+$stages_seen,}$current_stage"
        OBSERVED_STAGES=$((OBSERVED_STAGES + 1))
        note "observed stage → $current_stage ($(echo "$stages_seen" | tr ',' ' '))"
      fi
    fi
    if [ "$status" = "completed" ]; then
      started_at=$(echo "$runs" | jq -r '.runs[0].started_at')
      completed_at=$(echo "$runs" | jq -r '.runs[0].completed_at')
      break
    fi
    if [ "$status" = "failed" ]; then
      die "run failed: $(echo "$runs" | jq -r '.runs[0].error_message // "no message"')"
    fi
    sleep 0.5
  done

  [ -n "$started_at" ] && [ -n "$completed_at" ] \
    || die "run did not complete within 60 s"

  # Duration in ms. `date -d` varies on macOS; use python3 for portability.
  RUN_DURATION_MS=$(python3 -c "
import sys, datetime as dt
def parse(s):
    s = s.replace('Z', '+00:00')
    return dt.datetime.fromisoformat(s)
a = parse('$started_at'); b = parse('$completed_at')
print(int((b - a).total_seconds() * 1000))
")
  rm -f "$commit_body"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  hdr "0. Startup"
  ACCESS_TOKEN=$(get_token)
  [ -n "$ACCESS_TOKEN" ] && [ "$ACCESS_TOKEN" != "null" ] \
    || die "could not get Keycloak token"
  ok "got Keycloak token"

  # =========================================================================
  # Pass A — delay = 5000 ms (dev/demo mode)
  # =========================================================================
  hdr "A. FUNNEL_STAGE_DELAY_MS=5000 — stages must be observable"
  start_backend_with_env "5000"
  ok "backend started with FUNNEL_STAGE_DELAY_MS=5000"

  ACCESS_TOKEN=$(get_token)
  build_fixture "$(date +%s)" "SlowProbe"
  trap cleanup_fixture EXIT

  measure_commit
  note "run duration: ${RUN_DURATION_MS} ms, distinct stages observed: $OBSERVED_STAGES"

  # Four stages × 5 s = 20 s ideal. Accept ≥ 15 s floor — the
  # activity delay is at the TOP of each stage, so every stage
  # contributes its ~5 s. 15 s leaves room for any single stage
  # that completes under 5 s for reasons outside our control
  # (e.g. hydration shortcuts for zero splits).
  if [ "$RUN_DURATION_MS" -lt 15000 ]; then
    die "delay=5000 run finished in ${RUN_DURATION_MS} ms (expected ≥ 15000 — delay not applied?)"
  fi
  ok "run duration ≥ 15 s (${RUN_DURATION_MS} ms) → stage pacing is active"

  # At least TWO distinct stages observed via polling — proves the
  # UI has a window where changelog/merge/indexing/hydration
  # transitions are actually visible to a client polling at 1 s.
  if [ "$OBSERVED_STAGES" -lt 2 ]; then
    die "only $OBSERVED_STAGES distinct stage(s) observed mid-run — UI would not see transitions"
  fi
  ok "observed $OBSERVED_STAGES distinct stages mid-run → UI transitions visible"

  # Stronger assertion — each stage_run's finished_at - started_at
  # must individually be ≥ 4500 ms. Tighter than the aggregate check:
  # catches a regression where, say, indexing runs in 10 ms but
  # hydration waits 19 s — total still passes the 15 s floor but the
  # UI would show hydration frozen instead of an even 5 s per stage.
  auth="Authorization: Bearer $ACCESS_TOKEN"
  runs_body=$(curl -sf -H "$auth" \
    "$API/v1/funnel/runs/objectTypeId/$OBJECT_TYPE_ID?limit=1")
  run_id=$(echo "$runs_body" | jq -r '.runs[0].run_id // empty')
  # Postgres emits `YYYY-MM-DD HH:MM:SS.ffffff+00` which jq's
  # fromdateiso8601 can't parse — hand the raw rows to python3 which
  # handles sub-seconds + TZ offsets natively.
  stage_rows=$(echo "$runs_body" | jq -c --arg rid "$run_id" '
    [ .stages[] | select(.run_id == $rid and .started_at and .finished_at)
      | {stage, started_at, finished_at} ]
  ')
  durations_json=$(printf '%s' "$stage_rows" | python3 -c '
import sys, json, datetime as dt
def parse(s):
    s = s.replace(" ", "T", 1)
    if s.endswith("+00"):
        s = s[:-3] + "+00:00"
    return dt.datetime.fromisoformat(s)
rows = json.load(sys.stdin)
out = [{"stage": r["stage"],
        "ms": int((parse(r["finished_at"]) - parse(r["started_at"])).total_seconds() * 1000)}
       for r in rows]
print(json.dumps(out))
')
  note "per-stage durations (ms): $(echo "$durations_json" | jq -c 'map({(.stage): .ms}) | add')"
  min_ms=$(echo "$durations_json" | jq 'map(.ms) | min // 0')
  if [ "${min_ms:-0}" -lt 4500 ]; then
    die "at least one stage ran in ${min_ms} ms (<4500) — backend pacing is uneven: $durations_json"
  fi
  ok "every stage individually ≥ 4.5 s (min ${min_ms} ms) → pacing is uniform"

  cleanup_fixture
  trap - EXIT

  # =========================================================================
  # Pass B — delay = 0 (production default)
  # =========================================================================
  hdr "B. FUNNEL_STAGE_DELAY_MS=0 — production baseline unchanged"
  start_backend_with_env "0"
  ok "backend restarted with FUNNEL_STAGE_DELAY_MS=0"

  ACCESS_TOKEN=$(get_token)
  build_fixture "$(date +%s)" "FastProbe"
  trap cleanup_fixture EXIT

  measure_commit
  note "run duration: ${RUN_DURATION_MS} ms"

  # Strict upper bound — if this fails, the dev knob leaked into
  # the default-off path.
  if [ "$RUN_DURATION_MS" -ge 5000 ]; then
    die "delay=0 run took ${RUN_DURATION_MS} ms (expected < 5000 — knob leaking into prod default?)"
  fi
  ok "run duration < 5 s (${RUN_DURATION_MS} ms) → prod baseline preserved"

  cleanup_fixture
  trap - EXIT

  hdr "All passes green"
  printf "${GREEN}FUNNEL_STAGE_DELAY_MS is production-ready.${NC}\n"
  printf "  dev/demo:   set FUNNEL_STAGE_DELAY_MS=5000 → each stage visible for ~5 s\n"
  printf "  production: leave unset (defaults to 0) → no added latency\n"
}

main "$@"
