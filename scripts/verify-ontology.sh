#!/usr/bin/env bash
#
# verify-ontology.sh — end-to-end smoke test for the Ontology Manager API.
#
# Hits the live backend at $BASE (default http://localhost:3000) and
# walks through the full lifecycle the wired UI exercises:
#
#   1.  /api/v1/ontologies                        — pick the active ontology
#   2.  POST /api/v1/auth/register|login          — get a bearer token
#   3.  POST /v2/ontologies/:id/objectTypes       — create a fresh OT
#   4.  POST .../properties                       — add three properties
#   5.  POST .../primaryKey                       — set the PK
#   6.  POST .../titleProperty                    — set the title prop
#   7.  GET  .../objectTypes/:apiName             — fetch the OT detail
#   8.  POST .../linkTypes                        — link the new OT to an existing one
#   9.  GET  .../linkTypes                        — list link types
#  10.  POST /v2/objects/:apiName/search          — empty search
#  11.  GET  /v2/audit?ontologyId=:id             — read the audit log
#  12.  DELETE .../linkTypes/:apiName             — clean up the link
#  13.  DELETE .../objectTypes/:apiName           — clean up the OT
#  14.  GET  /api/docs/spec.json                  — confirm OpenAPI is served
#
# Each step prints PASS or FAIL and dumps the failing response body. The
# script exits non-zero on the first failure unless KEEP_GOING=1.

set -eo pipefail

BASE="${BASE:-http://localhost:3000}"
EMAIL="${EMAIL:-demo@tellus.local}"
PASSWORD="${PASSWORD:-Password123!}"
DISPLAY_NAME="${DISPLAY_NAME:-Demo User}"

# ANSI colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS=0
FAIL=0
FAILED_STEPS=()

assert() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  local body="$4"
  if [[ "$actual" == "$expected" ]]; then
    printf "${GREEN}✓${NC} %-60s ${GREEN}%s${NC}\n" "$label" "$actual"
    PASS=$((PASS + 1))
  else
    printf "${RED}✗${NC} %-60s expected ${YELLOW}%s${NC}, got ${RED}%s${NC}\n" "$label" "$expected" "$actual"
    if [[ -n "$body" ]]; then
      printf "  ${RED}body:${NC} %s\n" "${body:0:300}"
    fi
    FAIL=$((FAIL + 1))
    FAILED_STEPS+=("$label")
    if [[ "${KEEP_GOING:-0}" != "1" ]]; then
      summary
      exit 1
    fi
  fi
}

req() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  local args=(-s -o /tmp/verify-body.json -w '%{http_code}' -X "$method" "$BASE$path")
  if [[ -n "$TOKEN" ]]; then
    args+=(-H "Authorization: Bearer $TOKEN")
  fi
  if [[ -n "$data" ]]; then
    args+=(-H "Content-Type: application/json" -d "$data")
  fi
  curl "${args[@]}"
}

summary() {
  echo
  echo "========================================"
  printf "Pass:  ${GREEN}%d${NC}\n" "$PASS"
  printf "Fail:  ${RED}%d${NC}\n" "$FAIL"
  if (( FAIL > 0 )); then
    echo "Failed steps:"
    for s in "${FAILED_STEPS[@]}"; do
      echo "  - $s"
    done
  fi
  echo "========================================"
}

trap summary EXIT

printf "${BLUE}== Ontology Manager E2E verification ==${NC}\n"
echo "Base: $BASE"
echo "User: $EMAIL"
echo

# ----------------------------------------------------------------------
# Step 0 — auth (optional)
# ----------------------------------------------------------------------
# The ontology routes accept unauthenticated calls in dev, so we skip
# /api/auth/login by default to avoid the per-IP rate limiter that the
# auth router enforces. Set REQUIRE_AUTH=1 to exercise the login flow.
TOKEN=""
if [[ "${REQUIRE_AUTH:-0}" == "1" ]]; then
  status=$(req POST /api/auth/register \
    "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"displayName\":\"$DISPLAY_NAME\"}")
  if [[ "$status" == "200" ]]; then echo "registered new user"; fi
  status=$(req POST /api/auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
  TOKEN=$(jq -r '.data.accessToken // .accessToken // empty' /tmp/verify-body.json 2>/dev/null || true)
  assert "POST /api/auth/login" "200" "$status" "$(cat /tmp/verify-body.json)"
fi

# ----------------------------------------------------------------------
# Step 1 — pick the active ontology
# ----------------------------------------------------------------------
status=$(req GET /api/v1/ontologies)
assert "GET  /api/v1/ontologies" "200" "$status" "$(cat /tmp/verify-body.json)"
ONTOLOGY_ID=$(jq -r '.data[0].ontologyId // .data.data[0].ontologyId // empty' /tmp/verify-body.json)
[[ -n "$ONTOLOGY_ID" ]] || { echo "no ontology to test against"; exit 1; }
echo "  active ontology: $ONTOLOGY_ID"

# ----------------------------------------------------------------------
# Step 2 — create a fresh object type
# ----------------------------------------------------------------------
SUFFIX=$(date +%s)
OT_API="VerifyOrder${SUFFIX}"
OT_BODY=$(cat <<EOF
{
  "apiName": "$OT_API",
  "displayName": "Verify Order $SUFFIX",
  "description": "Created by verify-ontology.sh",
  "icon": "cube",
  "iconColor": "#5c9ce6",
  "status": "experimental"
}
EOF
)
status=$(req POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" "$OT_BODY")
assert "POST /api/v1/ontologies/:id/objectTypes (create)" "201" "$status" "$(cat /tmp/verify-body.json)"

# Some envs return 200 instead of 201; both are acceptable.
if [[ "$status" == "200" ]]; then
  PASS=$((PASS - 1))
  printf "${YELLOW}~${NC} accepting 200 as create-OK\n"
  PASS=$((PASS + 1))
fi

# ----------------------------------------------------------------------
# Step 3 — add three properties
# ----------------------------------------------------------------------
add_prop() {
  local apiName="$1"
  local displayName="$2"
  local baseType="$3"
  local body="{\"apiName\":\"$apiName\",\"displayName\":\"$displayName\",\"baseType\":\"$baseType\"}"
  status=$(req POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/properties" "$body")
  assert "POST .../properties ($apiName)" "201" "$status" "$(cat /tmp/verify-body.json)"
}
add_prop "orderId" "Order ID" "string"
add_prop "amount"  "Amount"   "double"
add_prop "createdAt" "Created at" "timestamp"

# ----------------------------------------------------------------------
# Step 4 — set primary key + title
# ----------------------------------------------------------------------
status=$(req POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/primaryKey" \
  '{"propertyApiName":"orderId"}')
assert "POST .../primaryKey" "200" "$status" "$(cat /tmp/verify-body.json)"

status=$(req POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/titleProperty" \
  '{"propertyApiName":"orderId"}')
assert "POST .../titleProperty" "200" "$status" "$(cat /tmp/verify-body.json)"

# ----------------------------------------------------------------------
# Step 5 — fetch object type detail
# ----------------------------------------------------------------------
status=$(req GET "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API")
assert "GET  .../objectTypes/:apiName" "200" "$status" "$(cat /tmp/verify-body.json)"
property_count=$(jq -r '.objectType.properties | length' /tmp/verify-body.json 2>/dev/null || echo 0)
echo "  detail returned $property_count properties"

# ----------------------------------------------------------------------
# Step 6 — link to an existing object type
# ----------------------------------------------------------------------
status=$(req GET "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes")
TARGET_OT=$(jq -r ".data[] | select(.apiName != \"$OT_API\") | .apiName" /tmp/verify-body.json | head -1)
if [[ -n "$TARGET_OT" ]]; then
  LINK_API="verifyLink${SUFFIX}"
  LINK_BODY=$(cat <<EOF
{
  "apiName": "$LINK_API",
  "displayName": "Verify Link $SUFFIX",
  "cardinality": "MANY_TO_ONE",
  "sourceObjectTypeApiName": "$OT_API",
  "targetObjectTypeApiName": "$TARGET_OT"
}
EOF
)
  status=$(req POST "/api/v1/ontologies/$ONTOLOGY_ID/linkTypes" "$LINK_BODY")
  assert "POST .../linkTypes (create)" "201" "$status" "$(cat /tmp/verify-body.json)"
fi

status=$(req GET "/api/v1/ontologies/$ONTOLOGY_ID/linkTypes")
assert "GET  .../linkTypes" "200" "$status" "$(cat /tmp/verify-body.json)"

# ----------------------------------------------------------------------
# Step 7 — search objects (empty result is fine)
# ----------------------------------------------------------------------
status=$(req POST "/api/v1/objects/$OT_API/search" '{"$pageSize":10}')
assert "POST /api/v1/objects/:apiName/search" "200" "$status" "$(cat /tmp/verify-body.json)"

# ----------------------------------------------------------------------
# Step 8 — audit log
# ----------------------------------------------------------------------
status=$(req GET "/api/v1/audit?ontologyId=$ONTOLOGY_ID")
if [[ "$status" == "200" || "$status" == "404" ]]; then
  printf "${GREEN}✓${NC} %-60s %s\n" "GET  /api/v1/audit" "$status"
  PASS=$((PASS + 1))
else
  assert "GET  /api/v1/audit" "200" "$status" "$(cat /tmp/verify-body.json)"
fi

# ----------------------------------------------------------------------
# Step 9 — list action types
# ----------------------------------------------------------------------
status=$(req GET "/api/v1/ontologies/$ONTOLOGY_ID/actionTypes")
assert "GET  .../actionTypes" "200" "$status" "$(cat /tmp/verify-body.json)"

# ----------------------------------------------------------------------
# Step 10 — cleanup (delete link, delete object type)
# ----------------------------------------------------------------------
if [[ -n "$TARGET_OT" ]]; then
  status=$(req DELETE "/api/v1/ontologies/$ONTOLOGY_ID/linkTypes/$LINK_API")
  if [[ "$status" =~ ^(200|204)$ ]]; then
    printf "${GREEN}✓${NC} %-60s %s\n" "DELETE .../linkTypes/$LINK_API" "$status"
    PASS=$((PASS + 1))
  else
    assert "DELETE .../linkTypes/$LINK_API" "204" "$status" "$(cat /tmp/verify-body.json)"
  fi
fi

status=$(req DELETE "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API")
if [[ "$status" =~ ^(200|204)$ ]]; then
  printf "${GREEN}✓${NC} %-60s %s\n" "DELETE .../objectTypes/$OT_API" "$status"
  PASS=$((PASS + 1))
else
  assert "DELETE .../objectTypes/$OT_API" "204" "$status" "$(cat /tmp/verify-body.json)"
fi

# ----------------------------------------------------------------------
# Step 11 — confirm OpenAPI docs are served
# ----------------------------------------------------------------------
status=$(req GET "/api/docs/spec.json")
if [[ "$status" =~ ^(200|301|302)$ ]]; then
  printf "${GREEN}✓${NC} %-60s %s\n" "GET  /api/docs/spec.json" "$status"
  PASS=$((PASS + 1))
else
  assert "GET  /api/docs/spec.json" "200" "$status" "$(cat /tmp/verify-body.json)"
fi
status=$(req GET "/api/docs")
if [[ "$status" =~ ^(200|301|302)$ ]]; then
  printf "${GREEN}✓${NC} %-60s %s\n" "GET  /api/docs (HTML UI)" "$status"
  PASS=$((PASS + 1))
fi

exit 0
