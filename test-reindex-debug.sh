#!/bin/bash
# Debug script for reindexing object types
# Investigates why reindex fails with "Failed to trigger indexing"

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ONTOLOGY_ID="${ONTOLOGY_ID:-00000000-0000-0000-0000-000000000001}"
OBJECT_TYPE_API_NAME="${OBJECT_TYPE_API_NAME:-OlivierOrder}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_test() {
    echo -e "${YELLOW}[TEST]${NC} $1"
}

# Get auth token from command line or environment
AUTH_TOKEN="${AUTH_TOKEN:-}"
if [ -z "$AUTH_TOKEN" ] && [ -n "${1:-}" ]; then
    AUTH_TOKEN="$1"
fi

# Make authenticated API call
api_call() {
    local method="$1"
    local endpoint="$2"
    local data="${3:-}"

    local args=(-s -w "\n%{http_code}" -X "$method" "${BASE_URL}${endpoint}")
    args+=(-H "Authorization: Bearer ${AUTH_TOKEN}")
    args+=(-H "Content-Type: application/json")
    args+=(-H "Accept: application/json")

    if [ -n "$data" ]; then
        args+=(-d "$data")
    fi

    curl "${args[@]}"
}

# Extract body and HTTP code from response
extract_body() {
    echo "$1" | sed '$d'
}

extract_http_code() {
    echo "$1" | tail -n 1
}

# Test 1: Check server health
test_server_health() {
    log_test "Checking server health..."

    RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE_URL}/health" 2>/dev/null || echo -e "\n000")
    HTTP_CODE=$(extract_http_code "$RESPONSE")

    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "404" ]; then
        log_success "Server is reachable (HTTP $HTTP_CODE)"
        return 0
    elif [ "$HTTP_CODE" = "000" ]; then
        log_error "Server not reachable at $BASE_URL"
        log_info "Please start the backend server: cd /Users/olivierhabimana/Desktop/projects/tellus && pnpm dev"
        return 1
    else
        log_error "Server returned unexpected status: $HTTP_CODE"
        return 1
    fi
}

# Test 2: Check authentication
test_authentication() {
    log_test "Checking authentication..."

    if [ -z "$AUTH_TOKEN" ]; then
        log_error "No authentication token provided"
        log_info "Usage: $0 <auth_token>"
        log_info "Or set AUTH_TOKEN environment variable"
        log_info "Get the token from your browser's cookies (TELLUS_TOKEN)"
        return 1
    fi

    RESPONSE=$(api_call "GET" "/api/v1/ontology")
    BODY=$(extract_body "$RESPONSE")
    HTTP_CODE=$(extract_http_code "$RESPONSE")

    if [ "$HTTP_CODE" = "401" ]; then
        log_error "Authentication failed - token may be expired"
        echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
        log_info "Get a fresh token from your browser's cookies"
        return 1
    elif [ "$HTTP_CODE" = "200" ]; then
        log_success "Authentication successful"
        return 0
    else
        log_error "Unexpected response: HTTP $HTTP_CODE"
        echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
        return 1
    fi
}

# Test 3: Check if object type exists
test_object_type_exists() {
    log_test "Checking if object type '${OBJECT_TYPE_API_NAME}' exists..."

    RESPONSE=$(api_call "GET" "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes")
    BODY=$(extract_body "$RESPONSE")
    HTTP_CODE=$(extract_http_code "$RESPONSE")

    if [ "$HTTP_CODE" != "200" ]; then
        log_error "Failed to fetch object types (HTTP $HTTP_CODE)"
        echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
        return 1
    fi

    # Find the object type
    OBJECT_TYPE_ID=$(echo "$BODY" | jq -r '.data[] | select(.apiName == "'${OBJECT_TYPE_API_NAME}'") | .objectTypeId' 2>/dev/null | head -1)
    OBJECT_TYPE_RID=$(echo "$BODY" | jq -r '.data[] | select(.apiName == "'${OBJECT_TYPE_API_NAME}'") | .rid' 2>/dev/null | head -1)

    if [ -z "$OBJECT_TYPE_ID" ] || [ "$OBJECT_TYPE_ID" = "null" ]; then
        log_error "Object type '${OBJECT_TYPE_API_NAME}' not found"
        echo "Available object types:"
        echo "$BODY" | jq -r '.data[].apiName' 2>/dev/null || echo "$BODY"
        return 1
    fi

    log_success "Object type found"
    log_info "  ID: $OBJECT_TYPE_ID"
    log_info "  RID: $OBJECT_TYPE_RID"

    # Show object type details
    echo ""
    echo "Object type details:"
    echo "$BODY" | jq '.data[] | select(.apiName == "'${OBJECT_TYPE_API_NAME}'")' 2>/dev/null || echo "$BODY"

    # Export for other tests
    export OBJECT_TYPE_ID OBJECT_TYPE_RID
}

# Test 4: Check backing datasource
test_backing_datasource() {
    log_test "Checking backing datasource..."

    RESPONSE=$(api_call "GET" "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/${OBJECT_TYPE_API_NAME}")
    BODY=$(extract_body "$RESPONSE")
    HTTP_CODE=$(extract_http_code "$RESPONSE")

    if [ "$HTTP_CODE" != "200" ]; then
        log_error "Failed to fetch object type details (HTTP $HTTP_CODE)"
        echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
        return 1
    fi

    # Check for backing datasource
    DS=$(echo "$BODY" | jq -r '.data.backingDatasource // .backingDatasource // empty' 2>/dev/null)

    if [ -z "$DS" ] || [ "$DS" = "null" ]; then
        log_error "No backing datasource found for ${OBJECT_TYPE_API_NAME}"
        log_info "This is likely the cause of the reindex failure"
        return 1
    fi

    log_success "Backing datasource found"
    echo ""
    echo "Datasource details:"
    echo "$BODY" | jq '.data.backingDatasource // .backingDatasource' 2>/dev/null || echo "$BODY"

    # Check file path
    FILE_PATH=$(echo "$BODY" | jq -r '.data.backingDatasource.filePath // .backingDatasource.filePath // empty' 2>/dev/null)
    if [ -n "$FILE_PATH" ]; then
        log_info "File path: $FILE_PATH"

        # Check if it's a foundry-bridged path
        if [[ "$FILE_PATH" == *"foundry-dataset"* ]]; then
            log_info "This is a foundry-bridged datasource"
            # Extract S3 key
            S3_KEY="${FILE_PATH%%#foundry-dataset*}"
            log_info "S3 key: $S3_KEY"
        fi
    fi
}

# Test 5: Check funnel state
test_funnel_state() {
    log_test "Checking funnel state..."

    RESPONSE=$(api_call "GET" "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/${OBJECT_TYPE_API_NAME}/reindex/status")
    BODY=$(extract_body "$RESPONSE")
    HTTP_CODE=$(extract_http_code "$RESPONSE")

    if [ "$HTTP_CODE" != "200" ]; then
        log_error "Failed to fetch funnel state (HTTP $HTTP_CODE)"
        echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
        return 1
    fi

    log_success "Funnel state retrieved"
    echo ""
    echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"

    # Check for errors
    FUNNEL_STATUS=$(echo "$BODY" | jq -r '.data.funnelState.status // .funnelState.status // empty' 2>/dev/null)
    ERROR_MESSAGE=$(echo "$BODY" | jq -r '.data.funnelState.errorMessage // .funnelState.errorMessage // empty' 2>/dev/null)

    if [ "$FUNNEL_STATUS" = "failed" ] && [ -n "$ERROR_MESSAGE" ] && [ "$ERROR_MESSAGE" != "null" ]; then
        log_error "Previous funnel run failed: $ERROR_MESSAGE"
    fi

    if [ "$FUNNEL_STATUS" = "indexing" ]; then
        log_info "Funnel is currently indexing - waiting for completion"
    fi
}

# Test 6: Attempt reindex and capture full error
test_reindex() {
    log_test "Attempting reindex..."

    RESPONSE=$(api_call "POST" "/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/${OBJECT_TYPE_API_NAME}/reindex?force=true")
    BODY=$(extract_body "$RESPONSE")
    HTTP_CODE=$(extract_http_code "$RESPONSE")

    echo ""
    echo "HTTP Status: $HTTP_CODE"
    echo "Response Body:"
    echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"

    if [ "$HTTP_CODE" = "200" ]; then
        log_success "Reindex succeeded!"
        return 0
    else
        log_error "Reindex failed (HTTP $HTTP_CODE)"

        # Extract error details
        ERROR_CODE=$(echo "$BODY" | jq -r '.errorCode // .error.code // empty' 2>/dev/null)
        ERROR_MSG=$(echo "$BODY" | jq -r '.message // .error.message // empty' 2>/dev/null)

        if [ -n "$ERROR_CODE" ]; then
            log_error "Error code: $ERROR_CODE"
        fi
        if [ -n "$ERROR_MSG" ]; then
            log_error "Error message: $ERROR_MSG"
        fi

        return 1
    fi
}

# Test 7: Check OpenSearch index
test_opensearch() {
    log_test "Checking OpenSearch index..."

    INDEX_NAME="tellus_${OBJECT_TYPE_API_NAME,,}"

    # Try to get index info (no auth needed for local OpenSearch)
    RESPONSE=$(curl -s -w "\n%{http_code}" "http://localhost:9200/${INDEX_NAME}" 2>/dev/null || echo -e "\n000")
    BODY=$(extract_body "$RESPONSE")
    HTTP_CODE=$(extract_http_code "$RESPONSE")

    if [ "$HTTP_CODE" = "200" ]; then
        log_success "OpenSearch index exists"
        echo "$BODY" | jq '.[].settings // .' 2>/dev/null | head -20 || echo "$BODY"
    elif [ "$HTTP_CODE" = "404" ]; then
        log_info "OpenSearch index does not exist (will be created on first reindex)"
    elif [ "$HTTP_CODE" = "000" ]; then
        log_info "OpenSearch not reachable at localhost:9200"
    else
        log_error "Failed to check OpenSearch index (HTTP $HTTP_CODE)"
    fi

    # Check document count if index exists
    if [ "$HTTP_CODE" = "200" ]; then
        RESPONSE=$(curl -s "http://localhost:9200/${INDEX_NAME}/_count" 2>/dev/null)
        echo ""
        echo "Document count:"
        echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
    fi
}

# Main
main() {
    echo "========================================="
    echo "Reindex Debug Script for ${OBJECT_TYPE_API_NAME}"
    echo "========================================="
    echo ""
    log_info "Base URL: $BASE_URL"
    log_info "Ontology ID: $ONTOLOGY_ID"
    log_info "Object Type: $OBJECT_TYPE_API_NAME"
    echo ""

    # Check server first
    test_server_health || exit 1
    echo ""

    # Check authentication
    test_authentication || exit 1
    echo ""

    # Run all tests
    test_object_type_exists
    echo ""

    test_backing_datasource
    echo ""

    test_funnel_state
    echo ""

    test_opensearch
    echo ""

    # Finally, attempt the reindex
    test_reindex
    echo ""

    echo "========================================="
    echo "Debug Complete"
    echo "========================================="
}

main "$@"
