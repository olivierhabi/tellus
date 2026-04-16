#!/usr/bin/env bash
# ===========================================================================
# Friday (Day 5) End-to-End Test Suite
#
# Tests the ENTIRE Friday API surface including:
#   - Action Type CRUD (create, list, get, update, clone, impact, delete)
#   - Action Type validation (missing fields, bad rules, duplicates)
#   - Action execution — happy paths (registerTaxpayer, fileTaxReturn,
#     flagForAudit, updateTaxpayerRiskScore, registerBusiness)
#   - Action execution — error cases (duplicate PK, bad ref, constraint
#     violation, missing required params)
#   - Validate / dry-run (preview without side effects)
#   - Batch execution (mixed success/failure, oversized batch rejection)
#   - Idempotency (cached response on retry)
#   - Optimistic concurrency control (expected version check)
#   - Audit log (global log, per-entry lookup, per-action-type, stats)
#   - Edit history (per-object, paginated)
#   - OpenAPI spec + Swagger UI docs
#   - Rate limiting
#   - Cleanup
#
# Prerequisites:
#   - Server running at BASE_URL (default http://localhost:3000)
#   - PostgreSQL and OpenSearch both reachable
#   - Seed ontology with Taxpayer, TaxReturn, Business object types
#
# Usage:
#   npm run test:friday:e2e
#   bash tests/friday/e2e/suite.sh
#   BASE_URL=http://host:8080 bash tests/friday/e2e/suite.sh
#
# Exit code: 0 if all pass, 1 if any fail.
# ===========================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

# ---------------------------------------------------------------------------
# Generate unique suffix for this run
# ---------------------------------------------------------------------------
SUFFIX=$(date +%s | tail -c 5)
CUSTOM_ACTION="e2eFridayCustom${SUFFIX}"
CLONE_ACTION="e2eFridayClone${SUFFIX}"
TEST_TIN="88001${SUFFIX}"
TEST_TIN_2="88002${SUFFIX}"
TEST_RETURN_ID="E2EFRI${SUFFIX}R1"
TEST_BUSINESS_ID="E2EFRI${SUFFIX}B1"
IDEM_TIN="88003${SUFFIX}"
DELETE_TIN="88004${SUFFIX}"
DELETE_RETURN_ID="E2EFRI${SUFFIX}D1"

# Will be populated after discovering ontology
ONTOLOGY_ID=""
EXEC_IDS=()

# ---------------------------------------------------------------------------
# Wait for server to be ready
# ---------------------------------------------------------------------------
echo -e "${BOLD}Friday (Day 5) E2E Test Suite${NC}"
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
# 0. DISCOVER ONTOLOGY
# ===========================================================================
section "0. Discover Seed Ontology"

do_request GET /api/v1/ontology
assert_status "$HTTP_STATUS" "200" "List ontologies"
ONTOLOGY_ID=$(json_field "$HTTP_BODY" "ontologyId")
assert_not_empty "$ONTOLOGY_ID" "Seed ontology ID discovered"
echo "  Using ontologyId: $ONTOLOGY_ID"

# ===========================================================================
# 1. ACTION TYPE CRUD
# ===========================================================================
section "1. Action Type CRUD"

# --- 1.1 Create custom action type ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actionTypes" '{
  "apiName":"'"${CUSTOM_ACTION}"'",
  "displayName":"E2E Friday Custom Action",
  "description":"Custom action type for Friday E2E testing",
  "parameters":[
    {"apiName":"targetTin","displayName":"Target TIN","type":"string","required":true},
    {"apiName":"score","displayName":"Score","type":"double","required":true,"constraints":{"min":0,"max":100}},
    {"apiName":"notes","displayName":"Notes","type":"string","required":false}
  ],
  "rules":[
    {
      "type":"modifyObject",
      "objectType":"Taxpayer",
      "objectReference":{"source":"parameter","param":"targetTin"},
      "properties":{
        "riskScore":{"source":"parameter","param":"score"}
      }
    }
  ]
}'
assert_status "$HTTP_STATUS" "201" "Create custom action type"
assert_contains "$HTTP_BODY" "\"${CUSTOM_ACTION}\"" "apiName in response"
assert_contains "$HTTP_BODY" '"actionTypeId"' "actionTypeId present"
assert_contains "$HTTP_BODY" '"parameters"' "parameters present"
assert_contains "$HTTP_BODY" '"rules"' "rules present"
assert_contains "$HTTP_BODY" '"isEnabled"' "isEnabled present"
assert_contains "$HTTP_BODY" '"createdAt"' "createdAt present"

# --- 1.2 List action types ---
do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/actionTypes"
assert_status "$HTTP_STATUS" "200" "List action types"
assert_contains "$HTTP_BODY" '"data"' "data array present"
assert_contains "$HTTP_BODY" '"registerTaxpayer"' "Seed action type in list"
assert_contains "$HTTP_BODY" "\"${CUSTOM_ACTION}\"" "Custom action type in list"

# --- 1.3 Get single action type ---
do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/actionTypes/registerTaxpayer"
assert_status "$HTTP_STATUS" "200" "Get registerTaxpayer"
assert_contains "$HTTP_BODY" '"registerTaxpayer"' "apiName matches"
assert_contains "$HTTP_BODY" '"parameters"' "Parameters present"
assert_contains "$HTTP_BODY" '"rules"' "Rules present"

# --- 1.4 Get non-existent action type ---
do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/actionTypes/nonExistentAction"
assert_status "$HTTP_STATUS" "404" "Non-existent action type returns 404"

# --- 1.5 Update action type (remove notes param — breaking change) ---
do_request PUT "/api/v1/ontology/${ONTOLOGY_ID}/actionTypes/${CUSTOM_ACTION}" '{
  "displayName":"E2E Friday Custom Action Updated",
  "parameters":[
    {"apiName":"targetTin","displayName":"Target TIN","type":"string","required":true},
    {"apiName":"score","displayName":"Score","type":"integer","required":true,"constraints":{"min":0,"max":100}}
  ]
}'
assert_status "$HTTP_STATUS" "200" "Update action type"
assert_contains "$HTTP_BODY" '"E2E Friday Custom Action Updated"' "Updated displayName"

# --- 1.6 Clone action type ---
# Delete clone target if it exists from prior run
do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/actionTypes/${CLONE_ACTION}"

do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actionTypes/registerTaxpayer/clone" \
  '{"newApiName":"'"${CLONE_ACTION}"'","newDisplayName":"Cloned Register TP"}'
assert_status "$HTTP_STATUS" "201" "Clone action type"
assert_contains "$HTTP_BODY" "\"${CLONE_ACTION}\"" "Clone apiName matches"
assert_contains "$HTTP_BODY" '"Cloned Register TP"' "Clone displayName matches"
assert_contains "$HTTP_BODY" '"parameters"' "Clone has parameters"
assert_contains "$HTTP_BODY" '"rules"' "Clone has rules"

# --- 1.7 Impact analysis ---
do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/actionTypes/flagForAudit/impact"
assert_status "$HTTP_STATUS" "200" "Impact analysis"
assert_contains "$HTTP_BODY" '"actionTypeApiName"' "actionTypeApiName in impact"
assert_contains "$HTTP_BODY" '"affectedObjectTypes"' "affectedObjectTypes present"
assert_contains "$HTTP_BODY" '"TaxReturn"' "TaxReturn in affected types"
assert_contains "$HTTP_BODY" '"Taxpayer"' "Taxpayer in affected types"
assert_contains "$HTTP_BODY" '"executionStats"' "executionStats present"

# ===========================================================================
# 2. ACTION TYPE VALIDATION
# ===========================================================================
section "2. Action Type Validation"

# --- Missing required fields ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actionTypes" '{}'
assert_status "$HTTP_STATUS" "400" "Empty body returns 400"

# --- Missing rules ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actionTypes" '{
  "apiName":"noRulesAction",
  "displayName":"No Rules",
  "rules":[]
}'
assert_status "$HTTP_STATUS" "400" "Empty rules rejected"

# --- Duplicate apiName ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actionTypes" '{
  "apiName":"registerTaxpayer",
  "displayName":"Duplicate",
  "rules":[{"type":"createObject","objectType":"Taxpayer","properties":{}}]
}'
assert_status "$HTTP_STATUS" "409" "Duplicate apiName returns 409"

# --- Clone non-existent source ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actionTypes/nonExistent/clone" \
  '{"newApiName":"cloneFail"}'
assert_status "$HTTP_STATUS" "404" "Clone non-existent returns 404"

# ===========================================================================
# 3. ENSURE LINK TYPE (for registerBusiness)
# ===========================================================================
section "3. Setup: Ensure taxpayerBusiness Link Type"

do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/linkTypes" '{
  "apiName":"taxpayerBusiness",
  "displayName":"Taxpayer Business",
  "cardinality":"MANY_TO_MANY",
  "sourceObjectTypeApiName":"Taxpayer",
  "targetObjectTypeApiName":"Business",
  "isBidirectional":true
}'
# Accept 201 (created) or 409 (already exists)
if [[ "$HTTP_STATUS" == "201" || "$HTTP_STATUS" == "409" ]]; then
  pass "taxpayerBusiness link type exists [HTTP ${HTTP_STATUS}]"
else
  fail "Ensure taxpayerBusiness link type (expected 201 or 409, got $HTTP_STATUS)"
fi

# ===========================================================================
# 4. ACTION EXECUTION — HAPPY PATHS
# ===========================================================================
section "4. Action Execution — Happy Paths"

# --- 4.1 Create taxpayer ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/registerTaxpayer/apply" '{
  "parameters":{
    "tin":"'"${TEST_TIN}"'",
    "fullName":"E2E Friday Taxpayer",
    "taxpayerType":"Individual",
    "province":"Kigali"
  }
}'
assert_status "$HTTP_STATUS" "200" "Create taxpayer via action"
assert_contains "$HTTP_BODY" '"success"' "Result is success"
assert_contains "$HTTP_BODY" '"executionId"' "executionId present"
assert_contains "$HTTP_BODY" '"affectedObjects"' "affectedObjects present"
assert_contains "$HTTP_BODY" '"durationMs"' "durationMs present"
EXEC_ID=$(json_field "$HTTP_BODY" "executionId")
EXEC_IDS+=("$EXEC_ID")

sleep 1

# --- Verify object exists ---
do_request GET "/api/v1/objects/Taxpayer/${TEST_TIN}"
assert_status "$HTTP_STATUS" "200" "Taxpayer exists in OpenSearch"
assert_contains "$HTTP_BODY" "\"${TEST_TIN}\"" "TIN matches"
assert_contains "$HTTP_BODY" '"E2E Friday Taxpayer"' "fullName matches"
assert_contains "$HTTP_BODY" '"Individual"' "taxpayerType matches"
assert_contains "$HTTP_BODY" '"active"' "complianceStatus = active"

# --- 4.2 Create second taxpayer ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/registerTaxpayer/apply" '{
  "parameters":{
    "tin":"'"${TEST_TIN_2}"'",
    "fullName":"E2E Friday Secondary",
    "taxpayerType":"Corporate",
    "province":"Eastern"
  }
}'
assert_status "$HTTP_STATUS" "200" "Create second taxpayer"
EXEC_ID=$(json_field "$HTTP_BODY" "executionId")
EXEC_IDS+=("$EXEC_ID")

sleep 1

# --- 4.3 File tax return ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/fileTaxReturn/apply" '{
  "parameters":{
    "returnId":"'"${TEST_RETURN_ID}"'",
    "taxType":"VAT",
    "period":"2025-Q1",
    "declaredRevenue":50000000,
    "declaredTax":9000000
  }
}'
assert_status "$HTTP_STATUS" "200" "File tax return"
assert_contains "$HTTP_BODY" '"success"' "Tax return filed successfully"
EXEC_ID=$(json_field "$HTTP_BODY" "executionId")
EXEC_IDS+=("$EXEC_ID")

sleep 1

# --- Verify tax return ---
do_request GET "/api/v1/objects/TaxReturn/${TEST_RETURN_ID}"
assert_status "$HTTP_STATUS" "200" "TaxReturn exists"
assert_contains "$HTTP_BODY" '"VAT"' "taxType = VAT"
assert_contains "$HTTP_BODY" '"filed"' "status = filed"

# --- 4.4 Flag for audit (multi-object modification) ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/flagForAudit/apply" '{
  "parameters":{
    "returnRef":"'"${TEST_RETURN_ID}"'",
    "taxpayerRef":"'"${TEST_TIN}"'",
    "auditReason":"Income discrepancy detected"
  }
}'
assert_status "$HTTP_STATUS" "200" "Flag for audit"
assert_contains "$HTTP_BODY" '"success"' "Audit flag succeeded"
EXEC_ID=$(json_field "$HTTP_BODY" "executionId")
EXEC_IDS+=("$EXEC_ID")

sleep 1

# --- Verify TaxReturn was flagged ---
do_request GET "/api/v1/objects/TaxReturn/${TEST_RETURN_ID}"
assert_contains "$HTTP_BODY" '"auditFlag"' "auditFlag field present"

# --- Verify Taxpayer compliance status changed ---
do_request GET "/api/v1/objects/Taxpayer/${TEST_TIN}"
assert_contains "$HTTP_BODY" '"under_review"' "Compliance status changed to under_review"

# --- 4.5 Register business (create + link) ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/registerBusiness/apply" '{
  "parameters":{
    "businessId":"'"${TEST_BUSINESS_ID}"'",
    "tradeName":"E2E Friday Corp",
    "sector":"Technology",
    "ownerTin":"'"${TEST_TIN}"'"
  }
}'
assert_status "$HTTP_STATUS" "200" "Register business"
EXEC_ID=$(json_field "$HTTP_BODY" "executionId")
EXEC_IDS+=("$EXEC_ID")

sleep 1

# --- Verify business exists ---
do_request GET "/api/v1/objects/Business/${TEST_BUSINESS_ID}"
assert_status "$HTTP_STATUS" "200" "Business exists"
assert_contains "$HTTP_BODY" '"E2E Friday Corp"' "tradeName matches"
assert_contains "$HTTP_BODY" '"Technology"' "sector matches"

# ===========================================================================
# 5. ACTION EXECUTION — ERROR CASES
# ===========================================================================
section "5. Action Execution — Error Cases"

# --- 5.1 Duplicate primary key ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/registerTaxpayer/apply" '{
  "parameters":{
    "tin":"'"${TEST_TIN}"'",
    "fullName":"Duplicate",
    "taxpayerType":"Individual",
    "province":"Kigali"
  }
}'
assert_status "$HTTP_STATUS" "409" "Duplicate PK returns 409"
assert_contains "$HTTP_BODY" '"DUPLICATE_PRIMARY_KEY"' "Error code is DUPLICATE_PRIMARY_KEY"

# --- 5.2 Missing required parameters ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/registerTaxpayer/apply" '{
  "parameters":{}
}'
assert_status "$HTTP_STATUS" "400" "Missing required params returns 400"
assert_contains "$HTTP_BODY" '"INVALID_PARAMETER"' "Error code is INVALID_PARAMETER"

# --- 5.3 Constraint violation (riskScore > 100) ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/updateTaxpayerRiskScore/apply" '{
  "parameters":{
    "taxpayerRef":"'"${TEST_TIN}"'",
    "riskScore":150
  }
}'
assert_status "$HTTP_STATUS" "400" "Constraint violation returns 400"
assert_contains "$HTTP_BODY" '"INVALID_PARAMETER"' "Error code for constraint violation"

# --- 5.4 Non-existent object reference ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/updateTaxpayerRiskScore/apply" '{
  "parameters":{
    "taxpayerRef":"NONEXISTENT999",
    "riskScore":50
  }
}'
# Should fail with 400 (ref validation) or 404 (object not found)
if [[ "$HTTP_STATUS" == "400" || "$HTTP_STATUS" == "404" ]]; then
  pass "Non-existent ref rejected [HTTP ${HTTP_STATUS}]"
else
  fail "Non-existent ref rejected (expected 400 or 404, got $HTTP_STATUS)"
fi

# --- 5.5 Negative revenue (min constraint) ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/fileTaxReturn/apply" '{
  "parameters":{
    "returnId":"'"E2EFRI${SUFFIX}NEG"'",
    "taxType":"VAT",
    "period":"2025-Q2",
    "declaredRevenue":-1000,
    "declaredTax":0
  }
}'
assert_status "$HTTP_STATUS" "400" "Negative revenue rejected"

# --- 5.6 Non-existent action type ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/nonExistentAction/apply" '{
  "parameters":{}
}'
assert_status "$HTTP_STATUS" "404" "Non-existent action type returns 404"

# ===========================================================================
# 6. VALIDATE / DRY RUN
# ===========================================================================
section "6. Validate (Dry Run)"

VALIDATE_TIN="88099${SUFFIX}"

# --- 6.1 Valid action preview ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/registerTaxpayer/validate" '{
  "parameters":{
    "tin":"'"${VALIDATE_TIN}"'",
    "fullName":"Preview Only",
    "taxpayerType":"Individual",
    "province":"Kigali"
  }
}'
assert_status "$HTTP_STATUS" "200" "Validate returns 200"
assert_contains "$HTTP_BODY" '"valid"' "valid field present"
assert_contains "$HTTP_BODY" '"preview"' "preview field present"
assert_contains "$HTTP_BODY" '"affectedObjectCount"' "affectedObjectCount in preview"
assert_contains "$HTTP_BODY" '"edits"' "edits array in preview"

# --- Verify no object was actually created ---
sleep 1
do_request GET "/api/v1/objects/Taxpayer/${VALIDATE_TIN}"
assert_status "$HTTP_STATUS" "404" "Validated object NOT created (dry run)"

# --- 6.2 Invalid params validation ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/registerTaxpayer/validate" '{
  "parameters":{}
}'
assert_status "$HTTP_STATUS" "400" "Validate invalid params returns 400"
assert_contains "$HTTP_BODY" '"errors"' "errors array in validation response"

# --- 6.3 Constraint violation validation ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/updateTaxpayerRiskScore/validate" '{
  "parameters":{
    "taxpayerRef":"'"${TEST_TIN}"'",
    "riskScore":200
  }
}'
assert_status "$HTTP_STATUS" "400" "Validate constraint violation returns 400"

# ===========================================================================
# 7. BATCH EXECUTION
# ===========================================================================
section "7. Batch Execution"

# --- 7.1 Mixed success/failure batch ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/updateTaxpayerRiskScore/applyBatch" '{
  "requests":[
    {"parameters":{"taxpayerRef":"'"${TEST_TIN}"'","riskScore":50}},
    {"parameters":{"taxpayerRef":"000000000","riskScore":60}},
    {"parameters":{"taxpayerRef":"'"${TEST_TIN_2}"'","riskScore":70}}
  ]
}'
assert_status "$HTTP_STATUS" "200" "Batch execution returns 200"
assert_contains "$HTTP_BODY" '"batchId"' "batchId present"
assert_contains "$HTTP_BODY" '"totalRequests"' "totalRequests present"
assert_contains "$HTTP_BODY" '"successCount"' "successCount present"
assert_contains "$HTTP_BODY" '"failedCount"' "failedCount present"
assert_contains "$HTTP_BODY" '"results"' "results array present"
assert_contains "$HTTP_BODY" '"totalDurationMs"' "totalDurationMs present"

sleep 1

# --- 7.2 Oversized batch (> 100 items) ---
# Build a JSON array with 101 items
LARGE_BATCH='{"requests":['
for i in $(seq 1 101); do
  if [[ $i -gt 1 ]]; then LARGE_BATCH="${LARGE_BATCH},"; fi
  LARGE_BATCH="${LARGE_BATCH}{\"parameters\":{\"taxpayerRef\":\"${TEST_TIN}\",\"riskScore\":$((i % 100))}}"
done
LARGE_BATCH="${LARGE_BATCH}]}"

do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/updateTaxpayerRiskScore/applyBatch" "$LARGE_BATCH"
assert_status "$HTTP_STATUS" "400" "Oversized batch rejected"

# --- 7.3 Missing requests field ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/updateTaxpayerRiskScore/applyBatch" '{"notRequests":[]}'
assert_status "$HTTP_STATUS" "400" "Missing requests field returns 400"

# ===========================================================================
# 8. IDEMPOTENCY
# ===========================================================================
section "8. Idempotency"

IDEM_KEY="friday-e2e-idem-${SUFFIX}"

# --- 8.1 First execution ---
do_request_with_header POST \
  "/api/v1/ontology/${ONTOLOGY_ID}/actions/registerTaxpayer/apply" \
  "Idempotency-Key: ${IDEM_KEY}" \
  '{"parameters":{"tin":"'"${IDEM_TIN}"'","fullName":"Idempotent Test","taxpayerType":"Individual","province":"Kigali"}}'
assert_status "$HTTP_STATUS" "200" "First idempotent execution"
assert_contains "$HTTP_BODY" '"success"' "First execution succeeded"
FIRST_EXEC_ID=$(json_field "$HTTP_BODY" "executionId")
assert_not_empty "$FIRST_EXEC_ID" "First executionId present"

# --- 8.2 Retry with same key ---
do_request_with_header POST \
  "/api/v1/ontology/${ONTOLOGY_ID}/actions/registerTaxpayer/apply" \
  "Idempotency-Key: ${IDEM_KEY}" \
  '{"parameters":{"tin":"'"${IDEM_TIN}"'","fullName":"Idempotent Test","taxpayerType":"Individual","province":"Kigali"}}'
assert_status "$HTTP_STATUS" "200" "Idempotent retry returns 200"
RETRY_EXEC_ID=$(json_field "$HTTP_BODY" "executionId")
assert_eq "$RETRY_EXEC_ID" "$FIRST_EXEC_ID" "Retry returns same executionId"

# Check X-Idempotency-Cached header
CACHED=$(header_value "X-Idempotency-Cached")
assert_eq "$CACHED" "true" "X-Idempotency-Cached header is true"

# ===========================================================================
# 9. OPTIMISTIC CONCURRENCY CONTROL
# ===========================================================================
section "9. Optimistic Concurrency Control"

sleep 1

# --- 9.1 Get current version ---
do_request GET "/api/v1/objects/Taxpayer/${TEST_TIN}"
CURRENT_VERSION=$(json_field_raw "$HTTP_BODY" "__version")
assert_not_empty "$CURRENT_VERSION" "Current version found"

# --- 9.2 Update with correct version ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/updateTaxpayerRiskScore/apply" \
  '{"parameters":{"taxpayerRef":"'"${TEST_TIN}"'","riskScore":42},"$expectedVersion":'"${CURRENT_VERSION}"'}'
assert_status "$HTTP_STATUS" "200" "OCC update with correct version"
assert_contains "$HTTP_BODY" '"success"' "OCC update succeeded"
EXEC_ID=$(json_field "$HTTP_BODY" "executionId")
EXEC_IDS+=("$EXEC_ID")

sleep 1

# --- 9.3 Concurrent conflict (stale version) ---
do_request POST "/api/v1/ontology/${ONTOLOGY_ID}/actions/updateTaxpayerRiskScore/apply" \
  '{"parameters":{"taxpayerRef":"'"${TEST_TIN}"'","riskScore":60},"$expectedVersion":'"${CURRENT_VERSION}"'}'
assert_status "$HTTP_STATUS" "409" "Stale version returns 409"
assert_contains "$HTTP_BODY" '"CONCURRENCY_CONFLICT"' "Error code is CONCURRENCY_CONFLICT"

# ===========================================================================
# 10. AUDIT LOG
# ===========================================================================
section "10. Audit Log"

# --- 10.1 Get single audit entry ---
FIRST_EXEC="${EXEC_IDS[0]}"
do_request GET "/api/v1/audit/log/${FIRST_EXEC}"
assert_status "$HTTP_STATUS" "200" "Get audit entry by executionId"
assert_contains "$HTTP_BODY" '"executionId"' "executionId in audit entry"
assert_contains "$HTTP_BODY" '"actionTypeApiName"' "actionTypeApiName in entry"
assert_contains "$HTTP_BODY" '"result"' "result in entry"
assert_contains "$HTTP_BODY" '"executedAt"' "executedAt in entry"
assert_contains "$HTTP_BODY" '"durationMs"' "durationMs in entry"

# --- 10.2 Non-existent audit entry ---
do_request GET "/api/v1/audit/log/00000000-0000-0000-0000-000000000000"
assert_status "$HTTP_STATUS" "404" "Non-existent audit entry returns 404"

# --- 10.3 Global audit log with pagination ---
do_request GET "/api/v1/audit/log?\$pageSize=5"
assert_status "$HTTP_STATUS" "200" "Global audit log"
assert_contains "$HTTP_BODY" '"data"' "data array in audit log"
assert_contains "$HTTP_BODY" '"totalCount"' "totalCount in audit log"

# --- 10.4 Filter by result ---
do_request GET "/api/v1/audit/log?result=success&\$pageSize=10"
assert_status "$HTTP_STATUS" "200" "Filter audit log by result"

# --- 10.5 Per-action-type audit log ---
do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/actions/registerTaxpayer/audit?\$pageSize=10"
assert_status "$HTTP_STATUS" "200" "Per-action-type audit log"
assert_contains "$HTTP_BODY" '"data"' "data in per-action audit"
assert_contains "$HTTP_BODY" '"totalCount"' "totalCount in per-action audit"

# --- 10.6 Audit statistics ---
do_request GET "/api/v1/audit/stats"
assert_status "$HTTP_STATUS" "200" "Audit statistics"
assert_contains "$HTTP_BODY" '"period"' "period in stats"
assert_contains "$HTTP_BODY" '"totalExecutions"' "totalExecutions in stats"
assert_contains "$HTTP_BODY" '"results"' "results breakdown in stats"
assert_contains "$HTTP_BODY" '"timing"' "timing in stats"
assert_contains "$HTTP_BODY" '"topActionTypes"' "topActionTypes in stats"

# ===========================================================================
# 11. EDIT HISTORY
# ===========================================================================
section "11. Edit History"

# --- 11.1 Taxpayer edit history ---
do_request GET "/api/v1/objects/Taxpayer/${TEST_TIN}/editHistory"
assert_status "$HTTP_STATUS" "200" "Get taxpayer edit history"
assert_contains "$HTTP_BODY" '"objectType"' "objectType in response"
assert_contains "$HTTP_BODY" '"primaryKey"' "primaryKey in response"
assert_contains "$HTTP_BODY" '"data"' "data array present"
assert_contains "$HTTP_BODY" '"totalCount"' "totalCount present"

# --- 11.2 Edit history pagination ---
do_request GET "/api/v1/objects/Taxpayer/${TEST_TIN}/editHistory?\$pageSize=2"
assert_status "$HTTP_STATUS" "200" "Edit history with pageSize"

# --- 11.3 TaxReturn edit history ---
do_request GET "/api/v1/objects/TaxReturn/${TEST_RETURN_ID}/editHistory"
assert_status "$HTTP_STATUS" "200" "TaxReturn edit history"
assert_contains "$HTTP_BODY" '"data"' "Edit history data present"

# ===========================================================================
# 12. OPENAPI SPEC + SWAGGER UI
# ===========================================================================
section "12. OpenAPI Spec & Documentation"

# --- 12.1 OpenAPI spec ---
do_request GET /api/docs/spec.json
assert_status "$HTTP_STATUS" "200" "OpenAPI spec returns 200"
assert_contains "$HTTP_BODY" '"openapi"' "openapi field present"
assert_contains "$HTTP_BODY" '"3.0.3"' "OpenAPI version 3.0.3"
assert_contains "$HTTP_BODY" '"info"' "info block present"
assert_contains "$HTTP_BODY" '"paths"' "paths block present"
assert_contains "$HTTP_BODY" '"components"' "components block present"

# --- 12.2 Swagger UI ---
# Use raw curl since do_request expects JSON
SWAGGER_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/api/docs" 2>/dev/null)
assert_eq "$SWAGGER_STATUS" "200" "Swagger UI returns 200"

SWAGGER_HTML=$(curl -s "${BASE_URL}/api/docs" 2>/dev/null)
assert_contains "$SWAGGER_HTML" "swagger-ui" "Swagger UI HTML contains swagger-ui"

# ===========================================================================
# 13. RATE LIMITING
# ===========================================================================
section "13. Rate Limiting"

# Send rapid requests to closeTaxReturn to trigger rate limit.
# Per-action-type limit is 100/min by default.
# Skip this test when rate limits are elevated (e.g., CI or test:e2e runner).
ACTION_LIMIT="${ACTION_RATE_LIMIT_MAX:-100}"
if [[ "$ACTION_LIMIT" -gt 200 ]]; then
  pass "Rate limiter test skipped (ACTION_RATE_LIMIT_MAX=$ACTION_LIMIT is elevated)"
else
  RATE_LIMITED="false"
  for i in $(seq 1 120); do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
      -H "Content-Type: application/json" \
      -d '{"parameters":{"returnRef":"'"${TEST_RETURN_ID}"'"}}' \
      "${BASE_URL}/api/v1/ontology/${ONTOLOGY_ID}/actions/closeTaxReturn/apply" 2>/dev/null)
    if [[ "$STATUS" == "429" ]]; then
      RATE_LIMITED="true"
      break
    fi
  done

  assert_eq "$RATE_LIMITED" "true" "Rate limiter triggered (429 received)"
fi

# ===========================================================================
# 14. DELETE ACTION TYPE
# ===========================================================================
section "14. Delete Action Type"

# --- 14.1 Delete custom action type ---
do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/actionTypes/${CUSTOM_ACTION}"
assert_status "$HTTP_STATUS" "204" "Delete custom action type"

# --- 14.2 Verify deletion ---
do_request GET "/api/v1/ontology/${ONTOLOGY_ID}/actionTypes/${CUSTOM_ACTION}"
assert_status "$HTTP_STATUS" "404" "Deleted action type returns 404"

# --- 14.3 Delete non-existent returns 404 ---
do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/actionTypes/${CUSTOM_ACTION}"
assert_status "$HTTP_STATUS" "404" "Delete non-existent action type returns 404"

# ===========================================================================
# 15. CLEANUP
# ===========================================================================
section "15. Cleanup"

# Delete clone action type
do_request DELETE "/api/v1/ontology/${ONTOLOGY_ID}/actionTypes/${CLONE_ACTION}"
if [[ "$HTTP_STATUS" == "204" || "$HTTP_STATUS" == "404" ]]; then
  pass "Delete clone action type [HTTP ${HTTP_STATUS}]"
else
  fail "Delete clone action type (expected 204 or 404, got ${HTTP_STATUS})"
fi

# Note: We do NOT delete the seed ontology or object types — they are shared.
# Test data (taxpayer objects, tax returns, businesses) are left in place as
# they use unique suffixed keys and don't interfere with other tests.

pass "Cleanup complete"

# ===========================================================================
# REPORT
# ===========================================================================
print_report
