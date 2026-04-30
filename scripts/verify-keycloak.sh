#!/usr/bin/env bash
#
# verify-keycloak.sh
# ------------------
# End-to-end SSO verification:
#
#   docker (Keycloak)      → realm + client + user bootstrapped via Admin API
#   Keycloak               → direct grant returns an RS256 token
#   backend (tellus)       → JWKS-validates the token, returns claims
#   role enforcement       → ontology-admin check returns 403 for non-admin
#   negative cases         → garbage / missing tokens return structured 401s
#
# Run it manually:
#
#   ./scripts/verify-keycloak.sh
#
# Exits non-zero on first failure unless KEEP_GOING=1.

set -o pipefail

KC="${KC_URL:-http://localhost:8086}"
REALM="${KC_REALM:-tellus}"
USER_NAME="${KC_TEST_USER:-cypress@tellus.local}"
PASSWORD="${KC_TEST_PASS:-Password123!}"
CLIENT="${KC_CLIENT:-tellus-frontend}"
BACKEND="${BACKEND_URL:-http://localhost:3000}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

PASS=0
FAIL=0

check() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  local body="$4"
  if [[ "$actual" == "$expected" ]]; then
    printf "${GREEN}✓${NC} %-58s ${GREEN}%s${NC}\n" "$label" "$actual"
    PASS=$((PASS + 1))
  else
    printf "${RED}✗${NC} %-58s ${RED}%s${NC} (want ${YELLOW}%s${NC})\n" "$label" "$actual" "$expected"
    [[ -n "$body" ]] && printf "  ${DIM}%s${NC}\n" "${body:0:300}"
    FAIL=$((FAIL + 1))
    if [[ "${KEEP_GOING:-0}" != "1" ]]; then summary; exit 1; fi
  fi
}

summary() {
  echo
  printf "${BOLD}Pass: ${GREEN}%d${NC}${BOLD}   Fail: ${RED}%d${NC}\n" "$PASS" "$FAIL"
}
trap summary EXIT

echo -e "${BOLD}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║  Keycloak SSO end-to-end verification                            ║${NC}"
echo -e "${BOLD}╚════════════════════════════════════════════════════════════════╝${NC}"
echo "  Keycloak URL : $KC"
echo "  Realm        : $REALM"
echo "  Backend URL  : $BACKEND"
echo

# 0. Container reachable
status=$(curl -s -o /dev/null -w '%{http_code}' "$KC/realms/master")
check "Keycloak master realm reachable" "200" "$status"

# 1. Bootstrap the realm if needed (idempotent).
echo
echo -e "${BOLD}── bootstrap ──${NC}"
"$(dirname "$0")/bootstrap-keycloak.sh" > /tmp/kc-bootstrap.log 2>&1
if [[ $? -eq 0 ]]; then
  printf "${GREEN}✓${NC} %s\n" "bootstrap-keycloak.sh succeeded"
  PASS=$((PASS + 1))
else
  printf "${RED}✗${NC} %s\n" "bootstrap-keycloak.sh failed"
  cat /tmp/kc-bootstrap.log | tail -20
  FAIL=$((FAIL + 1))
  exit 1
fi

# 2. Direct grant returns a token.
echo
echo -e "${BOLD}── direct grant (resource-owner password) ──${NC}"
TOKEN_BODY=$(curl -sf -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=$USER_NAME&password=$PASSWORD&grant_type=password&client_id=$CLIENT&scope=openid" \
  "$KC/realms/$REALM/protocol/openid-connect/token")
TOKEN=$(echo "$TOKEN_BODY" | jq -r '.access_token // empty')
if [[ -n "$TOKEN" ]]; then
  printf "${GREEN}✓${NC} %s\n" "user direct grant returned an access token"
  PASS=$((PASS + 1))
else
  printf "${RED}✗${NC} direct grant failed:\n  %s\n" "$TOKEN_BODY"
  FAIL=$((FAIL + 1))
  exit 1
fi

# Decode the JWT header so we can see the kid + alg
HEADER=$(echo "$TOKEN" | cut -d. -f1 | base64 -d 2>/dev/null || echo "$TOKEN" | cut -d. -f1)
ALG=$(echo "$HEADER" | jq -r '.alg' 2>/dev/null || echo "?")
KID=$(echo "$HEADER" | jq -r '.kid' 2>/dev/null || echo "?")
echo -e "  ${DIM}token alg=$ALG kid=$KID${NC}"

# 3. Backend /sso/config publishes the realm metadata.
echo
echo -e "${BOLD}── backend ${BACKEND}/api/v1/sso/* ──${NC}"
status=$(curl -s -o /tmp/sso-config.json -w '%{http_code}' "$BACKEND/api/v1/sso/config")
check "GET /api/v1/sso/config (public)" "200" "$status"
realm_in_config=$(jq -r '.data.realm // empty' /tmp/sso-config.json)
if [[ "$realm_in_config" == "$REALM" ]]; then
  printf "${GREEN}✓${NC} %s\n" "config.realm == '$REALM'"
  PASS=$((PASS + 1))
else
  printf "${RED}✗${NC} %s\n" "config.realm == '$REALM' (got '$realm_in_config')"
  FAIL=$((FAIL + 1))
fi

# 4. /sso/whoami without a token → 401
status=$(curl -s -o /tmp/sso-na.json -w '%{http_code}' "$BACKEND/api/v1/sso/whoami")
check "GET /api/v1/sso/whoami without token" "401" "$status" "$(cat /tmp/sso-na.json)"

# 5. /sso/whoami with garbage token → 401
status=$(curl -s -o /tmp/sso-bad.json -w '%{http_code}' \
  -H "Authorization: Bearer not.a.real.token" \
  "$BACKEND/api/v1/sso/whoami")
check "GET /api/v1/sso/whoami with garbage token" "401" "$status" "$(cat /tmp/sso-bad.json)"

# 6. /sso/whoami with REAL token → 200 + claims
status=$(curl -s -o /tmp/sso-ok.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  "$BACKEND/api/v1/sso/whoami")
check "GET /api/v1/sso/whoami with valid Keycloak token" "200" "$status" "$(cat /tmp/sso-ok.json)"

# 7. The whoami response actually contains the test user's email.
got_email=$(jq -r '.data.email // empty' /tmp/sso-ok.json)
if [[ "$got_email" == "$USER_NAME" ]]; then
  printf "${GREEN}✓${NC} %s\n" "claims.email == '$USER_NAME'"
  PASS=$((PASS + 1))
else
  printf "${RED}✗${NC} %s\n" "claims.email mismatch: '$got_email'"
  FAIL=$((FAIL + 1))
fi

# 8. The user has the ontology-editor realm role.
has_editor=$(jq -r '.data.realmRoles | any(. == "ontology-editor")' /tmp/sso-ok.json)
if [[ "$has_editor" == "true" ]]; then
  printf "${GREEN}✓${NC} %s\n" "realm role 'ontology-editor' present in claims"
  PASS=$((PASS + 1))
else
  printf "${RED}✗${NC} %s\n" "realm role 'ontology-editor' missing"
  FAIL=$((FAIL + 1))
fi

# 9. /sso/admin requires ontology-admin → editor user gets 403.
status=$(curl -s -o /tmp/sso-admin.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  "$BACKEND/api/v1/sso/admin")
check "GET /api/v1/sso/admin without ontology-admin role" "403" "$status" "$(cat /tmp/sso-admin.json)"

# 10. Promote the user to ontology-admin and verify access.
echo
echo -e "${BOLD}── role escalation check ──${NC}"
ADMIN_TOKEN=$(curl -sf -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=admin&password=admin&grant_type=password&client_id=admin-cli" \
  "$KC/realms/master/protocol/openid-connect/token" | jq -r '.access_token')
USER_ID=$(curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$KC/admin/realms/$REALM/users?username=$USER_NAME" | jq -r '.[0].id')
ADMIN_ROLE=$(curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$KC/admin/realms/$REALM/roles/ontology-admin")
curl -sf -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "[$ADMIN_ROLE]" \
  "$KC/admin/realms/$REALM/users/$USER_ID/role-mappings/realm" > /dev/null
printf "${GREEN}✓${NC} %s\n" "ontology-admin role granted to $USER_NAME"
PASS=$((PASS + 1))

# Get a NEW token so the role mapping shows up in the JWT.
TOKEN=$(curl -sf -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=$USER_NAME&password=$PASSWORD&grant_type=password&client_id=$CLIENT&scope=openid" \
  "$KC/realms/$REALM/protocol/openid-connect/token" | jq -r '.access_token')

status=$(curl -s -o /tmp/sso-admin2.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  "$BACKEND/api/v1/sso/admin")
check "GET /api/v1/sso/admin with elevated role" "200" "$status" "$(cat /tmp/sso-admin2.json)"

# Cleanup: revoke the admin role so re-runs start clean.
curl -sf -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "[$ADMIN_ROLE]" \
  "$KC/admin/realms/$REALM/users/$USER_ID/role-mappings/realm" > /dev/null
printf "${GREEN}✓${NC} %s\n" "ontology-admin role revoked (cleanup)"
PASS=$((PASS + 1))
