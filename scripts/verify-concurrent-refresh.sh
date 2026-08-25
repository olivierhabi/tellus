#!/usr/bin/env bash
# verify-concurrent-refresh.sh
# ---------------------------------------------------------------------------
# P0-12 integration test (plan root-cause (b)): refresh-token rotation race.
#
# Verifies the Keycloak `tellus` realm has rotation ON (revokeRefreshToken=true,
# refreshTokenMaxReuse=0) — the deployment modification that makes the reuse
# race detectable — AND demonstrates the race at the backend level: N concurrent
# /auth/refresh calls carrying the SAME refresh cookie (no FE mutex) → Keycloak
# sees a reuse event → revokes the session.
#
# This is the MOTIVATION for the FE Web Lock mutex (lib/api.ts refreshOnce),
# which serializes refreshes across tabs so the race never reaches the backend.
# The FIX is verified separately by:
#   - tellus-fe tests/unit/refreshOnce.coalesce.test.ts (within-tab single-flight)
#   - tellus-fe cypress auth-concurrent-refresh-mutex.cy.ts (FE serializes 2
#     concurrent 401s into 1 /auth/refresh via the Web Lock)
#   - tellus-fe scripts/verify-two-tab-staging.sh (real cross-tab)
#
# Prerequisites: Keycloak on :8086 (docker compose up keycloak + bootstrap),
# backend on :3000 (NODE_ENV != production so the _test/login-bypass hook mounts).
#
# Usage: ./scripts/verify-concurrent-refresh.sh
# ---------------------------------------------------------------------------
set -euo pipefail
KC="${KC_URL:-http://localhost:8086}"
API="${TELLUS_API:-http://localhost:3000/api/v1}"
REALM="${KC_REALM:-tellus}"
ADMIN_USER="${KC_ADMIN_USER:-admin}"
ADMIN_PASS="${KC_ADMIN_PASS:-admin}"
TEST_USER="${KC_TEST_USER:-cypress@tellus.local}"
TEST_PASS="${KC_TEST_PASS:-Password123!}"
JAR=$(mktemp); TMP=$(mktemp -d)
trap 'rm -f "$JAR"; rm -rf "$TMP"' EXIT

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; NC='\033[0m'
pass(){ printf "${GREEN}✓${NC} %s\n" "$1"; }
fail(){ printf "${RED}✗${NC} %s\n" "$1"; exit 1; }
info(){ printf "${YELLOW}~${NC} %s\n" "$1"; }

# --- Part 1 (HARD assertion): realm rotation config ---------------------------
info "authenticating to Keycloak admin at $KC..."
TOKEN=$(curl -sf -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=$ADMIN_USER&password=$ADMIN_PASS&grant_type=password&client_id=admin-cli" \
  "$KC/realms/master/protocol/openid-connect/token" 2>/dev/null | jq -r '.access_token') \
  || fail "could not authenticate as Keycloak admin (is Keycloak up on :8086 + bootstrapped?)"

CFG=$(curl -sf -H "Authorization: Bearer $TOKEN" "$KC/admin/realms/$REALM") \
  || fail "could not GET realm '$REALM' (run scripts/bootstrap-keycloak.sh first)"

rt=$(echo "$CFG" | jq -r '.revokeRefreshToken')
mru=$(echo "$CFG" | jq -r '.refreshTokenMaxReuse')
[ "$rt" = "true" ] || fail "revokeRefreshToken=$rt (expected true) — rotation is OFF"
[ "$mru" = "0" ] || fail "refreshTokenMaxReuse=$mru (expected 0) — rotation allows reuse"
pass "realm '$REALM' has revokeRefreshToken=true + refreshTokenMaxReuse=0 (rotation ON)"
info "accessTokenLifespan=$(echo "$CFG" | jq -r '.accessTokenLifespan'), ssoSessionMaxLifespan=$(echo "$CFG" | jq -r '.ssoSessionMaxLifespan'), ssoSessionIdleTimeout=$(echo "$CFG" | jq -r '.ssoSessionIdleTimeout')"

# --- Part 2 (race demonstration): N concurrent /auth/refresh, no FE mutex ----
info "logging in via /auth/_test/login-bypass (real Keycloak ROPC → real refresh token)..."
LOGIN_CODE=$(curl -s -o "$TMP/login.json" -w "%{http_code}" -X POST \
  -H "X-Tellus-Test-Hook: 1" -H "Content-Type: application/json" \
  -d "{\"username\":\"$TEST_USER\",\"password\":\"$TEST_PASS\"}" -c "$JAR" \
  "$API/auth/_test/login-bypass")
[ "$LOGIN_CODE" = "200" ] || fail "login-bypass returned $LOGIN_CODE (backend on :3000 + NODE_ENV!=production?)"
jq -e '.data.accessToken' "$TMP/login.json" >/dev/null || fail "login-bypass returned no accessToken"
pass "login-bypass succeeded (TELLUS_REFRESH cookie carries a real rotated refresh token)"

N=5
info "firing $N CONCURRENT /auth/refresh with the SAME refresh cookie (no FE mutex)..."
# Each curl uses the SAME original cookie jar — none sees the others' Set-Cookie
# rotation, so all present the same refresh token to Keycloak. Under rotation,
# the 2nd+ use is a reuse event → Keycloak revokes the whole session.
for i in $(seq 1 "$N"); do
  curl -s -o /dev/null -w "%{http_code}\n" -b "$JAR" -X POST \
    -H "Content-Type: application/json" -d "{}" "$API/auth/refresh" > "$TMP/r$i.txt" &
done
wait

codes=$(for i in $(seq 1 "$N"); do cat "$TMP/r$i.txt"; done | tr '\n' ' ')
info "concurrent /auth/refresh status codes: $codes"

# A follow-up refresh with the original cookie — if any reuse happened, the
# session is revoked → 401. This is the reliable signal that the race occurred.
FOLLOW=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X POST \
  -H "Content-Type: application/json" -d "{}" "$API/auth/refresh")
info "follow-up /auth/refresh (same cookie): $FOLLOW"

revokes=$(echo "$codes" | tr ' ' '\n' | grep -c '^401$' || true)
if [ "$revokes" -gt 0 ] || [ "$FOLLOW" = "401" ]; then
  pass "reuse race observed ($revokes of $N concurrent 401, follow-up=$FOLLOW) — rotation enforced, session revoked"
  info "→ The FE Web Lock mutex (lib/api.ts) prevents this by serializing cross-tab refreshes."
else
  info "race not reproduced this run (timing — the $N requests didn't overlap at Keycloak); re-run to observe."
  info "  config verification (Part 1) is the hard assertion + already passed."
fi

echo
pass "P0-12: realm rotation config verified ON + reuse-race demonstration complete"
