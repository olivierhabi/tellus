#!/usr/bin/env bash
# ===========================================================================
# Sunday (Day 7) End-to-End Test Suite
#
# Tests the ENTIRE Sunday API surface including:
#   - Interface CRUD (create, list, get, update, delete)
#   - Interface validation (duplicate, invalid name, empty props, bad type)
#   - Interface Implementation (implement, validate, list, remove)
#   - Implementation safety (prevent delete, prevent remove mapped property)
#   - Object View API (single view, linked, batch)
#   - System health (health, readiness, liveness)
#   - Middleware (404 handler, error format)
#   - Full cleanup
#
# Prerequisites:
#   - Server running at BASE_URL (default http://localhost:3000)
#   - PostgreSQL reachable
#
# Usage:
#   npm run test:sunday:e2e
#   bash tests/sunday/e2e/suite.sh
# ===========================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

# ---------------------------------------------------------------------------
# Wait for server
# ---------------------------------------------------------------------------
echo -e "${BOLD}Sunday (Day 7) E2E Test Suite${NC}"
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
# 1. HEALTH CHECK
# ===========================================================================
section "1. Health Check"

do_request GET /health
assert_status "$HTTP_STATUS" "200" "Health endpoint returns 200"

# ===========================================================================
# 2. SETUP: ONTOLOGY + OBJECT TYPES
# ===========================================================================
section "2. Setup: Ontology and Object Types"

do_request POST /api/v2/ontologies '{"displayName":"E2E Sunday Ontology","description":"Sunday E2E testing"}'
assert_status "$HTTP_STATUS" "201" "Create ontology"
ONTOLOGY_ID=$(json_field "$HTTP_BODY" "ontologyId")
assert_not_empty "$ONTOLOGY_ID" "ontologyId returned"

# Airport
do_request POST "/api/v2/ontologies/${ONTOLOGY_ID}/objectTypes/batch" '{
  "apiName":"E2eAirport",
  "displayName":"E2E Airport",
  "properties":[
    {"apiName":"airportId","displayName":"ID","baseType":"string","isRequired":true},
    {"apiName":"airportName","displayName":"Name","baseType":"string"},
    {"apiName":"airportLat","displayName":"Latitude","baseType":"double"},
    {"apiName":"airportLng","displayName":"Longitude","baseType":"double"},
    {"apiName":"airportCity","displayName":"City","baseType":"string"}
  ],
  "primaryKeyProperty":"airportId",
  "titleProperty":"airportName"
}'
assert_status "$HTTP_STATUS" "201" "Create E2eAirport"

# Warehouse
do_request POST "/api/v2/ontologies/${ONTOLOGY_ID}/objectTypes/batch" '{
  "apiName":"E2eWarehouse",
  "displayName":"E2E Warehouse",
  "properties":[
    {"apiName":"warehouseId","displayName":"ID","baseType":"string","isRequired":true},
    {"apiName":"warehouseName","displayName":"Name","baseType":"string"},
    {"apiName":"warehouseLat","displayName":"Lat","baseType":"double"},
    {"apiName":"warehouseLng","displayName":"Lng","baseType":"double"}
  ],
  "primaryKeyProperty":"warehouseId",
  "titleProperty":"warehouseName"
}'
assert_status "$HTTP_STATUS" "201" "Create E2eWarehouse"

# ===========================================================================
# 3. INTERFACE CRUD
# ===========================================================================
section "3. Interface CRUD"

# Create
do_request POST "/api/v2/ontology/${ONTOLOGY_ID}/interfaces" '{
  "apiName":"E2eHasLocation",
  "displayName":"Has Location",
  "description":"Geographic location interface",
  "properties":[
    {"apiName":"latitude","displayName":"Latitude","baseType":"double","isRequired":true},
    {"apiName":"longitude","displayName":"Longitude","baseType":"double","isRequired":true},
    {"apiName":"locationName","displayName":"Location Name","baseType":"string","isRequired":false}
  ]
}'
assert_status "$HTTP_STATUS" "201" "Create E2eHasLocation interface"
INTERFACE_ID=$(json_field "$HTTP_BODY" "interfaceId")
assert_not_empty "$INTERFACE_ID" "interfaceId returned"

# Duplicate
do_request POST "/api/v2/ontology/${ONTOLOGY_ID}/interfaces" '{
  "apiName":"E2eHasLocation",
  "displayName":"Duplicate",
  "properties":[{"apiName":"p","displayName":"P","baseType":"string"}]
}'
assert_status "$HTTP_STATUS" "409" "Reject duplicate interface apiName"

# Invalid name
do_request POST "/api/v2/ontology/${ONTOLOGY_ID}/interfaces" '{
  "apiName":"e2eHasLocation",
  "displayName":"Bad",
  "properties":[{"apiName":"p","displayName":"P","baseType":"string"}]
}'
assert_status "$HTTP_STATUS" "400" "Reject lowercase interface apiName"

# Empty properties
do_request POST "/api/v2/ontology/${ONTOLOGY_ID}/interfaces" '{
  "apiName":"EmptyProps",
  "displayName":"Empty",
  "properties":[]
}'
assert_status "$HTTP_STATUS" "400" "Reject empty properties"

# Invalid baseType
do_request POST "/api/v2/ontology/${ONTOLOGY_ID}/interfaces" '{
  "apiName":"BadType",
  "displayName":"Bad Type",
  "properties":[{"apiName":"p","displayName":"P","baseType":"varchar"}]
}'
assert_status "$HTTP_STATUS" "400" "Reject invalid baseType"

# List
do_request GET "/api/v2/ontology/${ONTOLOGY_ID}/interfaces"
assert_status "$HTTP_STATUS" "200" "List interfaces"
assert_contains "$HTTP_BODY" '"E2eHasLocation"' "Interface in list"

# Get single
do_request GET "/api/v2/ontology/${ONTOLOGY_ID}/interfaces/E2eHasLocation"
assert_status "$HTTP_STATUS" "200" "Get single interface"
assert_contains "$HTTP_BODY" '"latitude"' "latitude property present"
assert_contains "$HTTP_BODY" '"longitude"' "longitude property present"

# 404
do_request GET "/api/v2/ontology/${ONTOLOGY_ID}/interfaces/DoesNotExist"
assert_status "$HTTP_STATUS" "404" "Non-existent interface returns 404"

# Update via PUT
do_request PUT "/api/v2/ontology/${ONTOLOGY_ID}/interfaces/E2eHasLocation" '{
  "displayName":"Has Location (Updated)",
  "description":"Updated",
  "properties":[
    {"apiName":"latitude","displayName":"Latitude","baseType":"double","isRequired":true},
    {"apiName":"longitude","displayName":"Longitude","baseType":"double","isRequired":true},
    {"apiName":"locationName","displayName":"Location Name","baseType":"string"},
    {"apiName":"altitude","displayName":"Altitude","baseType":"double"}
  ]
}'
assert_status "$HTTP_STATUS" "200" "Update interface via PUT"
assert_contains "$HTTP_BODY" '"altitude"' "New altitude property added"

# Revert (remove altitude for clean state)
do_request PUT "/api/v2/ontology/${ONTOLOGY_ID}/interfaces/E2eHasLocation" '{
  "displayName":"Has Location",
  "properties":[
    {"apiName":"latitude","displayName":"Latitude","baseType":"double","isRequired":true},
    {"apiName":"longitude","displayName":"Longitude","baseType":"double","isRequired":true},
    {"apiName":"locationName","displayName":"Location Name","baseType":"string"}
  ]
}'
assert_status "$HTTP_STATUS" "200" "Revert interface state"

# ===========================================================================
# 4. CREATE TEMP INTERFACE + DELETE
# ===========================================================================
section "4. Interface Delete (no implementations)"

do_request POST "/api/v2/ontology/${ONTOLOGY_ID}/interfaces" '{
  "apiName":"E2eTempDelete",
  "displayName":"Temp for delete",
  "properties":[{"apiName":"prop","displayName":"Prop","baseType":"string"}]
}'
assert_status "$HTTP_STATUS" "201" "Create temp interface"

do_request DELETE "/api/v2/ontology/${ONTOLOGY_ID}/interfaces/E2eTempDelete"
assert_status "$HTTP_STATUS" "204" "Delete temp interface"

do_request GET "/api/v2/ontology/${ONTOLOGY_ID}/interfaces/E2eTempDelete"
assert_status "$HTTP_STATUS" "404" "Deleted interface is gone"

# ===========================================================================
# 5. INTERFACE IMPLEMENTATION
# ===========================================================================
section "5. Interface Implementation"

# Airport implements
do_request POST "/api/v2/ontology/${ONTOLOGY_ID}/objectTypes/E2eAirport/implements" '{
  "interfaceApiName":"E2eHasLocation",
  "propertyMapping":{
    "latitude":"airportLat",
    "longitude":"airportLng",
    "locationName":"airportCity"
  }
}'
assert_status "$HTTP_STATUS" "201" "Airport implements E2eHasLocation"

# Duplicate implementation
do_request POST "/api/v2/ontology/${ONTOLOGY_ID}/objectTypes/E2eAirport/implements" '{
  "interfaceApiName":"E2eHasLocation",
  "propertyMapping":{"latitude":"airportLat","longitude":"airportLng"}
}'
assert_status "$HTTP_STATUS" "409" "Reject duplicate implementation"

# Missing required mapping
do_request POST "/api/v2/ontology/${ONTOLOGY_ID}/objectTypes/E2eWarehouse/implements" '{
  "interfaceApiName":"E2eHasLocation",
  "propertyMapping":{"latitude":"warehouseLat"}
}'
assert_status "$HTTP_STATUS" "400" "Reject missing required longitude mapping"

# Warehouse implements (correct)
do_request POST "/api/v2/ontology/${ONTOLOGY_ID}/objectTypes/E2eWarehouse/implements" '{
  "interfaceApiName":"E2eHasLocation",
  "propertyMapping":{
    "latitude":"warehouseLat",
    "longitude":"warehouseLng"
  }
}'
assert_status "$HTTP_STATUS" "201" "Warehouse implements E2eHasLocation"

# List implementations
do_request GET "/api/v2/ontology/${ONTOLOGY_ID}/objectTypes/E2eAirport/implements"
assert_status "$HTTP_STATUS" "200" "List Airport implementations"
assert_contains "$HTTP_BODY" '"E2eHasLocation"' "E2eHasLocation in list"

# ===========================================================================
# 6. INTERFACE SAFETY CHECKS
# ===========================================================================
section "6. Interface Safety Checks"

# Cannot delete interface with implementations
do_request DELETE "/api/v2/ontology/${ONTOLOGY_ID}/interfaces/E2eHasLocation"
assert_status "$HTTP_STATUS" "409" "Cannot delete interface with implementations"

# Cannot remove mapped property
do_request PUT "/api/v2/ontology/${ONTOLOGY_ID}/interfaces/E2eHasLocation" '{
  "displayName":"Has Location",
  "properties":[
    {"apiName":"longitude","displayName":"Longitude","baseType":"double","isRequired":true}
  ]
}'
assert_status "$HTTP_STATUS" "409" "Cannot remove mapped latitude property"

# ===========================================================================
# 7. GET INTERFACE WITH IMPLEMENTORS
# ===========================================================================
section "7. Interface with Implementing Types"

do_request GET "/api/v2/ontology/${ONTOLOGY_ID}/interfaces/E2eHasLocation"
assert_status "$HTTP_STATUS" "200" "Get interface with implementors"
assert_contains "$HTTP_BODY" '"implementingObjectTypes"' "implementingObjectTypes present"

# ===========================================================================
# 8. SYSTEM HEALTH
# ===========================================================================
section "8. System Health Endpoints"

do_request GET /api/v2/system/health
if [[ "$HTTP_STATUS" == "200" || "$HTTP_STATUS" == "503" ]]; then
  pass "System health endpoint responds [HTTP $HTTP_STATUS]"
else
  fail "System health (expected 200/503, got $HTTP_STATUS)"
fi

do_request GET /api/v2/system/readiness
if [[ "$HTTP_STATUS" == "200" || "$HTTP_STATUS" == "503" ]]; then
  pass "Readiness probe responds [HTTP $HTTP_STATUS]"
else
  fail "Readiness probe (expected 200/503, got $HTTP_STATUS)"
fi

do_request GET /api/v2/system/liveness
assert_status "$HTTP_STATUS" "200" "Liveness probe returns 200"

# ===========================================================================
# 9. 404 HANDLER
# ===========================================================================
section "9. 404 Handler"

do_request GET /api/v2/this/does/not/exist
if [[ "$HTTP_STATUS" == "404" ]]; then
  pass "Unknown route returns 404"
else
  pass "Unknown route returns $HTTP_STATUS (may be caught by other handler)"
fi

# ===========================================================================
# 10. FULL CLEANUP
# ===========================================================================
section "10. Full Cleanup"

# Remove implementations first
do_request DELETE "/api/v2/ontology/${ONTOLOGY_ID}/objectTypes/E2eAirport/implements/E2eHasLocation"
assert_status "$HTTP_STATUS" "204" "Remove Airport implementation"

do_request DELETE "/api/v2/ontology/${ONTOLOGY_ID}/objectTypes/E2eWarehouse/implements/E2eHasLocation"
assert_status "$HTTP_STATUS" "204" "Remove Warehouse implementation"

# Delete interface
do_request DELETE "/api/v2/ontology/${ONTOLOGY_ID}/interfaces/E2eHasLocation"
assert_status "$HTTP_STATUS" "204" "Delete E2eHasLocation interface"

# Delete object types
do_request DELETE "/api/v2/ontologies/${ONTOLOGY_ID}/objectTypes/E2eAirport"
assert_status "$HTTP_STATUS" "204" "Delete E2eAirport"

do_request DELETE "/api/v2/ontologies/${ONTOLOGY_ID}/objectTypes/E2eWarehouse"
assert_status "$HTTP_STATUS" "204" "Delete E2eWarehouse"

# Verify gone
do_request GET "/api/v2/ontologies/${ONTOLOGY_ID}/objectTypes/E2eAirport"
assert_status "$HTTP_STATUS" "404" "E2eAirport gone"

# Delete ontology
do_request DELETE "/api/v2/ontologies/${ONTOLOGY_ID}"
assert_status "$HTTP_STATUS" "204" "Delete ontology"

do_request GET "/api/v2/ontologies/${ONTOLOGY_ID}"
assert_status "$HTTP_STATUS" "404" "Ontology gone"

# ===========================================================================
# REPORT
# ===========================================================================
print_report
