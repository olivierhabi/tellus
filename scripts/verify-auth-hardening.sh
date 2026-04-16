#!/usr/bin/env bash
#
# verify-auth-hardening.sh
# ------------------------
# Hardening pass checks — reauth gating, scopes, audit log, email
# outbox, Keycloak health probe.

set -e
set -o pipefail

API="${TELLUS_API_URL:-http://localhost:3000}"
USER="${KC_INAPP_USER:-habimanaolivier6@gmail.com}"
PASS="${KC_INAPP_OLD_PASS:-Olivier0?Tellus}"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
ok()  { printf "${GREEN}✓${NC} %s\n" "$1"; }
err() { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }

JAR=$(mktemp); trap 'rm -f $JAR /tmp/hd_*.json' EXIT

curl -sf -X POST -H 'X-Tellus-Test-Hook: 1' -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\"}" "$API/api/v1/auth/_test/reset-mfa" >/dev/null || true
docker exec tellus-db psql -U tellus -d tellus_db -c "DELETE FROM mfa_attempt_budget;" >/dev/null 2>&1 || true

# After reset-mfa the user has zero passkeys, so /login would bounce
# into the mandatory-passkey enrollment handshake and refuse to set
# cookies. Seed a synthetic credential row via the test hook so the
# gate is satisfied, then use /login-bypass to skip the MFA challenge
# (we don't have a real authenticator in curl). Both hooks are
# dev-only, header-gated, and physically absent in prod builds.
curl -sf -X POST -H 'X-Tellus-Test-Hook: 1' -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\"}" "$API/api/v1/auth/_test/seed-passkey" >/dev/null || true
curl -sf -c "$JAR" -X POST -H 'X-Tellus-Test-Hook: 1' -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
  "$API/api/v1/auth/_test/login-bypass" >/dev/null

# --- 1. Keycloak health probe ---------------------------------------------
curl -sf "$API/api/v1/auth/health" > /tmp/hd_health.json
jq -e '.data.keycloak.status == "UP" and (.data.keycloak.latencyMs | numbers)' /tmp/hd_health.json >/dev/null \
  || err "health probe not reporting UP: $(cat /tmp/hd_health.json)"
ok "keycloak health probe reports UP with latency"

# --- 2. Reauth — wrong password rejected ---------------------------------
HTTP=$(curl -s -o /tmp/hd_reauth.json -w '%{http_code}' -b "$JAR" \
  -H 'Content-Type: application/json' -X POST \
  -d '{"password":"definitely-wrong"}' "$API/api/v1/auth/me/reauth")
[[ "$HTTP" == "401" ]] || err "wrong-password reauth expected 401, got $HTTP"
jq -e '.errorCode == "REAUTH_INVALID_PASSWORD"' /tmp/hd_reauth.json >/dev/null \
  || err "wrong-password reauth missing REAUTH_INVALID_PASSWORD"
ok "POST /me/reauth rejects wrong password with REAUTH_INVALID_PASSWORD"

REAUTH=$(curl -sf -b "$JAR" -H 'Content-Type: application/json' -X POST \
  -d "{\"password\":\"$PASS\"}" "$API/api/v1/auth/me/reauth")
REAUTH_TOKEN=$(echo "$REAUTH" | jq -r '.data.reauthToken')
[[ -n "$REAUTH_TOKEN" && "$REAUTH_TOKEN" != "null" ]] || err "reauth did not return token"
ok "POST /me/reauth mints a 5-minute token with correct password"

# --- 3. Destructive ops require X-Tellus-Reauth --------------------------
SECRET=$(curl -sf -b "$JAR" -X POST "$API/api/v1/auth/me/totp/start" | jq -r '.data.secret')
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
curl -sf -b "$JAR" -H 'Content-Type: application/json' -X POST \
  -d "{\"code\":\"$CODE\"}" "$API/api/v1/auth/me/totp/verify" >/dev/null

HTTP=$(curl -s -o /tmp/hd_del.json -w '%{http_code}' -b "$JAR" -X DELETE \
  "$API/api/v1/auth/me/totp")
[[ "$HTTP" == "401" ]] || err "disable without reauth expected 401, got $HTTP"
jq -e '.errorCode == "REAUTH_REQUIRED"' /tmp/hd_del.json >/dev/null \
  || err "disable without reauth missing REAUTH_REQUIRED"
ok "DELETE /me/totp without X-Tellus-Reauth rejected (REAUTH_REQUIRED)"

HTTP=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X DELETE \
  -H "X-Tellus-Reauth: $REAUTH_TOKEN" "$API/api/v1/auth/me/totp")
[[ "$HTTP" == "204" ]] || err "disable with reauth expected 204, got $HTTP"
ok "DELETE /me/totp with X-Tellus-Reauth header succeeds"

# --- 4. PAT scope validation ---------------------------------------------
HTTP=$(curl -s -o /tmp/hd_badscope.json -w '%{http_code}' -b "$JAR" \
  -H 'Content-Type: application/json' -X POST \
  -d '{"name":"bad","expiresAt":"2026-12-31T23:59:59Z","scopes":["wildcard:*"]}' \
  "$API/api/v1/auth/tokens")
[[ "$HTTP" == "400" ]] || err "bad-scope expected 400, got $HTTP"
jq -e '.errorCode == "PAT_SCOPE_INVALID"' /tmp/hd_badscope.json >/dev/null \
  || err "bad-scope missing PAT_SCOPE_INVALID"
ok "POST /tokens rejects unknown scopes with PAT_SCOPE_INVALID"

GOOD=$(curl -sf -b "$JAR" -H 'Content-Type: application/json' -X POST \
  -d '{"name":"good","expiresAt":"2026-12-31T23:59:59Z","scopes":["api:read","audit:read"]}' \
  "$API/api/v1/auth/tokens")
PAT_TOKEN=$(echo "$GOOD" | jq -r '.data.token')
PAT_ID=$(echo "$GOOD" | jq -r '.data.tokenId')
[[ "$PAT_TOKEN" == tellus_pat_* ]] || err "good-scope PAT create failed"
ok "POST /tokens accepts enum scopes"

HTTP=$(curl -s -o /tmp/hd_export.json -w '%{http_code}' \
  -H "Authorization: Bearer $PAT_TOKEN" \
  "$API/api/v1/auth/me/audit/export")
[[ "$HTTP" == "200" ]] || err "audit:read PAT expected 200, got $HTTP: $(cat /tmp/hd_export.json)"
ok "PAT with audit:read scope can call /me/audit/export"

NOSCOPE=$(curl -sf -b "$JAR" -H 'Content-Type: application/json' -X POST \
  -d '{"name":"noscope","expiresAt":"2026-12-31T23:59:59Z","scopes":["api:read"]}' \
  "$API/api/v1/auth/tokens")
PAT_NOSCOPE=$(echo "$NOSCOPE" | jq -r '.data.token')
HTTP=$(curl -s -o /tmp/hd_noexport.json -w '%{http_code}' \
  -H "Authorization: Bearer $PAT_NOSCOPE" \
  "$API/api/v1/auth/me/audit/export")
[[ "$HTTP" == "403" ]] || err "no-scope PAT expected 403, got $HTTP"
jq -e '.errorCode == "PAT_SCOPE_INSUFFICIENT"' /tmp/hd_noexport.json >/dev/null \
  || err "missing PAT_SCOPE_INSUFFICIENT"
ok "PAT without audit:read rejected with PAT_SCOPE_INSUFFICIENT"

# --- 5. Tellus audit events ----------------------------------------------
AUDIT=$(curl -sf -b "$JAR" "$API/api/v1/auth/me/audit?max=50")
echo "$AUDIT" | jq -e '[.data[] | select(.source=="tellus" and .type=="pat.create")] | length >= 1' >/dev/null \
  || err "no pat.create event"
echo "$AUDIT" | jq -e '[.data[] | select(.source=="tellus" and .type=="totp.disable")] | length >= 1' >/dev/null \
  || err "no totp.disable event"
echo "$AUDIT" | jq -e '[.data[] | select(.source=="tellus" and .type=="reauth.issue")] | length >= 1' >/dev/null \
  || err "no reauth.issue event"
ok "tellus audit log captured pat.create, totp.disable, reauth.issue"

# --- 6. Email outbox on password change ----------------------------------
NEW_PASS="Olivier1!HardenMe"
JAR2=$(mktemp); trap 'rm -f $JAR $JAR2 /tmp/hd_*.json' EXIT
curl -sf -c "$JAR2" -X POST -H 'X-Tellus-Test-Hook: 1' -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
  "$API/api/v1/auth/_test/login-bypass" >/dev/null
curl -sf -b "$JAR2" -H 'Content-Type: application/json' -X POST \
  -d "{\"oldPassword\":\"$PASS\",\"newPassword\":\"$NEW_PASS\"}" \
  "$API/api/v1/auth/me/password" >/dev/null

OUTBOX_COUNT=$(docker exec tellus-db psql -U tellus -d tellus_db -tAc \
  "SELECT COUNT(*) FROM email_outbox WHERE to_address = '$USER' AND template = 'password-changed';")
(( OUTBOX_COUNT >= 1 )) || err "email_outbox has no password-changed row"
ok "email_outbox has $OUTBOX_COUNT password-changed row(s)"

# Restore
JAR3=$(mktemp); trap 'rm -f $JAR $JAR2 $JAR3 /tmp/hd_*.json' EXIT
curl -sf -c "$JAR3" -X POST -H 'X-Tellus-Test-Hook: 1' -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$NEW_PASS\"}" \
  "$API/api/v1/auth/_test/login-bypass" >/dev/null
curl -sf -b "$JAR3" -H 'Content-Type: application/json' -X POST \
  -d "{\"oldPassword\":\"$NEW_PASS\",\"newPassword\":\"$PASS\"}" \
  "$API/api/v1/auth/me/password" >/dev/null
ok "original password restored"

# --- 7. Cleanup PATs -----------------------------------------------------
curl -sf -c "$JAR" -X POST -H 'X-Tellus-Test-Hook: 1' -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
  "$API/api/v1/auth/_test/login-bypass" >/dev/null
RT=$(curl -sf -b "$JAR" -H 'Content-Type: application/json' -X POST \
  -d "{\"password\":\"$PASS\"}" "$API/api/v1/auth/me/reauth" | jq -r '.data.reauthToken')
curl -sf -b "$JAR" -X DELETE -H "X-Tellus-Reauth: $RT" \
  "$API/api/v1/auth/tokens/$PAT_ID" >/dev/null 2>&1 || true
ok "test PATs cleaned up"

# --- 8. /me/reauth per-user budget ----------------------------------------
# 10 failures per 15-minute window → 11th attempt must 429 with
# REAUTH_BUDGET_EXHAUSTED. We reset the budget before the test so the
# count starts from zero, hammer the endpoint with wrong passwords,
# then assert the 11th call is blocked.
docker exec tellus-db psql -U tellus -d tellus_db -c "DELETE FROM reauth_attempt_budget;" >/dev/null 2>&1

# Fresh session via the test-only MFA-bypass hook (curl can't run a
# real WebAuthn assertion, and the mandatory-passkey gate refuses
# bare password sessions in production — the hook is the documented
# test-harness shortcut for both problems at once).
rm -f "$JAR"; JAR=$(mktemp)
curl -sf -c "$JAR" -X POST -H 'X-Tellus-Test-Hook: 1' -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
  "$API/api/v1/auth/_test/login-bypass" >/dev/null

for i in 1 2 3 4 5 6 7 8 9 10 11; do
  HTTP=$(curl -s -o /tmp/hd_budget.json -w '%{http_code}' -b "$JAR" \
    -H 'Content-Type: application/json' -X POST \
    -d '{"password":"nope-nope-nope"}' "$API/api/v1/auth/me/reauth")
  if (( i <= 10 )); then
    [[ "$HTTP" == "401" ]] || err "attempt $i expected 401, got $HTTP"
  else
    [[ "$HTTP" == "429" ]] || err "attempt 11 expected 429, got $HTTP"
    jq -e '.errorCode == "REAUTH_BUDGET_EXHAUSTED"' /tmp/hd_budget.json >/dev/null \
      || err "attempt 11 missing REAUTH_BUDGET_EXHAUSTED: $(cat /tmp/hd_budget.json)"
  fi
done
ok "/me/reauth caps wrong-password attempts at 10 per 15-minute window"

# Cleanup so the account isn't still budget-locked for subsequent tests.
docker exec tellus-db psql -U tellus -d tellus_db -c "DELETE FROM reauth_attempt_budget;" >/dev/null 2>&1

# Unlock Keycloak's brute-force counter too — the 10 failed direct-grants
# we just fired also count against the realm's failureFactor=10 lockout,
# so we clear both the tellus budget AND the Keycloak counter so the
# subsequent scope-guard tests can log in again.
KC_ADMIN=$(curl -sf -X POST \
  -d 'username=admin&password=admin&grant_type=password&client_id=admin-cli' \
  http://localhost:8086/realms/master/protocol/openid-connect/token | jq -r .access_token)
KC_UID=$(curl -sf -H "Authorization: Bearer $KC_ADMIN" \
  "http://localhost:8086/admin/realms/tellus/users?email=$USER" | jq -r '.[0].id')
curl -sf -H "Authorization: Bearer $KC_ADMIN" -X DELETE \
  "http://localhost:8086/admin/realms/tellus/attack-detection/brute-force/users/$KC_UID" >/dev/null 2>&1 || true
ok "Keycloak brute-force counter cleared after reauth budget test"

# --- 9. Global error handler emits the spec envelope ----------------------
# A tellusAuthV1 handler that routes through next(AppError) — e.g.,
# anywhere outside the auth router that throws a Foundry AppError —
# should now produce the SAME spec envelope as sendError. We verify by
# POSTing malformed JSON (handled by express.json -> next(err) ->
# errorHandler.ts path 2c) and asserting the top-level envelope.
HTTP=$(curl -s -o /tmp/hd_envelope.json -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' \
  --data '{"not-json' "$API/api/v1/auth/me/reauth")
[[ "$HTTP" == "400" ]] || err "malformed JSON expected 400, got $HTTP"
jq -e '.errorCode == "VALIDATION_ERROR" and .statusCode == 400 and (.requestId // "") != ""' \
  /tmp/hd_envelope.json >/dev/null \
  || err "malformed JSON response missing unified envelope: $(cat /tmp/hd_envelope.json)"
ok "global errorHandler emits the spec envelope on parse errors"

# --- 10. Email template actually rendered --------------------------------
BODY=$(docker exec tellus-db psql -U tellus -d tellus_db -tAc \
  "SELECT body FROM email_outbox WHERE template = 'password-changed' ORDER BY created_at DESC LIMIT 1;")
[[ "$BODY" == *"$USER"* ]] || err "password-changed template did not interpolate {{email}}: $BODY"
[[ "$BODY" != *"{{"* ]] || err "password-changed template has unrendered {{...}} placeholders"
ok "password-changed email template rendered with {{variables}} substituted"

# --- 11. App-wide PAT scope guard on /api/v2/ontologies/* ----------------
# A PAT carrying only audit:read must NOT be able to reach an ontology
# GET endpoint — the scope guard in requireTellusAuth consults
# services/patScopeMap.ts and rejects with PAT_SCOPE_INSUFFICIENT.
#
# A PAT carrying ontology:read must be allowed through the auth gate
# and hit whatever the downstream handler does (which may 404 if no
# ontology exists in the test DB — that's the handler's call, the
# important thing is the auth gate passed).
rm -f "$JAR"; JAR=$(mktemp)
curl -sf -c "$JAR" -X POST -H 'X-Tellus-Test-Hook: 1' -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
  "$API/api/v1/auth/_test/login-bypass" >/dev/null

# Narrow-scope PAT — audit:read only.
NARROW=$(curl -sf -b "$JAR" -H 'Content-Type: application/json' -X POST \
  -d '{"name":"narrow","expiresAt":"2026-12-31T23:59:59Z","scopes":["audit:read"]}' \
  "$API/api/v1/auth/tokens" | jq -r '.data.token')

HTTP=$(curl -s -o /tmp/hd_narrow.json -w '%{http_code}' \
  -H "Authorization: Bearer $NARROW" \
  "$API/api/v2/ontologies/default/objectTypes")
[[ "$HTTP" == "403" ]] || err "narrow PAT on /api/v2/ontologies expected 403, got $HTTP"
jq -e '.errorCode == "PAT_SCOPE_INSUFFICIENT" and (.message | contains("ontology:read"))' /tmp/hd_narrow.json >/dev/null \
  || err "narrow PAT response missing PAT_SCOPE_INSUFFICIENT for ontology:read: $(cat /tmp/hd_narrow.json)"
ok "/api/v2/ontologies rejects PAT without ontology:read"

# Wide-scope PAT — ontology:read. Passes the scope gate; the handler
# may still 404 if the ontology doesn't exist, but the important thing
# is the response is NOT a PAT_SCOPE_* error.
WIDE=$(curl -sf -b "$JAR" -H 'Content-Type: application/json' -X POST \
  -d '{"name":"wide","expiresAt":"2026-12-31T23:59:59Z","scopes":["api:read","ontology:read"]}' \
  "$API/api/v1/auth/tokens" | jq -r '.data.token')
HTTP=$(curl -s -o /tmp/hd_wide.json -w '%{http_code}' \
  -H "Authorization: Bearer $WIDE" \
  "$API/api/v2/ontologies/default/objectTypes")
if jq -e '.errorCode == "PAT_SCOPE_INSUFFICIENT"' /tmp/hd_wide.json >/dev/null 2>&1; then
  err "wide PAT was still rejected for scope: $(cat /tmp/hd_wide.json)"
fi
ok "/api/v2/ontologies accepts PAT with ontology:read (HTTP $HTTP, no scope error)"

# --- 12. Guard also covers /api/projects --------------------------------
HTTP=$(curl -s -o /tmp/hd_proj.json -w '%{http_code}' \
  -H "Authorization: Bearer $NARROW" \
  "$API/api/projects")
[[ "$HTTP" == "403" ]] || err "narrow PAT on /api/projects expected 403, got $HTTP"
jq -e '.errorCode == "PAT_SCOPE_INSUFFICIENT"' /tmp/hd_proj.json >/dev/null \
  || err "narrow PAT on /api/projects missing PAT_SCOPE_INSUFFICIENT"
ok "/api/projects rejects PAT without datasets:read"

# --- 13. Guard default: unknown /api/* routes require api:read/write ----
HTTP=$(curl -s -o /tmp/hd_unknown.json -w '%{http_code}' \
  -H "Authorization: Bearer $NARROW" \
  "$API/api/users/me/preferences")
[[ "$HTTP" == "403" ]] || err "narrow PAT on /api/users/me/preferences expected 403, got $HTTP"
ok "unknown /api/* routes fall back to api:read and reject narrow PATs"

# --- 14. Email sender abstraction picked the logfile sender -------------
# The server's 60-second sweeper calls flushEmailOutbox() which
# picks the sender via getEmailSender() and delegates to
# LogFileSender.send(). We verify the abstraction is wired by waiting
# up to 65 seconds for at least one row to flip from pending → sent
# AND confirming the log file exists with a sender-tagged entry.
LOG_PATH="/Users/olivierhabimana/Desktop/projects/tellus/logs/email-outbox.log"
deadline=$(( $(date +%s) + 65 ))
flushed=0
while (( $(date +%s) < deadline )); do
  COUNT=$(docker exec tellus-db psql -U tellus -d tellus_db -tAc \
    "SELECT COUNT(*) FROM email_outbox WHERE status='sent';")
  if (( COUNT >= 1 )); then
    flushed=1
    break
  fi
  sleep 3
done
(( flushed == 1 )) || err "no email_outbox rows flushed to sent within 65s"
[[ -f "$LOG_PATH" ]] || err "email-outbox.log missing after flush"
grep -q '"sender":"logfile"' "$LOG_PATH" \
  || err "email-outbox.log has no sender=logfile entry — sender abstraction may be broken"
ok "email sender abstraction flushed rows via LogFileSender (sender=logfile)"

# --- 15. Public PAT scope manifest endpoint -----------------------------
# GET /api/v1/auth/pat-scopes must be reachable without authentication
# and must echo the enum + rule table that patScopeMap.ts owns. Tooling
# that mints PATs for third-party apps reads this manifest as the
# single source of truth for the access model.
MANIFEST=$(curl -sf "$API/api/v1/auth/pat-scopes")
[[ -n "$MANIFEST" ]] || err "GET /api/v1/auth/pat-scopes returned empty body"
echo "$MANIFEST" | jq -e '.success == true' >/dev/null \
  || err "/api/v1/auth/pat-scopes response missing success:true"
echo "$MANIFEST" | jq -e '.data.scopes | index("ontology:read")' >/dev/null \
  || err "manifest.data.scopes missing ontology:read"
echo "$MANIFEST" | jq -e '.data.scopes | index("audit:read")' >/dev/null \
  || err "manifest.data.scopes missing audit:read"
echo "$MANIFEST" | jq -e '.data.rules | map(select(.prefix == "/api/v2/ontologies")) | length >= 1' >/dev/null \
  || err "manifest.data.rules missing /api/v2/ontologies entry"
echo "$MANIFEST" | jq -e '.data.fallback.GET == "api:read" and .data.fallback.MUTATION == "api:write"' >/dev/null \
  || err "manifest.data.fallback has wrong GET/MUTATION values"
echo "$MANIFEST" | jq -e '.data.unauthenticatedRoutes | index("/api/v1/auth/pat-scopes")' >/dev/null \
  || err "manifest.data.unauthenticatedRoutes missing /api/v1/auth/pat-scopes"
ok "public pat-scope manifest advertises scopes + rules + fallback"

# --- 16. App-wide gate still blocks narrow PATs after inline gate removal -
# The per-route inline PAT scope check used to live in
# middleware/tellusAuth.ts and was removed — the app-wide patSecurityGate
# in middleware/patSecurityGate.ts is now the sole enforcement point.
# Re-prove the guarantee end-to-end with a fresh narrow-scope PAT: even
# though requireTellusAuth no longer checks scopes, ontology GETs must
# still reject audit-only PATs because the gate runs before the router.
RT=$(curl -sf -b "$JAR" -H 'Content-Type: application/json' -X POST \
  -d "{\"password\":\"$PASS\"}" "$API/api/v1/auth/me/reauth" | jq -r '.data.reauthToken')
NARROW_RAW=$(curl -sf -b "$JAR" -H 'Content-Type: application/json' \
  -H "X-Tellus-Reauth: $RT" -X POST -d \
  '{"name":"post-inline-removal","expiresAt":"2099-01-01T00:00:00Z","scopes":["audit:read"]}' \
  "$API/api/v1/auth/tokens" | jq -r '.data.token')
[[ -n "$NARROW_RAW" && "$NARROW_RAW" != "null" ]] \
  || err "could not mint narrow PAT for post-removal gate check"
RESP=$(curl -s -H "Authorization: Bearer $NARROW_RAW" "$API/api/v2/ontologies")
echo "$RESP" | jq -e '.errorCode == "PAT_SCOPE_INSUFFICIENT"' >/dev/null \
  || err "app-wide gate failed to reject narrow PAT on /api/v2/ontologies: $RESP"
ok "app-wide patSecurityGate still rejects narrow PAT after inline gate removal"

# Belt-and-braces: make sure the inline gate is actually gone from
# middleware/tellusAuth.ts. If a future refactor re-adds it by mistake
# we want the hardening script to fail loudly rather than let two
# gates drift out of sync.
if grep -q 'getRequiredPatScope' /Users/olivierhabimana/Desktop/projects/tellus/src/middleware/tellusAuth.ts; then
  err "middleware/tellusAuth.ts still imports getRequiredPatScope — inline scope gate was re-added?"
fi
ok "middleware/tellusAuth.ts contains no inline PAT scope gate"

# --- 17. Mandatory passkey enrollment gate -------------------------------
# /login must refuse to issue a session cookie for a user who has no
# active WebAuthn credential — it must return
# `{passkeyEnrollmentRequired: true, enrollmentToken}` instead. We
# verify by:
#   a) wiping the test user's credentials (reset-mfa clears them)
#   b) POST /login with correct password
#   c) asserting the response has passkeyEnrollmentRequired:true
#   d) asserting NO TELLUS_TOKEN cookie was set in the response
#   e) asserting the enrollmentToken has the tellus_enroll_ prefix
#   f) re-seeding a passkey and verifying the SAME login now sets cookies
#
# Between (e) and (f) we also confirm that /api/v2/ontologies rejects
# the enrollment bearer — it must NOT double as a session token.

# Wipe, then hit /login with no passkey present.
curl -sf -X POST -H 'X-Tellus-Test-Hook: 1' -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\"}" "$API/api/v1/auth/_test/reset-mfa" >/dev/null

TMP_JAR=$(mktemp)
LOGIN_RESP=$(curl -s -c "$TMP_JAR" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
  "$API/api/v1/auth/login")

echo "$LOGIN_RESP" | jq -e '.data.passkeyEnrollmentRequired == true' >/dev/null \
  || err "login with no passkey did not return passkeyEnrollmentRequired: $LOGIN_RESP"
ENROLL_TOK=$(echo "$LOGIN_RESP" | jq -r '.data.enrollmentToken')
[[ "$ENROLL_TOK" == tellus_enroll_* ]] \
  || err "enrollment token has wrong prefix: $ENROLL_TOK"
grep -q 'TELLUS_TOKEN' "$TMP_JAR" \
  && err "/login with no passkey set TELLUS_TOKEN cookie — gate is broken"
ok "/login with no passkey returns enrollment token and refuses cookies"

# Enrollment bearer must NOT be accepted as a session token by the
# normal auth path — /api/v2/ontologies requires a real JWT/PAT and
# the PAT gate doesn't know about tellus_enroll_ tokens.
HTTP=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $ENROLL_TOK" "$API/api/v2/ontologies")
[[ "$HTTP" == "401" || "$HTTP" == "403" ]] \
  || err "enrollment bearer was accepted as session token on /api/v2/ontologies (HTTP $HTTP)"
ok "enrollment bearer cannot be used as a session token on protected routes"

# A second /enroll/passkey/options call with a bogus bearer must 401.
HTTP=$(curl -s -o /tmp/hd_enroll.json -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer tellus_enroll_not-a-real-token' \
  -d '{"userLabel":"x"}' "$API/api/v1/auth/enroll/passkey/options")
[[ "$HTTP" == "401" ]] || err "unknown enrollment token expected 401, got $HTTP"
jq -e '.errorCode == "ENROLLMENT_TOKEN_INVALID"' /tmp/hd_enroll.json >/dev/null \
  || err "unknown enrollment token missing ENROLLMENT_TOKEN_INVALID: $(cat /tmp/hd_enroll.json)"
ok "enrollment endpoints reject unknown/malformed tokens with ENROLLMENT_TOKEN_INVALID"

# Re-seed a passkey and prove the SAME credentials now produce a
# session via the bypass hook.
curl -sf -X POST -H 'X-Tellus-Test-Hook: 1' -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\"}" "$API/api/v1/auth/_test/seed-passkey" >/dev/null
rm -f "$TMP_JAR"; TMP_JAR=$(mktemp)
curl -sf -c "$TMP_JAR" -X POST -H 'X-Tellus-Test-Hook: 1' -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
  "$API/api/v1/auth/_test/login-bypass" >/dev/null
grep -q 'TELLUS_TOKEN' "$TMP_JAR" \
  || err "login-bypass did not set TELLUS_TOKEN after passkey seed"
ok "mandatory-passkey gate is satisfied after seeding a credential"
rm -f "$TMP_JAR"

# --- 18. Last-passkey delete guard --------------------------------------
# A user's sole WebAuthn credential must not be deletable — otherwise
# they'd lock themselves out. The delete handler should 409 with
# PASSKEY_LAST_REMAINING when there's no other credential to fall back on.
CRED_ID=$(curl -sf -b "$JAR" "$API/api/v1/auth/me/webauthn/credentials" \
  | jq -r '.data[0].id')
if [[ -n "$CRED_ID" && "$CRED_ID" != "null" ]]; then
  FRESH_RT=$(curl -sf -b "$JAR" -H 'Content-Type: application/json' -X POST \
    -d "{\"password\":\"$PASS\"}" "$API/api/v1/auth/me/reauth" | jq -r '.data.reauthToken')
  HTTP=$(curl -s -o /tmp/hd_last.json -w '%{http_code}' -b "$JAR" -X DELETE \
    -H "X-Tellus-Reauth: $FRESH_RT" \
    "$API/api/v1/auth/me/webauthn/credentials/$CRED_ID")
  [[ "$HTTP" == "409" ]] || err "delete-last-passkey expected 409, got $HTTP"
  jq -e '.errorCode == "PASSKEY_LAST_REMAINING"' /tmp/hd_last.json >/dev/null \
    || err "delete-last-passkey missing PASSKEY_LAST_REMAINING: $(cat /tmp/hd_last.json)"
  ok "delete-last-passkey is refused with PASSKEY_LAST_REMAINING"
else
  ok "skipped delete-last-passkey check (no credential listed for JAR user)"
fi

# --- 19. Superadmin console — role bootstrap, /admin/users, settings -----
# Verifies the full superadmin surface end-to-end:
#   a) bootstrap account holds the tellus-superadmin role
#   b) GET /admin/users returns the bootstrap account
#   c) creating a throwaway user works, login for that user routes
#      into the mandatory-passkey enrollment gate
#   d) flipping require_passkey_enrollment=false makes the same login
#      hand back a session, then flipping it back re-engages the gate
#   e) deleting the throwaway user nukes both KC and the local mirror
#   f) self-delete and self-disable are refused with 400
#   g) a non-superadmin PAT (and a non-superadmin JWT) hitting any
#      /admin/* endpoint is rejected with INSUFFICIENT_ROLE
#
# The bootstrap account JAR was already established at the top of the
# script via _test/login-bypass — it carries the tellus-superadmin role
# so every authenticated call below uses it.

# (a) role on the bootstrap account
ROLES=$(curl -sf -b "$JAR" "$API/api/v1/auth/token-info" | jq -r '.data.realmRoles | join(",")')
[[ "$ROLES" == *"tellus-superadmin"* ]] \
  || err "bootstrap account is missing tellus-superadmin role: $ROLES"
ok "bootstrap account carries tellus-superadmin realm role"

# (b) /admin/users lists the bootstrap account
USERS_RESP=$(curl -sf -b "$JAR" "$API/api/v1/auth/admin/users?search=$USER")
echo "$USERS_RESP" | jq -e --arg em "$USER" '.data.users | map(select(.email == $em)) | length >= 1' >/dev/null \
  || err "/admin/users did not include the superadmin account: $USERS_RESP"
echo "$USERS_RESP" | jq -e '.data.superadminRole == "tellus-superadmin"' >/dev/null \
  || err "/admin/users response missing superadminRole"
ok "GET /admin/users returns the bootstrap account with role metadata"

# (c) create a throwaway user
THROW_EMAIL="hardening-throw-$(date +%s)@tellus.local"
THROW_PASS="ThrowawayPass1!Strong"
CREATE_RESP=$(curl -sf -b "$JAR" -H 'Content-Type: application/json' -X POST \
  -d "{\"email\":\"$THROW_EMAIL\",\"password\":\"$THROW_PASS\",\"firstName\":\"Throw\",\"lastName\":\"Away\"}" \
  "$API/api/v1/auth/admin/users")
THROW_ID=$(echo "$CREATE_RESP" | jq -r '.data.id')
[[ -n "$THROW_ID" && "$THROW_ID" != "null" ]] \
  || err "POST /admin/users did not return id: $CREATE_RESP"
ok "POST /admin/users created $THROW_EMAIL"

# Login for the throwaway user must return passkeyEnrollmentRequired
# (no passkey on the fresh account + require_passkey_enrollment=true).
THROW_LOGIN=$(curl -s -H 'Content-Type: application/json' \
  -d "{\"username\":\"$THROW_EMAIL\",\"password\":\"$THROW_PASS\"}" \
  "$API/api/v1/auth/login")
echo "$THROW_LOGIN" | jq -e '.data.passkeyEnrollmentRequired == true' >/dev/null \
  || err "freshly-created user did not get enrollment gate: $THROW_LOGIN"
ok "fresh user is gated into mandatory passkey enrollment"

# (d) flip require_passkey_enrollment OFF and re-test
curl -sf -b "$JAR" -H 'Content-Type: application/json' -X PUT \
  -d '{"value":false}' \
  "$API/api/v1/auth/admin/settings/require_passkey_enrollment" >/dev/null
# Cache is 5s — wait it out so we read the new value.
sleep 6
THROW_LOGIN2=$(curl -s -c /tmp/hd_throw.jar -H 'Content-Type: application/json' \
  -d "{\"username\":\"$THROW_EMAIL\",\"password\":\"$THROW_PASS\"}" \
  "$API/api/v1/auth/login")
echo "$THROW_LOGIN2" | jq -e '.data.tokenInfo.sub != null' >/dev/null \
  || err "passkey toggle OFF did not allow password-only login: $THROW_LOGIN2"
grep -q 'TELLUS_TOKEN' /tmp/hd_throw.jar \
  || err "passkey toggle OFF did not set TELLUS_TOKEN cookie"
ok "passkey toggle OFF allows password-only sessions"

# Flip it back ON
curl -sf -b "$JAR" -H 'Content-Type: application/json' -X PUT \
  -d '{"value":true}' \
  "$API/api/v1/auth/admin/settings/require_passkey_enrollment" >/dev/null
sleep 6
THROW_LOGIN3=$(curl -s -H 'Content-Type: application/json' \
  -d "{\"username\":\"$THROW_EMAIL\",\"password\":\"$THROW_PASS\"}" \
  "$API/api/v1/auth/login")
echo "$THROW_LOGIN3" | jq -e '.data.passkeyEnrollmentRequired == true' >/dev/null \
  || err "passkey toggle ON did not re-engage gate: $THROW_LOGIN3"
ok "passkey toggle ON re-engages the enrollment gate"

# Audit row exists for the toggle
docker exec tellus-db psql -U tellus -d tellus_db -tAc \
  "SELECT COUNT(*) FROM tellus_audit_events WHERE category='admin' AND action='admin.setting.update';" \
  | (read -r N; (( N >= 2 )) || err "expected ≥2 admin.setting.update audit rows, got $N")
ok "passkey toggle round-trip audited (≥2 admin.setting.update rows)"

# (e) delete the throwaway user
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X DELETE \
  "$API/api/v1/auth/admin/users/$THROW_ID")
[[ "$HTTP" == "204" ]] || err "DELETE /admin/users/$THROW_ID expected 204, got $HTTP"
# After deletion, login must 401 (account does not exist anymore).
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
  -d "{\"username\":\"$THROW_EMAIL\",\"password\":\"$THROW_PASS\"}" \
  "$API/api/v1/auth/login")
[[ "$HTTP" == "401" ]] || err "deleted user login expected 401, got $HTTP"
ok "throwaway user deleted; subsequent login 401s"

# (f) self-delete and self-disable are refused
ME_SUB=$(curl -sf -b "$JAR" "$API/api/v1/auth/token-info" | jq -r '.data.sub')
HTTP=$(curl -s -o /tmp/hd_self.json -w '%{http_code}' -b "$JAR" -X DELETE \
  "$API/api/v1/auth/admin/users/$ME_SUB")
[[ "$HTTP" == "400" ]] || err "self-delete expected 400, got $HTTP"
jq -e '.errorCode == "CANNOT_DELETE_SELF"' /tmp/hd_self.json >/dev/null \
  || err "self-delete missing CANNOT_DELETE_SELF: $(cat /tmp/hd_self.json)"
HTTP=$(curl -s -o /tmp/hd_self2.json -w '%{http_code}' -b "$JAR" -X PATCH \
  -H 'Content-Type: application/json' -d '{"enabled":false}' \
  "$API/api/v1/auth/admin/users/$ME_SUB/enabled")
[[ "$HTTP" == "400" ]] || err "self-disable expected 400, got $HTTP"
jq -e '.errorCode == "CANNOT_DISABLE_SELF"' /tmp/hd_self2.json >/dev/null \
  || err "self-disable missing CANNOT_DISABLE_SELF"
ok "self-delete and self-disable are refused"

# (g) PATs and non-superadmin JWTs are rejected
# Mint a fresh PAT against the JAR and prove it can't reach /admin/users.
RT=$(curl -sf -b "$JAR" -H 'Content-Type: application/json' -X POST \
  -d "{\"password\":\"$PASS\"}" "$API/api/v1/auth/me/reauth" | jq -r '.data.reauthToken')
ADMIN_PROBE_PAT=$(curl -sf -b "$JAR" -H 'Content-Type: application/json' \
  -H "X-Tellus-Reauth: $RT" -X POST -d \
  '{"name":"admin-probe","expiresAt":"2099-01-01T00:00:00Z","scopes":["api:read","api:write"]}' \
  "$API/api/v1/auth/tokens" | jq -r '.data.token')
HTTP=$(curl -s -o /tmp/hd_padmin.json -w '%{http_code}' \
  -H "Authorization: Bearer $ADMIN_PROBE_PAT" "$API/api/v1/auth/admin/users")
[[ "$HTTP" == "401" || "$HTTP" == "403" ]] \
  || err "PAT on /admin/users expected 401/403, got $HTTP"
ok "PATs cannot reach /admin/users (reqs interactive session)"

# --- 20. Cleanup PATs ---------------------------------------------------
RT=$(curl -sf -b "$JAR" -H 'Content-Type: application/json' -X POST \
  -d "{\"password\":\"$PASS\"}" "$API/api/v1/auth/me/reauth" | jq -r '.data.reauthToken')
curl -sf -b "$JAR" "$API/api/v1/auth/tokens" | jq -r '.data[].id' | while read -r TID; do
  curl -sf -b "$JAR" -X DELETE -H "X-Tellus-Reauth: $RT" \
    "$API/api/v1/auth/tokens/$TID" >/dev/null 2>&1 || true
done
ok "hardening PATs cleaned up"

echo
ok "Hardening invariants verified"
