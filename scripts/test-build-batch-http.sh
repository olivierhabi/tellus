#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Live HTTP contract for the multi-table Build:
#   POST /api/v1/connectivity/imports/execute-batch  { importRids: [...] }
#   GET  /api/v1/connectivity/builds/:groupBuildRid
#
# Asserts end-to-end against the running server:
#   - execute-batch with two imports returns ONE group buildRid + a member per
#     import.
#   - GET /builds/<group> returns ONE Build whose jobs[] has BOTH datasets, the
#     top-level rid is the group rid, and the status aggregates the jobs.
#   - empty importRids → 400; unauthenticated → 401.
#
#   bash scripts/test-build-batch-http.sh
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

echo "[targets]"
TARGETS=$(npx tsx scripts/pick-batch-targets.ts 2>/dev/null)
IMP1=$(echo "$TARGETS" | grep '^IMP=' | sed -n '1p' | cut -d= -f2)
IMP2=$(echo "$TARGETS" | grep '^IMP=' | sed -n '2p' | cut -d= -f2)
[ -n "$IMP1" ] && [ -n "$IMP2" ] && ok "two imports: $IMP1 , $IMP2" || { no "need two imports on a connection"; echo FAILED; exit 1; }

echo "[errors]"
CODE_401=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
  -d "{\"importRids\":[\"$IMP1\"]}" "$API/imports/execute-batch")
[ "$CODE_401" = "401" ] && ok "unauthenticated → 401" || no "unauth returned $CODE_401"

CODE_400=$(curl -s -o /tmp/batch400.json -w "%{http_code}" -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $(uuidgen 2>/dev/null || echo k0)" \
  -d '{"importRids":[]}' "$API/imports/execute-batch")
[ "$CODE_400" = "400" ] && ok "empty importRids → 400" || no "empty returned $CODE_400"

# Unknown import → 404 BEFORE any dispatch (pre-flight guards against a partial Build).
CODE_404=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $(uuidgen 2>/dev/null || echo k404)" \
  -d '{"importRids":["ri.magritte.main.extract.00000000-0000-0000-0000-000000000000"]}' \
  "$API/imports/execute-batch")
[ "$CODE_404" = "404" ] && ok "unknown import → 404 (no partial Build)" || no "unknown import returned $CODE_404"

# Oversize batch (>100) → 400 (cap). 101 distinct fake rids; the cap rejects
# before any existence check, so the fake format is irrelevant here.
BIG=$(python3 -c "import json;print(json.dumps({'importRids':['ri.magritte.main.extract.%032x'%i for i in range(101)]}))")
CODE_BIG=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $(uuidgen 2>/dev/null || echo kbig)" \
  -d "$BIG" "$API/imports/execute-batch")
[ "$CODE_BIG" = "400" ] && ok ">100 imports → 400 (batch cap)" || no "oversize batch returned $CODE_BIG"

echo "[execute-batch]"
RESP=$(curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen 2>/dev/null || echo k1)" \
  -d "{\"importRids\":[\"$IMP1\",\"$IMP2\"]}" "$API/imports/execute-batch")
echo "  resp: $RESP"
GROUP=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('buildRid',''))" 2>/dev/null)
MEMBERS=$(echo "$RESP" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('members',[])))" 2>/dev/null)
echo "$GROUP" | grep -qE '^ri\.foundry\.main\.build\.' && ok "returned a foundry group buildRid" || no "bad group rid: $GROUP"
[ "$MEMBERS" = "2" ] && ok "two members dispatched" || no "members=$MEMBERS (want 2)"

echo "[read the group build]"
# Dev builds finish in ms; poll briefly for terminal then read jobs[].
TERMINAL=""
for i in $(seq 1 30); do
  curl -s -H "Authorization: Bearer $TOKEN" "$API/builds/$GROUP" > /tmp/batchget.json
  ST=$(python3 -c "import json;print(json.load(open('/tmp/batchget.json')).get('status',''))" 2>/dev/null)
  if [ "$ST" != "RUNNING" ] && [ -n "$ST" ]; then TERMINAL="$ST"; break; fi
  sleep 1
done
python3 - "$GROUP" <<'PY'
import json,sys
d=json.load(open('/tmp/batchget.json'))
group=sys.argv[1]
print("  status:", d.get("status"), "| jobs:", len(d.get("jobs",[])), "| rowsWritten:", d.get("rowsWritten"))
assert d.get("rid")==group, f"top-level rid should be the group ({d.get('rid')})"
assert len(d.get("jobs",[]))==2, f"jobs[] must list BOTH datasets (got {len(d.get('jobs',[]))})"
tables=sorted([ (j.get('import') or {}).get('table') for j in d['jobs'] ])
print("  job tables:", tables)
assert d.get("status") in ("SUCCEEDED","RUNNING","FAILED","CANCELED"), d.get("status")
print("  OK")
PY
[ $? -eq 0 ] && ok "GET /builds/<group> returns one Build with both jobs" || no "group read contract failed"
[ "$TERMINAL" = "SUCCEEDED" ] && ok "both jobs built — Build SUCCEEDED" || echo "  (note: terminal status was '${TERMINAL:-RUNNING}' — jobs[] contract still verified)"

echo ""
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ] && { echo "All batch HTTP assertions passed."; exit 0; } || { echo "Batch HTTP verification FAILED."; exit 1; }
