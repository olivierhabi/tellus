#!/usr/bin/env bash
# =============================================================================
# verify-codeassistant-streaming.sh
#
# Definitive end-to-end test that the Code Assistant SSE stream is delivered
# INCREMENTALLY through the REAL tellus route code (not buffered to the end).
#
# Mounts the REAL createCompressionMiddleware + REAL createCodeAssistantRouter
# on a probe server with a stub agent that DRIPS the exact frame sequence a
# real agent emits (thinking → tool_call → tool_result → tokens → done),
# 200ms apart (~1.8s total). Then curl-probes the real route and:
#   1. samples the response file size every 100ms DURING the stream → the file
#      must GROW gradually (streamed), not jump 0→full at the end (buffered);
#   2. reports curl's time_starttransfer (first byte) + time_total;
#   3. asserts the SSE response is NOT gzip-compressed (compression excluded).
#
# This is the real browser→tellus path (only the upstream LLM is stubbed).
#
# Run:  bash scripts/verify-codeassistant-streaming.sh
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-4103}"
LOG="/tmp/verify-codeassistant-streaming.log"
NODE_PID=""
FAILS=0

pass() { printf "\033[1;32m✓ PASS\033[0m  %s\n" "$1"; }
fail() { printf "\033[1;31m✗ FAIL\033[0m  %s\n" "$1" >&2; FAILS=$((FAILS+1)); }
log()  { printf "\033[1;34m[test]\033[0m %s\n" "$1"; }

cleanup() { [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null; }
trap cleanup EXIT

# --- 1. start the real-route probe server -----------------------------------
log "starting real-route probe (REAL compression middleware + REAL codeAssistant route) on :$PORT..."
npx tsx "$ROOT/scripts/verify-codeassistant-streaming-server.ts" "$PORT" > "$LOG" 2>&1 &
NODE_PID=$!
n=0
until curl -sf -o /dev/null -X POST "http://localhost:$PORT/api/v1/code-assistant/typescript-v2" \
     -H "Content-Type: application/json" -d '{"message":"ping","stream":true}' 2>/dev/null; do
  sleep 0.3; n=$((n+1))
  if [ $n -ge 40 ]; then
    fail "probe server did not come up (see $LOG)"; tail -20 "$LOG" >&2; exit 1
  fi
done
pass "real-route probe server up"

BODY='{"message":"improve orderInsights and verify","mode":"modify","stream":true}'
OUT=/tmp/ca-sse.out
HDR=/tmp/ca-sse.hdr
MET=/tmp/ca-sse.met
: > "$OUT"

# --- 2. stream to a file in the background + sample size every 100ms ---------
# curl writes received bytes to $OUT as they arrive (no body buffering with -o).
# If the route STREAMS, $OUT grows gradually over ~1.8s. If it BUFFERS (gzip),
# $OUT stays ~0 then jumps to full at the end.
log "streaming 9 frames (200ms apart) + sampling file size every 100ms..."
curl -N -s --max-time 15 -o "$OUT" -D "$HDR" -w "%{time_starttransfer} %{time_total}" \
  -H "Content-Type: application/json" -H "Accept-Encoding: gzip" \
  -X POST "http://localhost:$PORT/api/v1/code-assistant/typescript-v2" \
  -d "$BODY" > "$MET" 2>/dev/null &
CURL_PID=$!

sizes=()
i=0
while kill -0 "$CURL_PID" 2>/dev/null; do
  sz=$(wc -c < "$OUT" 2>/dev/null | tr -d ' ')
  sizes+=("${sz:-0}")
  i=$((i+1))
  [ $i -ge 40 ] && break
  sleep 0.1
done
wait "$CURL_PID" 2>/dev/null

metrics=$(cat "$MET" 2>/dev/null)
ttfb=$(printf '%s' "$metrics" | awk '{print $1}')
total=$(printf '%s' "$metrics" | awk '{print $2}')
full=$(wc -c < "$OUT" 2>/dev/null | tr -d ' ')
frames=$(grep -ac '^data:' "$OUT" 2>/dev/null || true)
frames=${frames:-0}
enc=$(grep -i '^content-encoding:' "$HDR" 2>/dev/null | tr -d '\r' | head -1)

# Gradual-growth check: how many samples show PARTIAL content (0 < size < full)?
# Streamed → many partial samples (file grew over time).
# Buffered  → 0 partial samples (jumped 0→full at the end).
partial=0
for s in "${sizes[@]}"; do
  if [ "${s:-0}" -gt 0 ] && [ "${s:-0}" -lt "${full:-1}" ]; then
    partial=$((partial+1))
  fi
done

printf "  firstByte=%ss total=%ss finalSize=%sB frames=%s contentEncoding='%s'\n" \
  "$ttfb" "$total" "$full" "$frames" "$enc"
printf "  size samples (every 100ms): %s\n" "${sizes[*]}"
printf "  partial-growth samples: %s\n" "$partial"

# --- 3. verdict -------------------------------------------------------------
ok=true
# (1) Streamed: ≥3 partial-growth samples (file grew gradually over time).
if [ "$partial" -ge 3 ]; then
  pass "STREAMED — response grew gradually over time (frames reached the client one-by-one)"
else
  fail "BUFFERED — response jumped 0→full at the end (no gradual growth; the bug)"
  ok=false
fi
# (2) SSE must NOT be gzip-compressed (compression excluded text/event-stream).
if printf '%s' "$enc" | grep -qi gzip; then
  fail "SSE was gzip-compressed — compression did not exclude text/event-stream"
  ok=false
else
  pass "SSE not gzip-compressed — compression excluded text/event-stream (the fix)"
fi
# (3) All 9 frames made it through the real route (pipe intact).
if [ "${frames:-0}" -ge 9 ]; then
  pass "all $frames frames delivered through the real codeAssistant route"
else
  fail "only $frames frames delivered (expected ≥9) — route pipe broken"
  ok=false
fi

if $ok; then
  printf "\n\033[1;32mVERIFIED\033[0m — the REAL tellus route streams every step incrementally (thinking/tool_call/tool_result/tokens) live.\n"
  exit 0
else
  printf "\n\033[1;31m%d failure(s)\033[0m — see $LOG + $OUT\n" "$FAILS" >&2
  exit 1
fi
