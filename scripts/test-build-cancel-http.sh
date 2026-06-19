#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Live HTTP contract for the cancel endpoint:
#   POST /api/v1/connectivity/builds/:buildRid/cancel
#
# Asserts:
#   - unknown build → 404 BuildNotFound
#   - unauthenticated → 401
#   - cancelling an already-terminal build is idempotent: 200 with
#     alreadyTerminal=true and the build's terminal status preserved.
#
# (Cancelling a genuinely in-flight worker is covered by the integration test
# scripts/test-build-cancel.ts — dev builds finish in ms, so the latest build is
# terminal and exercises the idempotent path here.)
#
#   bash scripts/test-build-cancel-http.sh
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

BUILD_RID="${BUILD_RID:-$(npx tsx scripts/latest-build-rid.ts 2>/dev/null \
  | grep -oE 'ri\.(foundry|orchestration)\.main\.build\.[0-9a-fA-F-]+' | tail -1)}"
[ -n "$BUILD_RID" ] && ok "latest build: $BUILD_RID" || { no "no build"; echo FAILED; exit 1; }

echo "[errors]"
CODE_404=$(curl -s -o /tmp/cancel404.json -w "%{http_code}" -X POST -H "Authorization: Bearer $TOKEN" \
  "$API/builds/ri.foundry.main.build.00000000-0000-0000-0000-000000000000/cancel")
[ "$CODE_404" = "404" ] && ok "unknown build → 404" || no "unknown returned $CODE_404"
grep -q "BuildNotFound" /tmp/cancel404.json && ok "404 envelope is BuildNotFound" || no "404 envelope wrong"

CODE_401=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/builds/$BUILD_RID/cancel")
[ "$CODE_401" = "401" ] && ok "unauthenticated → 401" || no "unauth returned $CODE_401"

echo "[idempotent on terminal build]"
curl -s -o /tmp/cancel.json -w "" -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen 2>/dev/null || echo k1)" "$API/builds/$BUILD_RID/cancel"
cat /tmp/cancel.json | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('  body:', json.dumps(d))
assert d.get('alreadyTerminal') is True, 'expected alreadyTerminal=true for a finished build'
assert d.get('status') in ('SUCCEEDED','FAILED','CANCELED'), d.get('status')
print('  OK')
" && ok "terminal build cancel is idempotent (alreadyTerminal=true)" || no "idempotent cancel contract failed"

echo ""
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ] && { echo "All cancel HTTP assertions passed."; exit 0; } || { echo "Cancel HTTP verification FAILED."; exit 1; }
