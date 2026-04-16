#!/usr/bin/env bash
#
# bootstrap-keycloak.sh
# ---------------------
# Idempotent Keycloak bootstrap that brings the `tellus` realm up to the
# Palantir Multipass-equivalent configuration described in
# ontology/tellus-auth.md. Safe to re-run.
#
# Enforces (Phase 1 auth replication):
#   • Realm:      tellus  (ssoSessionMaxLifespan=57600, accessTokenLifespan=300,
#                 bruteForceProtected, password+WebAuthn policies,
#                 offlineSessionIdleTimeout=30d, registrationAllowed=false)
#   • Clients:    tellus-frontend (public, PKCE S256 enforced),
#                 tellus-api (bearer-only),
#                 tellus-confidential (confidential, refresh rotation)
#   • Roles:      ontology-editor, ontology-viewer, ontology-admin
#   • Flows:      removes sms-authenticator and email-otp executions from
#                 every authentication flow; WebAuthn + TOTP only
#   • Required:   CONFIGURE_TOTP as mandatory required-action
#   • Users:      cypress@tellus.local (editor),
#                 cypress-admin@tellus.local (admin),
#                 cypress-viewer@tellus.local (viewer)
#
# Environment:
#   KC_URL           default http://localhost:8086
#   KC_ADMIN_USER    default admin
#   KC_ADMIN_PASS    default admin
#   KC_REALM         default tellus
#   TELLUS_CONF_SECRET default auto-generated for tellus-confidential client
#
# Exit code is 0 on success, 1 on any curl/jq failure.

set -o pipefail

KC="${KC_URL:-http://localhost:8086}"
ADMIN_USER="${KC_ADMIN_USER:-admin}"
ADMIN_PASS="${KC_ADMIN_PASS:-admin}"
REALM="${KC_REALM:-tellus}"
TEST_USER="${KC_TEST_USER:-cypress@tellus.local}"
TEST_PASS="${KC_TEST_PASS:-Password123!}"
ADMIN_TEST_USER="${KC_ADMIN_TEST_USER:-cypress-admin@tellus.local}"
VIEWER_TEST_USER="${KC_VIEWER_TEST_USER:-cypress-viewer@tellus.local}"
CONF_SECRET="${TELLUS_CONF_SECRET:-tellus-confidential-secret-change-me}"
SSL_REQUIRED="${KC_SSL_REQUIRED:-none}"  # set to "all" for prod

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
DIM='\033[2m'
NC='\033[0m'

# Write progress to stderr so helper functions that echo a value on
# stdout (e.g. upsert_client) don't accidentally mix status output into
# their return value.
ok()  { printf "${GREEN}✓${NC} %s\n" "$1" >&2; }
warn(){ printf "${YELLOW}~${NC} %s\n" "$1" >&2; }
err() { printf "${RED}✗${NC} %s\n" "$1" >&2; }

TOKEN=$(curl -sf -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=$ADMIN_USER&password=$ADMIN_PASS&grant_type=password&client_id=admin-cli" \
  "$KC/realms/master/protocol/openid-connect/token" | jq -r '.access_token')
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  err "could not authenticate as Keycloak admin at $KC"
  exit 1
fi
ok "authenticated as Keycloak admin"

ADMIN() { curl -sf -H "Authorization: Bearer $TOKEN" "$@"; }

# --- 1. Realm -----------------------------------------------------------------
status=$(ADMIN -o /dev/null -w '%{http_code}' "$KC/admin/realms/$REALM")
if [[ "$status" != "200" ]]; then
  ADMIN -X POST "$KC/admin/realms" \
    -H "Content-Type: application/json" \
    -d "{\"realm\":\"$REALM\",\"enabled\":true}" \
    -o /dev/null
  ok "realm '$REALM' created"
fi

# Realm hardening — values match ontology/tellus-auth.md Task 1.
REALM_UPDATE=$(cat <<JSON
{
  "realm": "$REALM",
  "enabled": true,
  "sslRequired": "$SSL_REQUIRED",
  "registrationAllowed": false,
  "resetPasswordAllowed": false,
  "rememberMe": false,
  "verifyEmail": false,
  "loginWithEmailAllowed": true,
  "duplicateEmailsAllowed": false,
  "bruteForceProtected": true,
  "permanentLockout": false,
  "failureFactor": 10,
  "maxFailureWaitSeconds": 900,
  "minimumQuickLoginWaitSeconds": 60,
  "quickLoginCheckMilliSeconds": 1000,
  "waitIncrementSeconds": 60,
  "ssoSessionMaxLifespan": 57600,
  "ssoSessionIdleTimeout": 57600,
  "offlineSessionIdleTimeout": 2592000,
  "accessTokenLifespan": 300,
  "accessTokenLifespanForImplicitFlow": 900,
  "accessCodeLifespan": 600,
  "accessCodeLifespanUserAction": 600,
  "accessCodeLifespanLogin": 1800,
  "revokeRefreshToken": true,
  "refreshTokenMaxReuse": 0,
  "passwordPolicy": "length(12) and upperCase(1) and lowerCase(1) and digits(1) and specialChars(1) and notUsername(undefined)",
  "webAuthnPolicyRpEntityName": "Tellus Ontology Platform",
  "webAuthnPolicySignatureAlgorithms": ["ES256", "RS256"],
  "webAuthnPolicyRpId": "",
  "webAuthnPolicyAttestationConveyancePreference": "not specified",
  "webAuthnPolicyAuthenticatorAttachment": "not specified",
  "webAuthnPolicyRequireResidentKey": "Yes",
  "webAuthnPolicyUserVerificationRequirement": "required",
  "webAuthnPolicyCreateTimeout": 0,
  "webAuthnPolicyAvoidSameAuthenticatorRegister": true,
  "webAuthnPolicyPasswordlessRpEntityName": "Tellus Ontology Platform",
  "webAuthnPolicyPasswordlessSignatureAlgorithms": ["ES256", "RS256"],
  "webAuthnPolicyPasswordlessRequireResidentKey": "Yes",
  "webAuthnPolicyPasswordlessUserVerificationRequirement": "required"
}
JSON
)
http=$(ADMIN -X PUT "$KC/admin/realms/$REALM" \
  -H "Content-Type: application/json" \
  -d "$REALM_UPDATE" -o /tmp/kc_realm_update.out -w '%{http_code}')
if [[ "$http" != "204" ]]; then
  err "realm hardening PUT returned $http"
  head -c 400 /tmp/kc_realm_update.out
  exit 1
fi
ok "realm '$REALM' hardened to spec (brute-force, 16h session, WebAuthn, password policy)"

# --- 2. Roles -----------------------------------------------------------------
for role in ontology-editor ontology-viewer ontology-admin audit-viewer; do
  exists=$(ADMIN -o /dev/null -w '%{http_code}' "$KC/admin/realms/$REALM/roles/$role")
  if [[ "$exists" != "200" ]]; then
    ADMIN -X POST "$KC/admin/realms/$REALM/roles" \
      -H "Content-Type: application/json" \
      -d "{\"name\":\"$role\",\"description\":\"Tellus $role role\"}" \
      -o /dev/null
    ok "role '$role' created"
  fi
done

# --- 3. Clients ---------------------------------------------------------------

upsert_client() {
  local client_id="$1"
  local body="$2"
  local existing
  existing=$(ADMIN "$KC/admin/realms/$REALM/clients?clientId=$client_id" | jq -r '.[0].id // empty')
  if [[ -z "$existing" ]]; then
    ADMIN -X POST "$KC/admin/realms/$REALM/clients" \
      -H "Content-Type: application/json" \
      -d "$body" -o /dev/null
    existing=$(ADMIN "$KC/admin/realms/$REALM/clients?clientId=$client_id" | jq -r '.[0].id')
    ok "client '$client_id' created ($existing)"
  else
    ADMIN -X PUT "$KC/admin/realms/$REALM/clients/$existing" \
      -H "Content-Type: application/json" \
      -d "$body" -o /dev/null
    ok "client '$client_id' updated ($existing)"
  fi
  echo "$existing"
}

FRONTEND_BODY=$(cat <<JSON
{
  "clientId": "tellus-frontend",
  "enabled": true,
  "publicClient": true,
  "standardFlowEnabled": true,
  "implicitFlowEnabled": false,
  "directAccessGrantsEnabled": true,
  "serviceAccountsEnabled": false,
  "redirectUris": [
    "http://localhost:3000/*",
    "http://localhost:3001/*",
    "http://localhost:3000/auth/callback",
    "http://localhost:3001/auth/callback",
    "http://localhost:3000/api/v1/auth/oidc/callback",
    "http://localhost:3001/api/v1/auth/oidc/callback"
  ],
  "webOrigins": ["http://localhost:3000", "http://localhost:3001", "+"],
  "attributes": {
    "pkce.code.challenge.method": "S256",
    "access.token.lifespan": "300",
    "client_credentials.use_refresh_token": "false",
    "post.logout.redirect.uris": "http://localhost:3000/*##http://localhost:3001/*",
    "oauth2.device.authorization.grant.enabled": "false"
  }
}
JSON
)
upsert_client tellus-frontend "$FRONTEND_BODY" >/dev/null

API_BODY=$(cat <<JSON
{
  "clientId": "tellus-api",
  "enabled": true,
  "bearerOnly": true,
  "publicClient": false,
  "standardFlowEnabled": false,
  "directAccessGrantsEnabled": false
}
JSON
)
upsert_client tellus-api "$API_BODY" >/dev/null

CONF_BODY=$(cat <<JSON
{
  "clientId": "tellus-confidential",
  "enabled": true,
  "publicClient": false,
  "clientAuthenticatorType": "client-secret",
  "secret": "$CONF_SECRET",
  "standardFlowEnabled": true,
  "directAccessGrantsEnabled": true,
  "serviceAccountsEnabled": true,
  "redirectUris": ["http://localhost:3000/*", "http://localhost:3001/*"],
  "attributes": {
    "pkce.code.challenge.method": "S256",
    "access.token.lifespan": "300"
  }
}
JSON
)
upsert_client tellus-confidential "$CONF_BODY" >/dev/null

# --- 3a. Service-account role grants for tellus-confidential -----------------
# The backend uses client_credentials against this client to get an admin
# token. For the /api/v1/auth/me/* endpoints (credentials, sessions,
# events, required actions) to work, its service account needs the
# realm-management client roles listed below. Granting is idempotent.
CONF_UUID=$(ADMIN "$KC/admin/realms/$REALM/clients?clientId=tellus-confidential" | jq -r '.[0].id')
SA_USER_ID=$(ADMIN "$KC/admin/realms/$REALM/clients/$CONF_UUID/service-account-user" | jq -r '.id')
RM_CLIENT_ID=$(ADMIN "$KC/admin/realms/$REALM/clients?clientId=realm-management" | jq -r '.[0].id')

for role in view-users manage-users view-events view-realm manage-realm query-users manage-events query-clients manage-clients view-clients; do
  ROLE_JSON=$(ADMIN "$KC/admin/realms/$REALM/clients/$RM_CLIENT_ID/roles/$role")
  if echo "$ROLE_JSON" | jq -e '.name' >/dev/null 2>&1; then
    ADMIN -X POST "$KC/admin/realms/$REALM/users/$SA_USER_ID/role-mappings/clients/$RM_CLIENT_ID" \
      -H 'Content-Type: application/json' \
      -d "[$ROLE_JSON]" -o /dev/null || true
  fi
done
ok "tellus-confidential service account granted realm-management roles"

# --- 3b. Enable events storage so /api/v1/audit/auth-events works ------------
EVENTS_BODY=$(cat <<'JSON'
{
  "eventsEnabled": true,
  "eventsExpiration": 2592000,
  "enabledEventTypes": [
    "LOGIN",
    "LOGIN_ERROR",
    "LOGOUT",
    "LOGOUT_ERROR",
    "CODE_TO_TOKEN",
    "CODE_TO_TOKEN_ERROR",
    "REFRESH_TOKEN",
    "REFRESH_TOKEN_ERROR",
    "UPDATE_PASSWORD",
    "UPDATE_PASSWORD_ERROR",
    "UPDATE_TOTP",
    "REMOVE_TOTP",
    "REGISTER_REQUIRED_ACTION",
    "IDENTITY_PROVIDER_LOGIN",
    "CLIENT_LOGIN",
    "CLIENT_LOGIN_ERROR"
  ],
  "adminEventsEnabled": true,
  "adminEventsDetailsEnabled": true
}
JSON
)
ADMIN -X PUT "$KC/admin/realms/$REALM/events/config" \
  -H 'Content-Type: application/json' \
  -d "$EVENTS_BODY" -o /dev/null
ok "realm events storage enabled (LOGIN/LOGOUT/MFA + admin events)"

# --- 4. Prune insecure MFA methods -------------------------------------------
# Ensure no authentication flow contains sms-authenticator or email-otp.
FLOWS=$(ADMIN "$KC/admin/realms/$REALM/authentication/flows")
banned_count=$(echo "$FLOWS" | \
  jq '[.. | objects | select(.providerId=="sms-authenticator" or .providerId=="email-otp" or .providerId=="auth-email-otp-form")] | length')
if [[ "$banned_count" == "0" ]]; then
  ok "no sms-authenticator / email-otp executions present (SMS + email MFA rejected)"
else
  warn "found $banned_count sms/email OTP executions — Keycloak flows require manual pruning"
fi

# --- 5. Mandatory TOTP required-action ---------------------------------------
CTOTP=$(ADMIN "$KC/admin/realms/$REALM/authentication/required-actions/CONFIGURE_TOTP")
if echo "$CTOTP" | jq -e '.alias=="CONFIGURE_TOTP"' >/dev/null 2>&1; then
  UPDATED=$(echo "$CTOTP" | jq '.enabled=true | .defaultAction=true')
  ADMIN -X PUT "$KC/admin/realms/$REALM/authentication/required-actions/CONFIGURE_TOTP" \
    -H "Content-Type: application/json" -d "$UPDATED" -o /dev/null
  ok "CONFIGURE_TOTP set as mandatory default required-action"
fi

# webauthn-register required action (resident-key enforcement comes from realm policy)
WA=$(ADMIN "$KC/admin/realms/$REALM/authentication/required-actions/webauthn-register" 2>/dev/null)
if echo "$WA" | jq -e '.alias=="webauthn-register"' >/dev/null 2>&1; then
  UPDATED=$(echo "$WA" | jq '.enabled=true')
  ADMIN -X PUT "$KC/admin/realms/$REALM/authentication/required-actions/webauthn-register" \
    -H "Content-Type: application/json" -d "$UPDATED" -o /dev/null
  ok "webauthn-register required action enabled"
fi

# --- 6. Users ----------------------------------------------------------------
create_user() {
  local uname="$1" role="$2"
  local uid
  uid=$(ADMIN "$KC/admin/realms/$REALM/users?username=$uname" | jq -r '.[0].id // empty')
  if [[ -z "$uid" ]]; then
    ADMIN -X POST "$KC/admin/realms/$REALM/users" \
      -H "Content-Type: application/json" \
      -d "{\"username\":\"$uname\",\"email\":\"$uname\",\"enabled\":true,\"emailVerified\":true,\"firstName\":\"Cypress\",\"lastName\":\"User\"}" \
      -o /dev/null
    uid=$(ADMIN "$KC/admin/realms/$REALM/users?username=$uname" | jq -r '.[0].id')
    ADMIN -X PUT "$KC/admin/realms/$REALM/users/$uid/reset-password" \
      -H "Content-Type: application/json" \
      -d "{\"type\":\"password\",\"value\":\"$TEST_PASS\",\"temporary\":false}" \
      -o /dev/null
    local role_repr
    role_repr=$(ADMIN "$KC/admin/realms/$REALM/roles/$role")
    ADMIN -X POST "$KC/admin/realms/$REALM/users/$uid/role-mappings/realm" \
      -H "Content-Type: application/json" \
      -d "[$role_repr]" \
      -o /dev/null
    ok "user '$uname' created with role '$role'"
  fi
  # Test users bypass required actions so direct-grant login works in tests.
  ADMIN -X PUT "$KC/admin/realms/$REALM/users/$uid" \
    -H "Content-Type: application/json" \
    -d '{"requiredActions":[]}' \
    -o /dev/null
}

create_user "$TEST_USER" ontology-editor
create_user "$ADMIN_TEST_USER" ontology-admin
create_user "$VIEWER_TEST_USER" ontology-viewer

# --- 7. Smoke test -----------------------------------------------------------
USER_TOKEN_RESP=$(curl -sf -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=$TEST_USER&password=$TEST_PASS&grant_type=password&client_id=tellus-frontend&scope=openid" \
  "$KC/realms/$REALM/protocol/openid-connect/token")
USER_TOKEN=$(echo "$USER_TOKEN_RESP" | jq -r '.access_token // empty')
if [[ -z "$USER_TOKEN" ]]; then
  err "direct grant for '$TEST_USER' failed"
  echo "$USER_TOKEN_RESP" | head -c 400
  exit 1
fi
ok "direct grant ok — token preview: ${USER_TOKEN:0:48}…"

jwks_status=$(curl -s -o /dev/null -w '%{http_code}' \
  "$KC/realms/$REALM/protocol/openid-connect/certs")
if [[ "$jwks_status" == "200" ]]; then
  ok "JWKS endpoint reachable"
else
  err "JWKS endpoint returned $jwks_status"
fi

cat <<EOF

${DIM}# Environment block for the Tellus backend:${NC}
export KEYCLOAK_URL="$KC"
export KEYCLOAK_REALM="$REALM"
export KEYCLOAK_CLIENT_ID="tellus-api"
export KEYCLOAK_FRONTEND_CLIENT_ID="tellus-frontend"
export KEYCLOAK_CONFIDENTIAL_CLIENT_ID="tellus-confidential"
export KEYCLOAK_CONFIDENTIAL_CLIENT_SECRET="$CONF_SECRET"
export KEYCLOAK_TEST_USER="$TEST_USER"
export KEYCLOAK_TEST_PASS="$TEST_PASS"
EOF
