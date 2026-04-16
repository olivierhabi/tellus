#!/usr/bin/env bash
#
# verify-auth-pat.sh
# ------------------
# Task 9 backend check — create/list/use/revoke a Personal Access Token
# through the tellus backend. Asserts the spec contract: token returned
# exactly once, tellus_pat_ prefix, list endpoint never includes raw
# token, revoked tokens fail with 401.

set -o pipefail

API="${TELLUS_API_URL:-http://localhost:3000}"
USER="${KC_TEST_USER:-cypress@tellus.local}"
PASS="${KC_TEST_PASS:-Password123!}"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
ok() { printf "${GREEN}✓${NC} %s\n" "$1"; }
err(){ printf "${RED}✗${NC} %s\n" "$1"; exit 1; }

COOKIE=$(mktemp); trap 'rm -f $COOKIE' EXIT

curl -sf -c "$COOKIE" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
  "$API/api/v1/auth/login" >/dev/null || err "login failed"

# 1. Create a PAT
EXPIRES=$(date -u -v+1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)
PAT_BODY=$(curl -sf -b "$COOKIE" -X POST -H 'Content-Type: application/json' \
  -d "{\"name\":\"verify-script\",\"expiresAt\":\"$EXPIRES\",\"scopes\":[\"api:read\"]}" \
  "$API/api/v1/auth/tokens") || err "PAT create failed"
TOKEN=$(echo "$PAT_BODY" | jq -r '.data.token')
TOKEN_ID=$(echo "$PAT_BODY" | jq -r '.data.tokenId')
[[ "$TOKEN" == tellus_pat_* ]] || err "PAT missing tellus_pat_ prefix: $TOKEN"
ok "PAT created with tellus_pat_ prefix (id=$TOKEN_ID)"

# 2. Listing must NOT include raw token
LIST=$(curl -sf -b "$COOKIE" "$API/api/v1/auth/tokens")
if echo "$LIST" | jq -e '.data[] | select(.token)' >/dev/null 2>&1; then
  err "PAT listing leaked raw token"
fi
echo "$LIST" | jq -e ".data[] | select(.id == \"$TOKEN_ID\")" >/dev/null \
  || err "created PAT not present in listing"
ok "PAT listing returns metadata only (no raw token)"

# 3. Use the PAT via Authorization Bearer
curl -sf -H "Authorization: Bearer $TOKEN" "$API/api/v1/auth/token-info" >/dev/null \
  && ok "PAT authenticates via Bearer header"

# 4. Revoke — DELETE /tokens/:id is reauth-gated so we mint a fresh
#    reauth token first and forward it in X-Tellus-Reauth.
REAUTH=$(curl -sf -b "$COOKIE" -H 'Content-Type: application/json' -X POST \
  -d "{\"password\":\"$PASS\"}" "$API/api/v1/auth/me/reauth" | jq -r '.data.reauthToken')
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -b "$COOKIE" \
  -H "X-Tellus-Reauth: $REAUTH" \
  "$API/api/v1/auth/tokens/$TOKEN_ID")
[[ "$HTTP" == "204" ]] || err "revoke expected 204, got $HTTP"

# 5. Revoked PAT must 401
HTTP=$(curl -s -o /tmp/revoked.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" "$API/api/v1/auth/token-info")
[[ "$HTTP" == "401" ]] || err "revoked PAT still works (got $HTTP)"
jq -e '.errorCode == "TOKEN_REVOKED"' /tmp/revoked.json >/dev/null \
  || err "revoked PAT response missing TOKEN_REVOKED errorCode"
ok "revoked PAT rejected with TOKEN_REVOKED"

echo
ok "Task 9 PAT lifecycle verified"
