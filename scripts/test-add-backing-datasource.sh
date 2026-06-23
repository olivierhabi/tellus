#!/bin/bash
# =============================================================================
# Fullstack E2E: POST /api/v1/ontology/object-types/:objectTypeRid/datasources
#
# Proves the "Add new backing datasource" flow is production-complete:
#   1. Resolves the object type from the projected RID (no 404 OBJECT_TYPE_NOT_FOUND).
#   2. REPLACE semantics: exactly one backing_datasource row (no "append").
#   3. The object-type GET carries `backingDatasource` (what the UI renders).
#   4. RC2: saving TRIGGERS indexing (reindexObjectType) — previously only a
#      ws event was emitted and nothing indexed.
#   5. RC3: the UI-facing `funnel_state` badge flips to "indexed" with a real
#      object count (previously stuck at "not_indexed / 0").
#   6. RC1: GET /objects/:type returns objects within budget (no Redis 504).
#
# Self-contained: creates the target object type (+ properties) via the batch
# API if it is missing, and tears down only what it created. Uses a LEGACY
# `dataset` + committed `dataset_transaction` pointing at the local
# real-estate.csv so reindexObjectType reads locally (no S3/MinIO needed) —
# the same engine the FE "Force Reindex" button uses.
#
# Non-destructive: if the object type pre-existed, the original backing
# source is snapshotted and restored; the throwaway dataset/transaction are
# removed; if the test created the object type, it is deleted (cascade).
#
# Usage:
#   ./scripts/test-add-backing-datasource.sh [api_name] [legacy_dataset_id]
# =============================================================================
set -uo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass(){ printf "${GREEN}✓ PASS${NC}: %s\n" "$1"; }
fail(){ printf "${RED}✗ FAIL${NC}: %s\n" "$1"; FAILURES=$((FAILURES+1)); }
section(){ printf "\n${YELLOW}── %s ──${NC}\n" "$1"; }
FAILURES=0

BASE_URL="${BASE_URL:-http://localhost:3000}"
PG_CONTAINER="${PG_CONTAINER:-tellus-postgres-1}"
OS_CONTAINER="${OS_CONTAINER:-tellus-opensearch-1}"
API_NAME="${1:-RealEstateProperty}"
LEGACY_DS="${2:-c3333333-3333-4333-8333-333333333333}"
CSV_PATH="/tmp/ontology-testdata/real-estate.csv"
ONTOLOGY_ID="${ONTOLOGY_ID:-}"
CREATED_OT=0
ORIG_SNAPSHOT=$(mktemp)

psql_exec(){ docker exec -i "$PG_CONTAINER" psql -U tellus -d tellus_db -t -A -c "$1" 2>&1; }
os_count(){ local idx="ontology-$(echo "$1" | tr '[:upper:]' '[:lower:]')"; docker exec "$OS_CONTAINER" curl -s -u admin:admin "localhost:9200/${idx}/_count" 2>/dev/null | jq -r '.count // "0"' 2>/dev/null || echo 0; }
auth(){ echo "-H \"Authorization: Bearer $TOKEN\""; }

cleanup(){
  section "9. Teardown"
  if [[ -z "${OBJECT_TYPE_ID:-}" ]]; then
    echo "  (nothing to tear down — pre-flight failed before the object type resolved)"
    rm -f "$ORIG_SNAPSHOT"
    return
  fi
  if [[ "$CREATED_OT" == "1" ]]; then
    echo "  deleting test-created object type '$API_NAME' (cascade removes backing/funnel_state)..."
    psql_exec "DELETE FROM object_type WHERE api_name='$API_NAME';" >/dev/null
  else
    echo "  restoring original backing source..."
    psql_exec "DELETE FROM backing_datasource WHERE object_type_id='$OBJECT_TYPE_ID';" >/dev/null
    if [[ -s "$ORIG_SNAPSHOT" ]]; then
      M=$(jq -r '.mapping_id' "$ORIG_SNAPSHOT"); D=$(jq -r '.dataset_id // empty' "$ORIG_SNAPSHOT")
      N=$(jq -r '.dataset_name' "$ORIG_SNAPSHOT"); F=$(jq -r '.file_path' "$ORIG_SNAPSHOT")
      C=$(jq -c '.column_mapping' "$ORIG_SNAPSHOT"); P=$(jq -r '.primary_key_column' "$ORIG_SNAPSHOT")
      DT="NULL"; [[ -n "$D" && "$D" != "null" ]] && DT="'$D'"
      psql_exec "INSERT INTO backing_datasource (mapping_id, object_type_id, dataset_id, dataset_name, file_path, column_mapping, primary_key_column) VALUES ('$M','$OBJECT_TYPE_ID',$DT,'$N','$F','$C','$P');" >/dev/null
    fi
  fi
  echo "  removing throwaway legacy dataset/transaction..."
  psql_exec "DELETE FROM dataset_transaction WHERE dataset_id='$LEGACY_DS'; DELETE FROM dataset WHERE dataset_id='$LEGACY_DS';" >/dev/null
  rm -f "$ORIG_SNAPSHOT"
}
trap cleanup EXIT

section "0. Pre-flight"
TOKEN=$(curl -sf -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=${KC_TEST_USER:-cypress@tellus.local}&password=${KC_TEST_PASS:-Password123!}&grant_type=password&client_id=${KC_CLIENT:-tellus-frontend}&scope=openid" \
  "http://${KC_URL:-localhost:8086}/realms/${KC_REALM:-tellus}/protocol/openid-connect/token" | jq -r '.access_token // empty')
[[ -n "$TOKEN" ]] || { fail "could not mint Keycloak token"; exit 1; }
pass "minted Keycloak token"

[[ -n "$ONTOLOGY_ID" ]] || ONTOLOGY_ID=$(curl -sf "$BASE_URL/api/v1/ontology" -H "Authorization: Bearer $TOKEN" | jq -r '.data[0].ontologyId // empty')
[[ -n "$ONTOLOGY_ID" ]] || { fail "could not resolve ontology id"; exit 1; }
echo "  ontology_id: $ONTOLOGY_ID"
[[ -f "$CSV_PATH" ]] || { fail "fixture CSV not found at $CSV_PATH"; exit 1; }
pass "fixture CSV present"

# --- Self-seed: create the object type (+ 7 string properties, PK=propertyId)
#     via the batch API if it doesn't already exist. ---
OT_HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/v1/ontology/$ONTOLOGY_ID/objectTypes/$API_NAME" -H "Authorization: Bearer $TOKEN")
if [[ "$OT_HTTP" == "200" ]]; then
  pass "object type '$API_NAME' already exists — will restore its backing source after"
else
  echo "  object type missing (HTTP $OT_HTTP) — creating via batch API..."
  BATCH=$(jq -n '{
    apiName:"'"$API_NAME"'", displayName:"Real Estate Property", status:"active",
    primaryKeyProperty:"propertyId", titleProperty:"propertyId",
    properties:[
      {apiName:"propertyId",displayName:"Property Id",baseType:"string"},
      {apiName:"location",displayName:"Location",baseType:"string"},
      {apiName:"propertyType",displayName:"Property Type",baseType:"string"},
      {apiName:"registeredValue",displayName:"Registered Value",baseType:"string"},
      {apiName:"district",displayName:"District",baseType:"string"},
      {apiName:"ownerTin",displayName:"Owner Tin",baseType:"string"},
      {apiName:"registrationDate",displayName:"Registration Date",baseType:"string"}
    ]}')
  BH=$(curl -s -o /tmp/batch-ot.json -w "%{http_code}" -X POST "$BASE_URL/api/v1/ontology/$ONTOLOGY_ID/objectTypes/batch" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-raw "$BATCH")
  if [[ "$BH" == "201" || "$BH" == "200" ]]; then CREATED_OT=1; pass "created object type '$API_NAME' (will delete after)"; else fail "batch create failed: HTTP $BH — $(jq -c . /tmp/batch-ot.json 2>/dev/null)"; exit 1; fi
fi

OBJECT_TYPE_ID=$(psql_exec "SELECT object_type_id FROM object_type WHERE api_name='$API_NAME';")
OT_ONTOLOGY=$(psql_exec "SELECT ontology_id FROM object_type WHERE api_name='$API_NAME';")
[[ -n "$OBJECT_TYPE_ID" ]] || { fail "object type '$API_NAME' not found after ensure"; exit 1; }
OBJECT_TYPE_RID="ri.ontology.main.object-type.${OBJECT_TYPE_ID}"
echo "  object type: $API_NAME  ($OBJECT_TYPE_RID)  ontology: $OT_ONTOLOGY"

# --- Throwaway LEGACY dataset + committed transaction (local CSV, no S3). ---
psql_exec "DELETE FROM dataset_transaction WHERE dataset_id='$LEGACY_DS'; DELETE FROM dataset WHERE dataset_id='$LEGACY_DS';" >/dev/null
psql_exec "INSERT INTO dataset (dataset_id, name, file_format, schema_definition) VALUES ('$LEGACY_DS','[test-fixture] real-estate (legacy)','csv','[\"property_id\",\"location\",\"property_type\",\"registered_value\",\"district\",\"owner_tin\",\"registration_date\"]'::jsonb) ON CONFLICT (dataset_id) DO NOTHING;" >/dev/null
psql_exec "INSERT INTO dataset_transaction (transaction_id, dataset_id, transaction_type, status, file_path, row_count, committed_at) VALUES (gen_random_uuid(), '$LEGACY_DS', 'SNAPSHOT', 'committed', '$CSV_PATH', 100, now());" >/dev/null
pass "legacy fixture dataset + committed transaction ready"

# --- Snapshot original backing source (only meaningful if OT pre-existed). ---
ORIG_EXISTS=$(psql_exec "SELECT count(*) FROM backing_datasource WHERE object_type_id='$OBJECT_TYPE_ID';")
if [[ "$ORIG_EXISTS" -ge 1 ]]; then
  psql_exec "SELECT row_to_json(t) FROM (SELECT * FROM backing_datasource WHERE object_type_id='$OBJECT_TYPE_ID') t;" > "$ORIG_SNAPSHOT"
fi

section "1. POST /object-types/{rid}/datasources  (the previously-failing call)"
BODY=$(jq -n --arg ds "$LEGACY_DS" '{datasourceRid:$ds, primaryKeyMapping:"property_id",
  propertyMappings:[
    {sourceColumn:"property_id",targetPropertyId:"propertyId"},
    {sourceColumn:"location",targetPropertyId:"location"},
    {sourceColumn:"district",targetPropertyId:"district"},
    {sourceColumn:"owner_tin",targetPropertyId:"ownerTin"},
    {sourceColumn:"property_type",targetPropertyId:"propertyType"},
    {sourceColumn:"registered_value",targetPropertyId:"registeredValue"},
    {sourceColumn:"registration_date",targetPropertyId:"registrationDate"}
  ], resolutionStrategy:"UNION", conflictPolicy:"OVERWRITE_WITH_NEW"}')
RESP=$(curl -s -o /tmp/add-ds-body.json -w "%{http_code}" -X POST "$BASE_URL/api/v1/ontology/object-types/$OBJECT_TYPE_RID/datasources" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-raw "$BODY")
echo "  HTTP $RESP"; echo "  body: $(jq -c . /tmp/add-ds-body.json)"
[[ "$RESP" == "200" && "$(jq -r '.success // .data.success // empty' /tmp/add-ds-body.json)" == "true" ]] && pass "POST returned 200 success (no OBJECT_TYPE_NOT_FOUND)" || fail "expected 200 + success:true, got $RESP"

section "2. AFTER state — REPLACE semantics"
AFTER_COUNT=$(psql_exec "SELECT count(*) FROM backing_datasource WHERE object_type_id='$OBJECT_TYPE_ID';")
NEW_PK=$(psql_exec "SELECT primary_key_column FROM backing_datasource WHERE object_type_id='$OBJECT_TYPE_ID';")
echo "  backing_datasource rows: $AFTER_COUNT  pk: $NEW_PK"
[[ "$AFTER_COUNT" == "1" ]] && pass "exactly one backing_datasource row (no append)" || fail "expected 1 row, got $AFTER_COUNT"
[[ "$NEW_PK" == "property_id" ]] && pass "primary_key_column stored correctly" || fail "pk mismatch: $NEW_PK"

section "3. GET object type carries backingDatasource"
AFTER_OBJ=$(curl -sf "$BASE_URL/api/v1/ontology/$OT_ONTOLOGY/objectTypes/by-id/$OBJECT_TYPE_ID" -H "Authorization: Bearer $TOKEN" | jq -c '.objectType.backingDatasource')
echo "  GET backingDatasource: $AFTER_OBJ"
[[ "$AFTER_OBJ" != "null" && -n "$AFTER_OBJ" ]] && pass "object-type GET returns populated backingDatasource" || fail "GET backingDatasource is null"

section "4. RC2 + RC3 — save triggered indexing; badge flipped to 'indexed'"
IDX_STATUS="not_indexed"; IDX_COUNT=0; DEADLINE=$(( $(date +%s) + 45 ))
while [[ "$(date +%s)" -lt "$DEADLINE" ]]; do
  LINE=$(psql_exec "SELECT status || '|' || COALESCE(objects_indexed::text,'0') FROM funnel_state WHERE object_type_id='$OBJECT_TYPE_ID';")
  IDX_STATUS="${LINE%%|*}"
  IDX_COUNT="${LINE#*|}"
  { [[ "$IDX_STATUS" == "indexed" ]] || [[ "$IDX_STATUS" == "failed" ]]; } && break
  sleep 1
done
echo "  funnel_state: status=$IDX_STATUS objects_indexed=$IDX_COUNT"
[[ "$IDX_STATUS" == "indexed" && "$IDX_COUNT" -gt 0 ]] && pass "auto-index ran on save and badge reflects reality (indexed/$IDX_COUNT)" || fail "funnel_state did not reach indexed/>0 (status=$IDX_STATUS count=$IDX_COUNT)"

section "5. RC1 — objects listable via /objects (no Redis 504)"
LIST_HTTP=$(curl -s -o /tmp/list-body.json -w "%{http_code}" "$BASE_URL/api/v1/objects/$API_NAME?pageSize=3" -H "Authorization: Bearer $TOKEN")
LIST_TOTAL=$(jq -r '.totalCount // .data.totalCount // 0' /tmp/list-body.json 2>/dev/null || echo 0)
echo "  GET /objects/$API_NAME → HTTP $LIST_HTTP  totalCount=$LIST_TOTAL"
[[ "$LIST_HTTP" == "200" && "$LIST_TOTAL" -gt 0 ]] && pass "/objects returns objects within budget" || fail "/objects not healthy: HTTP $LIST_HTTP total=$LIST_TOTAL"

section "6. OpenSearch index populated"
OS_DOCS=$(os_count "$API_NAME")
echo "  ontology-$(echo "$API_NAME" | tr '[:upper:]' '[:lower:]') docs.count = $OS_DOCS"
[[ "$OS_DOCS" -gt 0 ]] && pass "OpenSearch index has $OS_DOCS documents" || fail "OpenSearch index empty ($OS_DOCS)"

section "RESULT"
if [[ $FAILURES -eq 0 ]]; then printf "${GREEN}ALL CHECKS PASSED${NC}\n"; else printf "${RED}%d CHECK(S) FAILED${NC}\n" "$FAILURES"; exit 1; fi
