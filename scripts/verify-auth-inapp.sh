#!/usr/bin/env bash
#
# verify-auth-inapp.sh
# --------------------
# Phase 3 in-app credential flows (ontology/tellus-auth.md). Asserts
# that every credential-management surface runs inside tellus — no
# browser redirect to the Keycloak hostname — AND that the two-step
# MFA login flow through /api/v1/auth/login/mfa works end-to-end.
#
# Checks:
#
#   1. Legacy FE-hitting redirect endpoints are GONE:
#        GET  /api/v1/auth/oidc/authorize  → 404
#        GET  /api/v1/auth/oidc/callback   → 404
#        POST /api/v1/auth/me/required-actions → 404
#
#   2. Password change in-app:
#        POST /api/v1/auth/me/password {old, new}
#        → 204 on success
#        → 401 OLD_PASSWORD_INVALID when the current password is wrong
#
#   3. TOTP enrollment in-app:
#        POST /api/v1/auth/me/totp/start   → {qrDataUrl, secret, otpauthUrl}
#        POST /api/v1/auth/me/totp/verify  → 204 when the code matches
#        After enrollment, /api/v1/auth/me/totp/status.enabled == true
#
#   4. Two-step login works when TOTP is enrolled:
#        POST /api/v1/auth/login           → {mfaRequired:true, mfaChallenge, methods}
#        POST /api/v1/auth/login/mfa       → session cookie set
#
#   5. Disabling TOTP returns the account to single-factor login.
#
# Prereqs:
#   • tellus backend running on $TELLUS_API_URL
#   • Keycloak running + bootstrapped
#   • habimanaolivier6@gmail.com / Olivier0?Tellus exists (created earlier)

set -e
set -o pipefail

API="${TELLUS_API_URL:-http://localhost:3000}"
KC="${KC_URL:-http://localhost:8086}"
REALM="${KC_REALM:-tellus}"

# Use a dedicated account so we don't stomp on anyone else's TOTP secret.
USER="${KC_INAPP_USER:-habimanaolivier6@gmail.com}"
OLD_PASS="${KC_INAPP_OLD_PASS:-Olivier0?Tellus}"
NEW_PASS="${KC_INAPP_NEW_PASS:-Olivier1!TellusRotation}"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
ok()  { printf "${GREEN}✓${NC} %s\n" "$1"; }
err() { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }

JAR=$(mktemp); trap 'rm -f $JAR /tmp/inapp_*.json' EXIT

# ---------- 1. Legacy redirect endpoints removed ---------------------------
for path in oidc/authorize oidc/callback me/required-actions; do
  HTTP=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/v1/auth/$path")
  if [[ "$path" == "me/required-actions" ]]; then
    # POST-only; an unauthenticated GET still has to fail (401 or 404)
    [[ "$HTTP" == "401" || "$HTTP" == "404" ]] || err "/$path expected 401/404, got $HTTP"
  else
    [[ "$HTTP" == "404" ]] || err "/$path expected 404 (removed), got $HTTP"
  fi
done
ok "/oidc/authorize, /oidc/callback, /me/required-actions all removed"

# ---------- 2. Login round-trip with current credentials -------------------
login() {
  local user="$1" pass="$2" jar="$3"
  curl -sf -c "$jar" -b "$jar" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$user\",\"password\":\"$pass\"}" \
    "$API/api/v1/auth/login" 2>/dev/null
}

LOGIN_RES=$(login "$USER" "$OLD_PASS" "$JAR") || err "initial login failed"
MFA_REQUIRED=$(echo "$LOGIN_RES" | jq -r '.data.mfaRequired // false')
if [[ "$MFA_REQUIRED" == "true" ]]; then
  err "account $USER already has MFA enrolled — rerun with a clean user or disable TOTP first"
fi
ok "baseline login ok (no MFA enrolled yet)"

# ---------- 3. Password change happy-path ----------------------------------
HTTP=$(curl -s -o /tmp/inapp_pwd.json -w '%{http_code}' -b "$JAR" -c "$JAR" \
  -H 'Content-Type: application/json' -X POST \
  -d "{\"oldPassword\":\"$OLD_PASS\",\"newPassword\":\"$NEW_PASS\"}" \
  "$API/api/v1/auth/me/password")
[[ "$HTTP" == "204" ]] || err "password change expected 204, got $HTTP: $(cat /tmp/inapp_pwd.json)"
ok "POST /me/password accepted new password (204)"

# Verify old password no longer logs in (we have to start a new session).
JAR2=$(mktemp); trap 'rm -f $JAR $JAR2 /tmp/inapp_*.json' EXIT
HTTP=$(curl -s -o /tmp/inapp_oldfail.json -w '%{http_code}' -c "$JAR2" \
  -H 'Content-Type: application/json' -X POST \
  -d "{\"username\":\"$USER\",\"password\":\"$OLD_PASS\"}" \
  "$API/api/v1/auth/login")
[[ "$HTTP" == "401" ]] || err "old password still works ($HTTP)"
ok "old password rejected after change"

# New password works.
login "$USER" "$NEW_PASS" "$JAR" >/dev/null || err "login with new password failed"
ok "new password accepted"

# Wrong-old-password rejection on /me/password
HTTP=$(curl -s -o /tmp/inapp_wrongold.json -w '%{http_code}' -b "$JAR" \
  -H 'Content-Type: application/json' -X POST \
  -d "{\"oldPassword\":\"definitely-wrong\",\"newPassword\":\"Olivier2!TellusRotation\"}" \
  "$API/api/v1/auth/me/password")
[[ "$HTTP" == "401" ]] || err "wrong-old expected 401, got $HTTP"
jq -e '.errorCode == "OLD_PASSWORD_INVALID"' /tmp/inapp_wrongold.json >/dev/null \
  || err "wrong-old response missing OLD_PASSWORD_INVALID"
ok "/me/password rejects wrong current password with OLD_PASSWORD_INVALID"

# ---------- 4. TOTP enrollment + two-step login ----------------------------
START=$(curl -sf -b "$JAR" -X POST "$API/api/v1/auth/me/totp/start")
SECRET=$(echo "$START" | jq -r '.data.secret')
[[ -n "$SECRET" && "$SECRET" != "null" ]] || err "totp/start returned no secret"
echo "$START" | jq -e '.data.qrDataUrl | startswith("data:image/png;base64,")' >/dev/null \
  || err "totp/start missing qrDataUrl data URI"
ok "/me/totp/start returned secret + QR data URI"

# Generate a TOTP code from the secret using Node's built-in crypto.
CODE=$(node -e "
const c=require('crypto');
const a='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function dec(s){const b=[];let bits=0,v=0;for(const x of s.replace(/=/g,'').toUpperCase()){const i=a.indexOf(x);v=(v<<5)|i;bits+=5;if(bits>=8){b.push((v>>>(bits-8))&0xff);bits-=8;}}return Buffer.from(b);}
const k=dec('$SECRET');
const counter=Math.floor(Date.now()/1000/30);
const buf=Buffer.alloc(8);buf.writeUInt32BE(Math.floor(counter/0x100000000),0);buf.writeUInt32BE(counter&0xffffffff,4);
const h=c.createHmac('sha1',k).update(buf).digest();
const off=h[h.length-1]&0x0f;
const code=((h[off]&0x7f)<<24)|((h[off+1]&0xff)<<16)|((h[off+2]&0xff)<<8)|(h[off+3]&0xff);
process.stdout.write((code%1000000).toString().padStart(6,'0'));
")
[[ ${#CODE} == 6 ]] || err "failed to generate TOTP code (got '$CODE')"

HTTP=$(curl -s -o /tmp/inapp_verify.json -w '%{http_code}' -b "$JAR" \
  -H 'Content-Type: application/json' -X POST \
  -d "{\"code\":\"$CODE\"}" \
  "$API/api/v1/auth/me/totp/verify")
[[ "$HTTP" == "204" ]] || err "/me/totp/verify expected 204, got $HTTP: $(cat /tmp/inapp_verify.json)"
ok "TOTP enrollment verified with generated code"

STATUS=$(curl -sf -b "$JAR" "$API/api/v1/auth/me/totp/status")
echo "$STATUS" | jq -e '.data.enabled == true' >/dev/null \
  || err "/me/totp/status not reporting enabled=true"
ok "/me/totp/status.enabled == true"

# ---------- 5. Two-step /login now triggers the MFA challenge --------------
# The replay-protection layer in totpService tracks last_accepted_step
# per user. Enrollment at step N consumed that step — attempting to
# reuse the same step for login would be rejected as a replay. Wait
# until the RFC 6238 counter rolls over to step N+1 before continuing.
SECONDS_TO_NEXT_STEP=$(node -e "process.stdout.write(String(31 - Math.floor(Date.now()/1000)%30))")
sleep "$SECONDS_TO_NEXT_STEP"

# Fresh jar — we want a clean step-1 response, not whatever was cached.
JAR3=$(mktemp); trap 'rm -f $JAR $JAR2 $JAR3 /tmp/inapp_*.json' EXIT
STEP1=$(curl -sf -c "$JAR3" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$NEW_PASS\"}" \
  "$API/api/v1/auth/login")
MFA=$(echo "$STEP1" | jq -r '.data.mfaRequired')
CHALLENGE=$(echo "$STEP1" | jq -r '.data.mfaChallenge')
METHODS=$(echo "$STEP1" | jq -c '.data.methods')
[[ "$MFA" == "true" ]] || err "step 1 did not return mfaRequired ($STEP1)"
[[ "$METHODS" == *"totp"* ]] || err "methods list missing totp ($METHODS)"
# Session cookie must NOT be set yet.
if grep -q TELLUS_TOKEN "$JAR3"; then
  err "step 1 leaked TELLUS_TOKEN cookie before MFA verification"
fi
ok "step 1 returns mfaChallenge + methods=[totp] and withholds TELLUS_TOKEN"

# Regenerate a fresh code (30s window) and complete step 2.
sleep 1
CODE2=$(node -e "
const c=require('crypto');
const a='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function dec(s){const b=[];let bits=0,v=0;for(const x of s.replace(/=/g,'').toUpperCase()){const i=a.indexOf(x);v=(v<<5)|i;bits+=5;if(bits>=8){b.push((v>>>(bits-8))&0xff);bits-=8;}}return Buffer.from(b);}
const k=dec('$SECRET');
const counter=Math.floor(Date.now()/1000/30);
const buf=Buffer.alloc(8);buf.writeUInt32BE(Math.floor(counter/0x100000000),0);buf.writeUInt32BE(counter&0xffffffff,4);
const h=c.createHmac('sha1',k).update(buf).digest();
const off=h[h.length-1]&0x0f;
const code=((h[off]&0x7f)<<24)|((h[off+1]&0xff)<<16)|((h[off+2]&0xff)<<8)|(h[off+3]&0xff);
process.stdout.write((code%1000000).toString().padStart(6,'0'));
")

HTTP=$(curl -s -o /tmp/inapp_step2.json -w '%{http_code}' -c "$JAR3" -b "$JAR3" \
  -H 'Content-Type: application/json' -X POST \
  -d "{\"mfaChallenge\":\"$CHALLENGE\",\"method\":\"totp\",\"code\":\"$CODE2\"}" \
  "$API/api/v1/auth/login/mfa")
[[ "$HTTP" == "200" ]] || err "login/mfa expected 200, got $HTTP: $(cat /tmp/inapp_step2.json)"
grep -q TELLUS_TOKEN "$JAR3" || err "login/mfa did not set TELLUS_TOKEN cookie"
ok "two-step login with TOTP completed; TELLUS_TOKEN cookie set"

# ---------- 6. Disable TOTP — single-factor login restored -----------------
# Disabling TOTP is a destructive credential change — gated by a
# fresh reauth challenge. Mint one with the current (new) password.
REAUTH=$(curl -sf -b "$JAR3" -H 'Content-Type: application/json' -X POST \
  -d "{\"password\":\"$NEW_PASS\"}" "$API/api/v1/auth/me/reauth" | jq -r '.data.reauthToken')
curl -sf -b "$JAR3" -X DELETE -H "X-Tellus-Reauth: $REAUTH" \
  "$API/api/v1/auth/me/totp" >/dev/null || err "disable TOTP failed"
ok "/me/totp disabled"

JAR4=$(mktemp); trap 'rm -f $JAR $JAR2 $JAR3 $JAR4 /tmp/inapp_*.json' EXIT
STEP1B=$(curl -sf -c "$JAR4" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$NEW_PASS\"}" \
  "$API/api/v1/auth/login")
echo "$STEP1B" | jq -e '.data.mfaRequired // false | not' >/dev/null \
  || err "MFA still required after disable"
grep -q TELLUS_TOKEN "$JAR4" || err "single-factor login did not set cookie"
ok "single-factor login restored after TOTP disable"

# ---------- 7. Restore original password so re-runs keep working ----------
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR4" \
  -H 'Content-Type: application/json' -X POST \
  -d "{\"oldPassword\":\"$NEW_PASS\",\"newPassword\":\"$OLD_PASS\"}" \
  "$API/api/v1/auth/me/password")
[[ "$HTTP" == "204" ]] || err "password restore expected 204, got $HTTP"
ok "original password restored (script is idempotent)"

echo
ok "In-app credential flows (password + TOTP + two-step MFA login) verified"
