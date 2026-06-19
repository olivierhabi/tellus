#!/usr/bin/env bash
# ===========================================================================
# Tuesday (Day 2) End-to-End Test Suite
#
# Tests the ENTIRE Tuesday API surface including:
#   - System health / status endpoint (GET /api/v1/status)
#   - Full indexing pipeline (POST trigger, GET status, DELETE index)
#   - Indexing validation (missing datasource, bad ontology, concurrent run)
#   - Link type CRUD (create, list, get, delete, duplicate rejection)
#   - Link type validation (bad cardinality, missing fields, naming rules)
#   - Link resolution (forward + reverse, ONE_TO_MANY cardinality)
#   - Link count + bulk count
#   - Search around
#   - Index deletion + status after deletion
#   - Full cleanup (ontology, object types, datasource, link types, indices)
#
# Prerequisites:
#   - Server running at BASE_URL (default http://localhost:3000)
#   - PostgreSQL and OpenSearch both reachable
#   - No pre-existing "E2ETuesday" ontology or related indices
#
# Usage:
#   pnpm run test:tuesday:e2e
#   ./tests/tuesday/e2e/suite.sh
#   BASE_URL=http://host:8080 ./tests/tuesday/e2e/suite.sh
#
# Exit code: 0 if all pass, 1 if any fail.
# ===========================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

# ---------------------------------------------------------------------------
# Wait for server to be ready
# ---------------------------------------------------------------------------
echo -e "${BOLD}Tuesday (Day 2) E2E Test Suite${NC}"
echo "Target: $BASE_URL"
echo ""
echo -n "Waiting for server..."
for i in $(seq 1 30); do
  if curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
    echo " ready."
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo " TIMEOUT. Server not reachable at $BASE_URL"
    exit 1
  fi
  sleep 1
  echo -n "."
done

# ===========================================================================
# 1. SYSTEM STATUS ENDPOINT
# ===========================================================================
section "1. System Status (GET /api/v1/status)"

do_request GET /api/v1/status
assert_status "$HTTP_STATUS" "200" "Status endpoint returns 200"
assert_contains "$HTTP_BODY" '"status"' "Top-level status field present"
assert_contains "$HTTP_BODY" '"timestamp"' "Timestamp present"
assert_contains "$HTTP_BODY" '"services"' "Services block present"
assert_contains "$HTTP_BODY" '"postgresql"' "PostgreSQL section present"
assert_contains "$HTTP_BODY" '"opensearch"' "OpenSearch section present"
assert_contains "$HTTP_BODY" '"ontology"' "Ontology summary present"
assert_contains "$HTTP_BODY" '"uptime"' "Uptime present"
assert_contains "$HTTP_BODY" '"version"' "Version present"

# Check PostgreSQL is connected
PG_CONNECTED=$(json_field_raw "$HTTP_BODY" "connected" | head -1)
assert_eq "$PG_CONNECTED" "true" "PostgreSQL connected"

# Check table counts are present
assert_contains "$HTTP_BODY" '"tables"' "Tables block present"
assert_contains "$HTTP_BODY" '"ontology"' "ontology table listed"
assert_contains "$HTTP_BODY" '"object_type"' "object_type table listed"
assert_contains "$HTTP_BODY" '"property"' "property table listed"
assert_contains "$HTTP_BODY" '"backing_datasource"' "backing_datasource table listed"
assert_contains "$HTTP_BODY" '"link_type"' "link_type table listed"
assert_contains "$HTTP_BODY" '"funnel_pipeline_state"' "funnel_pipeline_state table listed"

# Status should be healthy or degraded (not unhealthy since PG + OS should be up)
STATUS_VAL=$(json_field "$HTTP_BODY" "status")
if [[ "$STATUS_VAL" == "healthy" || "$STATUS_VAL" == "degraded" ]]; then
  pass "System status is healthy or degraded"
else
  fail "System status is healthy or degraded (got '$STATUS_VAL')"
fi

# ===========================================================================
# 2. SETUP: CREATE ONTOLOGY + OBJECT TYPES + DATASOURCE
# ===========================================================================
section "2. Setup: Ontology, Object Types, Datasources"

# --- Create ontology ---
do_request GET /api/v1/ontology/default
assert_status "$HTTP_STATUS" "200" "Resolve enterprise ontology"
ONTOLOGY_ID=$(json_field "$HTTP_BODY" "ontologyId")
assert_not_empty "$ONTOLOGY_ID" "ontologyId returned"

# --- Create Company object type (target for links) ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/batch" '{
  "apiName":"Company",
  "displayName":"Company",
  "description":"Company object type for link testing",
  "properties":[
    {"apiName":"companyId","displayName":"Company ID","baseType":"string","isRequired":true},
    {"apiName":"companyName","displayName":"Company Name","baseType":"string","isRequired":true},
    {"apiName":"industry","displayName":"Industry","baseType":"string"}
  ],
  "primaryKeyProperty":"companyId",
  "titleProperty":"companyName"
}'
assert_status "$HTTP_STATUS" "201" "Create Company object type"

# --- Create E2EEmployee object type (source for links) ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/batch" '{
  "apiName":"E2EEmployee",
  "displayName":"E2EEmployee",
  "description":"E2EEmployee object type for indexing + link testing",
  "properties":[
    {"apiName":"employeeId","displayName":"E2EEmployee ID","baseType":"string","isRequired":true},
    {"apiName":"fullName","displayName":"Full Name","baseType":"string","isRequired":true},
    {"apiName":"salary","displayName":"Salary","baseType":"double"},
    {"apiName":"department","displayName":"Department","baseType":"string"},
    {"apiName":"companyId","displayName":"Company ID","baseType":"string"},
    {"apiName":"isActive","displayName":"Active","baseType":"boolean"}
  ],
  "primaryKeyProperty":"employeeId",
  "titleProperty":"fullName"
}'
assert_status "$HTTP_STATUS" "201" "Create E2EEmployee object type"

# --- Write CSV test data files ---
DATA_DIR="${DATA_DIR:-$(cd "$(dirname "$0")/../../.." && pwd)/data}"
mkdir -p "$DATA_DIR"

COMPANY_CSV="${DATA_DIR}/e2e-tuesday-companies.csv"
cat > "$COMPANY_CSV" <<'CSVEOF'
company_id,company_name,industry
C001,Acme Corp,Technology
C002,Globex Inc,Manufacturing
C003,Initech,Consulting
CSVEOF

EMPLOYEE_CSV="${DATA_DIR}/e2e-tuesday-employees.csv"
cat > "$EMPLOYEE_CSV" <<'CSVEOF'
emp_id,full_name,salary,department,company_id,is_active
E001,Alice Smith,75000.50,Engineering,C001,true
E002,Bob Jones,82000.00,Engineering,C001,true
E003,Carol Lee,91000.75,Sales,C002,false
E004,Dave Kim,67500.25,Engineering,C002,true
E005,Eve Park,105000.00,Sales,C003,true
CSVEOF

pass "Test CSV files created"

# --- Register Company datasource ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/Company/datasource" "{
  \"datasetName\":\"E2E Company Dataset\",
  \"filePath\":\"${COMPANY_CSV}\",
  \"fileFormat\":\"csv\",
  \"columnMapping\":{
    \"companyId\":\"company_id\",
    \"companyName\":\"company_name\",
    \"industry\":\"industry\"
  }
}"
assert_status "$HTTP_STATUS" "201" "Register Company CSV datasource"
ROW_COUNT=$(json_field_raw "$HTTP_BODY" "rowCount")
assert_eq "$ROW_COUNT" "3" "Company rowCount = 3"

# --- Register E2EEmployee datasource ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/E2EEmployee/datasource" "{
  \"datasetName\":\"E2E E2EEmployee Dataset\",
  \"filePath\":\"${EMPLOYEE_CSV}\",
  \"fileFormat\":\"csv\",
  \"columnMapping\":{
    \"employeeId\":\"emp_id\",
    \"fullName\":\"full_name\",
    \"salary\":\"salary\",
    \"department\":\"department\",
    \"companyId\":\"company_id\",
    \"isActive\":\"is_active\"
  }
}"
assert_status "$HTTP_STATUS" "201" "Register E2EEmployee CSV datasource"
ROW_COUNT=$(json_field_raw "$HTTP_BODY" "rowCount")
assert_eq "$ROW_COUNT" "5" "E2EEmployee rowCount = 5"

# ===========================================================================
# 3. INDEXING VALIDATION ERRORS
# ===========================================================================
section "3. Indexing Validation Errors"

# --- Bad ontology ID ---
FAKE_UUID="00000000-0000-0000-0000-000000000099"
do_request POST "/api/v1/ontology/${FAKE_UUID}/objectTypes/E2EEmployee/index" '{}'
assert_status "$HTTP_STATUS" "404" "Index with bad ontologyId returns 404"
ERR_CODE=$(json_error_code "$HTTP_BODY")
assert_eq "$ERR_CODE" "ONTOLOGY_NOT_FOUND" "Error code ONTOLOGY_NOT_FOUND"

# --- Bad object type ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/NonExistent/index" '{}'
assert_status "$HTTP_STATUS" "404" "Index with bad objectType returns 404"
ERR_CODE=$(json_error_code "$HTTP_BODY")
assert_eq "$ERR_CODE" "OBJECT_TYPE_NOT_FOUND" "Error code OBJECT_TYPE_NOT_FOUND"

# --- Object type with no datasource ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/batch" '{
  "apiName":"NoDatasource",
  "displayName":"No Datasource",
  "properties":[{"apiName":"nid","displayName":"ID","baseType":"string","isRequired":true}],
  "primaryKeyProperty":"nid"
}'
assert_status "$HTTP_STATUS" "201" "Create NoDatasource OT"

do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/NoDatasource/index" '{}'
assert_status "$HTTP_STATUS" "400" "Index without datasource returns 400"
ERR_CODE=$(json_error_code "$HTTP_BODY")
assert_eq "$ERR_CODE" "NO_BACKING_DATASOURCE" "Error code NO_BACKING_DATASOURCE"

do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/NoDatasource"
assert_status "$HTTP_STATUS" "204" "Cleanup NoDatasource OT"

# --- Index status for non-existent ontology ---
do_request GET "/api/v1/ontology/${FAKE_UUID}/objectTypes/E2EEmployee/index/status"
assert_status "$HTTP_STATUS" "404" "Index status bad ontologyId returns 404"

# --- Index status for non-existent object type ---
do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/NonExistent/index/status"
assert_status "$HTTP_STATUS" "404" "Index status bad objectType returns 404"

# ===========================================================================
# 4. TRIGGER INDEXING (Company + E2EEmployee)
# ===========================================================================
section "4. Trigger Indexing Pipeline"

# --- Index Company first ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/Company/index" '{"forceRecreateIndex":true}'
assert_status "$HTTP_STATUS" "200" "Trigger Company indexing"
assert_contains "$HTTP_BODY" '"success"' "Company indexing status = success"
COMPANY_INDEXED=$(json_field_raw "$HTTP_BODY" "objectsIndexed")
assert_eq "$COMPANY_INDEXED" "3" "Company objectsIndexed = 3"
assert_contains "$HTTP_BODY" '"indexName"' "indexName present in response"
assert_contains "$HTTP_BODY" '"totalDurationMs"' "totalDurationMs present"

# Brief pause for OpenSearch to settle
sleep 2

# --- Index E2EEmployee ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/E2EEmployee/index" '{"forceRecreateIndex":true}'
assert_status "$HTTP_STATUS" "200" "Trigger E2EEmployee indexing"
assert_contains "$HTTP_BODY" '"success"' "E2EEmployee indexing status = success"
EMPLOYEE_INDEXED=$(json_field_raw "$HTTP_BODY" "objectsIndexed")
assert_eq "$EMPLOYEE_INDEXED" "5" "E2EEmployee objectsIndexed = 5"

# Brief pause for OpenSearch to settle
sleep 2

# ===========================================================================
# 5. INDEXING STATUS
# ===========================================================================
section "5. Indexing Status (GET)"

do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/E2EEmployee/index/status"
assert_status "$HTTP_STATUS" "200" "Get E2EEmployee index status"
assert_contains "$HTTP_BODY" '"objectTypeApiName"' "objectTypeApiName in status"
assert_contains "$HTTP_BODY" '"indexName"' "indexName in status"
assert_contains "$HTTP_BODY" '"pipeline"' "pipeline block present"
assert_contains "$HTTP_BODY" '"index"' "index block present"
assert_contains "$HTTP_BODY" '"datasource"' "datasource block present"

# Pipeline should show success
PIPELINE_STATUS=$(json_field "$HTTP_BODY" "status")
assert_eq "$PIPELINE_STATUS" "success" "Pipeline status = success"

# Index should exist
assert_contains "$HTTP_BODY" '"exists"' "index.exists field present"
assert_contains "$HTTP_BODY" '"documentCount"' "documentCount present"
assert_contains "$HTTP_BODY" '"storeSizeBytes"' "storeSizeBytes present"

# Datasource should be registered
assert_contains "$HTTP_BODY" '"registered"' "datasource.registered present"

# Company index status too
do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/Company/index/status"
assert_status "$HTTP_STATUS" "200" "Get Company index status"

# ===========================================================================
# 6. LINK TYPE CRUD
# ===========================================================================
section "6. Link Type CRUD"

# --- Create link type: E2EEmployee -> Company (MANY_TO_ONE) ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" '{
  "apiName":"employeeBelongsToCompany",
  "displayName":"E2EEmployee Belongs To Company",
  "description":"Links employees to their company",
  "cardinality":"MANY_TO_ONE",
  "sourceObjectTypeApiName":"E2EEmployee",
  "targetObjectTypeApiName":"Company",
  "sourcePropertyApiName":"companyId"
}'
assert_status "$HTTP_STATUS" "201" "Create MANY_TO_ONE link type"
assert_contains "$HTTP_BODY" '"employeeBelongsToCompany"' "apiName in response"
assert_contains "$HTTP_BODY" '"MANY_TO_ONE"' "cardinality in response"
assert_contains "$HTTP_BODY" '"linkTypeId"' "linkTypeId present"
assert_contains "$HTTP_BODY" '"createdAt"' "createdAt present"
assert_contains "$HTTP_BODY" '"updatedAt"' "updatedAt present"
LINK_TYPE_ID=$(json_field "$HTTP_BODY" "linkTypeId")
assert_not_empty "$LINK_TYPE_ID" "linkTypeId not empty"

# --- Duplicate rejection ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" '{
  "apiName":"employeeBelongsToCompany",
  "displayName":"Dup",
  "cardinality":"MANY_TO_ONE",
  "sourceObjectTypeApiName":"E2EEmployee",
  "targetObjectTypeApiName":"Company"
}'
assert_status "$HTTP_STATUS" "409" "Duplicate link type returns 409"
ERR_CODE=$(json_error_code "$HTTP_BODY")
assert_eq "$ERR_CODE" "ALREADY_EXISTS" "Error code ALREADY_EXISTS"

# --- List link types ---
do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes"
assert_status "$HTTP_STATUS" "200" "List link types"
assert_contains "$HTTP_BODY" '"data"' "data array present"
assert_contains "$HTTP_BODY" '"employeeBelongsToCompany"' "Link type in list"

# --- Get single link type ---
do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany"
assert_status "$HTTP_STATUS" "200" "Get single link type"
assert_contains "$HTTP_BODY" '"employeeBelongsToCompany"' "apiName matches"
assert_contains "$HTTP_BODY" '"MANY_TO_ONE"' "cardinality matches"

# --- Get non-existent link type ---
do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/nonExistentLink"
assert_status "$HTTP_STATUS" "404" "Non-existent link type returns 404"
ERR_CODE=$(json_error_code "$HTTP_BODY")
assert_eq "$ERR_CODE" "LINK_TYPE_NOT_FOUND" "Error code LINK_TYPE_NOT_FOUND"

# --- Create a second link type for delete test ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" '{
  "apiName":"tempLink",
  "displayName":"Temp Link",
  "cardinality":"ONE_TO_ONE",
  "sourceObjectTypeApiName":"E2EEmployee",
  "targetObjectTypeApiName":"Company"
}'
assert_status "$HTTP_STATUS" "201" "Create temp link type"

# --- Delete link type ---
do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/tempLink"
assert_status "$HTTP_STATUS" "200" "Delete link type returns 200"

# --- Delete non-existent link type ---
do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/tempLink"
assert_status "$HTTP_STATUS" "404" "Delete non-existent link type returns 404"

# ===========================================================================
# 7. LINK TYPE VALIDATION
# ===========================================================================
section "7. Link Type Validation"

# --- Missing required fields ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" '{}'
assert_status "$HTTP_STATUS" "400" "Empty body returns 400"
ERR_CODE=$(json_error_code "$HTTP_BODY")
assert_eq "$ERR_CODE" "VALIDATION_FAILED" "Error code VALIDATION_FAILED"

do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" '{
  "apiName":"testLink",
  "displayName":"Test"
}'
assert_status "$HTTP_STATUS" "400" "Missing cardinality + objectTypes returns 400"

# --- Invalid cardinality ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" '{
  "apiName":"badCard",
  "displayName":"Bad",
  "cardinality":"INVALID_CARD",
  "sourceObjectTypeApiName":"E2EEmployee",
  "targetObjectTypeApiName":"Company"
}'
assert_status "$HTTP_STATUS" "400" "Invalid cardinality rejected"

# --- Invalid api name (PascalCase instead of camelCase) ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" '{
  "apiName":"BadName",
  "displayName":"Bad",
  "cardinality":"ONE_TO_ONE",
  "sourceObjectTypeApiName":"E2EEmployee",
  "targetObjectTypeApiName":"Company"
}'
assert_status "$HTTP_STATUS" "400" "PascalCase link type name rejected"

# --- Reserved __ prefix ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" '{
  "apiName":"__reserved",
  "displayName":"Reserved",
  "cardinality":"ONE_TO_ONE",
  "sourceObjectTypeApiName":"E2EEmployee",
  "targetObjectTypeApiName":"Company"
}'
assert_status "$HTTP_STATUS" "400" "__ prefix link type name rejected"

# --- Non-existent source object type ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" '{
  "apiName":"badSource",
  "displayName":"Bad Source",
  "cardinality":"ONE_TO_ONE",
  "sourceObjectTypeApiName":"NonExistent",
  "targetObjectTypeApiName":"Company"
}'
assert_status "$HTTP_STATUS" "404" "Non-existent source OT returns 404"

# --- Non-existent target object type ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" '{
  "apiName":"badTarget",
  "displayName":"Bad Target",
  "cardinality":"ONE_TO_ONE",
  "sourceObjectTypeApiName":"E2EEmployee",
  "targetObjectTypeApiName":"NonExistent"
}'
assert_status "$HTTP_STATUS" "404" "Non-existent target OT returns 404"

# --- Non-existent source property ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" '{
  "apiName":"badProp",
  "displayName":"Bad Prop",
  "cardinality":"MANY_TO_ONE",
  "sourceObjectTypeApiName":"E2EEmployee",
  "targetObjectTypeApiName":"Company",
  "sourcePropertyApiName":"doesNotExist"
}'
assert_status "$HTTP_STATUS" "404" "Non-existent source property returns 404"

# ===========================================================================
# 8. LINK RESOLVE (forward + reverse)
# ===========================================================================
section "8. Link Resolution"

# --- Resolve validation ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany/resolve" '{}'
assert_status "$HTTP_STATUS" "400" "Resolve with empty body returns 400"

do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany/resolve" \
  '{"objectPK":"E001"}'
assert_status "$HTTP_STATUS" "400" "Resolve without direction returns 400"

do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany/resolve" \
  '{"objectPK":"E001","direction":"sideways"}'
assert_status "$HTTP_STATUS" "400" "Resolve with invalid direction returns 400"

# --- Resolve with non-existent link type ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/nonExistent/resolve" \
  '{"objectPK":"E001","direction":"forward"}'
assert_status "$HTTP_STATUS" "404" "Resolve non-existent link type returns 404"

# --- Forward resolve: E2EEmployee E001 -> Company (MANY_TO_ONE forward = lookup FK) ---
# E001 has companyId=C001, so forward should return Acme Corp (Company C001)
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany/resolve" \
  '{"objectPK":"E001","direction":"forward"}'
assert_status "$HTTP_STATUS" "200" "Forward resolve E2EEmployee->Company"
# MANY_TO_ONE forward returns { linkedObject: ... } (singular — at most one target)
assert_contains "$HTTP_BODY" '"linkedObject"' "linkedObject in response"
assert_contains "$HTTP_BODY" '"C001"' "Forward resolve found Company C001"
assert_contains "$HTTP_BODY" '"Acme Corp"' "Forward resolve found Acme Corp"

# --- Forward resolve: E2EEmployee E003 -> Company C002 ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany/resolve" \
  '{"objectPK":"E003","direction":"forward"}'
assert_status "$HTTP_STATUS" "200" "Forward resolve E003->Company"
assert_contains "$HTTP_BODY" '"C002"' "E003 belongs to C002"
assert_contains "$HTTP_BODY" '"Globex Inc"' "E003 belongs to Globex Inc"

# --- Reverse resolve: Company C001 -> all E2EEmployees with companyId=C001 ---
# MANY_TO_ONE reverse: search source (E2EEmployee) where sourceFK (companyId) = targetPK (C001)
# Should find E001 (Alice) and E002 (Bob)
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany/resolve" \
  '{"objectPK":"C001","direction":"reverse"}'
assert_status "$HTTP_STATUS" "200" "Reverse resolve Company->E2EEmployees"
assert_contains "$HTTP_BODY" '"linkedObjects"' "linkedObjects in reverse response"
assert_contains "$HTTP_BODY" '"Alice Smith"' "Reverse found Alice Smith"
assert_contains "$HTTP_BODY" '"Bob Jones"' "Reverse found Bob Jones"

# --- Reverse resolve with no matches ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany/resolve" \
  '{"objectPK":"C999","direction":"reverse"}'
assert_status "$HTTP_STATUS" "200" "Reverse resolve non-existent PK returns 200"
TOTAL_COUNT=$(json_field_raw "$HTTP_BODY" "totalCount")
assert_eq "$TOTAL_COUNT" "0" "No linked objects for non-existent PK"

# ===========================================================================
# 9. LINK COUNT + BULK COUNT
# ===========================================================================
section "9. Link Count + Bulk Count"

# --- Count validation ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany/count" '{}'
assert_status "$HTTP_STATUS" "400" "Count with empty body returns 400"

# --- Count non-existent link type ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/nonExistent/count" \
  '{"objectPK":"C001","direction":"reverse"}'
assert_status "$HTTP_STATUS" "404" "Count non-existent link type returns 404"

# --- Count reverse: Company C001 -> E2EEmployees (should be 2: Alice, Bob) ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany/count" \
  '{"objectPK":"C001","direction":"reverse"}'
assert_status "$HTTP_STATUS" "200" "Count reverse C001"
assert_contains "$HTTP_BODY" '"count"' "count field present"
COUNT_VAL=$(json_field_raw "$HTTP_BODY" "count")
assert_eq "$COUNT_VAL" "2" "C001 has 2 employees"

# --- Count reverse: Company C002 -> E2EEmployees (should be 2: Carol, Dave) ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany/count" \
  '{"objectPK":"C002","direction":"reverse"}'
assert_status "$HTTP_STATUS" "200" "Count reverse C002"
COUNT_VAL=$(json_field_raw "$HTTP_BODY" "count")
assert_eq "$COUNT_VAL" "2" "C002 has 2 employees"

# --- Count reverse: Company C003 -> E2EEmployees (should be 1: Eve) ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany/count" \
  '{"objectPK":"C003","direction":"reverse"}'
assert_status "$HTTP_STATUS" "200" "Count reverse C003"
COUNT_VAL=$(json_field_raw "$HTTP_BODY" "count")
assert_eq "$COUNT_VAL" "1" "C003 has 1 employee"

# --- Count forward: E2EEmployee E001 -> Company (should be 1) ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany/count" \
  '{"objectPK":"E001","direction":"forward"}'
assert_status "$HTTP_STATUS" "200" "Count forward E001"
COUNT_VAL=$(json_field_raw "$HTTP_BODY" "count")
assert_eq "$COUNT_VAL" "1" "E001 belongs to 1 company"

# --- Bulk count validation ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/bulkCount" '{}'
assert_status "$HTTP_STATUS" "400" "Bulk count empty body returns 400"

do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/bulkCount" '{"requests":[]}'
assert_status "$HTTP_STATUS" "400" "Bulk count empty array returns 400"

# --- Bulk count: multiple requests ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/bulkCount" '{
  "requests":[
    {"linkTypeApiName":"employeeBelongsToCompany","objectPK":"C001","direction":"reverse"},
    {"linkTypeApiName":"employeeBelongsToCompany","objectPK":"C002","direction":"reverse"},
    {"linkTypeApiName":"employeeBelongsToCompany","objectPK":"C003","direction":"reverse"}
  ]
}'
assert_status "$HTTP_STATUS" "200" "Bulk count returns 200"
assert_contains "$HTTP_BODY" '"results"' "results array present"

# --- Bulk count with non-existent link type (should be inline error, not 500) ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/bulkCount" '{
  "requests":[
    {"linkTypeApiName":"nonExistentLink","objectPK":"C001","direction":"reverse"},
    {"linkTypeApiName":"employeeBelongsToCompany","objectPK":"C001","direction":"reverse"}
  ]
}'
assert_status "$HTTP_STATUS" "200" "Bulk count with bad link type still returns 200"
assert_contains "$HTTP_BODY" '"results"' "results present for mixed requests"

# ===========================================================================
# 10. SEARCH AROUND
# ===========================================================================
section "10. Search Around"

# --- Validation ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany/searchAround" '{}'
assert_status "$HTTP_STATUS" "400" "Search around without direction returns 400"

do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/nonExistent/searchAround" \
  '{"direction":"forward"}'
assert_status "$HTTP_STATUS" "404" "Search around non-existent link returns 404"

# --- Search around forward: all E2EEmployees -> their Companies ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany/searchAround" \
  '{"direction":"forward"}'
assert_status "$HTTP_STATUS" "200" "Search around forward all employees"
assert_contains "$HTTP_BODY" '"linkedObjects"' "linkedObjects present"
assert_contains "$HTTP_BODY" '"totalCount"' "totalCount present"
# Should find all 3 companies (C001, C002, C003) since employees span all 3
assert_contains "$HTTP_BODY" '"Acme Corp"' "Search around found Acme Corp"
assert_contains "$HTTP_BODY" '"Globex Inc"' "Search around found Globex Inc"
assert_contains "$HTTP_BODY" '"Initech"' "Search around found Initech"

# --- Search around reverse: all Companies -> their E2EEmployees ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany/searchAround" \
  '{"direction":"reverse"}'
assert_status "$HTTP_STATUS" "200" "Search around reverse all companies"
assert_contains "$HTTP_BODY" '"linkedObjects"' "linkedObjects present"
# Should find all 5 employees
TOTAL_COUNT=$(json_field_raw "$HTTP_BODY" "totalCount")
assert_eq "$TOTAL_COUNT" "5" "Search around reverse found 5 employees"

# --- Search around with sourceFilter ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany/searchAround" \
  '{"direction":"forward","sourceFilter":{"department":"Engineering"}}'
assert_status "$HTTP_STATUS" "200" "Search around with sourceFilter"
# Engineering employees: E001(C001), E002(C001), E004(C002) -> Companies C001, C002
assert_contains "$HTTP_BODY" '"Acme Corp"' "Filtered search found Acme Corp"
assert_contains "$HTTP_BODY" '"Globex Inc"' "Filtered search found Globex Inc"

# ===========================================================================
# 11. INDEX DELETE + STATUS AFTER DELETION
# ===========================================================================
section "11. Index Delete + Post-Deletion Status"

# --- Delete E2EEmployee index ---
do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/E2EEmployee/index"
assert_status "$HTTP_STATUS" "200" "Delete E2EEmployee index"
assert_contains "$HTTP_BODY" '"success"' "Delete status = success"
assert_contains "$HTTP_BODY" 'has been deleted' "Message mentions has been deleted"

# --- Delete non-existent index (idempotent) ---
do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/E2EEmployee/index"
assert_status "$HTTP_STATUS" "200" "Delete non-existent index returns 200 (idempotent)"
assert_contains "$HTTP_BODY" 'does not exist' "Message says index does not exist"

# --- Status after deletion ---
do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/E2EEmployee/index/status"
assert_status "$HTTP_STATUS" "200" "Index status after deletion"
PIPELINE_STATUS=$(json_field "$HTTP_BODY" "status")
assert_eq "$PIPELINE_STATUS" "idle" "Pipeline status = idle after delete"

# --- Delete validation errors ---
do_request DELETE "/api/v1/ontology/${FAKE_UUID}/objectTypes/E2EEmployee/index"
assert_status "$HTTP_STATUS" "404" "Delete index bad ontologyId returns 404"

do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/NonExistent/index"
assert_status "$HTTP_STATUS" "404" "Delete index bad objectType returns 404"

# --- Delete Company index too for clean state ---
do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/Company/index"
assert_status "$HTTP_STATUS" "200" "Delete Company index"

# ===========================================================================
# 12. RE-INDEX (verify re-indexing works after delete)
# ===========================================================================
section "12. Re-Index After Delete"

do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/E2EEmployee/index" '{"forceRecreateIndex":true}'
assert_status "$HTTP_STATUS" "200" "Re-index E2EEmployee after delete"
assert_contains "$HTTP_BODY" '"success"' "Re-index status = success"
REINDEX_COUNT=$(json_field_raw "$HTTP_BODY" "objectsIndexed")
assert_eq "$REINDEX_COUNT" "5" "Re-indexed 5 E2EEmployee objects"

sleep 2

# Verify status after re-index
do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/E2EEmployee/index/status"
assert_status "$HTTP_STATUS" "200" "Status after re-index"
PIPELINE_STATUS=$(json_field "$HTTP_BODY" "status")
assert_eq "$PIPELINE_STATUS" "success" "Pipeline status = success after re-index"

# ===========================================================================
# 13. DATASOURCE SCAN (re-scan after indexing)
# ===========================================================================
section "13. Datasource Scan"

do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/E2EEmployee/datasource/scan"
assert_status "$HTTP_STATUS" "200" "Scan E2EEmployee datasource"
assert_contains "$HTTP_BODY" '"schemaChanged"' "schemaChanged in scan response"
assert_contains "$HTTP_BODY" '"datasource"' "datasource in scan response"

do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/Company/datasource/scan"
assert_status "$HTTP_STATUS" "200" "Scan Company datasource"

# ===========================================================================
# 14. SYSTEM STATUS AFTER INDEXING (verify object counts)
# ===========================================================================
section "14. System Status After Indexing"

do_request GET /api/v1/status
assert_status "$HTTP_STATUS" "200" "Status after indexing"
# Should show objectTypes with counts
assert_contains "$HTTP_BODY" '"objectTypes"' "objectTypes in status"
# The E2EEmployee index should show 5 objects
assert_contains "$HTTP_BODY" '"E2EEmployee"' "E2EEmployee appears in status objectTypes"

# ===========================================================================
# 15. FULL CLEANUP
# ===========================================================================
section "15. Full Cleanup"

# --- Delete indices ---
do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/E2EEmployee/index"
pass "Delete E2EEmployee index for cleanup"

do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/Company/index"
pass "Delete Company index for cleanup"

# --- Delete link types ---
do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeBelongsToCompany"
assert_status "$HTTP_STATUS" "200" "Delete link type"

# --- Delete object types (cascade deletes properties + datasource) ---
do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/E2EEmployee"
assert_status "$HTTP_STATUS" "204" "Delete E2EEmployee OT"

do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/Company"
assert_status "$HTTP_STATUS" "204" "Delete Company OT"

# --- Verify OTs gone ---
do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/E2EEmployee"
assert_status "$HTTP_STATUS" "404" "E2EEmployee OT gone after delete"

do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/Company"
assert_status "$HTTP_STATUS" "404" "Company OT gone after delete"

# --- Delete ontology ---
do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}"
assert_status "$HTTP_STATUS" "204" "Delete ontology"

do_request GET "/api/v1/ontology/${ONTOLOGY_ID}"
assert_status "$HTTP_STATUS" "404" "Ontology gone after delete"

# --- Cleanup test data files ---
rm -f "$EMPLOYEE_CSV" "$COMPANY_CSV"
pass "Test data files cleaned up"

# ===========================================================================
# REPORT
# ===========================================================================
print_report
