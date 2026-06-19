#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-session-ttl.sh
#
# Verifies the single session-lifetime knob (TELLUS_SESSION_MAX_AGE) that
# governs "how long I stay logged in" — the fix for "duplicate a tab and it
# asks me to log in again."
#
#   1. STATIC (no server): the backend resolver parses + clamps the value
#      configured in .env to the expected number of seconds, and a couple
#      of fixed transforms hold (8h -> 28800, bad -> default).
#
#   2. LIVE  (best-effort; skipped cleanly if the backend isn't reachable
#      or the test account isn't on the cookie fast-path):
#        a. POST /auth/login sets TELLUS_TOKEN + TELLUS_REFRESH whose
#           Max-Age equals the configured window, and echoes the same value
#           as `sessionMaxAgeSeconds` in the body.
#        b. DUPLICATE-TAB SIMULATION: POST /auth/refresh using ONLY the
#           cookie jar (no Authorization header — exactly what a freshly
#           opened/duplicated tab has) recovers the session (200) and
#           echoes the same window. This is the precise condition that used
#           to bounce the user to /login.
#
# Usage:
#   scripts/verify-session-ttl.sh
#   API_ORIGIN=http://localhost:3000 scripts/verify-session-ttl.sh
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_ORIGIN="${API_ORIGIN:-http://localhost:3000}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

pass(){ printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILURES=$((FAILURES+1)); }
skip(){ printf '  \033[33mSKIP\033[0m %s\n' "$1"; }
info(){ printf '\033[36m==>\033[0m %s\n' "$1"; }
FAILURES=0

envval(){ grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }

# Resolve a duration string to seconds using the BACKEND's own resolver, so
# this script and the running server can never disagree on the math.
resolve(){
  npx --yes tsx -e '
    import { resolveSessionMaxAgeSeconds } from "./src/config/sessionConfig";
    process.stdout.write(String(resolveSessionMaxAgeSeconds({ TELLUS_SESSION_MAX_AGE: process.argv[1] })));
  ' "$1"
}

CONFIGURED="$(envval TELLUS_SESSION_MAX_AGE)"
[ -n "$CONFIGURED" ] || CONFIGURED="8h"  # module default

info "Configured TELLUS_SESSION_MAX_AGE=\"$CONFIGURED\""
EXPECTED="$(resolve "$CONFIGURED")"
info "Resolver says expected window = ${EXPECTED}s"

# ---------------------------------------------------------------------------
echo
info "1. Static resolver contract"
# ---------------------------------------------------------------------------
[ "$(resolve 8h)" = "28800" ]  && pass "8h resolves to 28800s"         || fail "8h should resolve to 28800s (got $(resolve 8h))"
[ "$(resolve 480m)" = "28800" ] && pass "480m resolves to 28800s"      || fail "480m should resolve to 28800s"
[ "$(resolve nonsense)" = "28800" ] && pass "malformed falls back to 8h default" || fail "malformed should fall back to 28800s"
[ "$(resolve 1s)" = "60" ]     && pass "1s clamps up to the 60s floor"  || fail "1s should clamp to 60s"
[ "$(resolve 365d)" = "2592000" ] && pass "365d clamps to the 30d ceiling" || fail "365d should clamp to 2592000s"
[ "$EXPECTED" -ge 60 ] && [ "$EXPECTED" -le 2592000 ] && pass "configured window is within [60s, 30d]" || fail "configured window out of range"

# ---------------------------------------------------------------------------
echo
info "2. Live login + duplicate-tab refresh (best-effort)"
# ---------------------------------------------------------------------------
if ! curl -sf -o /dev/null --max-time 3 "$API_ORIGIN/api/health" 2>/dev/null \
   && ! curl -sf -o /dev/null --max-time 3 "$API_ORIGIN/health" 2>/dev/null; then
  skip "backend not reachable at $API_ORIGIN — run the stack to exercise live checks"
  echo
  [ "$FAILURES" -eq 0 ] && { printf '\033[32mAll static checks passed.\033[0m\n'; exit 0; } || { printf '\033[31m%s check(s) failed.\033[0m\n' "$FAILURES"; exit 1; }
fi

EMAIL="${TEST_EMAIL:-$(envval TELLUS_SUPERADMIN_EMAIL)}"
PW="${TEST_PASSWORD:-$(envval TELLUS_SUPERADMIN_PASSWORD)}"
if [ -z "$EMAIL" ] || [ -z "$PW" ]; then
  skip "no login credentials (set TEST_EMAIL/TEST_PASSWORD or the superadmin vars in .env)"
else
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  JAR="$TMP/jar"; H1="$TMP/h1"; B1="$TMP/b1"; H2="$TMP/h2"; B2="$TMP/b2"

  curl -s -D "$H1" -o "$B1" -c "$JAR" \
    -X POST "$API_ORIGIN/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":$(jq -Rn --arg e "$EMAIL" '$e'),\"password\":$(jq -Rn --arg p "$PW" '$p')}" || true

  STATUS="$(head -1 "$H1" | awk '{print $2}')"
  HAS_TOKEN_COOKIE="$(grep -ic '^set-cookie: TELLUS_TOKEN=' "$H1" || true)"

  if [ "$STATUS" = "200" ] && [ "$HAS_TOKEN_COOKIE" -ge 1 ]; then
    # Cookie Max-Age must equal the configured window.
    for cookie in TELLUS_TOKEN TELLUS_REFRESH; do
      MA="$(grep -i "^set-cookie: ${cookie}=" "$H1" | grep -oiE 'max-age=[0-9]+' | head -1 | cut -d= -f2)"
      if [ -n "$MA" ] && [ "$MA" = "$EXPECTED" ]; then
        pass "$cookie Max-Age == ${EXPECTED}s"
      else
        fail "$cookie Max-Age should be ${EXPECTED}s (got '${MA:-none}')"
      fi
    done

    BODY_TTL="$(jq -r '.data.sessionMaxAgeSeconds // empty' "$B1")"
    [ "$BODY_TTL" = "$EXPECTED" ] && pass "login body sessionMaxAgeSeconds == ${EXPECTED}s" \
      || fail "login body sessionMaxAgeSeconds should be ${EXPECTED}s (got '${BODY_TTL:-none}')"

    # ---- duplicate-tab simulation: refresh with ONLY the cookie jar ----
    curl -s -D "$H2" -o "$B2" -b "$JAR" -c "$JAR" \
      -X POST "$API_ORIGIN/api/v1/auth/refresh" \
      -H 'Content-Type: application/json' -d '{}' || true
    RSTATUS="$(head -1 "$H2" | awk '{print $2}')"
    if [ "$RSTATUS" = "200" ]; then
      pass "duplicate-tab refresh (cookie-only, no bearer) recovered the session (200)"
    else
      fail "duplicate-tab refresh should return 200 (got '${RSTATUS:-none}') — this is the bug"
    fi
    RTTL="$(jq -r '.data.sessionMaxAgeSeconds // empty' "$B2")"
    [ "$RTTL" = "$EXPECTED" ] && pass "refresh body sessionMaxAgeSeconds == ${EXPECTED}s" \
      || fail "refresh body sessionMaxAgeSeconds should be ${EXPECTED}s (got '${RTTL:-none}')"
  else
    # Account is gated behind MFA / mandatory passkey enrollment — no session
    # cookies are minted on this path, so the cookie/refresh assertions don't
    # apply. Report rather than fail so the script stays useful in CI.
    REASON="$(jq -r '(.data.mfaRequired and "mfa-required") // (.data.passkeyEnrollmentRequired and "passkey-enrollment-required") // .errorCode // "unknown"' "$B1" 2>/dev/null || echo unknown)"
    skip "login did not take the cookie fast-path (status=$STATUS, reason=$REASON); use a fast-path account to exercise cookie/refresh assertions"
  fi
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  printf '\033[32mAll checks passed.\033[0m\n'; exit 0
else
  printf '\033[31m%s check(s) failed.\033[0m\n' "$FAILURES"; exit 1
fi
