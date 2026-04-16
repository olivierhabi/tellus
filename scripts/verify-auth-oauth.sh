#!/usr/bin/env bash
#
# verify-auth-oauth.sh
# --------------------
# Task 4 backend check — validates OAuth 2.0 behavior against Keycloak:
# refresh-token rotation, access token format, and (positively) that
# the confidential client is configured for Client Credentials grant.

set -o pipefail

KC="${KC_URL:-http://localhost:8086}"
REALM="${KC_REALM:-tellus}"
USER="${KC_TEST_USER:-cypress@tellus.local}"
PASS="${KC_TEST_PASS:-Password123!}"
CONF_SECRET="${TELLUS_CONF_SECRET:-tellus-confidential-secret-change-me}"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
ok() { printf "${GREEN}✓${NC} %s\n" "$1"; }
err(){ printf "${RED}✗${NC} %s\n" "$1"; exit 1; }

TOKEN_EP="$KC/realms/$REALM/protocol/openid-connect/token"

# --- 1. Direct grant via tellus-frontend ------------------------------------
R1=$(curl -sf -X POST \
  -d "grant_type=password&client_id=tellus-frontend&username=$USER&password=$PASS&scope=openid+offline_access" \
  "$TOKEN_EP")
RT1=$(echo "$R1" | jq -r .refresh_token)
[[ -n "$RT1" && "$RT1" != "null" ]] || err "no refresh_token from direct grant ($R1)"
ok "direct grant issued refresh_token"

# --- 2. Refresh-token rotation ----------------------------------------------
R2=$(curl -sf -X POST \
  -d "grant_type=refresh_token&client_id=tellus-frontend&refresh_token=$RT1" \
  "$TOKEN_EP")
RT2=$(echo "$R2" | jq -r .refresh_token)
[[ -n "$RT2" && "$RT2" != "null" ]] || err "refresh did not return new refresh_token"
[[ "$RT2" != "$RT1" ]] || err "refresh_token NOT rotated — revokeRefreshToken misconfigured"
ok "refresh_token rotated on use (revokeRefreshToken honored)"

# --- 3. Replay of the stale refresh token must fail -------------------------
HTTP=$(curl -s -o /tmp/replay.json -w '%{http_code}' -X POST \
  -d "grant_type=refresh_token&client_id=tellus-frontend&refresh_token=$RT1" \
  "$TOKEN_EP")
[[ "$HTTP" == "400" ]] || err "replay of stale RT expected 400, got $HTTP"
jq -e '.error == "invalid_grant"' /tmp/replay.json >/dev/null \
  || err "replay error code not invalid_grant ($(cat /tmp/replay.json))"
ok "stale refresh_token rejected with invalid_grant"

# --- 4. Client Credentials via tellus-confidential --------------------------
CC=$(curl -sf -X POST \
  -d "grant_type=client_credentials&client_id=tellus-confidential&client_secret=$CONF_SECRET" \
  "$TOKEN_EP") || err "client_credentials grant failed"
echo "$CC" | jq -e '.access_token' >/dev/null || err "client_credentials missing access_token"
if echo "$CC" | jq -e '.refresh_token' >/dev/null 2>&1; then
  err "client_credentials MUST NOT return refresh_token"
fi
ok "client_credentials issues access-only token (no refresh_token)"

echo
ok "Task 4 OAuth2 rotation + client_credentials verified"
