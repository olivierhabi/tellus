#!/usr/bin/env bash
# ===========================================================================
# Thursday E2E Test Suite — Link Type Subsystem
#
# Tests all Thursday link type endpoints:
#   - CRUD (create, list, get, update, delete)
#   - Link resolution, counts, bulk counts
#   - Search Around
#   - Multi-hop traversal
#   - Join table upload & validation
#   - Export / Import
#   - Cardinality migration validation
#   - Object-level link endpoints
#
# Prerequisites:
#   - Server running on port 3000
#   - PostgreSQL and OpenSearch available
#   - At least one ontology with 2+ object types
# ===========================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

echo -e "${BOLD}Thursday E2E Test Suite — Link Type Subsystem${NC}"
echo -e "${BOLD}===============================================${NC}"

# ===========================================================================
# Phase 0: Server health check
# ===========================================================================

section "Server Health Check"

do_request GET "/health"
if [[ "$HTTP_STATUS" != "200" ]]; then
  echo -e "${RED}Server not reachable at ${BASE_URL}. Aborting.${NC}"
  exit 1
fi
pass "Server is healthy"

# ===========================================================================
# Phase 1: Setup — find or create an ontology and object types
# ===========================================================================

section "Setup — Ontology & Object Types"

# Singleton deployment: POST /api/v1/ontology is frozen (ONTOLOGY_SINGLETON).
# Resolve the single canonical enterprise ontology instead of creating one.
do_request GET "/api/v1/ontology"
ONTOLOGY_ID=$(echo "$HTTP_BODY" | grep -o '"ontologyId":"[^"]*"' | head -1 | sed 's/"ontologyId":"//;s/"//')
assert_not_empty "$ONTOLOGY_ID" "Resolved canonical ontology"

# Idempotent pre-cleanup: remove leftover artifacts from a prior interrupted
# run so the creates below don't 409. Only deletes the specific apiNames this
# suite creates — never seeded types (e.g. Taxpayer, taxpayerBusiness).
THURSDAY_LINK_TYPES="companyEmployees employeeCompany employeeDepartments importedLink renamedLink badLink"
THURSDAY_OBJECT_TYPES="Company Employee Department badObjType"
for lt_name in $THURSDAY_LINK_TYPES; do
  do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/${lt_name}"
done
for ot_name in $THURSDAY_OBJECT_TYPES; do
  do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/${ot_name}"
done

# Create Company object type with properties (batch endpoint)
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/batch" \
  '{"apiName":"Company","displayName":"Company","description":"Test company","primaryKeyProperty":"companyId","properties":[{"apiName":"companyId","displayName":"Company ID","baseType":"string"},{"apiName":"companyName","displayName":"Company Name","baseType":"string"}]}'
assert_status "$HTTP_STATUS" "201" "Created Company object type with properties"

# Create Employee object type with properties (batch endpoint)
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/batch" \
  '{"apiName":"Employee","displayName":"Employee","description":"Test employee","primaryKeyProperty":"employeeId","properties":[{"apiName":"employeeId","displayName":"Employee ID","baseType":"string"},{"apiName":"companyId","displayName":"Company ID","baseType":"string"},{"apiName":"departmentId","displayName":"Department ID","baseType":"string"},{"apiName":"fullName","displayName":"Full Name","baseType":"string"}]}'
assert_status "$HTTP_STATUS" "201" "Created Employee object type with properties"

# Create Department object type with properties (batch endpoint)
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/batch" \
  '{"apiName":"Department","displayName":"Department","description":"Test department","primaryKeyProperty":"departmentId","properties":[{"apiName":"departmentId","displayName":"Department ID","baseType":"string"},{"apiName":"departmentName","displayName":"Department Name","baseType":"string"}]}'
assert_status "$HTTP_STATUS" "201" "Created Department object type with properties"

# ===========================================================================
# Phase 2: Create Link Types (Tasks 2)
# ===========================================================================

section "Create Link Types (Task 2)"

# ONE_TO_MANY: Company -> Employees
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" \
  "{\"apiName\":\"companyEmployees\",\"displayName\":\"Company Employees\",\"cardinality\":\"ONE_TO_MANY\",\"sourceObjectTypeApiName\":\"Company\",\"targetObjectTypeApiName\":\"Employee\",\"targetPropertyApiName\":\"companyId\"}"
assert_status "$HTTP_STATUS" "201" "Created ONE_TO_MANY link: companyEmployees"
assert_contains "$HTTP_BODY" '"apiName":"companyEmployees"' "Response has apiName"

# MANY_TO_ONE: Employee -> Company
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" \
  "{\"apiName\":\"employeeCompany\",\"displayName\":\"Employee Company\",\"cardinality\":\"MANY_TO_ONE\",\"sourceObjectTypeApiName\":\"Employee\",\"targetObjectTypeApiName\":\"Company\",\"sourcePropertyApiName\":\"companyId\"}"
assert_status "$HTTP_STATUS" "201" "Created MANY_TO_ONE link: employeeCompany"

# MANY_TO_MANY: Employee -> Department (no FK, will use join table)
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" \
  "{\"apiName\":\"employeeDepartments\",\"displayName\":\"Employee Departments\",\"cardinality\":\"MANY_TO_MANY\",\"sourceObjectTypeApiName\":\"Employee\",\"targetObjectTypeApiName\":\"Department\",\"isBidirectional\":true}"
assert_status "$HTTP_STATUS" "201" "Created MANY_TO_MANY link: employeeDepartments"
assert_contains "$HTTP_BODY" '"isBidirectional":true' "M2M link is bidirectional"

# Validation: missing required fields
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" \
  '{"apiName":"badLink"}'
assert_status "$HTTP_STATUS" "400" "Reject create with missing fields"

# Validation: invalid cardinality
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" \
  '{"apiName":"badLink","displayName":"Bad","cardinality":"INVALID","sourceObjectTypeApiName":"Company","targetObjectTypeApiName":"Employee"}'
assert_status "$HTTP_STATUS" "400" "Reject invalid cardinality"

# Validation: duplicate
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" \
  "{\"apiName\":\"companyEmployees\",\"displayName\":\"Dup\",\"cardinality\":\"ONE_TO_MANY\",\"sourceObjectTypeApiName\":\"Company\",\"targetObjectTypeApiName\":\"Employee\"}"
assert_status "$HTTP_STATUS" "409" "Reject duplicate link type"

# Validation: non-existent object type
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" \
  '{"apiName":"badObjType","displayName":"Bad","cardinality":"ONE_TO_MANY","sourceObjectTypeApiName":"NonExistent","targetObjectTypeApiName":"Employee"}'
assert_status "$HTTP_STATUS" "404" "Reject non-existent source object type"

# ===========================================================================
# Phase 3: List Link Types (Task 3)
# ===========================================================================

section "List Link Types (Task 3)"

do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes"
assert_status "$HTTP_STATUS" "200" "List link types"
assert_contains "$HTTP_BODY" '"totalCount"' "Has totalCount"
TOTAL_COUNT=$(json_field_raw "$HTTP_BODY" "totalCount")
assert_eq "$TOTAL_COUNT" "3" "3 link types created"

# Test pagination
do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes?pageSize=1"
assert_status "$HTTP_STATUS" "200" "List with pageSize=1"
assert_contains "$HTTP_BODY" '"nextPageToken"' "Has nextPageToken for pagination"

# ===========================================================================
# Phase 4: Get Single Link Type (Task 4)
# ===========================================================================

section "Get Single Link Type (Task 4)"

do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/companyEmployees"
assert_status "$HTTP_STATUS" "200" "Get companyEmployees link type"
assert_contains "$HTTP_BODY" '"cardinality":"ONE_TO_MANY"' "Correct cardinality"
assert_contains "$HTTP_BODY" '"sourceObjectTypeApiName"' "Has enriched source type name"

# Non-existent
do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/doesNotExist"
assert_status "$HTTP_STATUS" "404" "404 for non-existent link type"

# ===========================================================================
# Phase 5: Update Link Type (Task 5)
# ===========================================================================

section "Update Link Type (Task 5)"

do_request PUT "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/companyEmployees" \
  '{"displayName":"Company -> Employees (Updated)"}'
assert_status "$HTTP_STATUS" "200" "Update displayName"
assert_contains "$HTTP_BODY" 'Updated' "Response contains updated name"

# Reject immutable field change: apiName
do_request PUT "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/companyEmployees" \
  '{"apiName":"renamedLink"}'
assert_status "$HTTP_STATUS" "400" "Reject apiName change"

# Reject immutable field change: sourceObjectTypeApiName
do_request PUT "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/companyEmployees" \
  '{"sourceObjectTypeApiName":"Department"}'
assert_status "$HTTP_STATUS" "400" "Reject source object type change"

# Update with bidirectional flag
do_request PUT "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/companyEmployees" \
  '{"isBidirectional":true}'
assert_status "$HTTP_STATUS" "200" "Update isBidirectional"
assert_contains "$HTTP_BODY" '"isBidirectional":true' "Response shows bidirectional"

# Non-existent
do_request PUT "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/doesNotExist" \
  '{"displayName":"nope"}'
assert_status "$HTTP_STATUS" "404" "404 for updating non-existent"

# ===========================================================================
# Phase 6: Export Link Types (Task 25)
# ===========================================================================

section "Export Link Types (Task 25)"

do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/export"
assert_status "$HTTP_STATUS" "200" "Export link types"
assert_contains "$HTTP_BODY" '"ontologyId"' "Export has ontologyId"
assert_contains "$HTTP_BODY" '"exportedAt"' "Export has exportedAt"
assert_contains "$HTTP_BODY" '"linkTypes"' "Export has linkTypes array"
assert_contains "$HTTP_BODY" '"version":"1.0"' "Export has version"

# Save for import test
EXPORT_BODY="$HTTP_BODY"

# ===========================================================================
# Phase 7: Import Link Types (Task 26)
# ===========================================================================

section "Import Link Types (Task 26)"

# Import with all duplicates (should skip)
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/import" \
  "{\"linkTypes\":[{\"apiName\":\"companyEmployees\",\"displayName\":\"Company Employees\",\"cardinality\":\"ONE_TO_MANY\",\"sourceObjectTypeApiName\":\"Company\",\"targetObjectTypeApiName\":\"Employee\"},{\"apiName\":\"importedLink\",\"displayName\":\"Imported Link\",\"cardinality\":\"ONE_TO_ONE\",\"sourceObjectTypeApiName\":\"Company\",\"targetObjectTypeApiName\":\"Employee\"}]}"
assert_status "$HTTP_STATUS" "200" "Import link types"
assert_contains "$HTTP_BODY" '"summary"' "Import has summary"
assert_contains "$HTTP_BODY" '"skipped"' "Import has skipped list"

# Validation: missing linkTypes
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/import" '{}'
assert_status "$HTTP_STATUS" "400" "Reject import without linkTypes"

# Clean up the imported link
do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/importedLink"

# ===========================================================================
# Phase 8: Bulk Count (Task 16)
# ===========================================================================

section "Bulk Count (Task 16)"

do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/bulkCount" \
  "{\"requests\":[{\"linkTypeApiName\":\"companyEmployees\",\"objectPK\":\"c1\",\"direction\":\"forward\"},{\"linkTypeApiName\":\"employeeCompany\",\"objectPK\":\"e1\",\"direction\":\"forward\"}]}"
assert_status "$HTTP_STATUS" "200" "Bulk count returns 200"
assert_contains "$HTTP_BODY" '"results"' "Has results array"

# With objectTypeApiName + objectPK
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/bulkCount" \
  "{\"objectTypeApiName\":\"Company\",\"objectPK\":\"c1\"}"
assert_status "$HTTP_STATUS" "200" "Bulk count by object type"

# Validation: missing params
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/bulkCount" '{}'
assert_status "$HTTP_STATUS" "400" "Reject bulkCount without params"

# ===========================================================================
# Phase 9: Multi-Hop (Task 22)
# ===========================================================================

section "Multi-Hop Link Traversal (Task 22)"

do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/multiHop" \
  "{\"startingPKs\":[\"c1\"],\"steps\":[{\"linkTypeApiName\":\"companyEmployees\",\"direction\":\"forward\"}]}"
assert_status "$HTTP_STATUS" "200" "Multi-hop single step"
assert_contains "$HTTP_BODY" '"hopsCompleted"' "Has hopsCompleted"

# Validation: missing startingPKs
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/multiHop" \
  '{"steps":[{"linkTypeApiName":"companyEmployees","direction":"forward"}]}'
assert_status "$HTTP_STATUS" "400" "Reject multi-hop without startingPKs"

# Validation: missing steps
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/multiHop" \
  '{"startingPKs":["c1"]}'
assert_status "$HTTP_STATUS" "400" "Reject multi-hop without steps"

# ===========================================================================
# Phase 10: Resolve / Count / SearchAround (Tasks 12-15)
# ===========================================================================

section "Resolve, Count, SearchAround (Tasks 12-15)"

# Resolve
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/companyEmployees/resolve" \
  '{"objectPK":"c1","direction":"forward"}'
assert_status "$HTTP_STATUS" "200" "Resolve forward"
assert_contains "$HTTP_BODY" '"linkedObjects"' "Has linkedObjects"

# Resolve — missing fields
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/companyEmployees/resolve" '{}'
assert_status "$HTTP_STATUS" "400" "Reject resolve without objectPK"

# Resolve — invalid direction
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/companyEmployees/resolve" \
  '{"objectPK":"c1","direction":"sideways"}'
assert_status "$HTTP_STATUS" "400" "Reject invalid direction"

# Count
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/companyEmployees/count" \
  '{"objectPK":"c1","direction":"forward"}'
assert_status "$HTTP_STATUS" "200" "Count forward"
assert_contains "$HTTP_BODY" '"count"' "Has count field"

# Count — missing fields
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/companyEmployees/count" '{}'
assert_status "$HTTP_STATUS" "400" "Reject count without objectPK"

# SearchAround
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/companyEmployees/searchAround" \
  '{"direction":"forward"}'
assert_status "$HTTP_STATUS" "200" "SearchAround forward"
assert_contains "$HTTP_BODY" '"linkedObjects"' "SearchAround has linkedObjects"

# SearchAround — missing direction
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/companyEmployees/searchAround" '{}'
assert_status "$HTTP_STATUS" "400" "Reject searchAround without direction"

# Validate join table (Task 18)
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeDepartments/validate" '{}'
assert_status "$HTTP_STATUS" "200" "Validate join table (no file)"
assert_contains "$HTTP_BODY" '"valid"' "Has valid field"

# Cardinality migration validation (Task 24)
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/companyEmployees/validateMigration" \
  '{"targetCardinality":"ONE_TO_ONE"}'
assert_status "$HTTP_STATUS" "200" "Validate migration"
assert_contains "$HTTP_BODY" '"canMigrate"' "Has canMigrate"

# Validate migration — missing targetCardinality
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/companyEmployees/validateMigration" '{}'
assert_status "$HTTP_STATUS" "400" "Reject migration without targetCardinality"

# ===========================================================================
# Phase 11: Object-level link endpoints (Tasks 12, 15)
# ===========================================================================

section "Object-Level Link Endpoints"

# GET /api/v1/objects/:objectType/:pk/links/:linkType
do_request GET "/api/v1/objects/Company/c1/links/companyEmployees"
assert_status "$HTTP_STATUS" "200" "Object link resolution via GET"
assert_contains "$HTTP_BODY" '"linkedObjects"' "Has linkedObjects array"

# GET /api/v1/objects/:objectType/:pk/links/:linkType/count
do_request GET "/api/v1/objects/Company/c1/links/companyEmployees/count"
assert_status "$HTTP_STATUS" "200" "Object link count via GET"
assert_contains "$HTTP_BODY" '"count"' "Has count field"

# 404 for non-existent object type
do_request GET "/api/v1/objects/NonExistent/pk1/links/someLink"
assert_status "$HTTP_STATUS" "404" "404 for non-existent object type"

# 404 for non-existent link type
do_request GET "/api/v1/objects/Company/c1/links/nonExistentLink"
assert_status "$HTTP_STATUS" "404" "404 for non-existent link type"

# ===========================================================================
# Phase 12: Delete Link Type (Task 6)
# ===========================================================================

section "Delete Link Type (Task 6)"

# Delete one link type
do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeCompany"
assert_status "$HTTP_STATUS" "200" "Delete employeeCompany"
assert_contains "$HTTP_BODY" '"deletedAt"' "Has deletedAt timestamp"

# Verify it's gone
do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/employeeCompany"
assert_status "$HTTP_STATUS" "404" "Deleted link type returns 404"

# Delete non-existent
do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/doesNotExist"
assert_status "$HTTP_STATUS" "404" "404 for deleting non-existent"

# ===========================================================================
# Phase 13: Cleanup
# ===========================================================================

section "Cleanup"

# Singleton deployment: the ontology cannot be deleted (frozen → 409), so
# clean up the specific object/link types this suite created instead.
for lt_name in $THURSDAY_LINK_TYPES; do
  do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes/${lt_name}"
done
for ot_name in $THURSDAY_OBJECT_TYPES; do
  do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/${ot_name}"
done

# Ontology delete is frozen under the singleton deployment.
do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}"
if [[ "$HTTP_STATUS" == "200" || "$HTTP_STATUS" == "204" || "$HTTP_STATUS" == "409" ]]; then
  pass "Cleaned up test artifacts (ontology frozen: $HTTP_STATUS)"
else
  fail "Cleanup test ontology [HTTP $HTTP_STATUS]"
fi

# ===========================================================================
# Report
# ===========================================================================

print_report
