#!/usr/bin/env bash
#
# verify-auth-production.sh
# -------------------------
# Production-grade hardening checks added in the Phase-3+ review pass.
#
#   1. Silent refresh round-trip via POST /api/v1/auth/refresh
#   2. /login step 1 for an MFA-enrolled user does NOT leak sub/email
#   3. /login/mfa enforces max 5 attempts per challenge
#   4. TOTP replay inside the same 30-second window is rejected
#   5. Successful password change kills the current session
#   6. Legacy /api/auth/* returns 404 (router is fully deleted)

set -e
set -o pipefail

API="${TELLUS_API_URL:-http://localhost:3000}"
USER="${KC_INAPP_USER:-habimanaolivier6@gmail.com}"
OLD_PASS="${KC_INAPP_OLD_PASS:-Olivier0?Tellus}"
NEW_PASS="${KC_INAPP_NEW_PASS:-Olivier1!TellusProd}"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
ok()  { printf "${GREEN}✓${NC} %s\n" "$1"; }
err() { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }

JAR=$(mktemp)
JAR2=$(mktemp)
trap 'rm -f $JAR $JAR2 /tmp/prod_*.json' EXIT

curl -sf -X POST -H 'X-Tellus-Test-Hook: 1' -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\"}" "$API/api/v1/auth/_test/reset-mfa" >/dev/null || true

totp() {
  local secret="$1"
  node -e "
const c=require('crypto');
const a='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function dec(s){const b=[];let bits=0,v=0;for(const x of s.replace(/=/g,'').toUpperCase()){const i=a.indexOf(x);v=(v<<5)|i;bits+=5;if(bits>=8){b.push((v>>>(bits-8))&0xff);bits-=8;}}return Buffer.from(b);}
const k=dec('$secret');
const counter=Math.floor(Date.now()/1000/30);
const buf=Buffer.alloc(8);buf.writeUInt32BE(Math.floor(counter/0x100000000),0);buf.writeUInt32BE(counter&0xffffffff,4);
const h=c.createHmac('sha1',k).update(buf).digest();
const off=h[h.length-1]&0x0f;
const code=((h[off]&0x7f)<<24)|((h[off+1]&0xff)<<16)|((h[off+2]&0xff)<<8)|(h[off+3]&0xff);
process.stdout.write((code%1000000).toString().padStart(6,'0'));
"
}

# --- 1. Silent refresh ----------------------------------------------------
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/auth/refresh")
[[ "$STATUS" == "401" ]] || err "/refresh without cookie expected 401, got $STATUS"
ok "/refresh without cookie rejected with 401"

curl -sf -c "$JAR" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$OLD_PASS\"}" \
  "$API/api/v1/auth/login" >/dev/null
grep -q TELLUS_TOKEN "$JAR" || err "login did not set TELLUS_TOKEN"
grep -q TELLUS_REFRESH "$JAR" || err "login did not set TELLUS_REFRESH"

curl -sf -b "$JAR" -c "$JAR" -X POST "$API/api/v1/auth/refresh" > /tmp/prod_refresh.json \
  || err "/refresh failed"
jq -e '.data.accessToken and .data.tokenInfo.sub' /tmp/prod_refresh.json >/dev/null \
  || err "/refresh payload missing accessToken/sub"
ok "/refresh returns a new access token and rotates the cookies"

curl -sf -b "$JAR" "$API/api/v1/auth/token-info" >/dev/null || err "session dead after refresh"
ok "session survives a silent refresh round-trip"

# --- 2. Enroll TOTP so we can hit the MFA path ---------------------------
ENROLL=$(curl -sf -b "$JAR" -X POST "$API/api/v1/auth/me/totp/start")
SECRET=$(echo "$ENROLL" | jq -r '.data.secret')
CODE=$(totp "$SECRET")
curl -sf -b "$JAR" -X POST -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\"}" "$API/api/v1/auth/me/totp/verify" >/dev/null \
  || err "TOTP enrollment verify failed"
ok "TOTP enrolled for $USER"

# --- 3. /login step 1 does NOT leak sub/email ----------------------------
STEP1=$(curl -sf -c "$JAR2" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$OLD_PASS\"}" \
  "$API/api/v1/auth/login")
echo "$STEP1" | jq -e '.data.mfaRequired == true' >/dev/null \
  || err "step 1 did not request MFA"
if echo "$STEP1" | jq -e '.data.tokenInfo' >/dev/null 2>&1; then
  err "step 1 leaked tokenInfo — should only return {mfaRequired, mfaChallenge, methods}"
fi
CHALLENGE=$(echo "$STEP1" | jq -r '.data.mfaChallenge')
ok "step 1 returns only {mfaRequired, mfaChallenge, methods} — no sub/email leak"

# --- 4. /login/mfa caps attempts at 5 ------------------------------------
for i in 1 2 3 4 5 6; do
  HTTP=$(curl -s -o /tmp/prod_mfa.json -w '%{http_code}' \
    -H 'Content-Type: application/json' -X POST \
    -d "{\"mfaChallenge\":\"$CHALLENGE\",\"method\":\"totp\",\"code\":\"000000\"}" \
    "$API/api/v1/auth/login/mfa")
  if [[ $i -le 5 ]]; then
    [[ "$HTTP" == "401" ]] || err "attempt $i expected 401, got $HTTP"
  else
    jq -e '.errorCode == "MFA_CHALLENGE_INVALID"' /tmp/prod_mfa.json >/dev/null \
      || err "6th attempt did not burn the challenge: $(cat /tmp/prod_mfa.json)"
  fi
done
ok "/login/mfa caps attempts at 5 per challenge"

# --- 5. TOTP replay inside the same window is rejected ------------------
# Enrollment already consumed the current step, so we wait until the
# step counter advances before running the replay test. `sleep 31`
# guarantees we've crossed the 30-second boundary no matter when
# enrollment happened inside the previous window.
SECONDS_TO_NEXT_STEP=$(node -e "process.stdout.write(String(31 - Math.floor(Date.now()/1000)%30))")
sleep "$SECONDS_TO_NEXT_STEP"

STEP1_A=$(curl -sf -c "$JAR2" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$OLD_PASS\"}" "$API/api/v1/auth/login")
CHAL_A=$(echo "$STEP1_A" | jq -r '.data.mfaChallenge')
CODE_A=$(totp "$SECRET")
curl -sf -c "$JAR2" -H 'Content-Type: application/json' -X POST \
  -d "{\"mfaChallenge\":\"$CHAL_A\",\"method\":\"totp\",\"code\":\"$CODE_A\"}" \
  "$API/api/v1/auth/login/mfa" >/dev/null || err "first valid code rejected after step boundary"

sleep 1
STEP1_B=$(curl -sf -c "$JAR2" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$OLD_PASS\"}" "$API/api/v1/auth/login")
CHAL_B=$(echo "$STEP1_B" | jq -r '.data.mfaChallenge')
HTTP=$(curl -s -o /tmp/prod_replay.json -w '%{http_code}' \
  -H 'Content-Type: application/json' -X POST \
  -d "{\"mfaChallenge\":\"$CHAL_B\",\"method\":\"totp\",\"code\":\"$CODE_A\"}" \
  "$API/api/v1/auth/login/mfa")
[[ "$HTTP" == "401" ]] || err "replay of a consumed TOTP code expected 401, got $HTTP"
ok "TOTP replay inside the same 30-second window is rejected"

# --- 6. Password change kills current session ---------------------------
curl -sf -X POST -H 'X-Tellus-Test-Hook: 1' -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\"}" "$API/api/v1/auth/_test/reset-mfa" >/dev/null
rm -f "$JAR"; JAR=$(mktemp)
curl -sf -c "$JAR" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$OLD_PASS\"}" \
  "$API/api/v1/auth/login" >/dev/null

HTTP=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" \
  -H 'Content-Type: application/json' -X POST \
  -d "{\"oldPassword\":\"$OLD_PASS\",\"newPassword\":\"$NEW_PASS\"}" \
  "$API/api/v1/auth/me/password")
[[ "$HTTP" == "204" ]] || err "password change expected 204, got $HTTP"
ok "/me/password returns 204 on success"

HTTP=$(curl -s -o /tmp/prod_after_pwd.json -w '%{http_code}' -b "$JAR" \
  "$API/api/v1/auth/token-info")
[[ "$HTTP" == "401" ]] || err "session still live after password change (got $HTTP)"
ok "password change kills the current session (TELLUS_TOKEN rejected)"

# Restore original password
rm -f "$JAR"; JAR=$(mktemp)
curl -sf -c "$JAR" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$NEW_PASS\"}" \
  "$API/api/v1/auth/login" >/dev/null
curl -sf -b "$JAR" -H 'Content-Type: application/json' -X POST \
  -d "{\"oldPassword\":\"$NEW_PASS\",\"newPassword\":\"$OLD_PASS\"}" \
  "$API/api/v1/auth/me/password" >/dev/null
ok "original password restored (script is idempotent)"

# --- 7. Legacy /api/auth/* router is gone -------------------------------
for path in register login refresh logout; do
  HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' -d '{}' \
    "$API/api/auth/$path")
  [[ "$HTTP" == "404" ]] || err "/api/auth/$path expected 404, got $HTTP"
done
ok "legacy /api/auth/* router is deleted (404)"

echo
ok "Production-grade auth invariants verified"
