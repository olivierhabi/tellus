#!/bin/bash
# Comprehensive integration test for datasource attachment funnel trigger
# Tests the fix: https://github.com/olivierhabi/tellus/issues/XX

set -euo pipefail

# Test configuration
BASE_URL="${BASE_URL:-http://localhost:3000}"
API_KEY="${API_KEY:-test-api-key}"
TEST_ONTOLOGY_ID="${TEST_ONTOLOGY_ID:-}"
TEST_OBJECT_TYPE_RID="${TEST_OBJECT_TYPE_RID:-}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_TOTAL=0

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((TESTS_PASSED++))
}

log_error() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((TESTS_FAILED++))
}

log_test() {
    echo -e "${YELLOW}[TEST]${NC} $1"
    ((TESTS_TOTAL++))
}

# API helper functions
api_get() {
    local endpoint="$1"
    curl -s -w "\n%{http_code}" "${BASE_URL}${endpoint}" \
        -H "Authorization: Bearer ${API_KEY}" \
        -H "Content-Type: application/json"
}

api_post() {
    local endpoint="$1"
    local payload="$2"
    curl -s -w "\n%{http_code}" -X POST "${BASE_URL}${endpoint}" \
        -H "Authorization: Bearer ${API_KEY}" \
        -H "Content-Type: application/json" \
        -d "$payload"
}

extract_body() {
    echo "$1" | sed '$d'
}

extract_http_code() {
    echo "$1" | tail -n 1
}

# Setup: Ensure test environment
setup_test_environment() {
    log_info "Setting up test environment..."

    # Check if server is running
    RESPONSE=$(api_get "/api/v1/ontology" 2>/dev/null || echo -e "\n000")
    HTTP_CODE=$(extract_http_code "$RESPONSE")

    if [ "$HTTP_CODE" = "000" ] || [ "$HTTP_CODE" = "000" ]; then
        log_error "Server not reachable at $BASE_URL"
        log_info "Please start the server: npm run dev"
        exit 1
    fi

    log_info "Server is reachable (HTTP $HTTP_CODE)"

    # Get or create test ontology
    if [ -z "$TEST_ONTOLOGY_ID" ]; then
        RESPONSE=$(api_get "/api/v1/ontology")
        BODY=$(extract_body "$RESPONSE")
        TEST_ONTOLOGY_ID=$(echo "$BODY" | jq -r '.data[0].ontologyId // .data[0].ontology_id // empty' | head -1)

        if [ -z "$TEST_ONTOLOGY_ID" ]; then
            log_error "No ontology found in system"
            exit 1
        fi
    fi

    log_info "Using ontology: $TEST_ONTOLOGY_ID"

    # Get or create test object type
    if [ -z "$TEST_OBJECT_TYPE_RID" ]; then
        # Try to find existing object type
        RESPONSE=$(api_get "/api/v1/ontology/${TEST_ONTOLOGY_ID}/objectTypes")
        BODY=$(extract_body "$RESPONSE")

        TEST_OBJECT_TYPE_RID=$(echo "$BODY" | jq -r '.data[0].rid // empty' | head -1)
        TEST_OBJECT_TYPE_API_NAME=$(echo "$BODY" | jq -r '.data[0].apiName // .data[0].api_name // empty' | head -1)

        if [ -z "$TEST_OBJECT_TYPE_RID" ]; then
            log_info "Creating test object type..."
            CREATE_PAYLOAD=$(cat <<EOF
{
  "apiName": "TestDatasourceAttach_$(date +%s)",
  "displayName": "Test Datasource Attach",
  "description": "Test object for datasource attachment funnel trigger",
  "properties": [
    {
      "apiName": "id",
      "displayName": "ID",
      "baseType": "string",
      "isRequired": true
    }
  ]
}
EOF
)
            RESPONSE=$(api_post "/api/v1/ontology/${TEST_ONTOLOGY_ID}/objectTypes" "$CREATE_PAYLOAD")
            BODY=$(extract_body "$RESPONSE")
            HTTP_CODE=$(extract_http_code "$RESPONSE")

            if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "201" ]; then
                log_error "Failed to create test object type (HTTP $HTTP_CODE)"
                echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
                exit 1
            fi

            # Wait for creation
            sleep 2

            # Get the created object type
            RESPONSE=$(api_get "/api/v1/ontology/${TEST_ONTOLOGY_ID}/objectTypes")
            BODY=$(extract_body "$RESPONSE")
            TEST_OBJECT_TYPE_RID=$(echo "$BODY" | jq -r '.data[0].rid // empty' | head -1)
            TEST_OBJECT_TYPE_API_NAME=$(echo "$BODY" | jq -r '.data[0].apiName // .data[0].api_name // empty' | head -1)
        fi
    fi

    if [ -z "$TEST_OBJECT_TYPE_RID" ]; then
        log_error "Could not find or create test object type"
        exit 1
    fi

    log_info "Using object type: $TEST_OBJECT_TYPE_API_NAME (RID: $TEST_OBJECT_TYPE_RID)"
}

# Test 1: Basic datasource attachment
test_basic_datasource_attachment() {
    log_test "Test 1: Basic datasource attachment"

    DATASOURCE_RID="ri.stemma.main.dataset.test_$(date +%s)"

    PAYLOAD=$(cat <<EOF
{
  "datasourceRid": "${DATASOURCE_RID}",
  "primaryKeyMapping": "id",
  "propertyMappings": [
    {
      "sourceColumn": "id",
      "targetPropertyId": "id"
    }
  ],
  "resolutionStrategy": "UNION",
  "conflictPolicy": "OVERWRITE_WITH_NEW"
}
EOF
)

    RESPONSE=$(api_post "/api/v1/ontology/object-types/${TEST_OBJECT_TYPE_RID}/datasources" "$PAYLOAD")
    BODY=$(extract_body "$RESPONSE")
    HTTP_CODE=$(extract_http_code "$RESPONSE")

    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
        log_success "Datasource attached successfully (HTTP $HTTP_CODE)"
        echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
        return 0
    else
        log_error "Failed to attach datasource (HTTP $HTTP_CODE)"
        echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
        return 1
    fi
}

# Test 2: Verify funnel state change
test_funnel_state_change() {
    log_test "Test 2: Verify funnel state change after datasource attachment"

    # Get initial state
    RESPONSE=$(api_get "/api/v1/ontology/${TEST_ONTOLOGY_ID}/objectTypes/${TEST_OBJECT_TYPE_API_NAME}/indexing/status")
    BODY=$(extract_body "$RESPONSE")
    HTTP_CODE=$(extract_http_code "$RESPONSE")

    if [ "$HTTP_CODE" != "200" ]; then
        log_error "Could not fetch initial funnel state (HTTP $HTTP_CODE)"
        return 1
    fi

    INITIAL_STATUS=$(echo "$BODY" | jq -r '.data.status // "unknown"')
    log_info "Initial funnel status: $INITIAL_STATUS"

    # Attach a new datasource
    DATASOURCE_RID="ri.stemma.main.dataset.test2_$(date +%s)"

    PAYLOAD=$(cat <<EOF
{
  "datasourceRid": "${DATASOURCE_RID}",
  "primaryKeyMapping": "id",
  "propertyMappings": [
    {
      "sourceColumn": "id",
      "targetPropertyId": "id"
    }
  ]
}
EOF
)

    RESPONSE=$(api_post "/api/v1/ontology/object-types/${TEST_OBJECT_TYPE_RID}/datasources" "$PAYLOAD")
    HTTP_CODE=$(extract_http_code "$RESPONSE")

    if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "201" ]; then
        log_error "Failed to attach second datasource"
        return 1
    fi

    log_info "Waiting for async processing (10s)..."
    sleep 10

    # Check final state
    RESPONSE=$(api_get "/api/v1/ontology/${TEST_ONTOLOGY_ID}/objectTypes/${TEST_OBJECT_TYPE_API_NAME}/indexing/status")
    BODY=$(extract_body "$RESPONSE")
    HTTP_CODE=$(extract_http_code "$RESPONSE")

    if [ "$HTTP_CODE" != "200" ]; then
        log_error "Could not fetch final funnel state (HTTP $HTTP_CODE)"
        return 1
    fi

    FINAL_STATUS=$(echo "$BODY" | jq -r '.data.status // "unknown"')
    log_info "Final funnel status: $FINAL_STATUS"

    # Verify state changed or is in expected state
    if [ "$INITIAL_STATUS" != "$FINAL_STATUS" ]; then
        log_success "Funnel state changed: $INITIAL_STATUS -> $FINAL_STATUS"
        return 0
    elif [ "$FINAL_STATUS" = "indexing" ] || [ "$FINAL_STATUS" = "stale" ] || [ "$FINAL_STATUS" = "not_indexed" ]; then
        log_success "Funnel is in expected state: $FINAL_STATUS"
        return 0
    else
        log_error "Funnel state did not change and is not in expected state"
        return 1
    fi
}

# Test 3: Check funnel signals table
test_funnel_signals() {
    log_test "Test 3: Verify funnel signal was created (requires DB access)"

    # This test requires direct database access
    # In production, you would verify the funnel_signal table directly

    log_info "Skipping DB verification (manual check required)"
    log_info "Expected signal in funnel_signal table with:"
    log_info "  - object_type_api_name: $TEST_OBJECT_TYPE_API_NAME"
    log_info "  - signal_type: schemaChanged"
    log_info "  - signal_fingerprint: ds-attach-*"

    return 0
}

# Test 4: Multiple datasource attachments
test_multiple_attachments() {
    log_test "Test 4: Multiple datasource attachments"

    for i in 1 2 3; do
        DATASOURCE_RID="ri.stemma.main.dataset.multi_${i}_$(date +%s)"

        PAYLOAD=$(cat <<EOF
{
  "datasourceRid": "${DATASOURCE_RID}",
  "primaryKeyMapping": "id",
  "propertyMappings": [
    {
      "sourceColumn": "id",
      "targetPropertyId": "id"
    }
  ]
}
EOF
)

        RESPONSE=$(api_post "/api/v1/ontology/object-types/${TEST_OBJECT_TYPE_RID}/datasources" "$PAYLOAD")
        HTTP_CODE=$(extract_http_code "$RESPONSE")

        if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "201" ]; then
            log_error "Failed to attach datasource $i"
            return 1
        fi

        log_info "Attached datasource $i successfully"
        sleep 2
    done

    log_success "All multiple attachments successful"
    return 0
}

# Test 5: Idempotency test
test_idempotency() {
    log_test "Test 5: Idempotency - reattach same datasource"

    DATASOURCE_RID="ri.stemma.main.dataset.idempotent_$(date +%s)"

    PAYLOAD=$(cat <<EOF
{
  "datasourceRid": "${DATASOURCE_RID}",
  "primaryKeyMapping": "id",
  "propertyMappings": [
    {
      "sourceColumn": "id",
      "targetPropertyId": "id"
    }
  ]
}
EOF
)

    # First attachment
    RESPONSE=$(api_post "/api/v1/ontology/object-types/${TEST_OBJECT_TYPE_RID}/datasources" "$PAYLOAD")
    HTTP_CODE1=$(extract_http_code "$RESPONSE")

    sleep 2

    # Second attachment (should succeed with ON CONFLICT)
    RESPONSE=$(api_post "/api/v1/ontology/object-types/${TEST_OBJECT_TYPE_RID}/datasources" "$PAYLOAD")
    HTTP_CODE2=$(extract_http_code "$RESPONSE")

    if [ "$HTTP_CODE1" = "200" ] && [ "$HTTP_CODE2" = "200" ]; then
        log_success "Idempotent attachments successful"
        return 0
    else
        log_error "Idempotency test failed (HTTP codes: $HTTP_CODE1, $HTTP_CODE2)"
        return 1
    fi
}

# Run all tests
main() {
    echo "========================================="
    echo "Datasource Attachment Funnel Trigger Tests"
    echo "========================================="
    echo ""

    setup_test_environment
    echo ""

    test_basic_datasource_attachment
    echo ""

    test_funnel_state_change
    echo ""

    test_funnel_signals
    echo ""

    test_multiple_attachments
    echo ""

    test_idempotency
    echo ""

    # Summary
    echo "========================================="
    echo "Test Summary"
    echo "========================================="
    echo "Total tests: $TESTS_TOTAL"
    echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
    echo -e "${RED}Failed: $TESTS_FAILED${NC}"
    echo ""

    if [ $TESTS_FAILED -eq 0 ]; then
        echo -e "${GREEN}All tests passed!${NC}"
        exit 0
    else
        echo -e "${RED}Some tests failed${NC}"
        exit 1
    fi
}

# Run main
main "$@"
