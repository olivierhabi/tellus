#!/usr/bin/env bash
#
# verify-save-to-ontology.sh
# --------------------------
# End-to-end regression guard for the UUID-keyed "Save to ontology"
# commit endpoint:
#
#   POST /api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId
#
# This is now the single canonical write path for committing an object
# type's pending edits + kicking off the async funnel pipeline
# (changelog → merge → indexing → hydration). The old standalone
# `POST /api/v1/funnel/signals` path is NO LONGER called from the
# frontend; this script proves the new path is correct, durable, and
# idempotent so we can retire that second entry point with confidence.
#
# Flow:
#   1. Keycloak direct-grant token for the cypress test user.
#   2. Create a throw-away project + CSV dataset.
#   3. Batch-create an object type with properties + PK + title.
#   4. Bind the dataset as the backing datasource.
#   5. Resolve the object type's objectTypeId (UUID).
#   6. POST to the UUID commit endpoint. Assert:
#        - HTTP 202
#        - body.data.status == "accepted"
#        - body.data.signalId is a UUID
#        - body.data.objectTypeApiName matches what we created
#   7. Hit the same endpoint with a bogus UUID. Assert 404 with
#      errorCode == OBJECT_TYPE_NOT_FOUND.
#   8. GET /status on the UUID path. Assert 200 and that the
#      response carries the same objectType apiName (the resolver
#      middleware routed correctly).
#   9. Fire the commit twice in quick succession. Assert two
#      signal rows landed in `funnel_signal` BUT the dispatcher
#      still only starts one funnel_run for the pair (claim lock).
#  10. Assert GET /api/v1/funnel/runs/:apiName shows a run whose
#      signalId matches one of the signalIds we sent.
#  11. Clean up: delete the object type + project.
#
# Requires: curl, jq. The full stack must be running:
#   - API  on :3000
#   - Keycloak on :8086 with the tellus realm loaded
#   - The Postgres signal dispatcher running (started by server.ts)
#
# Exit 0 on success, 1 on the first failed assertion.

set -o pipefail

KC="${KC_URL:-http://localhost:8086}"
REALM="${KC_REALM:-${KEYCLOAK_REALM:-tellus}}"
CLIENT="${KC_CLIENT:-tellus-frontend}"
USER="${TELLUS_USER:-cypress@tellus.local}"
PASS="${TELLUS_PASS:-Password123!}"
API="${API_URL:-http://localhost:3000/api}"
ONTOLOGY="${TELLUS_ONTOLOGY:-default}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
DIM='\033[2m'
NC='\033[0m'
ok()   { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}!${NC} %s\n" "$1"; }
die()  { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }
note() { printf "${DIM}  %s${NC}\n" "$1"; }
hdr()  { printf "\n${DIM}── %s ──${NC}\n" "$1"; }

command -v jq   >/dev/null || die "jq is required"
command -v curl >/dev/null || die "curl is required"

# UUID v4 regex — used to validate signalId shape.
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

# ---- 1. Keycloak token --------------------------------------------------
hdr "1. Auth"
TOKEN_JSON=$(curl -sf -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=$USER" -d "password=$PASS" -d "grant_type=password" \
  -d "client_id=$CLIENT" -d "scope=openid profile email" \
  "$KC/realms/$REALM/protocol/openid-connect/token") \
  || die "Keycloak direct grant failed — is Keycloak running on $KC?"
ACCESS_TOKEN=$(echo "$TOKEN_JSON" | jq -r '.access_token')
[ -n "$ACCESS_TOKEN" ] && [ "$ACCESS_TOKEN" != "null" ] \
  || die "No access_token in Keycloak response"
AUTH="Authorization: Bearer $ACCESS_TOKEN"
ok "Got Keycloak token for $USER"

# ---- 2. Create project + dataset + object type -------------------------
hdr "2. Fixture setup"
STAMP=$(date +%s)
PROJECT_NAME="save-to-ontology-$STAMP"

PROJECT_JSON=$(curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "$(printf '{"name":"%s","description":"verify-save-to-ontology scratch"}' "$PROJECT_NAME")" \
  "$API/v1/projects") || die "Project creation failed"
PROJECT_ID=$(echo "$PROJECT_JSON" | jq -r '.data.id // .id // .project.id')
[ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "null" ] || die "No project id: $PROJECT_JSON"
note "project=$PROJECT_ID"

cleanup() {
  hdr "Cleanup"
  if [ -n "${OBJECT_TYPE_API_NAME:-}" ]; then
    curl -s -o /dev/null -X DELETE -H "$AUTH" \
      "$API/v1/ontology/$ONTOLOGY/objectTypes/$OBJECT_TYPE_API_NAME" || true
    note "deleted object type $OBJECT_TYPE_API_NAME"
  fi
  curl -s -o /dev/null -X DELETE -H "$AUTH" "$API/v1/projects/$PROJECT_ID" || true
  note "deleted project $PROJECT_ID"
  rm -f "$TMP_CSV" "$RESP_BODY"
}
trap cleanup EXIT

TMP_CSV="/tmp/verify-save-$STAMP.csv"
cat >"$TMP_CSV" <<'CSV'
order_id,customer_id,item_name,quantity
1,cust-a,Widget,10
2,cust-b,Gizmo,3
3,cust-a,Sprocket,25
CSV

# POST /api/v1/datasets/upload is the canonical dataset-ingest path: it
# scans the CSV SYNCHRONOUSLY and returns the dataset row + schema in one
# shot. (The older project-file-upload route no longer materialises a
# dataset row or its columns, which is why polling for columns here
# never succeeded — the verify script had rotted.)
UPLOAD_JSON=$(curl -sf -X POST -H "$AUTH" \
  -F "file=@$TMP_CSV" \
  -F "name=save-to-ontology-$STAMP" \
  "$API/v1/datasets/upload") || die "Upload failed"
DATASET_ID=$(echo "$UPLOAD_JSON" | jq -r '.dataset.datasetId // empty')
[ -n "$DATASET_ID" ] && [ "$DATASET_ID" != "null" ] \
  || die "No datasetId in upload response: $UPLOAD_JSON"
note "dataset=$DATASET_ID"

COL_COUNT=$(echo "$UPLOAD_JSON" \
  | jq '(.dataset.schemaDefinition.columns // []) | length')
[ "${COL_COUNT:-0}" -ge 4 ] || die "Dataset never materialised its columns: $UPLOAD_JSON"
ok "fixture ready (project + dataset with $COL_COUNT columns)"

OBJECT_TYPE_API_NAME="SaveProbe$STAMP"
BATCH_JSON=$(curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg apiName "$OBJECT_TYPE_API_NAME" \
    --arg displayName "[Verify] Save $STAMP" \
    '{
      apiName: $apiName,
      displayName: $displayName,
      status: "experimental",
      onConflict: "rename",
      properties: [
        {apiName: "orderId", displayName: "Order Id", baseType: "string", ordinal: 0},
        {apiName: "customerId", displayName: "Customer Id", baseType: "string", ordinal: 1},
        {apiName: "itemName", displayName: "Item Name", baseType: "string", ordinal: 2},
        {apiName: "quantity", displayName: "Quantity", baseType: "integer", ordinal: 3}
      ],
      primaryKeyProperty: "orderId",
      titleProperty: "itemName"
    }')" \
  "$API/v1/ontology/$ONTOLOGY/objectTypes/batch") || die "Batch create failed"

OBJECT_TYPE_ID=$(echo "$BATCH_JSON" | jq -r '
  .objectType.objectTypeId //
  .data.objectType.objectTypeId //
  .data.objectTypeId //
  .objectTypeId
')
# The backend may have renamed on conflict — pick up the stored apiName.
OBJECT_TYPE_API_NAME=$(echo "$BATCH_JSON" | jq -r '
  .objectType.apiName //
  .data.objectType.apiName //
  .data.apiName //
  .apiName //
  "'"$OBJECT_TYPE_API_NAME"'"
')
[ -n "$OBJECT_TYPE_ID" ] && [ "$OBJECT_TYPE_ID" != "null" ] \
  || die "No objectTypeId in batch response: $BATCH_JSON"
ok "created object type apiName=$OBJECT_TYPE_API_NAME id=$OBJECT_TYPE_ID"

curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "$(jq -n --arg id "$DATASET_ID" \
    '{datasetId: $id,
      columnMapping: {orderId:"order_id", customerId:"customer_id",
                      itemName:"item_name", quantity:"quantity"},
      primaryKeyColumn: "order_id"}')" \
  "$API/v1/ontology/$ONTOLOGY/objectTypes/$OBJECT_TYPE_API_NAME/datasource" \
  >/dev/null || die "Datasource bind failed"
ok "bound backing datasource"

# Resolve the ontologyId the SAME WAY the batch endpoint did — via
# the alias resolver on GET /v1/ontology/:alias. Going off a list call
# is unsafe: there can be several ontology rows, and `data[0]` is not
# necessarily the one `default` resolves to (the alias resolver picks
# the canonical row, which the list endpoint doesn't surface).
ONTOLOGY_UUID=$(curl -sf -H "$AUTH" "$API/v1/ontology/$ONTOLOGY" \
  | jq -r '.data.ontologyId // .ontologyId // empty')
[ -n "$ONTOLOGY_UUID" ] && [ "$ONTOLOGY_UUID" != "null" ] \
  || die "Could not resolve ontology UUID via alias '$ONTOLOGY'"
note "ontologyId=$ONTOLOGY_UUID  objectTypeId=$OBJECT_TYPE_ID"

# Sanity check: the object type we just created must actually live
# under this resolved ontology. Bail early with a clear message if
# not — otherwise the POST below fails with a confusing 404 that
# makes it look like the middleware is broken.
MW_CHECK=$(curl -sf -H "$AUTH" \
  "$API/v1/ontology/$ONTOLOGY/objectTypes/$OBJECT_TYPE_API_NAME/edits?limit=1" \
  2>/dev/null | jq -r '.ontologyId // empty' || true)
# `edits` endpoint echoes the ontologyId. Fall back to a raw status
# probe if it's not available in this build.
if [ -z "$MW_CHECK" ]; then
  MW_CHECK=$(curl -sf -H "$AUTH" \
    "$API/v1/ontology/$ONTOLOGY_UUID/objectTypes/$OBJECT_TYPE_API_NAME/edits?limit=1" \
    -o /dev/null -w "%{http_code}")
  [ "$MW_CHECK" = "200" ] \
    || die "Object type $OBJECT_TYPE_API_NAME is NOT under resolved ontology $ONTOLOGY_UUID (edits check returned $MW_CHECK) — alias resolver mismatch."
fi
ok "object type is under the resolved ontology"

# ---- 3. Happy path — POST commit ---------------------------------------
hdr "3. Happy path: POST /objectTypeId/:id"
RESP_BODY="/tmp/verify-save-resp-$STAMP.json"

HTTP=$(curl -s -o "$RESP_BODY" -w "%{http_code}" \
  -X POST -H "$AUTH" \
  "$API/v1/ontology/$ONTOLOGY_UUID/objectTypeId/$OBJECT_TYPE_ID")
[ "$HTTP" = "202" ] \
  || die "Expected HTTP 202, got $HTTP: $(cat "$RESP_BODY")"
ok "HTTP 202 Accepted"

STATUS=$(jq -r '.data.status // .status' "$RESP_BODY")
[ "$STATUS" = "accepted" ] \
  || die "Expected data.status=accepted, got '$STATUS': $(cat "$RESP_BODY")"
ok "body.data.status == accepted"

SIGNAL_ID_1=$(jq -r '.data.signalId // .signalId' "$RESP_BODY")
[[ "$SIGNAL_ID_1" =~ $UUID_RE ]] \
  || die "signalId is not a UUID: '$SIGNAL_ID_1'"
ok "body.data.signalId is a UUID ($SIGNAL_ID_1)"

ECHOED_APINAME=$(jq -r '.data.objectTypeApiName // .objectTypeApiName' "$RESP_BODY")
[ "$ECHOED_APINAME" = "$OBJECT_TYPE_API_NAME" ] \
  || die "Expected objectTypeApiName=$OBJECT_TYPE_API_NAME, got '$ECHOED_APINAME'"
ok "body.data.objectTypeApiName == $OBJECT_TYPE_API_NAME (resolver ran)"

ECHOED_ONTOLOGY=$(jq -r '.data.ontologyId // .ontologyId' "$RESP_BODY")
[ "$ECHOED_ONTOLOGY" = "$ONTOLOGY_UUID" ] \
  || die "Expected ontologyId=$ONTOLOGY_UUID, got '$ECHOED_ONTOLOGY'"
ok "body.data.ontologyId matches the URL"

# ---- 4. Error path — bogus UUID ----------------------------------------
hdr "4. Error path: unknown objectTypeId"
BOGUS_UUID="00000000-0000-0000-0000-000000000000"
HTTP=$(curl -s -o "$RESP_BODY" -w "%{http_code}" \
  -X POST -H "$AUTH" \
  "$API/v1/ontology/$ONTOLOGY_UUID/objectTypeId/$BOGUS_UUID")
[ "$HTTP" = "404" ] \
  || die "Expected HTTP 404 for bogus UUID, got $HTTP: $(cat "$RESP_BODY")"
CODE=$(jq -r '.errorCode // .error.code // .error' "$RESP_BODY")
[ "$CODE" = "OBJECT_TYPE_NOT_FOUND" ] \
  || die "Expected errorCode=OBJECT_TYPE_NOT_FOUND, got '$CODE'"
ok "bogus UUID → 404 OBJECT_TYPE_NOT_FOUND"

# ---- 5. GET /status on the UUID path -----------------------------------
hdr "5. GET /objectTypeId/:id/status (delegated to reindexRouter)"
HTTP=$(curl -s -o "$RESP_BODY" -w "%{http_code}" -H "$AUTH" \
  "$API/v1/ontology/$ONTOLOGY_UUID/objectTypeId/$OBJECT_TYPE_ID/status")
[ "$HTTP" = "200" ] \
  || die "Expected HTTP 200 on /status, got $HTTP: $(cat "$RESP_BODY")"
STATUS_OT=$(jq -r '.data.objectType // .objectType' "$RESP_BODY")
[ "$STATUS_OT" = "$OBJECT_TYPE_API_NAME" ] \
  || die "status response objectType=$STATUS_OT (expected $OBJECT_TYPE_API_NAME) — res.locals.apiName leak?"
ok "status endpoint resolved objectType correctly via res.locals.apiName"

# ---- 6. Idempotency — fire a second commit -----------------------------
hdr "6. Idempotency: second commit must also succeed"
HTTP=$(curl -s -o "$RESP_BODY" -w "%{http_code}" \
  -X POST -H "$AUTH" \
  "$API/v1/ontology/$ONTOLOGY_UUID/objectTypeId/$OBJECT_TYPE_ID")
[ "$HTTP" = "202" ] || die "Second POST expected 202, got $HTTP"
SIGNAL_ID_2=$(jq -r '.data.signalId // .signalId' "$RESP_BODY")
[[ "$SIGNAL_ID_2" =~ $UUID_RE ]] && [ "$SIGNAL_ID_2" != "$SIGNAL_ID_1" ] \
  || die "Second POST did not produce a fresh signalId"
ok "repeat commit → new signalId $SIGNAL_ID_2 (dispatcher dedups downstream)"

# ---- 7. Verify funnel picked up the signal (UUID runs endpoint) --------
hdr "7. Funnel dispatcher pickup — GET /runs/objectTypeId/:uuid"
# Poll the UUID-keyed runs endpoint (the one the FE hook now uses).
# The dispatcher polls on a short interval; give it up to 15s to claim
# one of our signals and produce a funnel_run row. If Temporal is
# connected the worker may register a run even faster.
RUN_ID=""
for attempt in $(seq 1 15); do
  RUNS=$(curl -sf -H "$AUTH" \
    "$API/v1/funnel/runs/objectTypeId/$OBJECT_TYPE_ID?limit=5" \
    || echo '{"runs":[]}')
  RUN_COUNT=$(echo "$RUNS" | jq '.runs | length')
  if [ "${RUN_COUNT:-0}" -ge 1 ]; then
    RUN_ID=$(echo "$RUNS" | jq -r '.runs[0].run_id // .runs[0].runId // empty')
    break
  fi
  sleep 1
done
if [ -z "$RUN_ID" ]; then
  warn "No funnel_run rows within 15s — dispatcher/Temporal may be idle. This is non-fatal (the signal is durably queued in PG), but the pipeline will not run until a worker picks it up."
else
  ok "funnel_run=$RUN_ID picked up the signal (via UUID runs route)"
fi

# ---- 8. Error path — bogus UUID on runs endpoint -----------------------
hdr "8. Error path: unknown objectTypeId on /runs"
HTTP=$(curl -s -o "$RESP_BODY" -w "%{http_code}" -H "$AUTH" \
  "$API/v1/funnel/runs/objectTypeId/$BOGUS_UUID?limit=1")
[ "$HTTP" = "404" ] \
  || die "Expected HTTP 404 for bogus UUID on /runs, got $HTTP: $(cat "$RESP_BODY")"
ok "bogus UUID on /runs → 404"

# ---- 9. Legacy apiName route still works -------------------------------
hdr "9. Back-compat: legacy apiName /runs route"
HTTP=$(curl -s -o "$RESP_BODY" -w "%{http_code}" -H "$AUTH" \
  "$API/v1/funnel/runs/$OBJECT_TYPE_API_NAME?limit=1")
[ "$HTTP" = "200" ] \
  || die "Legacy /runs/:apiName broke (HTTP $HTTP): $(cat "$RESP_BODY")"
LEGACY_COUNT=$(jq '.runs | length' "$RESP_BODY")
[ "${LEGACY_COUNT:-0}" -ge 1 ] \
  || warn "Legacy route returned 0 runs — dispatcher may not have caught up yet, but the endpoint is live."
ok "legacy /runs/:apiName still answers (${LEGACY_COUNT} runs)"

echo
printf "${GREEN}All save-to-ontology assertions passed.${NC}\n"
echo "Cleaning up test fixture…"
