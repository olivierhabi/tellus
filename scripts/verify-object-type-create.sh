#!/usr/bin/env bash
#
# verify-object-type-create.sh
# ----------------------------
# Reproduces the "Create a new object type" wizard end-to-end against the
# real stack and asserts the resulting object type actually has properties,
# a primary key, a title property, and a bound backing datasource.
#
# This script exists to pin the contract between tellus-fe's
# `handleCreateObjectType` dialog submit handler and the tellus backend's
# `POST /v2/ontologies/:id/objectTypes/batch` + `POST .../datasource`
# endpoints. Running it should surface any regression in either direction
# (missing fields, wrong baseType enum, camelCase mismatches, dataset-id
# binding mix-ups).
#
# Flow:
#   1. Get a Keycloak access token for cypress@tellus.local.
#   2. Create a fresh project so we can upload a dataset under it.
#   3. Upload a CSV → new foundry_datasets row with columns materialised.
#   4. GET /datasets/:id → verify column schema is populated.
#   5. POST /v2/ontologies/default/objectTypes/batch with:
#        - apiName: PascalCase derived from a timestamp
#        - properties: one per CSV column, camelCase apiName, baseType
#          mapped from Postgres column_type
#        - primaryKeyProperty: first property's apiName
#        - titleProperty: second property's apiName
#   6. POST .../datasource with columnMapping {propApiName -> source}.
#   7. GET the object type and assert properties.length > 0, primary key +
#      title match what we sent, backingDatasource is present.
#   8. Clean up: delete the object type + project.
#
# Requires: curl, jq. Stack must be running at API_URL with the
# bootstrap-keycloak.sh realm loaded.
#
# Exit 0 on success, 1 on the first failed assertion.

set -o pipefail

KC="${KC_URL:-http://localhost:8086}"
REALM="${KC_REALM:-tellus}"
CLIENT="${KC_CLIENT:-tellus-frontend}"
USER="${TELLUS_USER:-cypress@tellus.local}"
PASS="${TELLUS_PASS:-Password123!}"
API="${API_URL:-http://localhost:3000/api}"
ONTOLOGY="${TELLUS_ONTOLOGY:-default}"

GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m'
ok()  { printf "${GREEN}✓${NC} %s\n" "$1"; }
die() { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }
note(){ printf "${DIM}  %s${NC}\n" "$1"; }

command -v jq   >/dev/null || die "jq is required"
command -v curl >/dev/null || die "curl is required"

# ---- 1. Keycloak token --------------------------------------------------
TOKEN_JSON=$(curl -sf -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=$USER" -d "password=$PASS" -d "grant_type=password" \
  -d "client_id=$CLIENT" -d "scope=openid profile email" \
  "$KC/realms/$REALM/protocol/openid-connect/token") \
  || die "Keycloak direct grant failed"
ACCESS_TOKEN=$(echo "$TOKEN_JSON" | jq -r '.access_token')
[ -n "$ACCESS_TOKEN" ] && [ "$ACCESS_TOKEN" != "null" ] || die "No access_token in Keycloak response"
ok "Got Keycloak token for $USER"
AUTH="Authorization: Bearer $ACCESS_TOKEN"

# ---- 2. Create project ---------------------------------------------------
STAMP=$(date +%s)
PROJECT_NAME="ot-create-check-$STAMP"
PROJECT_JSON=$(curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "$(printf '{"name":"%s","description":"verify-object-type-create.sh scratch"}' "$PROJECT_NAME")" \
  "$API/projects") || die "Project creation failed"
PROJECT_ID=$(echo "$PROJECT_JSON" | jq -r '.data.id // .id // .project.id')
[ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "null" ] || die "No project id: $PROJECT_JSON"
ok "Created project $PROJECT_ID"

cleanup() {
  if [ -n "${OBJECT_TYPE_API_NAME:-}" ]; then
    curl -s -o /dev/null -X DELETE -H "$AUTH" \
      "$API/v2/ontologies/$ONTOLOGY/objectTypes/$OBJECT_TYPE_API_NAME" || true
  fi
  curl -s -o /dev/null -X DELETE -H "$AUTH" "$API/projects/$PROJECT_ID" || true
  rm -f "$TMP_CSV" "$SCHEMA_JSON"
}
trap cleanup EXIT

# ---- 3. Upload a CSV so a real dataset materialises ---------------------
TMP_CSV="/tmp/verify-ot-create-$STAMP.csv"
cat >"$TMP_CSV" <<'CSV'
order_id,customer_id,item_name,quantity,unit_price,order_date,is_paid
1,cust-a,Widget,10,4.25,2026-01-15,true
2,cust-b,Gizmo,3,17.50,2026-02-02,false
3,cust-a,Sprocket,25,1.10,2026-02-28,true
CSV

UPLOAD_JSON=$(curl -sf -X POST -H "$AUTH" \
  -F "files=@$TMP_CSV" \
  "$API/projects/$PROJECT_ID/upload") \
  || die "Upload failed"
DATASET_ID=$(echo "$UPLOAD_JSON" | jq -r '
  .data[0].dataset.id //
  .data[0].id //
  .data[0].datasetId //
  .data.datasets[0].id //
  .data.dataset.id //
  .data.id //
  empty
')
[ -n "$DATASET_ID" ] && [ "$DATASET_ID" != "null" ] \
  || die "No dataset id in upload response: $UPLOAD_JSON"
ok "Uploaded CSV → dataset $DATASET_ID"

# ---- 4. Wait for the async scan to populate columns --------------------
# Freshly uploaded datasets enter `status: pending` and have no columns
# until the backend's scan worker parses the CSV. Poll for up to 60s.
SCHEMA_JSON="/tmp/verify-ot-create-schema-$STAMP.json"
COLUMN_COUNT=0
for attempt in $(seq 1 30); do
  HTTP=$(curl -s -o "$SCHEMA_JSON" -w "%{http_code}" -H "$AUTH" "$API/datasets/$DATASET_ID")
  [ "$HTTP" = "200" ] || die "GET /datasets/$DATASET_ID → $HTTP: $(cat "$SCHEMA_JSON")"
  COLUMN_COUNT=$(jq '(.data.columns // .columns // .data.schema_info.columns // []) | length' "$SCHEMA_JSON")
  if [ -n "$COLUMN_COUNT" ] && [ "$COLUMN_COUNT" -ge 1 ]; then
    break
  fi
  note "columns still empty (attempt $attempt/30), sleeping 2s…"
  sleep 2
done
if [ -z "$COLUMN_COUNT" ] || [ "$COLUMN_COUNT" -lt 1 ]; then
  die "Dataset $DATASET_ID still has no columns after 60s: $(cat "$SCHEMA_JSON")"
fi
ok "Dataset has $COLUMN_COUNT columns"

# Build a jq-friendly camelCase helper (order_due_date → orderDueDate).
PROPS_JSON=$(jq '
  def cc: . as $raw
    | [ $raw | split("[^A-Za-z0-9]+"; "g") | map(select(length > 0)) | to_entries[]
        | if .key == 0 then .value | ascii_downcase
          else (.value | ascii_downcase | .[0:1] | ascii_upcase) + (.value | ascii_downcase | .[1:])
          end ] | join("");
  def baseTypeFor($t):
    ($t | ascii_downcase) as $lt
    | if ($lt | contains("boolean") or . == "bool") then "boolean"
      elif ($lt | contains("bigint") or . == "int8")  then "long"
      elif ($lt | contains("smallint") or . == "int2") then "integer"
      elif ($lt == "integer" or $lt == "int" or $lt == "int4" or ($lt | contains("serial"))) then "integer"
      elif ($lt | contains("double")) then "double"
      elif ($lt | contains("real") or . == "float4") then "float"
      elif ($lt | contains("numeric") or ($lt | contains("decimal"))) then "decimal"
      elif ($lt | contains("timestamp")) then "timestamp"
      elif ($lt | contains("date")) then "date"
      else "string" end;
  (.data.columns // .columns // .data.schema_info.columns) as $cols
  | [ $cols[] | {
      apiName: (.name | cc),
      displayName: .name,
      baseType: baseTypeFor(.type),
      source: .name
    } ]
' "$SCHEMA_JSON")

note "Derived property list:"
echo "$PROPS_JSON" | jq -c '.[] | {apiName, baseType}'

PK_API_NAME=$(echo "$PROPS_JSON" | jq -r '.[0].apiName')
PK_COLUMN=$(echo "$PROPS_JSON" | jq -r '.[0].source')
TITLE_API_NAME=$(echo "$PROPS_JSON" | jq -r '.[1].apiName // .[0].apiName')
[ -n "$PK_API_NAME" ] && [ "$PK_API_NAME" != "null" ] \
  || die "Could not derive primary key apiName"

# ---- 5. Batch-create the object type with properties ------------------
OBJECT_TYPE_API_NAME="VerifyOrder$STAMP"
BATCH_BODY=$(jq -n \
  --arg apiName "$OBJECT_TYPE_API_NAME" \
  --arg displayName "[Verify] Order $STAMP" \
  --argjson properties "$(echo "$PROPS_JSON" | jq 'map(del(.source))')" \
  --arg pk "$PK_API_NAME" \
  --arg title "$TITLE_API_NAME" \
  '{apiName: $apiName, displayName: $displayName, description: "verify-object-type-create.sh",
    properties: $properties, primaryKeyProperty: $pk, titleProperty: $title}')

BATCH_RESPONSE_FILE="/tmp/verify-ot-create-batch-$STAMP.json"
BATCH_HTTP=$(curl -s -o "$BATCH_RESPONSE_FILE" -w "%{http_code}" \
  -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "$BATCH_BODY" \
  "$API/v2/ontologies/$ONTOLOGY/objectTypes/batch")
if [ "$BATCH_HTTP" != "201" ] && [ "$BATCH_HTTP" != "200" ]; then
  die "Batch create failed ($BATCH_HTTP): $(cat "$BATCH_RESPONSE_FILE")"
fi
ok "Batch-created object type $OBJECT_TYPE_API_NAME (HTTP $BATCH_HTTP)"

# ---- 6. Bind the backing datasource -----------------------------------
COLUMN_MAPPING=$(echo "$PROPS_JSON" | jq 'map({key: .apiName, value: .source}) | from_entries')
DS_BODY=$(jq -n \
  --arg foundryDatasetId "$DATASET_ID" \
  --arg primaryKeyColumn "$PK_COLUMN" \
  --argjson columnMapping "$COLUMN_MAPPING" \
  '{foundryDatasetId: $foundryDatasetId, columnMapping: $columnMapping, primaryKeyColumn: $primaryKeyColumn}')

DS_RESPONSE_FILE="/tmp/verify-ot-create-ds-$STAMP.json"
DS_HTTP=$(curl -s -o "$DS_RESPONSE_FILE" -w "%{http_code}" \
  -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "$DS_BODY" \
  "$API/v2/ontologies/$ONTOLOGY/objectTypes/$OBJECT_TYPE_API_NAME/datasource")
if [ "$DS_HTTP" != "201" ] && [ "$DS_HTTP" != "200" ]; then
  die "Datasource binding failed ($DS_HTTP): $(cat "$DS_RESPONSE_FILE")"
fi
ok "Bound backing datasource (HTTP $DS_HTTP)"

# ---- 7. Fetch the object type and assert shape ------------------------
OT_FILE="/tmp/verify-ot-create-get-$STAMP.json"
OT_HTTP=$(curl -s -o "$OT_FILE" -w "%{http_code}" -H "$AUTH" \
  "$API/v2/ontologies/$ONTOLOGY/objectTypes/$OBJECT_TYPE_API_NAME")
[ "$OT_HTTP" = "200" ] || die "GET object type failed ($OT_HTTP): $(cat "$OT_FILE")"

# Response might be flat or wrapped under { objectType: ... }
OT=$(jq '(.data.objectType // .objectType // .data // .)' "$OT_FILE")

PROPS_RETURNED=$(echo "$OT" | jq '(.properties // {}) | length')
if [ "$PROPS_RETURNED" -lt 1 ]; then
  die "Object type came back with no properties: $(cat "$OT_FILE")"
fi
ok "Object type has $PROPS_RETURNED properties persisted"

GOT_PK=$(echo "$OT" | jq -r '.primaryKey // .primaryKeyProperty // ""')
if [ "$GOT_PK" != "$PK_API_NAME" ]; then
  die "Expected primaryKey=$PK_API_NAME, got='$GOT_PK'"
fi
ok "primaryKey matches ($GOT_PK)"

GOT_TITLE=$(echo "$OT" | jq -r '.titleProperty // ""')
if [ "$GOT_TITLE" != "$TITLE_API_NAME" ]; then
  die "Expected titleProperty=$TITLE_API_NAME, got='$GOT_TITLE'"
fi
ok "titleProperty matches ($GOT_TITLE)"

BACKING=$(echo "$OT" | jq -r '.backingDatasource // .backing_datasource // empty')
if [ -z "$BACKING" ] || [ "$BACKING" = "null" ]; then
  die "Object type has no backingDatasource"
fi
ok "backingDatasource is present"

# ---- 7a. Funnel indexing pipeline (spec §1.7 — changelog → merge → index → hydration)
# Kick off a reindex via the real pipeline and assert the response
# reports `status: "completed"` with non-zero objects indexed. This
# proves the foundry-bridge read path (MinIO → csv-parse → convertValue
# → OpenSearch bulk) works end-to-end, and the four-stage tracker
# cleared itself on success.
REINDEX_HTTP=$(curl -s -o /tmp/verify-ot-reindex-$STAMP.json -w "%{http_code}" \
  -X POST -H "$AUTH" \
  "$API/v2/ontology/$ONTOLOGY/objectTypes/$OBJECT_TYPE_API_NAME/reindex?force=true")
if [ "$REINDEX_HTTP" != "200" ] && [ "$REINDEX_HTTP" != "201" ]; then
  die "POST /reindex failed ($REINDEX_HTTP): $(cat /tmp/verify-ot-reindex-$STAMP.json)"
fi
REINDEX_STATUS=$(jq -r '.status // .data.status // empty' /tmp/verify-ot-reindex-$STAMP.json)
if [ "$REINDEX_STATUS" != "completed" ] && [ "$REINDEX_STATUS" != "no_changes" ]; then
  die "reindex returned unexpected status '$REINDEX_STATUS': $(cat /tmp/verify-ot-reindex-$STAMP.json)"
fi
OBJECTS_INDEXED=$(jq -r '.result.totalObjectsIndexed // .data.result.totalObjectsIndexed // 0' /tmp/verify-ot-reindex-$STAMP.json)
if [ "$OBJECTS_INDEXED" -lt 1 ]; then
  die "reindex reported 0 objects indexed — foundry bridge probably never read the MinIO file"
fi
ok "Reindex pipeline completed ($OBJECTS_INDEXED objects indexed through the funnel)"

# Verify the per-stage tracker settled back to idle + success (no
# stage is still marked running after the pipeline completed).
REINDEX_GET_STATUS_HTTP=$(curl -s -o /tmp/verify-ot-reindex-status-$STAMP.json -w "%{http_code}" \
  -H "$AUTH" \
  "$API/v2/ontology/$ONTOLOGY/objectTypes/$OBJECT_TYPE_API_NAME/reindex/status")
[ "$REINDEX_GET_STATUS_HTTP" = "200" ] \
  || die "GET /reindex/status failed ($REINDEX_GET_STATUS_HTTP)"
PIPELINE_STATUS=$(jq -r '.pipelineState.status // .data.pipelineState.status // empty' /tmp/verify-ot-reindex-status-$STAMP.json)
CURRENT_STAGE=$(jq -r '.pipelineState.currentStage // .data.pipelineState.currentStage // empty' /tmp/verify-ot-reindex-status-$STAMP.json)
if [ "$PIPELINE_STATUS" != "success" ]; then
  die "pipelineState.status = '$PIPELINE_STATUS' (expected success)"
fi
if [ -n "$CURRENT_STAGE" ] && [ "$CURRENT_STAGE" != "null" ]; then
  die "pipelineState.currentStage should be null on completion, got '$CURRENT_STAGE'"
fi
ok "Funnel pipeline tracker settled (status=success, currentStage=null)"

FUNNEL_STATE=$(jq -r '.funnelState.status // .data.funnelState.status // empty' /tmp/verify-ot-reindex-status-$STAMP.json)
if [ "$FUNNEL_STATE" != "indexed" ]; then
  die "funnelState.status = '$FUNNEL_STATE' (expected indexed)"
fi
ok "funnel_state.status = indexed"

# The dataset preview bottom panel in tellus-fe relies on
# `backingDatasource.datasetId` coming back from the API. Parse it out
# (either from the legacy FK or the synthetic `#foundry-dataset:<id>`
# tag in file_path) and confirm it matches the dataset we bound.
BACKING_DATASET_ID=$(echo "$OT" | jq -r '.backingDatasource.datasetId // .backing_datasource.datasetId // empty')
if [ "$BACKING_DATASET_ID" != "$DATASET_ID" ]; then
  die "backingDatasource.datasetId mismatch: got '$BACKING_DATASET_ID', expected '$DATASET_ID'"
fi
ok "backingDatasource.datasetId matches foundry dataset ($BACKING_DATASET_ID)"

# Smoke-test the preview endpoint the bottom panel hits. Anything
# other than 200 breaks the first-load "show me the data" experience.
PREVIEW_HTTP=$(curl -s -o /tmp/verify-ot-preview-$STAMP.json -w "%{http_code}" \
  -H "$AUTH" "$API/datasets/$DATASET_ID/preview?rows=5")
[ "$PREVIEW_HTTP" = "200" ] \
  || die "Dataset preview failed ($PREVIEW_HTTP): $(cat /tmp/verify-ot-preview-$STAMP.json)"
PREVIEW_ROW_COUNT=$(jq '(.data.rows // .rows // []) | length' /tmp/verify-ot-preview-$STAMP.json)
if [ "$PREVIEW_ROW_COUNT" -lt 1 ]; then
  die "Dataset preview returned 0 rows — bottom panel will be empty"
fi
ok "Dataset preview returned $PREVIEW_ROW_COUNT rows"

# ---- 8. Curatorial metadata round-trip --------------------------------
# Assert that every new field on the overview card (plural name,
# aliases, point of contact, contributors, visibility, RID, and the
# edits flag) travels from a PUT body to a GET response intact.
METADATA_BODY=$(jq -n \
  --arg pluralName "[Verify] Orders" \
  --argjson aliases '["order","purchase"]' \
  --arg pointOfContact "alice@example.com" \
  --argjson contributors '["bob@example.com","carol@example.com"]' \
  --arg visibility "prominent" \
  '{pluralName: $pluralName, aliases: $aliases, pointOfContact: $pointOfContact,
    contributors: $contributors, visibility: $visibility, editsViaActionsOnly: false}')

MD_HTTP=$(curl -s -o /tmp/verify-ot-md-put-$STAMP.json -w "%{http_code}" \
  -X PUT -H "$AUTH" -H "Content-Type: application/json" \
  -d "$METADATA_BODY" \
  "$API/v2/ontologies/$ONTOLOGY/objectTypes/$OBJECT_TYPE_API_NAME")
[ "$MD_HTTP" = "200" ] \
  || die "PUT metadata failed ($MD_HTTP): $(cat /tmp/verify-ot-md-put-$STAMP.json)"
ok "PUT metadata returned 200"

# Re-GET and check each field was persisted.
OT_HTTP2=$(curl -s -o "$OT_FILE" -w "%{http_code}" -H "$AUTH" \
  "$API/v2/ontologies/$ONTOLOGY/objectTypes/$OBJECT_TYPE_API_NAME")
[ "$OT_HTTP2" = "200" ] || die "GET after PUT failed ($OT_HTTP2)"
OT=$(jq '(.data.objectType // .objectType // .data // .)' "$OT_FILE")

[ "$(echo "$OT" | jq -r '.pluralName')" = "[Verify] Orders" ] \
  || die "pluralName did not round-trip: $(echo "$OT" | jq -c '.pluralName')"
ok "pluralName round-tripped"

[ "$(echo "$OT" | jq -c '.aliases')" = '["order","purchase"]' ] \
  || die "aliases did not round-trip: $(echo "$OT" | jq -c '.aliases')"
ok "aliases round-tripped"

[ "$(echo "$OT" | jq -r '.pointOfContact')" = "alice@example.com" ] \
  || die "pointOfContact did not round-trip"
ok "pointOfContact round-tripped"

[ "$(echo "$OT" | jq -c '.contributors')" = '["bob@example.com","carol@example.com"]' ] \
  || die "contributors did not round-trip: $(echo "$OT" | jq -c '.contributors')"
ok "contributors round-tripped"

[ "$(echo "$OT" | jq -r '.visibility')" = "prominent" ] \
  || die "visibility did not round-trip"
ok "visibility round-tripped"

[ "$(echo "$OT" | jq -r '.editsViaActionsOnly')" = "false" ] \
  || die "editsViaActionsOnly did not round-trip"
ok "editsViaActionsOnly round-tripped"

RID_VALUE=$(echo "$OT" | jq -r '.rid')
case "$RID_VALUE" in
  ri.ontology.*.object-type.*) ok "rid is derived ($RID_VALUE)";;
  *) die "rid has unexpected shape: $RID_VALUE";;
esac

DISPLAY_ID=$(echo "$OT" | jq -r '.displayId')
# VerifyOrder1776284438 → verify-order-1776284438. Split on case +
# digit boundaries, lowercase, join with dashes.
EXPECTED_DISPLAY_ID="verify-order-$STAMP"
if [ "$DISPLAY_ID" != "$EXPECTED_DISPLAY_ID" ]; then
  die "displayId mismatch: got '$DISPLAY_ID', expected '$EXPECTED_DISPLAY_ID'"
fi
ok "displayId derived correctly ($DISPLAY_ID)"

# ---- 9. API name uniqueness — duplicate rename must 409 ---------------
# Create a sibling object type we'll collide with.
SIBLING_API_NAME="VerifySibling$STAMP"
SIBLING_BODY=$(jq -n \
  --arg apiName "$SIBLING_API_NAME" \
  --arg displayName "[Verify] Sibling $STAMP" \
  --argjson properties "$(echo "$PROPS_JSON" | jq 'map(del(.source))')" \
  --arg pk "$PK_API_NAME" \
  '{apiName: $apiName, displayName: $displayName, properties: $properties, primaryKeyProperty: $pk}')
SIBLING_HTTP=$(curl -s -o /tmp/verify-ot-sibling-$STAMP.json -w "%{http_code}" \
  -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "$SIBLING_BODY" \
  "$API/v2/ontologies/$ONTOLOGY/objectTypes/batch")
[ "$SIBLING_HTTP" = "201" ] || die "Sibling create failed ($SIBLING_HTTP)"
ok "Created sibling $SIBLING_API_NAME"

cleanup_sibling() {
  curl -s -o /dev/null -X DELETE -H "$AUTH" \
    "$API/v2/ontologies/$ONTOLOGY/objectTypes/$SIBLING_API_NAME" || true
}
trap 'cleanup; cleanup_sibling' EXIT

# Attempt to rename OBJECT_TYPE_API_NAME → SIBLING_API_NAME. Must 409.
DUP_BODY=$(jq -n --arg apiName "$SIBLING_API_NAME" '{apiName: $apiName}')
DUP_HTTP=$(curl -s -o /tmp/verify-ot-dup-$STAMP.json -w "%{http_code}" \
  -X PUT -H "$AUTH" -H "Content-Type: application/json" \
  -d "$DUP_BODY" \
  "$API/v2/ontologies/$ONTOLOGY/objectTypes/$OBJECT_TYPE_API_NAME")
if [ "$DUP_HTTP" != "409" ]; then
  die "Expected duplicate rename to return 409, got $DUP_HTTP: $(cat /tmp/verify-ot-dup-$STAMP.json)"
fi
DUP_CODE=$(jq -r '.error.code // .errorCode' /tmp/verify-ot-dup-$STAMP.json)
if [ "$DUP_CODE" != "DUPLICATE_API_NAME" ]; then
  die "Expected errorCode=DUPLICATE_API_NAME, got $DUP_CODE"
fi
ok "Duplicate rename correctly rejected with 409 DUPLICATE_API_NAME"

# Rename to a fresh unique name and assert the record now lives there.
NEW_API_NAME="VerifyOrderRenamed$STAMP"
RENAME_HTTP=$(curl -s -o /tmp/verify-ot-rename-$STAMP.json -w "%{http_code}" \
  -X PUT -H "$AUTH" -H "Content-Type: application/json" \
  -d "$(jq -n --arg apiName "$NEW_API_NAME" '{apiName: $apiName}')" \
  "$API/v2/ontologies/$ONTOLOGY/objectTypes/$OBJECT_TYPE_API_NAME")
[ "$RENAME_HTTP" = "200" ] \
  || die "Unique rename failed ($RENAME_HTTP): $(cat /tmp/verify-ot-rename-$STAMP.json)"
ok "Unique rename returned 200"

# Old apiName must now 404.
OLD_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" \
  "$API/v2/ontologies/$ONTOLOGY/objectTypes/$OBJECT_TYPE_API_NAME")
[ "$OLD_HTTP" = "404" ] \
  || die "Old apiName still resolves after rename (HTTP $OLD_HTTP)"
ok "Old apiName 404s after rename"

# New apiName must resolve and carry the preserved metadata.
OT_HTTP3=$(curl -s -o "$OT_FILE" -w "%{http_code}" -H "$AUTH" \
  "$API/v2/ontologies/$ONTOLOGY/objectTypes/$NEW_API_NAME")
[ "$OT_HTTP3" = "200" ] || die "GET new apiName failed ($OT_HTTP3)"
ok "New apiName resolves"

# Re-point the cleanup trap so we delete the renamed record.
OBJECT_TYPE_API_NAME="$NEW_API_NAME"

# ---- 9b. onConflict=rename flow ---------------------------------------
# Create a second object type with the same apiName as an existing one
# and `onConflict: rename`. Must succeed, must return a suffixed
# apiName, and must round-trip `requestedApiName` so the frontend
# overview can surface the conflict.
CONFLICT_TARGET_API_NAME="$NEW_API_NAME"   # Already exists from the rename step.
CONFLICT_BODY=$(jq -n \
  --arg apiName "$CONFLICT_TARGET_API_NAME" \
  --arg displayName "[Verify] Conflict $STAMP" \
  --argjson properties "$(echo "$PROPS_JSON" | jq 'map(del(.source))')" \
  --arg pk "$PK_API_NAME" \
  '{apiName: $apiName, displayName: $displayName, onConflict: "rename",
    properties: $properties, primaryKeyProperty: $pk}')

CONFLICT_HTTP=$(curl -s -o /tmp/verify-ot-conflict-$STAMP.json -w "%{http_code}" \
  -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "$CONFLICT_BODY" \
  "$API/v2/ontologies/$ONTOLOGY/objectTypes/batch")
[ "$CONFLICT_HTTP" = "201" ] \
  || die "onConflict=rename failed ($CONFLICT_HTTP): $(cat /tmp/verify-ot-conflict-$STAMP.json)"

CONFLICT_RESOLVED_API_NAME=$(jq -r '.objectType.apiName' /tmp/verify-ot-conflict-$STAMP.json)
CONFLICT_REQUESTED=$(jq -r '.objectType.requestedApiName' /tmp/verify-ot-conflict-$STAMP.json)

if [ "$CONFLICT_RESOLVED_API_NAME" = "$CONFLICT_TARGET_API_NAME" ]; then
  die "Expected apiName to be renamed; got same value '$CONFLICT_RESOLVED_API_NAME'"
fi
if [ "$CONFLICT_REQUESTED" != "$CONFLICT_TARGET_API_NAME" ]; then
  die "Expected requestedApiName='$CONFLICT_TARGET_API_NAME', got '$CONFLICT_REQUESTED'"
fi
ok "onConflict=rename surfaced $CONFLICT_RESOLVED_API_NAME with requestedApiName=$CONFLICT_REQUESTED"

cleanup_conflict() {
  curl -s -o /dev/null -X DELETE -H "$AUTH" \
    "$API/v2/ontologies/$ONTOLOGY/objectTypes/$CONFLICT_RESOLVED_API_NAME" || true
}
trap 'cleanup; cleanup_sibling; cleanup_second; cleanup_conflict' EXIT

# Rename the conflict-rename record to something unique and confirm
# `requestedApiName` goes null (the update service clears it).
CONFLICT_RENAME_TO="VerifyConflictResolved$STAMP"
RESOLVE_HTTP=$(curl -s -o /tmp/verify-ot-resolve-$STAMP.json -w "%{http_code}" \
  -X PUT -H "$AUTH" -H "Content-Type: application/json" \
  -d "$(jq -n --arg apiName "$CONFLICT_RENAME_TO" '{apiName: $apiName}')" \
  "$API/v2/ontologies/$ONTOLOGY/objectTypes/$CONFLICT_RESOLVED_API_NAME")
[ "$RESOLVE_HTTP" = "200" ] \
  || die "Resolving apiName conflict failed ($RESOLVE_HTTP): $(cat /tmp/verify-ot-resolve-$STAMP.json)"

RESOLVED_REQUESTED=$(curl -s -H "$AUTH" \
  "$API/v2/ontologies/$ONTOLOGY/objectTypes/$CONFLICT_RENAME_TO" \
  | jq -r '.objectType.requestedApiName')
if [ "$RESOLVED_REQUESTED" != "null" ] && [ -n "$RESOLVED_REQUESTED" ]; then
  die "requestedApiName should be cleared after rename, got '$RESOLVED_REQUESTED'"
fi
ok "Renaming a conflict cleared requestedApiName"

# Re-point cleanup to the final name.
CONFLICT_RESOLVED_API_NAME="$CONFLICT_RENAME_TO"

# ---- 10. Second object type backed by the SAME dataset ---------------
# Regression guard for the "Created, but datasource bind failed: 409"
# bug — the synthetic `file_path` in backing_datasource used to key
# only on the foundry dataset id, so any second object type bound to
# the same dataset collided on the UNIQUE idx_ds_file_path index.
# With the fix, the synthetic path also contains the new object_type_id
# so each (dataset, object_type) pair gets its own row.
SECOND_OT_API_NAME="VerifySecondBacking$STAMP"
SECOND_BATCH_BODY=$(jq -n \
  --arg apiName "$SECOND_OT_API_NAME" \
  --arg displayName "[Verify] Second backing $STAMP" \
  --argjson properties "$(echo "$PROPS_JSON" | jq 'map(del(.source))')" \
  --arg pk "$PK_API_NAME" \
  '{apiName: $apiName, displayName: $displayName, properties: $properties, primaryKeyProperty: $pk}')

SECOND_BATCH_HTTP=$(curl -s -o /tmp/verify-ot-second-batch-$STAMP.json -w "%{http_code}" \
  -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "$SECOND_BATCH_BODY" \
  "$API/v2/ontologies/$ONTOLOGY/objectTypes/batch")
[ "$SECOND_BATCH_HTTP" = "201" ] \
  || die "Second batch create failed ($SECOND_BATCH_HTTP): $(cat /tmp/verify-ot-second-batch-$STAMP.json)"
ok "Created second object type $SECOND_OT_API_NAME"

cleanup_second() {
  curl -s -o /dev/null -X DELETE -H "$AUTH" \
    "$API/v2/ontologies/$ONTOLOGY/objectTypes/$SECOND_OT_API_NAME" || true
}
trap 'cleanup; cleanup_sibling; cleanup_second' EXIT

SECOND_DS_HTTP=$(curl -s -o /tmp/verify-ot-second-ds-$STAMP.json -w "%{http_code}" \
  -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "$DS_BODY" \
  "$API/v2/ontologies/$ONTOLOGY/objectTypes/$SECOND_OT_API_NAME/datasource")
if [ "$SECOND_DS_HTTP" != "201" ] && [ "$SECOND_DS_HTTP" != "200" ]; then
  die "Second datasource bind failed ($SECOND_DS_HTTP): $(cat /tmp/verify-ot-second-ds-$STAMP.json)"
fi
ok "Second object type bound to same foundry dataset (HTTP $SECOND_DS_HTTP)"

printf "\n${GREEN}All assertions passed${NC}\n"
