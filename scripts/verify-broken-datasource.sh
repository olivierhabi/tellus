#!/usr/bin/env bash
# =============================================================================
# verify-broken-datasource.sh
#
# Reproduces / verifies the "broken datasource in Ontology Manager" bug.
#
# Two object types share the same backing-table lineage
# (orders_bureau_transactional_system) but differ wildly in size:
#
#   WORKING  OlivierOrder1   98d01253-…  117 KB /    746 rows
#   BROKEN   OlivierOrderJuly cba80ac7-…  854 MB / 5,606,674 rows
#
# Root cause: the backend materializes the ENTIRE backing CSV in memory.
#   - Indexing: reindexService.readFoundryBridgedFile does
#       getObjectBuffer(s3Key)            // 854 MB Buffer
#       buffer.toString("utf-8")          // > Buffer.constants.MAX_STRING_LENGTH
#                                       //   (512 MiB) -> throws
#               "Cannot create a string longer than 0x1fffffe8 characters"
#     -> funnel_pipeline_state.status='failed', stuck at changelog/merge.
#   - Preview:  dataPreview downloads the whole 854 MB via getObjectBuffer
#     then readCSV collects ALL 5.6 M rows just to slice 50 -> exceeds the
#     global 5 s requestTimeoutMiddleware -> HTTP 504 -> FE renders no rows.
#
# Usage:
#   ./verify-broken-datasource.sh            # read-only checks (preview + status)
#   TRIGGER=1 ./verify-broken-datasource.sh  # also POST a fresh reindex + poll
#
# Run it BEFORE the fix (reproduces the bug) and AFTER the fix (confirms the
# resolution); the working UUID is checked both times for regression.
# =============================================================================
set -u

BACKEND="${BACKEND:-http://localhost:3001/api/v1}"
ADMIN_USER="${ADMIN_USER:-cypress@tellus.local}"
ADMIN_PASS="${ADMIN_PASS:-Password123!}"
ONTOLOGY_ID="${ONTOLOGY_ID:-00000000-0000-0000-0000-000000000001}"
TRIGGER="${TRIGGER:-0}"
REINDEX_POLL_TIMEOUT="${REINDEX_POLL_TIMEOUT:-420}"   # seconds to wait for a reindex to settle

BROKEN_OT="cba80ac7-ec8e-4b5e-945b-13671d4f5d11"
BROKEN_API="OlivierOrderJuly"
BROKEN_DS="03096f15-69dc-4800-85de-25b152a5beee"
WORKING_OT="98d01253-0afd-40ce-b69b-8f653d0b9f48"
WORKING_API="OlivierOrder1"
WORKING_DS="c3a54ed5-19a3-4394-a66b-7e8b0d5dee95"

CURL=(curl -sL --max-time 60)

# --- login bypass ----------------------------------------------------------
TOKEN=$("${CURL[@]}" -X POST "$BACKEND/auth/_test/login-bypass" \
  -H 'X-Tellus-Test-Hook: 1' -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(s).data.accessToken||'')}catch(e){}})")
if [ -z "$TOKEN" ]; then
  echo "FATAL: could not obtain an auth token via login-bypass ($BACKEND). Is the backend up?"
  exit 2
fi
AUTH="Authorization: Bearer $TOKEN"

# --- helpers ---------------------------------------------------------------
# jq-lite field extractor over HTTP responses that may carry a trailing
# status line we append with -w.
extract() { # <json-body> <node-expr>
  node -e "let s=process.argv[1];try{const j=JSON.parse(s);process.stdout.write(String(eval(process.argv[2])??''))}catch(e){process.stdout.write('')}" "$1" "$2" 2>/dev/null
}

check_uuid() { # <label> <objectTypeId> <apiName> <datasetId>
  local label="$1" otid="$2" api="$3" dsid="$4"
  echo "----------------------------------------------------------------"
  echo "[$label] objectTypeId=$otid  apiName=$api  datasetId=$dsid"
  echo "----------------------------------------------------------------"

  # 1) Preview
  local prev_http prev_body prev_rows prev_total
  prev_body=$("${CURL[@]}" -H "$AUTH" \
    -w $'\n__HTTP__%{http_code}__%{time_total}' \
    "$BACKEND/datasets/$dsid/preview?rows=50")
  prev_http=$(printf '%s' "$prev_body" | sed -n 's/.*__HTTP__\([0-9]*\)__.*/\1/p' | tail -1)
  prev_body=$(printf '%s' "$prev_body" | sed 's/__HTTP__[0-9]*__.*//')
  prev_rows=$(extract "$prev_body" "((j.data||j).rows||[]).length")
  prev_total=$(extract "$prev_body" "(j.data||j).totalRows")
  echo "  PREVIEW   : HTTP $prev_http | rows=$prev_rows | totalRows=$prev_total"

  # 2) Status (current, without re-triggering)
  local st_body st_status st_stage st_err st_objs
  st_body=$("${CURL[@]}" -H "$AUTH" "$BACKEND/ontology/$ONTOLOGY_ID/objectTypeId/$otid/status")
  st_status=$(extract "$st_body" "(j.data||j).pipelineState?.status")
  st_stage=$(extract "$st_body" "(j.data||j).pipelineState?.currentStage")
  st_objs=$(extract "$st_body" "(j.data||j).pipelineState?.objectsIndexed")
  st_err=$(extract "$st_body" "(j.data||j).pipelineState?.errorMessage")
  local maxstr=""
  case "$st_err" in
    *"Cannot create a string longer than"*) maxstr="  <-- MAX_STRING_LENGTH root-cause error present" ;;
  esac
  echo "  STATUS    : pipelineState.status=$st_status currentStage=$st_stage objectsIndexed=$st_objs"
  echo "  STATUS.err: ${st_err:0:160}${maxstr}"

  # 3) Optionally trigger a fresh reindex and poll to terminal
  if [ "$TRIGGER" = "1" ]; then
    echo "  TRIGGER   : POST /ontology/$ONTOLOGY_ID/objectTypes/$api/reindex?force=true"
    local trig_http
    trig_http=$("${CURL[@]}" --max-time 15 -o /dev/null -w '%{http_code}' -X POST \
      -H "$AUTH" "$BACKEND/ontology/$ONTOLOGY_ID/objectTypes/$api/reindex?force=true" || true)
    echo "  TRIGGER   : reindex POST returned HTTP $trig_http (async if 202); polling status..."
    local deadline=$(( $(date +%s) + REINDEX_POLL_TIMEOUT ))
    local last_status="$st_status" last_err="$st_err" last_stage="$st_stage" last_objs="$st_objs"
    while [ "$(date +%s)" -lt "$deadline" ]; do
      st_body=$("${CURL[@]}" --max-time 15 -H "$AUTH" "$BACKEND/ontology/$ONTOLOGY_ID/objectTypeId/$otid/status")
      last_status=$(extract "$st_body" "(j.data||j).pipelineState?.status")
      last_stage=$(extract "$st_body" "(j.data||j).pipelineState?.currentStage")
      last_objs=$(extract "$st_body" "(j.data||j).pipelineState?.objectsIndexed")
      last_err=$(extract "$st_body" "(j.data||j).pipelineState?.errorMessage")
      # terminal states
      case "$last_status" in
        indexed|success|failed|"") [ "$last_status" != "running" ] && [ -n "$last_status" ] && break ;;
      esac
      sleep 5
    done
    local maxstr2=""
    case "$last_err" in
      *"Cannot create a string longer than"*) maxstr2="  <-- MAX_STRING_LENGTH STILL PRESENT" ;;
    esac
    echo "  TRIGGER   : settled -> status=$last_status currentStage=$last_stage objectsIndexed=$last_objs"
    echo "  TRIGGER.err: ${last_err:0:160}${maxstr2}"
  fi
  echo
}

echo "################################################################"
echo "# verify-broken-datasource.sh   TRIGGER=$TRIGGER   backend=$BACKEND"
echo "################################################################"
echo
check_uuid "BROKEN " "$BROKEN_OT"  "$BROKEN_API"  "$BROKEN_DS"
check_uuid "WORKING" "$WORKING_OT" "$WORKING_API" "$WORKING_DS"

echo "################################################################"
echo "# Summary of pass/fail expectations"
echo "################################################################"
echo "  PRE-FIX : BROKEN preview=504/0 rows; BROKEN indexing failed w/ MAX_STRING_LENGTH"
echo "           WORKING preview=200/50 rows; WORKING indexing indexed"
echo "  POST-FIX: BROKEN preview=200/50 rows; BROKEN indexing no MAX_STRING_LENGTH err"
echo "           (progresses past changelog -> ideally indexed); WORKING unchanged"
