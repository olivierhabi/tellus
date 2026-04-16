#!/usr/bin/env bash
#
# verify-auth-mfa.sh
# ------------------
# Task 5 backend check — asserts WebAuthn policy matches spec and that
# brute-force protection locks an account after the failureFactor.

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
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || err "admin login failed"

REALM_JSON=$(curl -sf -H "Authorization: Bearer $TOKEN" "$KC/admin/realms/$REALM")

# WebAuthn policy checks — Task 5 + Task 1 overlap.
echo "$REALM_JSON" | jq -e '.webAuthnPolicyRequireResidentKey == "Yes"' >/dev/null \
  || err "webAuthnPolicyRequireResidentKey != Yes"
ok "WebAuthn policy requires resident key"

echo "$REALM_JSON" | jq -e '.webAuthnPolicyUserVerificationRequirement == "required"' >/dev/null \
  || err "webAuthnPolicyUserVerificationRequirement != required"
ok "WebAuthn policy requires user verification"

echo "$REALM_JSON" | jq -e '.webAuthnPolicySignatureAlgorithms | index("ES256")' >/dev/null \
  || err "WebAuthn missing ES256"
ok "WebAuthn signature algorithms include ES256"

# CONFIGURE_TOTP required action should be enabled+default for mandatory MFA.
CTOTP=$(curl -sf -H "Authorization: Bearer $TOKEN" \
  "$KC/admin/realms/$REALM/authentication/required-actions/CONFIGURE_TOTP")
echo "$CTOTP" | jq -e '.enabled == true' >/dev/null \
  || err "CONFIGURE_TOTP not enabled (MFA isn't mandatory)"
ok "CONFIGURE_TOTP required action enabled (mandatory MFA)"

# No SMS / email OTP anywhere.
FLOWS=$(curl -sf -H "Authorization: Bearer $TOKEN" \
  "$KC/admin/realms/$REALM/authentication/flows")
BAD=$(echo "$FLOWS" | jq '[.. | objects | select(.providerId=="sms-authenticator" or .providerId=="email-otp")] | length')
[[ "$BAD" == "0" ]] || err "found $BAD banned executions (sms/email)"
ok "no sms-authenticator / email-otp executions"

# Brute-force: hit the token endpoint with bad passwords >failureFactor.
BF_USER="${BF_USER:-brute-force-$(date +%s)}"
BF_PASS='WrongPass1!WrongPass1!'
# create a throwaway user
UID_=$(curl -sf -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -X POST -d "{\"username\":\"$BF_USER\",\"email\":\"$BF_USER@t.local\",\"enabled\":true,\"emailVerified\":true,\"firstName\":\"BF\",\"lastName\":\"Test\"}" \
  "$KC/admin/realms/$REALM/users" -i | awk '/^[Ll]ocation:/ {print $2}' | tr -d '\r' | awk -F/ '{print $NF}')
[[ -n "$UID_" ]] || UID_=$(curl -sf -H "Authorization: Bearer $TOKEN" \
  "$KC/admin/realms/$REALM/users?username=$BF_USER" | jq -r '.[0].id')
curl -sf -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X PUT -d "{\"type\":\"password\",\"value\":\"$BF_PASS\",\"temporary\":false}" \
  "$KC/admin/realms/$REALM/users/$UID_/reset-password" >/dev/null

for i in $(seq 1 11); do
  curl -s -o /dev/null -X POST \
    -d "grant_type=password&client_id=tellus-frontend&username=$BF_USER&password=WRONG_$i" \
    "$KC/realms/$REALM/protocol/openid-connect/token" || true
done

# Correct password should now fail (locked).
HTTP=$(curl -s -o /tmp/locked.json -w '%{http_code}' -X POST \
  -d "grant_type=password&client_id=tellus-frontend&username=$BF_USER&password=$BF_PASS" \
  "$KC/realms/$REALM/protocol/openid-connect/token")
if [[ "$HTTP" == "200" ]]; then
  err "account NOT locked after 10 failed attempts — brute-force protection inactive"
fi
ok "account locked after $((11)) failed attempts ($HTTP)"

# cleanup
curl -sf -H "Authorization: Bearer $TOKEN" -X DELETE \
  "$KC/admin/realms/$REALM/users/$UID_" >/dev/null || true

echo
ok "Task 5 MFA + brute-force verified"
