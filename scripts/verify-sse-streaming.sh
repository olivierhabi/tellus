#!/usr/bin/env bash
# =============================================================================
# verify-sse-streaming.sh
#
# Verifies the Code Assistant SSE-streaming fix: the global compression
# middleware must EXCLUDE text/event-stream (zlib otherwise buffers every
# frame and bursts them out at the END — the "response comes at once" bug).
#
# Method: start a probe server (scripts/verify-sse-streaming-server.ts) that
# mounts two identical drip-SSE endpoints — one with the REAL
# createCompressionMiddleware (the fix), one with plain compression() (the
# original bug). curl-probe both with `Accept-Encoding: gzip` (what browsers
# send) and assert:
#   fixed  → first byte EARLY (< total/2) + ≥3 frames drip in  → STREAMED
#   broken → first byte ≈ total + 0 plain frames (gzip'd)      → BUFFERED
#
# The fixed endpoint MUST stream and the broken one MUST buffer — that
# contrast proves both the fix and that the test would catch a regression.
#
# Run:  bash scripts/verify-sse-streaming.sh
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT_FIXED="${PORT_FIXED:-4101}"
PORT_BROKEN="${PORT_BROKEN:-4102}"
LOG="/tmp/verify-sse-streaming.log"
NODE_PID=""
FAILS=0

pass() { printf "\033[1;32m✓ PASS\033[0m  %s\n" "$1"; }
fail() { printf "\033[1;31m✗ FAIL\033[0m  %s\n" "$1" >&2; FAILS=$((FAILS+1)); }
log()  { printf "\033[1;34m[test]\033[0m %s\n" "$1"; }

cleanup() { [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null; }
trap cleanup EXIT

# --- 1. start the probe server (tsx so it imports the .ts middleware) -------
log "starting probe server (fixed :$PORT_FIXED, broken :$PORT_BROKEN)..."
npx tsx "$ROOT/scripts/verify-sse-streaming-server.ts" "$PORT_FIXED" "$PORT_BROKEN" > "$LOG" 2>&1 &
NODE_PID=$!

n=0
until curl -sf -o /dev/null "http://localhost:$PORT_FIXED/health" \
   && curl -sf -o /dev/null "http://localhost:$PORT_BROKEN/health"; do
  sleep 0.2; n=$((n+1))
  if [ $n -ge 60 ]; then
    fail "probe server did not come up (see $LOG)"
    tail -20 "$LOG" >&2
    exit 1
  fi
done
pass "probe server up"

# --- 2. probe one endpoint: first-byte vs total time + frame count ----------
#   time_starttransfer = first byte (first SSE frame).
#   time_total         = last byte (stream end).
#   Streamed  → first byte early, multiple plain frames.
#   Buffered  → first byte ≈ total, 0 plain frames (gzip'd bytes).
#   Prints the metrics + a STREAMED/BUFFERED verdict. Echoes "streamed" or
#   "buffered" on stdout (captured by the caller for the final verdict).
probe() {
  local port="$1" label="$2"
  local out metrics ttfb total frames verdict
  out=$(mktemp)
  metrics=$(curl -N -s --max-time 12 -o "$out" \
    -w "%{time_starttransfer} %{time_total}" \
    -H "Accept: text/event-stream" -H "Accept-Encoding: gzip" \
    "http://localhost:$port/sse" 2>/dev/null)
  ttfb=$(printf '%s' "$metrics" | awk '{print $1}')
  total=$(printf '%s' "$metrics" | awk '{print $2}')
  # Count plain SSE frames. The broken endpoint is gzip'd (curl has no
  # --compressed), so its raw bytes contain no "data:" lines → 0 frames.
  # `-a` treats the gzip blob as text so grep -c still prints a numeric count;
  # `|| true` avoids echo doubling the count when grep exits 1 (no matches).
  frames=$(grep -ac '^data:' "$out" 2>/dev/null || true)
  frames=${frames:-0}
  rm -f "$out"
  # Streamed = first byte arrives in the first half of the response AND the
  # plain frames are visible (not swallowed by gzip buffering).
  if awk "BEGIN{exit !($ttfb < $total/2)}" && [ "${frames:-0}" -ge 3 ]; then
    verdict="streamed"
  else
    verdict="buffered"
  fi
  printf "  %-32s firstByte=%ss total=%ss frames=%s  → %s\n" \
    "$label" "$ttfb" "$total" "$frames" "$verdict" >&2
  printf '%s' "$verdict"
}

log "probing both endpoints (5 frames, 200ms apart)..."
fixed_verdict=$(probe "$PORT_FIXED"  "fixed (real middleware)")
broken_verdict=$(probe "$PORT_BROKEN" "broken (plain compression)")
echo

# --- 3. verdict -------------------------------------------------------------
# Success IFF the fixed endpoint STREAMS (the fix works) AND the broken one
# BUFFERS (proving the test would catch a regression). Either mismatch is a
# real failure.
ok=true
if [ "$fixed_verdict" = "streamed" ]; then
  pass "fixed (real middleware): STREAMED — SSE reaches the client frame-by-frame"
else
  fail "fixed (real middleware): NOT streamed — the fix is not in place"
  ok=false
fi
if [ "$broken_verdict" = "buffered" ]; then
  pass "broken (plain compression): BUFFERED — confirms this test catches the bug"
else
  fail "broken (plain compression): unexpectedly streamed — the probe is wrong"
  ok=false
fi

if $ok; then
  printf "\n\033[1;32mVERIFIED\033[0m — the fix streams SSE live; plain compression buffers it (the bug the fix prevents).\n"
  exit 0
else
  printf "\n\033[1;31m%d failure(s)\033[0m — see $LOG\n" "$FAILS" >&2
  exit 1
fi
