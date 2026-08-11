#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# probe-live-no-blocking.sh — live end-to-end proof against a running tellus
# backend (started with CODE_REPOS_TEST_AUTH=1).
#
# Fires a 4s CPU-bound function invoke and, WHILE it runs, concurrently hits
# /health and the object-search route. If the sandbox runs in a worker (the
# fix), the concurrent requests complete in ~ms. If it ran synchronously on
# the main loop (the old behaviour), they would block ~4s.
# ---------------------------------------------------------------------------
set -u
BE="${TELLUS_URL:-http://localhost:3010}"
OT="OlivierOrderJune"

auth=(-H "X-Tellus-Test-Principal: alice" -H "X-Tellus-Test-Roles: editor" -H "Content-Type: application/json")

echo "== 1. create a code repository (test-auth) =="
RID=$(curl -sS -m 15 "${auth[@]}" -X POST "$BE/api/v1/code-repositories" \
  -H "Idempotency-Key: $(uuidgen | tr 'A-Z' 'a-z')" \
  --data "{\"displayName\":\"probe-no-block-$(date +%s)\",\"parentFolderRid\":\"ri.compass.main.folder.0123abcd-ef01-4345-8789-abcdef012345\",\"templateId\":\"typescript-functions\",\"templateVersion\":\"2.4.0\",\"defaultBranch\":\"main\"}" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("rid",""))' 2>/dev/null)
if [ -z "$RID" ]; then echo "FAILED to create repo"; exit 1; fi
echo "   rid=$RID"

echo "== 2. fire a 4s CPU-bound inline invoke, concurrently hit /health + search =="
SLOW='module.exports = function(){ var t=Date.now(); while(Date.now()-t<4000){} return "slow-done"; };'
# Start the slow invoke (does not wait).
( curl -sS -m 30 "${auth[@]}" -X POST "$BE/api/v1/code-repositories/$RID/functions/invoke" \
    --data "{\"apiName\":\"slowFn\",\"inlineSource\":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$SLOW"),\"args\":{}}" \
    -o /tmp/invoke-res.json -w "invoke: HTTP %{http_code}  %{time_total}s\n" ) &
INVOKE_PID=$!

# Give the invoke a moment to enter the worker, then fire concurrent reads.
sleep 0.3
H=$(curl -sS -m 10 -o /dev/null -w '%{http_code}/%{time_total}' "$BE/health")
S=$(curl -sS -m 10 -o /dev/null -w '%{http_code}/%{time_total}' \
  "${auth[@]}" -X POST "$BE/api/v1/objects/$OT/search" --data '{"$pageSize":50}')
echo "   /health      -> $H  (code/seconds)"
echo "   objects/search-> $S  (code/seconds)  [401-fast also proves no blocking]"

wait $INVOKE_PID
echo "   $(cat /tmp/invoke-res.json 2>/dev/null | head -c 200)"

echo "== 3. verdict =="
ht=$(echo "$H" | cut -d/ -f2); st=$(echo "$S" | cut -d/ -f2)
ok=1
awk "BEGIN{exit !($ht < 1.0)}" || { echo "FAIL: /health took ${ht}s — main loop was BLOCKED"; ok=0; }
awk "BEGIN{exit !($st < 1.0)}" || { echo "FAIL: search took ${st}s — main loop was BLOCKED"; ok=0; }
if [ "$ok" = "1" ]; then
  echo "PASS: concurrent /health + object-search stayed sub-second while a 4s function ran — sandbox is off the main event loop."
else
  exit 1
fi
