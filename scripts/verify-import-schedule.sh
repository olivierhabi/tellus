#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-import-schedule.sh
#
# End-to-end check of the table-import scheduler against a running local stack:
#   1. PUT a schedule (enabled, interval) -> 200; GET reflects it (nextRunAt set)
#   2. force the import "due" (next_run_at in the past) -> the running scheduler
#      claims it, enqueues a build (actor=tellus-table-import-scheduler),
#      records last_scheduled_build_rid, and advances next_run_at one interval
#   3. PUT schedule disabled -> GET shows enabled=false, nextRunAt=null
#
# Usage: scripts/verify-import-schedule.sh
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="${API_BASE:-http://localhost:3000/api/v1/connectivity}"
KC="${KC_BASE:-http://localhost:8086}"; REALM="${KC_REALM:-tellus}"; CLIENT="${KC_CLIENT:-tellus-frontend}"
SOURCE_RID="${SOURCE_RID:-ri.magritte.main.source.20e01559-7c88-43c4-b574-a083348f7b79}"
PG_CONTAINER="${PG_CONTAINER:-tellus-postgres-1}"
INTERVAL_MIN=5

pass(){ printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILURES=$((FAILURES+1)); }
info(){ printf '\033[36m==>\033[0m %s\n' "$1"; }
FAILURES=0
uu(){ python3 -c 'import uuid;print(uuid.uuid4())'; }
export PGPASSWORD="$(grep -E '^PGPASSWORD=' "$ROOT/.env" | cut -d= -f2-)"
sql(){ docker exec -e PGPASSWORD="$PGPASSWORD" "$PG_CONTAINER" psql -U tellus -d tellus_db -tAF'|' -X -c "$1"; }

EMAIL="$(grep -E '^TELLUS_SUPERADMIN_EMAIL=' "$ROOT/.env" | cut -d= -f2-)"
PW="$(grep -E '^TELLUS_SUPERADMIN_PASSWORD=' "$ROOT/.env" | cut -d= -f2-)"
TOK="$(curl -sf -X POST "$KC/realms/$REALM/protocol/openid-connect/token" -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=password --data-urlencode "client_id=$CLIENT" \
  --data-urlencode "username=$EMAIL" --data-urlencode "password=$PW" --data-urlencode scope=openid \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')"
AUTH=(-H "Authorization: Bearer $TOK"); JSON=(-H 'Content-Type: application/json')

echo
info "Setup — create a table import"
IMP="$(curl -sf "${AUTH[@]}" "${JSON[@]}" -H "Idempotency-Key: $(uu)" -X POST "$API/connections/$SOURCE_RID/imports" \
  -d "{\"connectionRid\":\"$SOURCE_RID\",\"datasetRid\":\"ri.foundry.main.dataset.$(uu)\",\"displayName\":\"sched-$(uu|cut -c1-8)\",\"config\":{\"schema\":\"public\",\"table\":\"users\",\"mode\":\"snapshot\"}}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["rid"])')"
echo "  import=$IMP"

echo
info "TEST 1 — PUT schedule {enabled:true, intervalMinutes:$INTERVAL_MIN}"
CODE="$(curl -s -o /tmp/sched_put.json -w '%{http_code}' "${AUTH[@]}" "${JSON[@]}" -H 'If-Match: W/"1"' -X PUT "$API/imports/$IMP" \
  -d "{\"schedule\":{\"enabled\":true,\"intervalMinutes\":$INTERVAL_MIN}}")"
[ "$CODE" = "200" ] && pass "schedule enabled (200)" || fail "expected 200, got $CODE — $(cat /tmp/sched_put.json)"
curl -sf "${AUTH[@]}" "$API/imports/$IMP" | python3 -c '
import sys,json; d=json.load(sys.stdin); s=d.get("schedule",{})
assert s.get("enabled") is True, s
assert s.get("intervalMinutes")==5, s
assert s.get("nextRunAt"), s
print("    schedule:", json.dumps(s))
' && pass "GET reflects enabled + interval + nextRunAt" || fail "schedule not reflected on GET"

echo
info "TEST 2 — force due, then the running scheduler claims + enqueues a build"
sql "UPDATE table_imports SET next_run_at = now() - interval '1 minute' WHERE rid='$IMP';" >/dev/null
echo "  waiting for a scheduler tick (poll ~30s)…"
BUILD=""
for i in $(seq 1 24); do
  BUILD="$(sql "SELECT COALESCE(last_scheduled_build_rid,'') FROM table_imports WHERE rid='$IMP';" | tr -d '[:space:]')"
  [ -n "$BUILD" ] && { echo "  scheduled build after ~$((i*3))s: $BUILD"; break; }
  sleep 3
done
[ -n "$BUILD" ] && pass "scheduler enqueued a build (last_scheduled_build_rid set)" || fail "no scheduled build within timeout"
if [ -n "$BUILD" ]; then
  ACTOR="$(sql "SELECT actor FROM orchestration_builds WHERE rid='$BUILD';" | tr -d '[:space:]')"
  [ "$ACTOR" = "tellus-table-import-scheduler" ] && pass "build actor is the scheduler ($ACTOR)" || fail "unexpected build actor: $ACTOR"
  FUTURE="$(sql "SELECT (next_run_at > now()) FROM table_imports WHERE rid='$IMP';" | tr -d '[:space:]')"
  [ "$FUTURE" = "t" ] && pass "next_run_at advanced into the future (no re-fire storm)" || fail "next_run_at not advanced"
fi

echo
info "TEST 3 — disable the schedule"
VER="$(curl -sf "${AUTH[@]}" "$API/imports/$IMP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["version"])')"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${JSON[@]}" -H "If-Match: W/\"$VER\"" -X PUT "$API/imports/$IMP" \
  -d '{"schedule":{"enabled":false,"intervalMinutes":null}}')"
[ "$CODE" = "200" ] && pass "schedule disabled (200)" || fail "expected 200, got $CODE"
curl -sf "${AUTH[@]}" "$API/imports/$IMP" | python3 -c '
import sys,json; s=json.load(sys.stdin).get("schedule",{})
assert s.get("enabled") is False, s
assert s.get("nextRunAt") is None, s
print("    schedule:", json.dumps(s))
' && pass "GET shows disabled + nextRunAt cleared" || fail "schedule not disabled on GET"

echo
if [ "$FAILURES" -eq 0 ]; then printf '\033[32mALL CHECKS PASSED\033[0m\n'; else printf '\033[31m%d CHECK(S) FAILED\033[0m\n' "$FAILURES"; exit 1; fi
