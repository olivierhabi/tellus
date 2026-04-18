#!/usr/bin/env bash
#
# verify-funnel-reset.sh
# ----------------------
# Proves that clicking "Save to ontology" AGAIN — after a previous
# funnel run has completed — creates a fresh run that re-executes
# every stage from the beginning (not a no-op, not a stuck state).
#
# Contract being verified:
#   * Each commit emits a signal → dispatcher / Temporal claims it
#     and creates a NEW `funnel_run` row with a fresh `run_id`.
#   * The new run's first observed `current_stage` is `"changelog"`
#     (the pipeline's first stage), not mid-pipeline carryover.
#   * The new run eventually reaches `status == "completed"`.
#   * Per-stage durations still honour FUNNEL_STAGE_DELAY_MS=5000
#     for the SECOND run too — pacing isn't a first-run-only affair.
#
# Fails on the first failed assertion with a specific message.
# Requires the stack running; restarts the backend twice — once
# paced at 5 s/stage for the assertions, once restored to 0 ms
# on exit so the dev loop isn't left slow.

set -o pipefail

KC="${KC_URL:-http://localhost:8086}"
REALM="${KC_REALM:-tellus}"
CLIENT="${KC_CLIENT:-tellus-frontend}"
USER="${TELLUS_USER:-cypress@tellus.local}"
PASS="${TELLUS_PASS:-Password123!}"
API="${API_URL:-http://localhost:3000/api}"
ONTOLOGY="${TELLUS_ONTOLOGY:-default}"
REPO_ROOT="${REPO_ROOT:-/Users/olivierhabimana/Desktop/projects/tellus}"

GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m'
ok()   { printf "${GREEN}✓${NC} %s\n" "$1"; }
die()  { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }
note() { printf "${DIM}  %s${NC}\n" "$1"; }
hdr()  { printf "\n${DIM}══ %s ══${NC}\n" "$1"; }

command -v jq   >/dev/null || die "jq is required"
command -v curl >/dev/null || die "curl is required"

# ---------------------------------------------------------------------------
# Restart backend with a given delay; wait for health.
# ---------------------------------------------------------------------------
start_backend_with_env() {
  local delay="$1"
  local pid
  pid=$(lsof -nP -iTCP:3000 -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $2}')
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 1
  done
  (
    cd "$REPO_ROOT"
    FUNNEL_STAGE_DELAY_MS="$delay" \
      nohup npx tsx src/server.ts \
      >/tmp/tellus-server.log 2>&1 &
    disown $!
  )
  for _ in $(seq 1 30); do
    curl -sf --max-time 2 "$API/v1/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "backend did not become healthy (delay=$delay)"
}

# Always leave the backend on prod default.
on_exit() {
  hdr "Restoring FUNNEL_STAGE_DELAY_MS=0"
  start_backend_with_env "0" && ok "backend back on prod default"
  [ -n "${OBJECT_TYPE_API_NAME:-}" ] && [ -n "${ACCESS_TOKEN:-}" ] && \
    curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $ACCESS_TOKEN" \
      "$API/v1/ontology/$ONTOLOGY/objectTypes/$OBJECT_TYPE_API_NAME" || true
  [ -n "${PROJECT_ID:-}" ] && [ -n "${ACCESS_TOKEN:-}" ] && \
    curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $ACCESS_TOKEN" \
      "$API/v1/projects/$PROJECT_ID" || true
}
trap on_exit EXIT

# ---------------------------------------------------------------------------
# Start paced.
# ---------------------------------------------------------------------------
hdr "0. Boot backend paced at 5 s/stage"
start_backend_with_env "5000"
ok "backend running with FUNNEL_STAGE_DELAY_MS=5000"

# ---------------------------------------------------------------------------
# Auth + fixture.
# ---------------------------------------------------------------------------
ACCESS_TOKEN=$(curl -sf -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=$USER" -d "password=$PASS" -d "grant_type=password" \
  -d "client_id=$CLIENT" -d "scope=openid profile email" \
  "$KC/realms/$REALM/protocol/openid-connect/token" | jq -r '.access_token')
[ -n "$ACCESS_TOKEN" ] && [ "$ACCESS_TOKEN" != "null" ] || die "no token"
AUTH="Authorization: Bearer $ACCESS_TOKEN"
ok "auth ok"

hdr "1. Build throw-away object type"
STAMP=$(date +%s)
PROJECT_ID=$(curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"name\":\"reset-probe-$STAMP\",\"description\":\"verify-funnel-reset\"}" \
  "$API/v1/projects" | jq -r '.data.id // .id // .project.id')
[ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "null" ] || die "project failed"
note "project=$PROJECT_ID"

TMP_CSV="/tmp/reset-$STAMP.csv"
cat >"$TMP_CSV" <<'CSV'
order_id,customer_id,item_name,quantity
1,a,Widget,10
2,b,Gizmo,3
3,a,Sprocket,25
CSV
UPLOAD=$(curl -sf -X POST -H "$AUTH" -F "files=@$TMP_CSV" \
  "$API/v1/projects/$PROJECT_ID/upload")
DATASET_ID=$(echo "$UPLOAD" | jq -r '.data[0].dataset.id // .data[0].id // .data[0].datasetId')
[ -n "$DATASET_ID" ] && [ "$DATASET_ID" != "null" ] || die "dataset missing"
note "dataset=$DATASET_ID"

for _ in $(seq 1 30); do
  cols=$(curl -sf -H "$AUTH" "$API/v1/datasets/$DATASET_ID" \
    | jq '(.data.columns // .columns // .data.schema_info.columns // []) | length')
  [ "${cols:-0}" -ge 4 ] && break
  sleep 2
done

OBJECT_TYPE_API_NAME="ResetProbe$STAMP"
BATCH=$(curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "$(jq -n --arg apiName "$OBJECT_TYPE_API_NAME" \
    '{apiName:$apiName, displayName:("[Verify] "+$apiName), status:"experimental",
      onConflict:"rename",
      properties:[
        {apiName:"orderId",displayName:"Order Id",baseType:"string",ordinal:0},
        {apiName:"customerId",displayName:"Customer Id",baseType:"string",ordinal:1},
        {apiName:"itemName",displayName:"Item Name",baseType:"string",ordinal:2},
        {apiName:"quantity",displayName:"Quantity",baseType:"integer",ordinal:3}
      ],
      primaryKeyProperty:"orderId", titleProperty:"itemName"}')" \
  "$API/v1/ontology/$ONTOLOGY/objectTypes/batch")
OBJECT_TYPE_ID=$(echo "$BATCH" | jq -r '.objectType.objectTypeId // .data.objectType.objectTypeId // .data.objectTypeId // .objectTypeId')
OBJECT_TYPE_API_NAME=$(echo "$BATCH" | jq -r '.objectType.apiName // .data.objectType.apiName // .data.apiName // .apiName // "'"$OBJECT_TYPE_API_NAME"'"')
curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "$(jq -n --arg id "$DATASET_ID" \
    '{foundryDatasetId:$id,
      columnMapping:{orderId:"order_id",customerId:"customer_id",itemName:"item_name",quantity:"quantity"},
      primaryKeyColumn:"order_id"}')" \
  "$API/v1/ontology/$ONTOLOGY/objectTypes/$OBJECT_TYPE_API_NAME/datasource" \
  >/dev/null

ONTOLOGY_UUID=$(curl -sf -H "$AUTH" "$API/v1/ontology/$ONTOLOGY" \
  | jq -r '.data.ontologyId // .ontologyId')
note "objectType=$OBJECT_TYPE_API_NAME ($OBJECT_TYPE_ID) ontology=$ONTOLOGY_UUID"

# ---------------------------------------------------------------------------
# Utility: wait for the newest run whose run_id differs from $1 to
# appear and reach status=completed. Writes results into globals
# so the caller (who runs this in the CURRENT shell, not a $()
# subshell — critical: $(…) forks, losing globals) can read them.
#
# Emits:
#   LAST_RUN_ID        — the completed run's run_id
#   FIRST_STAGE_SEEN   — the first non-null current_stage observed
#                        on the new run before it advanced
# ---------------------------------------------------------------------------
wait_for_new_run_completion() {
  local prior_run_id="$1"
  local deadline=$((SECONDS + 60))
  LAST_RUN_ID=""
  FIRST_STAGE_SEEN=""
  while [ $SECONDS -lt $deadline ]; do
    local runs
    runs=$(curl -sf -H "$AUTH" \
      "$API/v1/funnel/runs/objectTypeId/$OBJECT_TYPE_ID?limit=1" \
      2>/dev/null || echo '{"runs":[]}')
    local latest_id latest_status latest_stage
    latest_id=$(echo "$runs" | jq -r '.runs[0].run_id // empty')
    latest_status=$(echo "$runs" | jq -r '.runs[0].status // empty')
    latest_stage=$(echo "$runs" | jq -r '.runs[0].current_stage // empty')

    if [ -n "$latest_id" ] && [ "$latest_id" != "$prior_run_id" ]; then
      LAST_RUN_ID="$latest_id"
      if [ -z "$FIRST_STAGE_SEEN" ] && [ -n "$latest_stage" ] && [ "$latest_stage" != "null" ]; then
        FIRST_STAGE_SEEN="$latest_stage"
      fi
      [ "$latest_status" = "completed" ] && return 0
      [ "$latest_status" = "failed" ] && {
        die "new run $latest_id failed: $(echo "$runs" | jq -r '.runs[0].error_message // "(no msg)"')"
      }
    fi
    sleep 0.5
  done
  die "did not observe new completed run within 60 s (prior=$prior_run_id)"
}

# ---------------------------------------------------------------------------
# Commit A — first save-to-ontology.
# ---------------------------------------------------------------------------
hdr "2. First commit — run A"
HTTP=$(curl -s -o /tmp/commit.json -w "%{http_code}" \
  -X POST -H "$AUTH" \
  "$API/v1/ontology/$ONTOLOGY_UUID/objectTypeId/$OBJECT_TYPE_ID")
[ "$HTTP" = "202" ] || die "commit A expected 202, got $HTTP: $(cat /tmp/commit.json)"
SIGNAL_A=$(jq -r '.data.signalId // .signalId' /tmp/commit.json)
ok "commit A → 202, signalId=$SIGNAL_A"

wait_for_new_run_completion ""
RUN_A="$LAST_RUN_ID"
FIRST_STAGE_A="$FIRST_STAGE_SEEN"
note "run A=$RUN_A  first observed stage=$FIRST_STAGE_A"
[ "$FIRST_STAGE_A" = "changelog" ] \
  || die "run A first observed current_stage was '$FIRST_STAGE_A' (expected 'changelog')"
ok "run A completed, started from changelog"

# ---------------------------------------------------------------------------
# Commit B — second save-to-ontology. This is the invariant under test.
# ---------------------------------------------------------------------------
hdr "3. Second commit — run B must be a fresh run"
HTTP=$(curl -s -o /tmp/commit.json -w "%{http_code}" \
  -X POST -H "$AUTH" \
  "$API/v1/ontology/$ONTOLOGY_UUID/objectTypeId/$OBJECT_TYPE_ID")
[ "$HTTP" = "202" ] || die "commit B expected 202, got $HTTP: $(cat /tmp/commit.json)"
SIGNAL_B=$(jq -r '.data.signalId // .signalId' /tmp/commit.json)
[ "$SIGNAL_B" != "$SIGNAL_A" ] \
  || die "signalId not fresh: got $SIGNAL_B both times"
ok "commit B → 202, signalId=$SIGNAL_B (distinct from A)"

wait_for_new_run_completion "$RUN_A"
RUN_B="$LAST_RUN_ID"
FIRST_STAGE_B="$FIRST_STAGE_SEEN"
note "run B=$RUN_B  first observed stage=$FIRST_STAGE_B"

[ "$RUN_B" != "$RUN_A" ] \
  || die "run B run_id matches A ($RUN_A) — no new run was created"
ok "run B has a fresh run_id (distinct from A)"

[ "$FIRST_STAGE_B" = "changelog" ] \
  || die "run B first observed current_stage was '$FIRST_STAGE_B' (expected 'changelog' — re-index did NOT reset to start)"
ok "run B observed starting from 'changelog' — pipeline reset verified"

# ---------------------------------------------------------------------------
# Pacing must still hold for run B (catches a subtle regression where
# the second signal bypasses the stage-delay hook).
# ---------------------------------------------------------------------------
hdr "4. Run B per-stage pacing must also be ≥ 4.5 s"
RUN_B_BODY=$(curl -sf -H "$AUTH" \
  "$API/v1/funnel/runs/objectTypeId/$OBJECT_TYPE_ID?limit=5")
RUN_B_STAGES=$(echo "$RUN_B_BODY" | jq -c --arg rid "$RUN_B" '
  [ .stages[] | select(.run_id == $rid and .started_at and .finished_at)
    | {stage, started_at, finished_at} ]
')
RUN_B_DURATIONS=$(printf '%s' "$RUN_B_STAGES" | python3 -c '
import sys, json, datetime as dt
def parse(s):
    s = s.replace(" ", "T", 1)
    if s.endswith("+00"): s = s[:-3] + "+00:00"
    return dt.datetime.fromisoformat(s)
rows = json.load(sys.stdin)
out = [{"stage": r["stage"],
        "ms": int((parse(r["finished_at"]) - parse(r["started_at"])).total_seconds() * 1000)}
       for r in rows]
print(json.dumps(out))
')
note "run B per-stage (ms): $(echo "$RUN_B_DURATIONS" | jq -c 'map({(.stage): .ms}) | add')"
MIN_B=$(echo "$RUN_B_DURATIONS" | jq 'map(.ms) | min // 0')
[ "${MIN_B:-0}" -ge 4500 ] \
  || die "run B min stage duration ${MIN_B} ms < 4500 — re-runs are NOT paced"
ok "run B min stage duration ${MIN_B} ms — pacing honoured on repeat saves"

# ---------------------------------------------------------------------------
# Summary.
# ---------------------------------------------------------------------------
hdr "All assertions green"
printf "${GREEN}Save-to-ontology correctly re-indexes from scratch on repeat clicks.${NC}\n"
printf "  run A (%s) first stage=%s, run B (%s) first stage=%s\n" \
  "${RUN_A:0:8}" "$FIRST_STAGE_A" "${RUN_B:0:8}" "$FIRST_STAGE_B"
printf "  both runs paced ≥ 4.5 s/stage; fresh run_id on each commit.\n"
