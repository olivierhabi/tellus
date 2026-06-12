#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Live verification of the MULTI-JOB build-progress SSE stream:
#   GET /api/v1/connectivity/builds/:groupBuildRid/events
#
# A multi-table Build aggregates many jobs; its SSE stream emits aggregate
# `status`/`done` snapshots (each frame carrying the full jobs[]) rather than
# per-member raw event ids (member id sequences aren't globally meaningful — the
# FE consumes snapshots). Asserts:
#   - text/event-stream + no-buffering headers
#   - a `status` snapshot on connect whose payload carries jobs[] with BOTH
#     datasets and a Foundry aggregate status
#   - a terminal `done` snapshot (also carrying jobs[]) and the stream closes
#   - the stream emits NO raw `id:` lines (aggregate-snapshot design)
#   - Last-Event-ID resume still sends the current snapshot
#   - 404 unknown, 401 unauthenticated
#
#   bash scripts/test-build-batch-sse.sh
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")/.."
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
[ -n "$TOKEN" ] && ok "obtained Keycloak token" || { no "no token"; echo FAILED; exit 1; }

echo "[start a multi-job build]"
TARGETS=$(npx tsx scripts/pick-batch-targets.ts 2>/dev/null)
IMP1=$(echo "$TARGETS" | grep '^IMP=' | sed -n '1p' | cut -d= -f2)
IMP2=$(echo "$TARGETS" | grep '^IMP=' | sed -n '2p' | cut -d= -f2)
[ -n "$IMP1" ] && [ -n "$IMP2" ] && ok "two imports to build" || { no "need two imports"; echo FAILED; exit 1; }
GROUP=$(curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen 2>/dev/null || echo b1)" \
  -d "{\"importRids\":[\"$IMP1\",\"$IMP2\"]}" "$API/imports/execute-batch" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('buildRid',''))" 2>/dev/null)
echo "$GROUP" | grep -qE '^ri\.foundry\.main\.build\.' && ok "group build: $GROUP" || { no "no group rid"; echo FAILED; exit 1; }
sleep 2  # dev jobs finish in ms; ensures `done` + a terminal aggregate

echo "[stream]"
curl -s -N --max-time 10 -D /tmp/bsse_hdr.txt -o /tmp/bsse_body.txt \
  -H "Authorization: Bearer $TOKEN" -H "Accept: text/event-stream" \
  "$API/builds/$GROUP/events"
HDR=$(cat /tmp/bsse_hdr.txt)

echo "$HDR" | grep -qi "content-type: *text/event-stream" && ok "content-type is text/event-stream" || no "wrong content-type"
echo "$HDR" | grep -qi "x-accel-buffering: *no" && ok "x-accel-buffering:no (proxy-safe)" || no "missing x-accel-buffering"
grep -q "^event: status" /tmp/bsse_body.txt && ok "emits a status snapshot on connect" || no "no status snapshot"
grep -q "^event: done" /tmp/bsse_body.txt && ok "terminal build emits done + closes" || no "no done event"
if grep -q "^id: " /tmp/bsse_body.txt; then no "multi-job stream emitted raw id lines (should be aggregate-only)"; else ok "no raw id lines (aggregate-snapshot design)"; fi

# Parse every data: frame; assert at least one carries jobs[] of length 2 and a Foundry status.
python3 - <<'PY'
import json
frames=[]
for line in open('/tmp/bsse_body.txt'):
    if line.startswith('data: '):
        try: frames.append(json.loads(line[6:]))
        except Exception: pass
withjobs=[f for f in frames if isinstance(f, dict) and isinstance(f.get('jobs'), list)]
assert withjobs, "no snapshot carried a jobs[] array"
two=[f for f in withjobs if len(f['jobs'])==2]
assert two, f"no snapshot carried BOTH jobs (sizes={[len(f['jobs']) for f in withjobs]})"
f=two[-1]
assert f.get('status') in ('RUNNING','SUCCEEDED','FAILED','CANCELED'), f.get('status')
tables=sorted([(j.get('import') or {}).get('table') for j in f['jobs']])
print("  aggregate status:", f.get('status'), "| job tables:", tables, "| rowsWritten:", f.get('rowsWritten'))
assert all(tables), "a job was missing its table"
print("  OK")
PY
[ $? -eq 0 ] && ok "snapshot payload carries jobs[] for BOTH datasets + aggregate status" || no "multi-job snapshot payload malformed"

echo "[resume via Last-Event-ID]"
RESUME=$(curl -s -N --max-time 8 -H "Authorization: Bearer $TOKEN" \
  -H "Last-Event-ID: 999999999" "$API/builds/$GROUP/events")
echo "$RESUME" | grep -q "^event: status" && ok "resume still sends the current snapshot" || no "resume missing snapshot"

echo "[errors]"
CODE_404=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 -H "Authorization: Bearer $TOKEN" \
  "$API/builds/ri.foundry.main.build.00000000-0000-0000-0000-000000000000/events")
[ "$CODE_404" = "404" ] && ok "unknown build → 404" || no "unknown returned $CODE_404"
CODE_401=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$API/builds/$GROUP/events")
[ "$CODE_401" = "401" ] && ok "unauthenticated → 401" || no "unauth returned $CODE_401"

echo ""
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ] && { echo "All multi-job SSE assertions passed."; exit 0; } || { echo "Multi-job SSE verification FAILED."; exit 1; }
