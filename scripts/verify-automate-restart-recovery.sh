#!/usr/bin/env bash
# Manual verification for spec section 25:
#   "Retry and fallback" 3-4  — durable retry survives a backend restart
#   "Restart and recovery"    — worker termination, lease recovery, no
#                               permanently-running execution, no duplicate
#                               side effects after recovery
#
# Drives the REAL API server process (kill -9 + restart between phases)
# against the REAL database. All assertions are scoped to the automations
# this script creates. Records every command outcome to
# /tmp/restart-recovery-report.txt.
set -uo pipefail
cd "$(dirname "$0")/.."

set -a; . ./.env; set +a

TS="pnpm exec tsx scripts/verify-automate-restart-recovery.ts"
REPORT=/tmp/restart-recovery-report.txt
: > "$REPORT"
FAILURES=0
AID=""
BID=""

say() { echo "$*" | tee -a "$REPORT"; }

# PostgreSQL runs in the tellus-postgres-1 docker container; no local psql.
psql_q() {
  docker exec -e PGPASSWORD="$PGPASSWORD" tellus-postgres-1 \
    psql -h localhost -p 5432 -U "$PGUSER" -d "$PGDATABASE" -tAc "$1"
}

check() { # $1 description, $2 expected, $3 actual
  if [ "$2" = "$3" ]; then
    say "PASS: $1 (=$3)"
  else
    say "FAIL: $1 (expected=$2 actual=$3)"
    FAILURES=$((FAILURES + 1))
  fi
}

kill_api() {
  # All nodemon processes under the tellus repo watch src/server.ts;
  # any of them can respawn a competing listener after a kill.
  pkill -9 -f "tsx src/server.ts" 2>/dev/null || true
  pkill -9 -f "tellus/node_modules" 2>/dev/null || true
  local i
  for i in $(seq 1 15); do
    [ -z "$(lsof -tiTCP:3000 -sTCP:LISTEN 2>/dev/null | head -1)" ] && return 0
    sleep 1
  done
  echo "WARN: port 3000 still bound after kill" | tee -a "$REPORT"
}

start_api() { # $1 = log suffix
  (nohup pnpm dev > "/tmp/tellus-api-$1.log" 2>&1 &)
  local i
  for i in $(seq 1 45); do
    if curl -s -m 2 -o /dev/null http://localhost:3000/api/v1/health; then
      say "API server healthy (log /tmp/tellus-api-$1.log)"
      return 0
    fi
    sleep 2
  done
  say "FAIL: API server did not become healthy ($1)"
  FAILURES=$((FAILURES + 1))
  return 1
}

wait_sql() { # $1 description, $2 timeout seconds, $3 query returning 't'
  local deadline=$(( $(date +%s) + $2 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ "$(psql_q "$3")" = "t" ]; then
      say "PASS: $1"
      return 0
    fi
    sleep 2
  done
  say "FAIL: $1 (timed out after ${2}s)"
  FAILURES=$((FAILURES + 1))
  return 1
}

cleanup() {
  [ -n "$AID" ] && $TS cleanup "$AID" >> "$REPORT" 2>&1 || true
  [ -n "$BID" ] && $TS cleanup "$BID" >> "$REPORT" 2>&1 || true
}
trap cleanup EXIT

say "=== Automate restart/recovery manual verification $(date -u) ==="

# ---------------------------------------------------------------------------
# Scenario 1: durable retry across a backend restart.
# Email channel against an unroutable EMAIL_PROVIDER_URL fails every
# attempt with a retryable 503. Retry delay 20s, max 3 attempts.
# ---------------------------------------------------------------------------
say "--- Scenario 1: retry survives backend restart ---"
kill_api
EMAIL_PROVIDER_URL="http://127.0.0.1:9/egress" start_api part1a || exit 1

AID=$($TS setup email "Manual Restart Retry" | tail -1 | jq -r .automationId)
say "automation A (email, retry x3, delay 20s): $AID"

wait_sql "attempt 1 failed, effect retrying" 90 \
  "SELECT EXISTS (
     SELECT 1 FROM automation_effect_execution e
     JOIN automation_trigger_event t USING (trigger_event_id)
     JOIN automation_effect_attempt a USING (effect_execution_id)
    WHERE t.automation_id = '$AID'
      AND e.status = 'retrying' AND a.attempt_number = 1
      AND a.status = 'failed' AND a.retryable = true)"

say "state after attempt 1:"; $TS state "$AID" | tee -a "$REPORT"

KILL_EPOCH=$(date +%s)
say "kill -9 API server during retry delay at $(date -u)"
kill_api
check "API port closed after kill" "" "$(lsof -tiTCP:3000 -sTCP:LISTEN 2>/dev/null | head -1)"

say "restart API server at $(date -u)"
EMAIL_PROVIDER_URL="http://127.0.0.1:9/egress" start_api part1b || exit 1

wait_sql "effect reached terminal exhausted state after restart" 240 \
  "SELECT EXISTS (
     SELECT 1 FROM automation_effect_execution e
     JOIN automation_trigger_event t USING (trigger_event_id)
    WHERE t.automation_id = '$AID' AND e.status = 'exhausted')"

check "all 3 attempts recorded" "3" "$(psql_q \
  "SELECT count(*) FROM automation_effect_attempt a
   JOIN automation_effect_execution e USING (effect_execution_id)
   JOIN automation_trigger_event t USING (trigger_event_id)
   WHERE t.automation_id = '$AID'")"
check "attempts 2 and 3 ran AFTER the kill (durable across restart)" "t" "$(psql_q \
  "SELECT bool_and(a.started_at > to_timestamp($KILL_EPOCH))
     FROM automation_effect_attempt a
     JOIN automation_effect_execution e USING (effect_execution_id)
     JOIN automation_trigger_event t USING (trigger_event_id)
    WHERE t.automation_id = '$AID' AND a.attempt_number >= 2")"
check "no effect left pending/retrying/claimed/running" "0" "$(psql_q \
  "SELECT count(*) FROM automation_effect_execution e
   JOIN automation_trigger_event t USING (trigger_event_id)
   WHERE t.automation_id = '$AID'
     AND e.status IN ('pending','retrying','claimed','running')")"
check "no effect notification delivered (all attempts failed)" "0" "$(psql_q \
  "SELECT count(*) FROM notification_inbox
   WHERE template_id = 'automate.plain'
     AND execution_id IN (
       SELECT e.effect_execution_id::text
         FROM automation_effect_execution e
         JOIN automation_trigger_event t USING (trigger_event_id)
        WHERE t.automation_id = '$AID')")"
check "owner received one effect-failure notification on exhaustion" "1" "$(psql_q \
  "SELECT count(*) FROM notification_inbox
   WHERE template_id = 'automate.effect-failure' AND channel = 'in_app'
     AND execution_id IN (
       SELECT e.effect_execution_id::text
         FROM automation_effect_execution e
         JOIN automation_trigger_event t USING (trigger_event_id)
        WHERE t.automation_id = '$AID')")"
say "final scenario-1 state:"; $TS state "$AID" | tee -a "$REPORT"

# ---------------------------------------------------------------------------
# Scenario 2: lease recovery after worker termination.
# An effect is left claimed by a dead worker with a live lease (the exact
# durable state a kill -9 leaves). A restarted worker must respect the
# lease until it expires, then recover and execute exactly once.
# ---------------------------------------------------------------------------
say "--- Scenario 2: lease recovery after worker termination ---"
kill_api
AUTOMATE_RUNTIME_DISABLED=true start_api part2a || exit 1

BID=$($TS setup in_app "Manual Lease Recovery" | tail -1 | jq -r .automationId)
if [ -z "$BID" ] || [ "$BID" = "null" ]; then
  say "FAIL: scenario-2 setup did not return an automation id"
  exit 1
fi
say "automation B (in_app): $BID"
$TS schedule | tee -a "$REPORT"
$TS craft-crash "$BID" 60 | tee -a "$REPORT"
LEASE_EXPIRES=$(psql_q \
  "SELECT extract(epoch FROM e.lease_expires_at)::bigint
     FROM automation_effect_execution e
     JOIN automation_trigger_event t USING (trigger_event_id)
    WHERE t.automation_id = '$BID'")
say "crash state crafted; lease expires at epoch $LEASE_EXPIRES"

kill_api
start_api part2b || exit 1

NOW_EPOCH=$(date +%s)
if [ "$NOW_EPOCH" -lt "$LEASE_EXPIRES" ]; then
  check "lease respected while live (effect still claimed)" "claimed" "$(psql_q \
    "SELECT e.status FROM automation_effect_execution e
     JOIN automation_trigger_event t USING (trigger_event_id)
     WHERE t.automation_id = '$BID'")"
else
  say "NOTE: lease expired before post-restart check (slow startup); skipping early check"
fi

wait_sql "recovered effect executed after lease expiry" 150 \
  "SELECT EXISTS (
     SELECT 1 FROM automation_effect_execution e
     JOIN automation_trigger_event t USING (trigger_event_id)
    WHERE t.automation_id = '$BID' AND e.status = 'succeeded')"

check "recovered effect ran exactly one attempt" "1" "$(psql_q \
  "SELECT e.attempt_count FROM automation_effect_execution e
   JOIN automation_trigger_event t USING (trigger_event_id)
   WHERE t.automation_id = '$BID'")"
check "attempt history has exactly one row" "1" "$(psql_q \
  "SELECT count(*) FROM automation_effect_attempt a
   JOIN automation_effect_execution e USING (effect_execution_id)
   JOIN automation_trigger_event t USING (trigger_event_id)
   WHERE t.automation_id = '$BID'")"
check "recovery happened after lease expiry" "t" "$(psql_q \
  "SELECT e.completed_at >= to_timestamp($LEASE_EXPIRES)
     FROM automation_effect_execution e
     JOIN automation_trigger_event t USING (trigger_event_id)
    WHERE t.automation_id = '$BID'")"
check "exactly one notification side effect (no duplicate delivery)" "1" "$(psql_q \
  "SELECT count(*) FROM notification_inbox
   WHERE execution_id IN (
     SELECT e.effect_execution_id::text
       FROM automation_effect_execution e
       JOIN automation_trigger_event t USING (trigger_event_id)
      WHERE t.automation_id = '$BID')")"
check "exactly one effect execution row (no duplicate planning)" "1" "$(psql_q \
  "SELECT count(*) FROM automation_effect_execution e
   JOIN automation_trigger_event t USING (trigger_event_id)
   WHERE t.automation_id = '$BID'")"
check "no effect left permanently claimed/running" "0" "$(psql_q \
  "SELECT count(*) FROM automation_effect_execution e
   JOIN automation_trigger_event t USING (trigger_event_id)
   WHERE t.automation_id = '$BID'
     AND e.status IN ('claimed','running','pending','retrying')")"
say "final scenario-2 state:"; $TS state "$BID" | tee -a "$REPORT"

# Restore the normal dev server.
kill_api
start_api normal || true

say "=== verification finished: $FAILURES failure(s) ==="
exit "$([ "$FAILURES" -eq 0 ] && echo 0 || echo 1)"
