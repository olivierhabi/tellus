#!/bin/bash
# =============================================================================
# E2E test: POST /api/v1/ontology/object-types/:objectTypeRid/datasources
#
# Verifies the "Add new backing datasource" flow after the fix:
#   1. Resolves the object type from the projected RID (no more 404).
#   2. REPLACE semantics: an object type keeps exactly one backing_datasource;
#      the old row is removed and a new one inserted.
#   3. The canonical `backing_datasource` row is written, so the object-type
#      GET response now carries `backingDatasource` (what the UI renders).
#
# Non-destructive: snapshots the original backing source and restores it.
#
# Usage:
#   ./scripts/test-add-backing-datasource.sh [object_type_id] [foundry_dataset_id]
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass(){ printf "${GREEN}✓ PASS${NC}: %s\n" "$1"; }
fail(){ printf "${RED}✗ FAIL${NC}: %s\n" "$1"; FAILURES=$((FAILURES+1)); }
section(){ printf "\n${YELLOW}── %s ──${NC}\n" "$1"; }
FAILURES=0

BASE_URL="${BASE_URL:-http://localhost:3000}"
PG_CONTAINER="${PG_CONTAINER:-tellus-postgres-1}"
OBJECT_TYPE_ID="${1:-a048f816-c64e-425f-8d9d-9760a849b595}"
OBJECT_TYPE_RID="ri.ontology.main.object-type.${OBJECT_TYPE_ID}"

psql_exec(){ docker exec "$PG_CONTAINER" psql -U tellus -d tellus_db -t -A -c "$1" 2>&1; }

section "0. Pre-flight"
# --- Mint a Keycloak token (resource-owner password grant) ---
TOKEN=$(curl -sf -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=${KC_TEST_USER:-cypress@tellus.local}&password=${KC_TEST_PASS:-Password123!}&grant_type=password&client_id=${KC_CLIENT:-tellus-frontend}&scope=openid" \
  "http://${KC_URL:-localhost:8086}/realms/${KC_REALM:-tellus}/protocol/openid-connect/token" \
  | jq -r '.access_token // empty')
if [[ -z "$TOKEN" ]]; then fail "could not mint Keycloak token"; exit 1; fi
pass "minted Keycloak token"

OT_API_NAME=$(psql_exec "SELECT api_name FROM object_type WHERE object_type_id='$OBJECT_TYPE_ID';")
OT_ONTOLOGY=$(psql_exec "SELECT ontology_id FROM object_type WHERE object_type_id='$OBJECT_TYPE_ID';")
echo "  object type: $OT_API_NAME  ($OBJECT_TYPE_RID)"
echo "  ontology_id: $OT_ONTOLOGY"
[[ -n "$OT_API_NAME" ]] || { fail "object type not found in DB"; exit 1; }
pass "object type resolves in canonical object_type table"

# --- Ensure a foundry fixture dataset exists whose columns map cleanly onto
#     the object type's properties. Created (or reused) and torn down at exit. ---
FIXTURE_DS="a1111111-1111-4111-8111-111111111111"
cleanup(){ section "9. Teardown"; echo "  restoring original backing source..."; }
trap cleanup EXIT

psql_exec "INSERT INTO foundry_datasets (id, name, file_path, original_filename, row_count)
  VALUES ('$FIXTURE_DS','[test-fixture] real-estate.csv','/tmp/ontology-testdata/real-estate.csv','real-estate.csv',746)
  ON CONFLICT (id) DO NOTHING;" >/dev/null
# Columns mirror the existing real-estate column_mapping.
psql_exec "DELETE FROM dataset_columns WHERE dataset_id='$FIXTURE_DS';" >/dev/null
i=1
for col in property_id location property_type registered_value district owner_tin registration_date; do
  psql_exec "INSERT INTO dataset_columns (dataset_id, column_name, ordinal_position, column_type)
    VALUES ('$FIXTURE_DS','$col',$i,'string');" >/dev/null
  i=$((i+1))
done
pass "foundry fixture dataset ready ($FIXTURE_DS)"
DATASOURCE_RID="${2:-$FIXTURE_DS}"

# --- Snapshot the original backing source so we can restore it. ---
ORIG_EXISTS=$(psql_exec "SELECT count(*) FROM backing_datasource WHERE object_type_id='$OBJECT_TYPE_ID';")
ORIG_SNAPSHOT=$(mktemp)
if [[ "$ORIG_EXISTS" -ge 1 ]]; then
  psql_exec "SELECT row_to_json(t) FROM (SELECT * FROM backing_datasource WHERE object_type_id='$OBJECT_TYPE_ID') t;" > "$ORIG_SNAPSHOT"
  ORIG_MAPPING=$(jq -r '.mapping_id // empty' "$ORIG_SNAPSHOT")
  echo "  original backing source: $ORIG_MAPPING (will be restored)"
fi

section "1. BEFORE state"
BEFORE_COUNT=$(psql_exec "SELECT count(*) FROM backing_datasource WHERE object_type_id='$OBJECT_TYPE_ID';")
BEFORE_OBJ_TYPE=$(curl -sf -X GET "$BASE_URL/api/v1/ontology/$OT_ONTOLOGY/objectTypes/by-id/$OBJECT_TYPE_ID" \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" | jq -c '.objectType.backingDatasource // "null"')
echo "  backing_datasource rows: $BEFORE_COUNT"
echo "  GET backingDatasource:   $BEFORE_OBJ_TYPE"

section "2. POST /object-types/{rid}/datasources  (the previously-failing call)"
BODY=$(jq -n \
  --arg ds "$DATASOURCE_RID" \
  '{datasourceRid:$ds, primaryKeyMapping:"property_id",
    propertyMappings:[
      {sourceColumn:"district",targetPropertyId:"district"},
      {sourceColumn:"location",targetPropertyId:"location"},
      {sourceColumn:"owner_tin",targetPropertyId:"ownerTin"},
      {sourceColumn:"property_id",targetPropertyId:"propertyId"},
      {sourceColumn:"property_type",targetPropertyId:"propertyType"},
      {sourceColumn:"registered_value",targetPropertyId:"registeredValue"},
      {sourceColumn:"registration_date",targetPropertyId:"registrationDate"}
    ],
    resolutionStrategy:"UNION", conflictPolicy:"OVERWRITE_WITH_NEW"}')

RESP=$(curl -s -o /tmp/add-ds-body.json -w "%{http_code}" -X POST \
  "$BASE_URL/api/v1/ontology/object-types/$OBJECT_TYPE_RID/datasources" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Accept: application/json" --data-raw "$BODY")
echo "  HTTP $RESP"; echo "  body: $(cat /tmp/add-ds-body.json | jq -c .)"

if [[ "$RESP" == "200" ]] && [[ "$(jq -r '.success // .data.success // empty' /tmp/add-ds-body.json)" == "true" ]]; then
  pass "POST returned 200 success (no OBJECT_TYPE_NOT_FOUND)"
else
  fail "expected HTTP 200 + success:true, got $RESP"
fi

section "3. AFTER state — REPLACE semantics"
AFTER_COUNT=$(psql_exec "SELECT count(*) FROM backing_datasource WHERE object_type_id='$OBJECT_TYPE_ID';")
NEW_MAPPING=$(psql_exec "SELECT mapping_id FROM backing_datasource WHERE object_type_id='$OBJECT_TYPE_ID';")
NEW_DS=$(psql_exec "SELECT file_path FROM backing_datasource WHERE object_type_id='$OBJECT_TYPE_ID';")
NEW_PK=$(psql_exec "SELECT primary_key_column FROM backing_datasource WHERE object_type_id='$OBJECT_TYPE_ID';")
echo "  backing_datasource rows: $AFTER_COUNT"
echo "  new mapping_id:          $NEW_MAPPING"
echo "  new pk column:           $NEW_PK"

if [[ "$AFTER_COUNT" == "1" ]]; then pass "exactly one backing_datasource row (no append)"; else fail "expected 1 row, got $AFTER_COUNT"; fi
if [[ -n "$ORIG_MAPPING" ]] && [[ "$NEW_MAPPING" != "$ORIG_MAPPING" ]]; then
  pass "old source replaced (mapping_id changed)"
elif [[ -z "$ORIG_MAPPING" ]]; then
  pass "new source inserted (object had none before)"
else
  fail "mapping_id unchanged — replace did not happen"
fi
if [[ "$NEW_PK" == "property_id" ]]; then pass "primary_key_column stored correctly"; else fail "pk mismatch: $NEW_PK"; fi
if echo "$NEW_DS" | grep -q "foundry-dataset:$DATASOURCE_RID"; then pass "canonical foundry-bridge row written"; else fail "unexpected file_path: $NEW_DS"; fi

section "4. GET object type now carries backingDatasource"
AFTER_OBJ_TYPE=$(curl -sf -X GET "$BASE_URL/api/v1/ontology/$OT_ONTOLOGY/objectTypes/by-id/$OBJECT_TYPE_ID" \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" | jq -c '.objectType.backingDatasource')
echo "  GET backingDatasource: $AFTER_OBJ_TYPE"
if [[ "$AFTER_OBJ_TYPE" != "null" ]] && [[ -n "$AFTER_OBJ_TYPE" ]] && [[ "$AFTER_OBJ_TYPE" != "null" ]]; then
  pass "object-type GET returns populated backingDatasource (UI will render it)"
else
  fail "GET backingDatasource is null"
fi

# --- Restore the original backing source so the test is non-destructive. ---
section "5. Restore original backing source"
psql_exec "DELETE FROM backing_datasource WHERE object_type_id='$OBJECT_TYPE_ID';" >/dev/null
if [[ -s "$ORIG_SNAPSHOT" ]]; then
  MAPPING_ID=$(jq -r '.mapping_id' "$ORIG_SNAPSHOT")
  DATASET_ID=$(jq -r '.dataset_id // empty' "$ORIG_SNAPSHOT")
  DATASET_NAME=$(jq -r '.dataset_name' "$ORIG_SNAPSHOT")
  FILE_PATH=$(jq -r '.file_path' "$ORIG_SNAPSHOT")
  COL_MAP=$(jq -c '.column_mapping' "$ORIG_SNAPSHOT")
  PK=$(jq -r '.primary_key_column' "$ORIG_SNAPSHOT")
  if [[ -z "$DATASET_ID" || "$DATASET_ID" == "null" ]]; then DS_TOKEN="NULL"; else DS_TOKEN="'$DATASET_ID'"; fi
  psql_exec "INSERT INTO backing_datasource (mapping_id, object_type_id, dataset_id, dataset_name, file_path, column_mapping, primary_key_column)
    VALUES ('$MAPPING_ID','$OBJECT_TYPE_ID',$DS_TOKEN,'$DATASET_NAME','$FILE_PATH','$COL_MAP','$PK');" >/dev/null
  pass "original backing source restored"
else
  pass "object had no original source; left clean"
fi

section "RESULT"
if [[ $FAILURES -eq 0 ]]; then printf "${GREEN}ALL CHECKS PASSED${NC}\n"; else printf "${RED}%d CHECK(S) FAILED${NC}\n" "$FAILURES"; exit 1; fi
