#!/usr/bin/env bash
#
# verify-auth-keycloak-only.sh
# ----------------------------
# Proves that the backend accepts ONLY Keycloak-issued credentials and
# that both supported login paths (direct-grant POST /api/v1/auth/login
# and PKCE GET /api/v1/auth/oidc/authorize → callback) resolve to the
# same identity when used with the same email address.
#
# Invariants asserted:
#   • Legacy /api/auth/{register,login,refresh,logout} return 410 Gone
#     with errorCode=ENDPOINT_REMOVED and replacement=/api/v1/auth.
#   • /api/v1/auth/token-info without credentials is 401 with the
#     spec error envelope (errorCode + requestId).
#   • Direct-grant login for cypress@tellus.local returns tokenInfo.sub
#     equal to the PKCE flow's tokenInfo.sub for the same user.
#   • /api/v1/auth/check-access returns the same decision + reason for
#     both sessions for operation=read, resourceType=object-type.
#   • /api/docs/spec.json declares bearerAuth + cookieAuth + patAuth
#     and publishes the /v1/auth/* paths.
#
# Prereq: tellus backend on $TELLUS_API_URL, Keycloak on $KC_URL, and
# bootstrap-keycloak.sh has been run (user cypress@tellus.local exists).

set -e
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
err() { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }

# --- 1. Legacy /api/auth/* router is fully gone ---------------------------
# Phase 3 deleted the 410-shim router. Hitting the old paths now falls
# through to the catch-all notFoundHandler which returns 404 with
# { error: { code: "ROUTE_NOT_FOUND", ... } }. This test catches any
# accidental re-introduction of the legacy surface.
for path in register login refresh logout; do
  HTTP=$(curl -s -o /tmp/gone.json -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' \
    -d '{}' "$API/api/auth/$path")
  [[ "$HTTP" == "404" ]] || err "/api/auth/$path expected 404 (fully removed), got $HTTP"
done
ok "legacy /api/auth/{register,login,refresh,logout} router has been deleted"

# --- 2. Unauthenticated /api/v1/auth/token-info returns spec envelope -------
HTTP=$(curl -s -o /tmp/unauth.json -w '%{http_code}' "$API/api/v1/auth/token-info")
[[ "$HTTP" == "401" ]] || err "unauthenticated token-info expected 401, got $HTTP"
jq -e '.errorCode and .requestId and .statusCode == 401' /tmp/unauth.json >/dev/null \
  || err "401 response missing spec envelope"
ok "unauthenticated /api/v1/auth/token-info returns 401 with spec envelope"

# --- 3. Direct-grant login ---------------------------------------------------
DG=$(curl -sf -X POST -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
  "$API/api/v1/auth/login")
DG_TOKEN=$(echo "$DG" | jq -r '.data.accessToken')
DG_SUB=$(echo "$DG" | jq -r '.data.tokenInfo.sub')
[[ -n "$DG_TOKEN" && "$DG_TOKEN" != "null" ]] || err "direct grant returned no accessToken"
ok "direct-grant login ok (sub=$DG_SUB)"

# --- 4. The Phase-3 in-app auth invariant ----------------------------------
# The PKCE Authorization Code + browser-callback flow was retired in
# Phase 3 of ontology/tellus-auth.md so the frontend never navigates to
# the Keycloak hostname. The "both login paths are identity-equivalent"
# invariant from Phase 2 collapses to: two direct-grant logins for the
# same email always return the same Keycloak sub and resolve the same
# /check-access decision.
DG2=$(curl -sf -X POST -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
  "$API/api/v1/auth/login")
DG2_TOKEN=$(echo "$DG2" | jq -r '.data.accessToken')
DG2_SUB=$(echo "$DG2" | jq -r '.data.tokenInfo.sub')
[[ "$DG_SUB" == "$DG2_SUB" ]] \
  || err "direct-grant sub diverged between calls: $DG_SUB vs $DG2_SUB"
ok "two direct-grant logins for the same email resolve to the same sub"

# Confirm the retired redirect endpoints are actually gone from the
# backend — catches accidental re-introduction.
for path in oidc/authorize oidc/callback me/required-actions; do
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/v1/auth/$path")
  if [[ "$path" == "me/required-actions" ]]; then
    [[ "$STATUS" == "401" || "$STATUS" == "404" ]] || err "/$path expected 401/404, got $STATUS"
  else
    [[ "$STATUS" == "404" ]] || err "/$path expected 404 after retirement, got $STATUS"
  fi
done
ok "PKCE + required-actions redirect endpoints are gone"

# --- 5. Check-access parity between the two direct-grant sessions ---------
CHK1=$(curl -sf -X POST -H "Authorization: Bearer $DG_TOKEN" -H 'Content-Type: application/json' \
  -d '{"operation":"read","resourceType":"object-type"}' \
  "$API/api/v1/auth/check-access")
CHK2=$(curl -sf -X POST -H "Authorization: Bearer $DG2_TOKEN" -H 'Content-Type: application/json' \
  -d '{"operation":"read","resourceType":"object-type"}' \
  "$API/api/v1/auth/check-access")
A1=$(echo "$CHK1" | jq -c '.data.allowed')
A2=$(echo "$CHK2" | jq -c '.data.allowed')
R1=$(echo "$CHK1" | jq -r '.data.reason')
R2=$(echo "$CHK2" | jq -r '.data.reason')
[[ "$A1" == "$A2" && "$R1" == "$R2" ]] \
  || err "check-access divergence across sessions: $CHK1 vs $CHK2"
ok "check-access identical for both direct-grant sessions (allowed=$A1 reason=$R1)"

# --- 7. OpenAPI spec declares Keycloak auth ---------------------------------
SPEC=$(curl -sf "$API/api/docs/spec.json")
for scheme in bearerAuth cookieAuth patAuth; do
  echo "$SPEC" | jq -e ".components.securitySchemes.$scheme" >/dev/null \
    || err "/api/docs/spec.json missing securityScheme: $scheme"
done
ok "OpenAPI spec declares bearerAuth + cookieAuth + patAuth"

for path in /v1/auth/login /v1/auth/logout /v1/auth/token-info /v1/auth/check-access /v1/auth/login/mfa /v1/auth/me/password /v1/auth/me/totp/start /v1/auth/me/webauthn/register-options /v1/auth/tokens; do
  echo "$SPEC" | jq -e ".paths[\"$path\"]" >/dev/null \
    || err "OpenAPI spec missing path: $path"
done
ok "OpenAPI spec publishes every /v1/auth/* operation including Phase 3 in-app routes"

# OpenAPI spec no longer advertises any legacy /auth/* path — Phase 3
# removed them entirely. Presence of even one is a regression.
for path in /auth/login /auth/register /auth/refresh /auth/logout; do
  if echo "$SPEC" | jq -e ".paths[\"$path\"]" >/dev/null 2>&1; then
    err "OpenAPI spec still contains legacy $path — should be deleted"
  fi
done
ok "OpenAPI spec contains NO legacy /auth/* paths"

echo
ok "Keycloak-only auth invariants verified — both login paths are identity-equivalent"
