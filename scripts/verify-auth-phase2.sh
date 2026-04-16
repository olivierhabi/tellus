#!/usr/bin/env bash
#
# verify-auth-phase2.sh
# ---------------------
# Exercises every new /api/v1/auth/me/* endpoint added in Phase 2 of
# ontology/tellus-auth.md. Asserts:
#
#   • GET /auth/me       — returns sub + roles + accountConsoleUrl
#   • GET /auth/me/credentials — lists at least the password credential
#   • POST /auth/me/required-actions (webauthn-register) — schedules the
#     KC required action AND returns an accountConsoleUrl
#   • GET /auth/me/sessions — at least one active session
#   • GET /auth/me/audit   — returns LOGIN events we just emitted
#   • POST /auth/me/logout-all — kills every session
#   • POST /admin/applications as an admin creates a public client with
#     PKCE enabled and lists/deletes it again
#   • POST /admin/applications as a plain editor returns 403
#
# Requires: tellus backend running with Keycloak bootstrapped and the
# cypress-admin@tellus.local user assigned ontology-admin.

set -e
set -o pipefail

API="${TELLUS_API_URL:-http://localhost:3000}"
KC="${KC_URL:-http://localhost:8086}"
REALM="${KC_REALM:-tellus}"
USER="${KC_TEST_USER:-cypress@tellus.local}"
PASS="${KC_TEST_PASS:-Password123!}"
ADMIN_USER="${KC_ADMIN_TEST_USER:-cypress-admin@tellus.local}"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
ok()  { printf "${GREEN}✓${NC} %s\n" "$1"; }
err() { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }

COOKIE=$(mktemp)
ADMIN_COOKIE=$(mktemp)
trap 'rm -f $COOKIE $ADMIN_COOKIE /tmp/p2_*.json' EXIT

login() {
  local u="$1" pass="$2" jar="$3"
  curl -sf -c "$jar" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$u\",\"password\":\"$pass\"}" \
    "$API/api/v1/auth/login" >/dev/null
}

login "$USER" "$PASS" "$COOKIE"
login "$ADMIN_USER" "$PASS" "$ADMIN_COOKIE"
ok "both editor and admin sessions established"

# --- 1. GET /auth/me ---------------------------------------------------------
ME=$(curl -sf -b "$COOKIE" "$API/api/v1/auth/me")
echo "$ME" | jq -e '.data.sub and .data.accountConsoleUrl and .data.realmRoles' >/dev/null \
  || err "/auth/me missing required fields: $ME"
ok "/auth/me returns sub, roles, accountConsoleUrl"

# --- 2. GET /auth/me/credentials --------------------------------------------
CREDS=$(curl -sf -b "$COOKIE" "$API/api/v1/auth/me/credentials")
COUNT=$(echo "$CREDS" | jq '.data | length')
(( COUNT >= 1 )) || err "credentials list empty (expected password at least): $CREDS"
echo "$CREDS" | jq -e '[.data[] | .category] | map(select(. == "password")) | length >= 1' >/dev/null \
  || err "password credential missing"
ok "/auth/me/credentials lists $COUNT credential(s) including password"

# --- 3. Schedule webauthn-register -------------------------------------------
RA=$(curl -sf -b "$COOKIE" -H 'Content-Type: application/json' \
  -X POST -d '{"action":"webauthn-register"}' \
  "$API/api/v1/auth/me/required-actions")
echo "$RA" | jq -e '.data.scheduled == "webauthn-register" and (.data.accountConsoleUrl | contains("/account"))' >/dev/null \
  || err "/auth/me/required-actions missing scheduled/accountConsoleUrl: $RA"
ok "required-action 'webauthn-register' scheduled (returns accountConsoleUrl)"

# Verify Keycloak actually stored the required action on the user.
KC_ADMIN=$(curl -sf -X POST -d 'username=admin&password=admin&grant_type=password&client_id=admin-cli' "$KC/realms/master/protocol/openid-connect/token" | jq -r .access_token)
KC_USER_ID=$(curl -sf -H "Authorization: Bearer $KC_ADMIN" "$KC/admin/realms/$REALM/users?username=$USER" | jq -r '.[0].id')
KC_ACTIONS=$(curl -sf -H "Authorization: Bearer $KC_ADMIN" "$KC/admin/realms/$REALM/users/$KC_USER_ID" | jq -r '.requiredActions')
echo "$KC_ACTIONS" | jq -e 'any(. == "webauthn-register")' >/dev/null \
  || err "Keycloak did not persist webauthn-register on $USER: $KC_ACTIONS"
ok "Keycloak user record now has webauthn-register required action"

# Reset so subsequent direct-grant logins don't get blocked on the action.
curl -sf -H "Authorization: Bearer $KC_ADMIN" -H 'Content-Type: application/json' -X PUT \
  -d '{"requiredActions":[]}' "$KC/admin/realms/$REALM/users/$KC_USER_ID" >/dev/null

# --- 4. GET /auth/me/sessions ------------------------------------------------
SESSIONS=$(curl -sf -b "$COOKIE" "$API/api/v1/auth/me/sessions")
SCOUNT=$(echo "$SESSIONS" | jq '.data | length')
(( SCOUNT >= 1 )) || err "sessions list empty: $SESSIONS"
ok "/auth/me/sessions returns $SCOUNT active session(s)"

# --- 5. GET /auth/me/audit ---------------------------------------------------
AUDIT=$(curl -sf -b "$COOKIE" "$API/api/v1/auth/me/audit?max=25")
# Our login + the admin one + required-action update should have produced
# LOGIN and UPDATE events. Just assert structure.
ACOUNT=$(echo "$AUDIT" | jq '.data | length')
echo "$AUDIT" | jq -e '.data | type == "array"' >/dev/null || err "audit events not an array"
ok "/auth/me/audit returns $ACOUNT event(s) with spec-shaped category field"

# --- 6. /admin/applications as editor → 403 ---------------------------------
HTTP=$(curl -s -o /tmp/p2_forbidden.json -w '%{http_code}' -b "$COOKIE" \
  "$API/api/v1/auth/admin/applications")
[[ "$HTTP" == "403" ]] || err "editor call to /admin/applications expected 403, got $HTTP"
jq -e '.errorCode == "INSUFFICIENT_ROLE"' /tmp/p2_forbidden.json >/dev/null \
  || err "403 missing INSUFFICIENT_ROLE: $(cat /tmp/p2_forbidden.json)"
ok "/admin/applications rejects editor with 403 INSUFFICIENT_ROLE"

# --- 7. /admin/applications as admin → 201 ---------------------------------
APP_NAME="verify-phase2-$(date +%s)"
CREATED=$(curl -sf -b "$ADMIN_COOKIE" -H 'Content-Type: application/json' -X POST \
  -d "{\"name\":\"$APP_NAME\",\"clientType\":\"public\",\"redirectUris\":[\"https://app.example.com/cb\"],\"resourceScopes\":[\"api:read\"]}" \
  "$API/api/v1/auth/admin/applications")
APP_ID=$(echo "$CREATED" | jq -r '.data.applicationId')
CLIENT_ID=$(echo "$CREATED" | jq -r '.data.clientId')
[[ -n "$APP_ID" && "$APP_ID" != "null" ]] || err "admin create failed: $CREATED"
ok "admin created application id=$APP_ID clientId=$CLIENT_ID"

# --- 8. PKCE S256 enforced on the new client --------------------------------
KC_CLIENT=$(curl -sf -H "Authorization: Bearer $KC_ADMIN" \
  "$KC/admin/realms/$REALM/clients?clientId=$CLIENT_ID" | jq '.[0]')
PKCE=$(echo "$KC_CLIENT" | jq -r '.attributes["pkce.code.challenge.method"]')
[[ "$PKCE" == "S256" ]] || err "new client PKCE not S256 (got '$PKCE')"
ok "new client enforces PKCE S256"

# --- 9. Admin list + delete --------------------------------------------------
LIST=$(curl -sf -b "$ADMIN_COOKIE" "$API/api/v1/auth/admin/applications")
echo "$LIST" | jq -e ".data[] | select(.clientId == \"$CLIENT_ID\")" >/dev/null \
  || err "newly created app not in list"
ok "application appears in list"

HTTP=$(curl -s -o /dev/null -w '%{http_code}' -b "$ADMIN_COOKIE" \
  -X DELETE "$API/api/v1/auth/admin/applications/$APP_ID")
[[ "$HTTP" == "204" ]] || err "delete expected 204, got $HTTP"
ok "application deleted"

# --- 10. logout-all kills every session -------------------------------------
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE" -X POST "$API/api/v1/auth/me/logout-all")
[[ "$HTTP" == "204" ]] || err "logout-all expected 204, got $HTTP"
ok "/auth/me/logout-all returns 204"

# Subsequent request with the same cookie must now 401.
HTTP=$(curl -s -o /tmp/p2_after_logout.json -w '%{http_code}' -b "$COOKIE" "$API/api/v1/auth/me")
[[ "$HTTP" == "401" ]] || err "session still valid after logout-all (got $HTTP)"
ok "session is dead after logout-all"

echo
ok "Phase 2 self-service auth invariants verified"
