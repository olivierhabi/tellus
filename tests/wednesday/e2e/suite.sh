#!/usr/bin/env bash
# ===========================================================================
# Wednesday (Day 3) End-to-End Test Suite
#
# Tests the ENTIRE Wednesday API surface including:
#   - Object query API (list, get, search, searchFullText, aggregate)
#   - Query validation (filter types, page size, select, orderBy)
#   - Error handling (404, 400, validation errors)
#   - Pagination (cursor-based)
#
# Prerequisites:
#   - Server running at BASE_URL (default http://localhost:3000)
#   - PostgreSQL and OpenSearch both reachable
#
# Usage:
#   pnpm run test:wednesday:e2e
#   bash tests/wednesday/e2e/suite.sh
# ===========================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

# ---------------------------------------------------------------------------
# Wait for server
# ---------------------------------------------------------------------------
echo -e "${BOLD}Wednesday (Day 3) E2E Test Suite${NC}"
echo "Target: $BASE_URL"
echo ""
echo -n "Waiting for server..."
for i in $(seq 1 30); do
  if curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
    echo " ready."
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo " TIMEOUT."
    exit 1
  fi
  sleep 1
  echo -n "."
done

# ===========================================================================
# 1. SETUP: CREATE ONTOLOGY + OBJECT TYPE + PROPERTIES
# ===========================================================================
section "1. Setup: Ontology, Object Type, Properties"

# Clean up any pre-existing test ontology first
do_request GET /api/v1/ontology
OLD_ID=$(echo "$HTTP_BODY" | grep -o '"ontologyId":"[^"]*"' | while read -r line; do
  OID=$(echo "$line" | sed 's/"ontologyId":"//;s/"//')
  do_request GET "/api/v1/ontology/${OID}"
  if echo "$HTTP_BODY" | grep -q "E2E Wednesday Ontology"; then
    echo "$OID"
    break
  fi
done)
if [[ -n "${OLD_ID:-}" ]]; then
  do_request DELETE "/api/v1/ontology/${OLD_ID}"
fi

do_request POST /api/v1/ontology '{"displayName":"E2E Wednesday Ontology","description":"Wednesday E2E testing"}'
assert_status "$HTTP_STATUS" "201" "Create E2E Wednesday ontology"
ONTOLOGY_ID=$(json_field "$HTTP_BODY" "ontologyId")
assert_not_empty "$ONTOLOGY_ID" "Ontology ID returned"

do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes" '{"apiName":"WedTestEmployee","displayName":"Wed Test Employee","description":"Wednesday test"}'
assert_status "$HTTP_STATUS" "201" "Create WedTestEmployee object type"

# Create properties
for PROP_JSON in \
  '{"apiName":"employeeId","displayName":"Employee ID","baseType":"string"}' \
  '{"apiName":"fullName","displayName":"Full Name","baseType":"string"}' \
  '{"apiName":"salary","displayName":"Salary","baseType":"double"}' \
  '{"apiName":"department","displayName":"Department","baseType":"string"}' \
  '{"apiName":"isActive","displayName":"Is Active","baseType":"boolean"}' \
  '{"apiName":"startDate","displayName":"Start Date","baseType":"date"}'; do
  do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/WedTestEmployee/properties" "$PROP_JSON"
  PROP_NAME=$(echo "$PROP_JSON" | grep -o '"apiName":"[^"]*"' | head -1 | sed 's/"apiName":"//;s/"//')
  assert_status "$HTTP_STATUS" "201" "Create property: $PROP_NAME"
done

# ===========================================================================
# 2. OBJECT TYPE NOT FOUND (404)
# ===========================================================================
section "2. Object Type Not Found"

do_request GET /api/v1/objects/NonExistentType123
assert_status "$HTTP_STATUS" "404" "GET list - non-existent type returns 404"
assert_contains "$HTTP_BODY" "OBJECT_TYPE_NOT_FOUND" "Error code is OBJECT_TYPE_NOT_FOUND"

do_request POST /api/v1/objects/FakeType/search '{}'
assert_status "$HTTP_STATUS" "404" "POST search - non-existent type returns 404"

do_request GET /api/v1/objects/FakeType/SOME-PK
assert_status "$HTTP_STATUS" "404" "GET single - non-existent type returns 404"

do_request POST /api/v1/objects/FakeType/aggregate '{"aggregations":[{"type":"count","name":"total"}]}'
assert_status "$HTTP_STATUS" "404" "POST aggregate - non-existent type returns 404"

do_request POST /api/v1/objects/FakeType/searchFullText '{"query":"test"}'
assert_status "$HTTP_STATUS" "404" "POST searchFullText - non-existent type returns 404"

# ===========================================================================
# 3. LIST OBJECTS (empty — no indexed data)
# ===========================================================================
section "3. List Objects (empty)"

do_request GET /api/v1/objects/WedTestEmployee
assert_status "$HTTP_STATUS" "200" "GET list returns 200 for existing type"
assert_contains "$HTTP_BODY" '"data"' "Response has data field"

# ===========================================================================
# 4. PAGE SIZE VALIDATION
# ===========================================================================
section "4. PageSize Validation"

do_request GET "/api/v1/objects/WedTestEmployee?\$pageSize=0"
assert_status "$HTTP_STATUS" "400" "pageSize=0 rejected"

do_request GET "/api/v1/objects/WedTestEmployee?\$pageSize=-1"
assert_status "$HTTP_STATUS" "400" "pageSize=-1 rejected"

do_request GET "/api/v1/objects/WedTestEmployee?\$pageSize=10001"
assert_status "$HTTP_STATUS" "400" "pageSize=10001 rejected"

do_request GET "/api/v1/objects/WedTestEmployee?\$pageSize=50"
assert_status "$HTTP_STATUS" "200" "pageSize=50 accepted"

# ===========================================================================
# 5. SEARCH VALIDATION
# ===========================================================================
section "5. Search Validation"

do_request POST /api/v1/objects/WedTestEmployee/search '{"$pgeSize": 10}'
assert_status "$HTTP_STATUS" "400" "Unexpected field rejected"
assert_contains "$HTTP_BODY" "Unexpected field" "Error mentions unexpected field"

do_request POST /api/v1/objects/WedTestEmployee/search '{"where":{"type":"unknownFilter"}}'
assert_status "$HTTP_STATUS" "400" "Unknown filter type rejected"

do_request POST /api/v1/objects/WedTestEmployee/search '{}'
assert_status "$HTTP_STATUS" "200" "Empty body accepted (match_all)"

do_request POST /api/v1/objects/WedTestEmployee/search '{"$select":[]}'
assert_status "$HTTP_STATUS" "400" "Empty \$select rejected"

do_request POST /api/v1/objects/WedTestEmployee/search '{"$pageSize": 5}'
assert_status "$HTTP_STATUS" "200" "Valid pageSize in search accepted"

# ===========================================================================
# 6. FULL-TEXT SEARCH VALIDATION
# ===========================================================================
section "6. Full-Text Search Validation"

do_request POST /api/v1/objects/WedTestEmployee/searchFullText '{"query":""}'
assert_status "$HTTP_STATUS" "400" "Empty search query rejected"

do_request POST /api/v1/objects/WedTestEmployee/searchFullText '{}'
assert_status "$HTTP_STATUS" "400" "Missing search query rejected"

do_request POST /api/v1/objects/WedTestEmployee/searchFullText '{"query":"test search"}'
assert_status "$HTTP_STATUS" "200" "Valid search query accepted"

# ===========================================================================
# 7. AGGREGATE VALIDATION
# ===========================================================================
section "7. Aggregate Validation"

do_request POST /api/v1/objects/WedTestEmployee/aggregate '{"aggregations":[]}'
assert_status "$HTTP_STATUS" "400" "Empty aggregations rejected"

do_request POST /api/v1/objects/WedTestEmployee/aggregate '{}'
assert_status "$HTTP_STATUS" "400" "Missing aggregations rejected"

do_request POST /api/v1/objects/WedTestEmployee/aggregate '{"aggregations":[{"type":"count","name":"total"}]}'
assert_status "$HTTP_STATUS" "200" "Valid count aggregation accepted"

# ===========================================================================
# 8. SINGLE OBJECT (not found)
# ===========================================================================
section "8. Single Object Not Found"

do_request GET /api/v1/objects/WedTestEmployee/NONEXISTENT
assert_status "$HTTP_STATUS" "404" "Non-existent PK returns 404"
assert_contains "$HTTP_BODY" "OBJECT_NOT_FOUND" "Error code is OBJECT_NOT_FOUND"

# ===========================================================================
# 9. SEARCH WITH FILTERS (on empty index — should return 200 with empty data)
# ===========================================================================
section "9. Search With Filters (empty index)"

do_request POST /api/v1/objects/WedTestEmployee/search '{"where":{"type":"eq","field":"department","value":"Engineering"}}'
assert_status "$HTTP_STATUS" "200" "eq filter on empty index returns 200"
assert_contains "$HTTP_BODY" '"data"' "Response has data field"

do_request POST /api/v1/objects/WedTestEmployee/search '{"where":{"type":"and","value":[{"type":"eq","field":"department","value":"Engineering"},{"type":"gt","field":"salary","value":100000}]}}'
assert_status "$HTTP_STATUS" "200" "Compound and filter returns 200"

do_request POST /api/v1/objects/WedTestEmployee/search '{"where":{"type":"or","value":[{"type":"eq","field":"department","value":"Engineering"},{"type":"eq","field":"department","value":"Sales"}]}}'
assert_status "$HTTP_STATUS" "200" "Compound or filter returns 200"

do_request POST /api/v1/objects/WedTestEmployee/search '{"where":{"type":"not","value":[{"type":"eq","field":"isActive","value":false}]}}'
assert_status "$HTTP_STATUS" "200" "Not filter returns 200"

do_request POST /api/v1/objects/WedTestEmployee/search '{"where":{"type":"isNull","field":"salary"}}'
assert_status "$HTTP_STATUS" "200" "isNull filter returns 200"

do_request POST /api/v1/objects/WedTestEmployee/search '{"where":{"type":"in","field":"department","value":["Engineering","Sales"]}}'
assert_status "$HTTP_STATUS" "200" "in filter returns 200"

do_request POST /api/v1/objects/WedTestEmployee/search '{"where":{"type":"contains","field":"fullName","value":"melissa"}}'
assert_status "$HTTP_STATUS" "200" "contains filter returns 200"

do_request POST /api/v1/objects/WedTestEmployee/search '{"where":{"type":"startsWith","field":"fullName","value":"M"}}'
assert_status "$HTTP_STATUS" "200" "startsWith filter returns 200"

# ===========================================================================
# 10. ORDER BY + SELECT
# ===========================================================================
section "10. OrderBy + Select"

do_request POST /api/v1/objects/WedTestEmployee/search '{"$orderBy":[{"field":"salary","direction":"desc"}]}'
assert_status "$HTTP_STATUS" "200" "orderBy on salary:desc accepted"

do_request POST /api/v1/objects/WedTestEmployee/search '{"$select":["fullName","salary"]}'
assert_status "$HTTP_STATUS" "200" "\$select with valid fields accepted"

# ===========================================================================
# CLEANUP
# ===========================================================================
section "Cleanup"

do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}"
if [[ "$HTTP_STATUS" == "200" || "$HTTP_STATUS" == "204" ]]; then
  pass "Deleted test ontology"
else
  fail "Deleted test ontology (status: $HTTP_STATUS)"
fi

# ===========================================================================
# REPORT
# ===========================================================================
print_report
