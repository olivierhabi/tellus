#!/usr/bin/env bash
#
# verify-auth-realm.sh
# --------------------
# Task 1 backend check — asserts the `tellus` realm matches the Palantir
# Multipass-equivalent spec in ontology/tellus-auth.md. Must be run after
# bootstrap-keycloak.sh. Exits non-zero on any deviation.

set -o pipefail

KC="${KC_URL:-http://localhost:8086}"
ADMIN_USER="${KC_ADMIN_USER:-admin}"
ADMIN_PASS="${KC_ADMIN_PASS:-admin}"
REALM="${KC_REALM:-tellus}"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
ok() { printf "${GREEN}✓${NC} %s\n" "$1"; }
err(){ printf "${RED}✗${NC} %s\n" "$1"; exit 1; }

TOKEN=$(curl -sf -X POST \
  -d "username=$ADMIN_USER&password=$ADMIN_PASS&grant_type=password&client_id=admin-cli" \
  "$KC/realms/master/protocol/openid-connect/token" | jq -r .access_token)
[[ -z "$TOKEN" || "$TOKEN" == "null" ]] && err "keycloak admin login failed"

REALM_JSON=$(curl -sf -H "Authorization: Bearer $TOKEN" "$KC/admin/realms/$REALM")

assert_eq() {
  local path="$1" expected="$2" label="$3"
  local actual
  actual=$(echo "$REALM_JSON" | jq -r "$path")
  if [[ "$actual" != "$expected" ]]; then
    err "$label — expected '$expected', got '$actual'"
  fi
  ok "$label = $actual"
}

assert_eq '.realm'                              "$REALM"   "realm name"
assert_eq '.enabled'                            "true"     "realm enabled"
assert_eq '.bruteForceProtected'                "true"     "brute-force protection"
assert_eq '.failureFactor'                      "10"       "failureFactor"
assert_eq '.maxFailureWaitSeconds'              "900"      "maxFailureWaitSeconds (15 min lockout)"
assert_eq '.ssoSessionMaxLifespan'              "86400"    "ssoSessionMaxLifespan (24h absolute SSO cap)"
assert_eq '.ssoSessionIdleTimeout'              "86400"    "ssoSessionIdleTimeout (24h idle)"
assert_eq '.accessTokenLifespan'                "3600"     "accessTokenLifespan (1h; client may override)"
assert_eq '.accessCodeLifespan'                 "600"      "accessCodeLifespan (10m PKCE window)"
assert_eq '.offlineSessionIdleTimeout'          "2592000"  "offlineSessionIdleTimeout (30d inactivity)"
assert_eq '.revokeRefreshToken'                 "true"     "revokeRefreshToken (rotation on)"
assert_eq '.webAuthnPolicyRequireResidentKey'   "Yes"      "webAuthn requireResidentKey"
assert_eq '.webAuthnPolicyUserVerificationRequirement' "required" "webAuthn user verification"
assert_eq '.registrationAllowed'                "false"    "self-service registration disabled"

PWD_POLICY=$(echo "$REALM_JSON" | jq -r '.passwordPolicy // ""')
for needle in 'length(12)' 'upperCase(1)' 'lowerCase(1)' 'digits(1)' 'specialChars(1)'; do
  if ! echo "$PWD_POLICY" | grep -q "$needle"; then
    err "password policy missing clause: $needle (got: $PWD_POLICY)"
  fi
done
ok "password policy includes length(12)+upper/lower/digit/special"

# MFA: no sms-authenticator or email-otp executions anywhere.
FLOWS=$(curl -sf -H "Authorization: Bearer $TOKEN" "$KC/admin/realms/$REALM/authentication/flows")
BAD=$(echo "$FLOWS" | jq '[.. | objects | select(.providerId=="sms-authenticator" or .providerId=="email-otp")] | length')
if [[ "$BAD" != "0" ]]; then
  err "found $BAD banned MFA executions (sms-authenticator / email-otp)"
fi
ok "no SMS or email OTP executions (spec rejects these methods)"

# OIDC discovery.
curl -sf "$KC/realms/$REALM/.well-known/openid-configuration" \
  | jq -e '.grant_types_supported | index("authorization_code") and index("client_credentials")' \
  >/dev/null || err "OIDC discovery missing required grant types"
ok "OIDC discovery advertises authorization_code + client_credentials"

# PKCE on tellus-frontend.
FE=$(curl -sf -H "Authorization: Bearer $TOKEN" "$KC/admin/realms/$REALM/clients?clientId=tellus-frontend" | jq '.[0]')
PKCE=$(echo "$FE" | jq -r '.attributes["pkce.code.challenge.method"] // ""')
[[ "$PKCE" == "S256" ]] || err "tellus-frontend client missing PKCE S256 (got '$PKCE')"
ok "tellus-frontend client enforces PKCE S256"

echo
ok "realm '$REALM' is Palantir Multipass-equivalent"
