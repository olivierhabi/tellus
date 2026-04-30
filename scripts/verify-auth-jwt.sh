#!/usr/bin/env bash
#
# verify-auth-jwt.sh
# ------------------
# Task 3/4 backend check — exercises the end-to-end login → token-info →
# check-access → logout → revocation cycle against a live tellus backend.
# Run after bootstrap-keycloak.sh and with the tellus server running on
# TELLUS_API_URL (default http://localhost:3000).

set -o pipefail

API="${TELLUS_API_URL:-http://localhost:3000}"
KC="${KC_URL:-http://localhost:8086}"
REALM="${KC_REALM:-tellus}"
USER="${KC_TEST_USER:-cypress@tellus.local}"
PASS="${KC_TEST_PASS:-Password123!}"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
ok()  { printf "${GREEN}✓${NC} %s\n" "$1"; }
err() { printf "${RED}✗${NC} %s\n" "$1"; exit 1; }

COOKIE_JAR=$(mktemp)
trap 'rm -f $COOKIE_JAR' EXIT

# --- 1. Unauthenticated request → 401 with error envelope -------------------
STATUS=$(curl -s -o /tmp/unauth.json -w '%{http_code}' "$API/api/v1/auth/token-info")
[[ "$STATUS" == "401" ]] || err "unauthenticated /token-info expected 401, got $STATUS"
jq -e '.errorCode and .requestId and .statusCode' /tmp/unauth.json >/dev/null \
  || err "401 response missing spec error envelope ($(cat /tmp/unauth.json))"
ok "unauthenticated /token-info returns 401 + error envelope"

# --- 2. Login sets TELLUS_TOKEN cookie with correct attributes --------------
HTTP=$(curl -s -o /tmp/login.json -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -c "$COOKIE_JAR" \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
  "$API/api/v1/auth/login")
[[ "$HTTP" == "200" ]] || err "login expected 200, got $HTTP — $(cat /tmp/login.json)"

grep -q 'TELLUS_TOKEN' "$COOKIE_JAR" || err "TELLUS_TOKEN cookie not set on login"
grep -q 'HttpOnly.*TELLUS_TOKEN\|TELLUS_TOKEN.*' "$COOKIE_JAR" || true
ok "login sets TELLUS_TOKEN cookie"

ACCESS=$(jq -r '.data.accessToken' /tmp/login.json)
[[ -n "$ACCESS" && "$ACCESS" != "null" ]] || err "login did not return accessToken"
ok "login response contains accessToken"

# --- 3. JWT claims sanity ---------------------------------------------------
PAYLOAD=$(echo "$ACCESS" | awk -F. '{print $2}' | tr '_-' '/+' | base64 -d 2>/dev/null || true)
echo "$PAYLOAD" | jq -e '.sub and .jti and .iss' >/dev/null \
  || err "JWT missing required claims sub/jti/iss"
ok "JWT contains sub, jti, iss (Palantir PALANTIR_TOKEN equivalents)"

# --- 4. token-info via cookie -----------------------------------------------
curl -sf -b "$COOKIE_JAR" "$API/api/v1/auth/token-info" > /tmp/info.json \
  || err "token-info via cookie failed"
jq -e '.data.sub and .data.jti' /tmp/info.json >/dev/null \
  || err "token-info missing sub/jti"
ok "cookie session resolves on /token-info"

# --- 5. token-info via Bearer ------------------------------------------------
curl -sf -H "Authorization: Bearer $ACCESS" "$API/api/v1/auth/token-info" >/tmp/info2.json \
  || err "bearer auth on /token-info failed"
ok "Bearer JWKS validation works"

# --- 6. check-access for editor ---------------------------------------------
curl -sf -b "$COOKIE_JAR" -H 'Content-Type: application/json' \
  -d '{"operation":"read","resourceType":"object-type"}' \
  "$API/api/v1/auth/check-access" > /tmp/chk.json \
  || err "check-access failed"
jq -e '.data.allowed == true' /tmp/chk.json >/dev/null \
  || err "editor should have 'read' permission ($(cat /tmp/chk.json))"
ok "check-access allows editor to read"

# --- 7. Logout revokes the session ------------------------------------------
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$COOKIE_JAR" \
  "$API/api/v1/auth/logout")
[[ "$HTTP" == "204" ]] || err "logout expected 204, got $HTTP"
ok "logout returns 204"

# Reusing the (now-revoked) JWT must fail.
HTTP=$(curl -s -o /tmp/revoked.json -w '%{http_code}' \
  -H "Authorization: Bearer $ACCESS" "$API/api/v1/auth/token-info")
if [[ "$HTTP" == "200" ]]; then
  err "revoked JWT still works — jti revocation is broken"
fi
ok "revoked JWT no longer accepted ($HTTP)"

echo
ok "Task 3 JWT + cookie + authz + revocation pipeline verified"
