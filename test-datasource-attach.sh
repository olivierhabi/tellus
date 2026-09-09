#!/bin/bash
# Test script for datasource attachment triggering funnel indexing
# Usage: ./test-datasource-attach.sh <object_type_rid> <datasource_rid>

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

BASE_URL="${BASE_URL:-http://localhost:3000}"

# API_KEY must be provided by the caller — no baked-in default credential.
# See .env.test.example.
if [ -z "${API_KEY:-}" ]; then
    echo "ERROR: API_KEY is not set. Export it before running this script (see .env.test.example)." >&2
    exit 1
fi

if [ $# -lt 2 ]; then
    echo "Usage: $0 <object_type_rid> <datasource_rid>"
    echo ""
    echo "Example:"
    echo "  $0 ri.stemma.main.object-type.e476ad71-44c8-4dfc-a434-e5c75189a7f9 ri.stemma.main.dataset.abc123"
    exit 1
fi

OBJECT_TYPE_RID="$1"
DATASOURCE_RID="$2"

echo -e "${YELLOW}=== Testing Datasource Attachment Funnel Trigger ===${NC}"
echo "Object Type RID: $OBJECT_TYPE_RID"
echo "Datasource RID: $DATASOURCE_RID"
echo "Base URL: $BASE_URL"
echo ""

# 1. Get object type details first
echo -e "${YELLOW}Step 1: Fetching object type details...${NC}"
OBJECT_TYPE_RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE_URL}/api/v1/ontology/object-types/${OBJECT_TYPE_RID}" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json")

HTTP_CODE=$(echo "$OBJECT_TYPE_RESPONSE" | tail -n 1)
BODY=$(echo "$OBJECT_TYPE_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "200" ]; then
    echo -e "${RED}ERROR: Failed to fetch object type (HTTP $HTTP_CODE)${NC}"
    echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
    exit 1
fi

API_NAME=$(echo "$BODY" | jq -r '.data.apiName // .data.api_name // empty')
ONTOLOGY_ID=$(echo "$BODY" | jq -r '.data.ontologyId // .data.ontology_id // empty')

if [ -z "$API_NAME" ]; then
    echo -e "${RED}ERROR: Could not extract api_name from object type response${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Object Type: $API_NAME${NC}"
echo -e "${GREEN}✓ Ontology ID: $ONTOLOGY_ID${NC}"
echo ""

# 2. Check initial funnel state
echo -e "${YELLOW}Step 2: Checking initial funnel state...${NC}"
FUNNEL_RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE_URL}/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/${API_NAME}/indexing/status" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json")

HTTP_CODE=$(echo "$FUNNEL_RESPONSE" | tail -n 1)
BODY=$(echo "$FUNNEL_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
    INITIAL_STATUS=$(echo "$BODY" | jq -r '.data.status // "unknown"')
    echo -e "${GREEN}✓ Initial funnel status: $INITIAL_STATUS${NC}"
else
    echo -e "${YELLOW}⚠ Could not fetch initial funnel state (HTTP $HTTP_CODE)${NC}"
    INITIAL_STATUS="unknown"
fi
echo ""

# 3. Attach datasource
echo -e "${YELLOW}Step 3: Attaching datasource...${NC}"
ATTACH_PAYLOAD=$(cat <<EOF
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

ATTACH_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "${BASE_URL}/api/v1/ontology/object-types/${OBJECT_TYPE_RID}/datasources" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$ATTACH_PAYLOAD")

HTTP_CODE=$(echo "$ATTACH_RESPONSE" | tail -n 1)
BODY=$(echo "$ATTACH_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "201" ]; then
    echo -e "${RED}ERROR: Failed to attach datasource (HTTP $HTTP_CODE)${NC}"
    echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
    exit 1
fi

echo -e "${GREEN}✓ Datasource attached successfully${NC}"
echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
echo ""

# 4. Wait a moment for async processing
echo -e "${YELLOW}Step 4: Waiting for async processing (5s)...${NC}"
sleep 5
echo ""

# 5. Check funnel state after attachment
echo -e "${YELLOW}Step 5: Checking funnel state after attachment...${NC}"
FUNNEL_RESPONSE=$(curl -s -w "\n%{http_code}" "${BASE_URL}/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/${API_NAME}/indexing/status" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json")

HTTP_CODE=$(echo "$FUNNEL_RESPONSE" | tail -n 1)
BODY=$(echo "$FUNNEL_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "200" ]; then
    echo -e "${RED}ERROR: Failed to fetch funnel state (HTTP $HTTP_CODE)${NC}"
    echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
    exit 1
fi

FINAL_STATUS=$(echo "$BODY" | jq -r '.data.status // "unknown"')
echo -e "${GREEN}✓ Final funnel status: $FINAL_STATUS${NC}"
echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
echo ""

# 6. Verify the funnel was triggered
echo -e "${YELLOW}Step 6: Verifying funnel was triggered...${NC}"
if [ "$INITIAL_STATUS" != "$FINAL_STATUS" ]; then
    echo -e "${GREEN}✓ SUCCESS: Funnel state changed from '$INITIAL_STATUS' to '$FINAL_STATUS'${NC}"
    exit 0
elif [ "$FINAL_STATUS" = "indexing" ] || [ "$FINAL_STATUS" = "stale" ]; then
    echo -e "${GREEN}✓ SUCCESS: Funnel is in expected state: $FINAL_STATUS${NC}"
    exit 0
else
    echo -e "${YELLOW}⚠ WARNING: Funnel state did not change (still '$FINAL_STATUS')${NC}"
    echo -e "${YELLOW}The attachment may have succeeded but the funnel signal might not have been processed.${NC}"
    echo -e "${YELLOW}Check server logs for funnel signal processing errors.${NC}"
    exit 2
fi
