#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Live verification of the build-progress SSE endpoint:
#   GET /api/v1/connectivity/builds/:buildRid/events
#
# Asserts the wire contract the FE EventSource relies on:
#   - text/event-stream content type + no-buffering headers
#   - a full `status` snapshot on connect
#   - raw events carry an SSE `id:` (so reconnects can resume)
#   - a terminal build emits `done` and the server closes the stream
#   - Last-Event-ID resume: a high cursor backfills no raw events
#   - 404 for an unknown build, 401 unauthenticated
#
# Requires the dev backend on :3000 and Keycloak on :8086. Drives a fresh
# SINGLE-job build (so the raw-event id + Last-Event-ID resume contract below
# exercises the single-build stream path; multi-job Builds emit aggregate
# snapshots and are covered by test-build-batch*). Exit non-zero on any failure.
#
#   bash scripts/test-build-sse.sh
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")/.."

# Load DB/storage env so the rid-discovery tsx probe can reach Postgres.
if [ -f ./.env ]; then set -a; . ./.env; set +a; fi

KC="${KC_URL:-http://localhost:8086}"
REALM="${KC_REALM:-tellus}"
API="${API_BASE:-http://localhost:3000/api/v1/connectivity}"
KUSER="${KC_USER:-cypress@tellus.local}"
KPASS="${KC_PASS:-Password123!}"

pass=0; fail=0
ok(){ echo "  ✓ $1"; pass=$((pass+1)); }
no(){ echo "  ✗ $1"; fail=$((fail+1)); }

echo "[auth]"
TOKEN=$(curl -s -X POST "$KC/realms/$REALM/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=tellus-frontend \
  -d "username=$KUSER" -d "password=$KPASS" -d scope=openid \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
if [ -n "$TOKEN" ]; then ok "obtained Keycloak token"; else no "could not obtain token"; echo "FAILED"; exit 1; fi

echo "[discover build]"
# Execute ONE import → a single-job Build (group of one), so the raw-event id +
# resume assertions below exercise the single-build stream path.
IMP1=$(npx tsx scripts/pick-batch-targets.ts 2>/dev/null | grep '^IMP=' | sed -n '1p' | cut -d= -f2)
if [ -z "$IMP1" ]; then no "no import to build (run a sync first)"; echo "FAILED"; exit 1; fi
BUILD_RID="${BUILD_RID:-$(curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen 2>/dev/null || echo sse1)" \
  "$API/imports/$IMP1/execute" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('buildRid',''))" 2>/dev/null)}"
if [ -n "$BUILD_RID" ]; then ok "single-job build: $BUILD_RID"; else no "could not start a build"; echo "FAILED"; exit 1; fi
# Let the build finish (dev builds finish in ms) so `done` + backfilled id lines appear.
sleep 2

echo "[stream]"
# Capture headers + body; --max-time bounds the wait (a terminal build closes early).
curl -s -N --max-time 10 -D /tmp/sse_hdr.txt -o /tmp/sse_body.txt \
  -H "Authorization: Bearer $TOKEN" -H "Accept: text/event-stream" \
  "$API/builds/$BUILD_RID/events"
HDR=$(cat /tmp/sse_hdr.txt); BODY=$(cat /tmp/sse_body.txt)

echo "$HDR" | grep -qi "content-type: *text/event-stream" && ok "content-type is text/event-stream" || no "wrong content-type"
echo "$HDR" | grep -qi "x-accel-buffering: *no" && ok "x-accel-buffering:no (proxy-safe)" || no "missing x-accel-buffering"
echo "$BODY" | grep -q "^event: status" && ok "emits a status snapshot on connect" || no "no status snapshot"
echo "$BODY" | grep -q "^id: " && ok "raw events carry an SSE id (resumable)" || no "no id: lines"
echo "$BODY" | grep -q "^event: done" && ok "terminal build emits done + closes stream" || no "no done event"
# The status payload is compact JSON; confirm it carries a Foundry status enum.
echo "$BODY" | grep -Eq '"status":"(RUNNING|SUCCEEDED|FAILED|CANCELED)"' && ok "status payload carries a Foundry status enum" || no "status payload malformed"

echo "[resume via Last-Event-ID]"
RESUME=$(curl -s -N --max-time 8 -H "Authorization: Bearer $TOKEN" \
  -H "Last-Event-ID: 999999999" "$API/builds/$BUILD_RID/events")
echo "$RESUME" | grep -q "^event: status" && ok "resume still sends the current snapshot" || no "resume missing snapshot"
if echo "$RESUME" | grep -q "^id: "; then no "resume backfilled events past the cursor (should not)"; else ok "resume backfills no events past the cursor"; fi

echo "[errors]"
CODE_404=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
  -H "Authorization: Bearer $TOKEN" \
  "$API/builds/ri.orchestration.main.build.00000000-0000-0000-0000-000000000000/events")
[ "$CODE_404" = "404" ] && ok "unknown build → 404" || no "unknown build returned $CODE_404 (want 404)"
CODE_401=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$API/builds/$BUILD_RID/events")
[ "$CODE_401" = "401" ] && ok "unauthenticated → 401" || no "unauthenticated returned $CODE_401 (want 401)"

echo ""
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ] && { echo "All SSE assertions passed."; exit 0; } || { echo "SSE verification FAILED."; exit 1; }
