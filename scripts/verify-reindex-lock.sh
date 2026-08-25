#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-reindex-lock.sh — proves the Force Reindex mutex against real Postgres.
#
# claimIndexingLock (src/routes/reindex.ts) is one atomic
# INSERT ... ON CONFLICT DO UPDATE ... WHERE <predicate>. Its correctness is
# Postgres semantics, not TypeScript: the loser of a race must get ZERO rows
# back rather than an error, and a lock leaked by a crashed run must be
# stealable by force=true but NOT by a normal call. A mocked `query` can only
# check the parameters are shaped right, so this runs the statement verbatim.
#
# Scratch table, same shape minus the FK — never touches real funnel_state.
# Usage: bash scripts/verify-reindex-lock.sh
# ---------------------------------------------------------------------------
set -uo pipefail

PSQL="docker exec -i tellus-postgres-1 psql -U tellus -d tellus_db -tAq"
OT="00000000-0000-0000-0000-0000000000ff"
PASS=0; FAIL=0

check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; PASS=$((PASS+1));
  else echo "  FAIL  $1 (expected '$2', got '$3')"; FAIL=$((FAIL+1)); fi
}

# The predicate under test, verbatim from claimIndexingLock. $1 object_type_id,
# $2 allowStealStale, $3 stale interval.
CLAIM="INSERT INTO funnel_state_locktest (object_type_id, status, error_message, updated_at)
     VALUES (\$1, 'indexing', NULL, now())
     ON CONFLICT (object_type_id) DO UPDATE
       SET status = 'indexing', error_message = NULL, updated_at = now()
       WHERE funnel_state_locktest.status <> 'indexing'
          OR (\$2::boolean AND funnel_state_locktest.updated_at < now() - \$3::interval)
     RETURNING object_type_id"

claim() { # claim <force:true|false> [stale_seconds]
  local force="$1" secs="${2:-900}"
  $PSQL <<SQL | tr -d '[:space:]'
PREPARE c (uuid, boolean, interval) AS $CLAIM;
EXECUTE c ('$OT', $force, '$secs seconds');
SQL
}

rows() { $PSQL -c "SELECT count(*) FROM funnel_state_locktest WHERE object_type_id = '$OT';" | tr -d '[:space:]'; }
status_of() { $PSQL -c "SELECT status FROM funnel_state_locktest WHERE object_type_id = '$OT';" | tr -d '[:space:]'; }
reset() { $PSQL -c "DELETE FROM funnel_state_locktest WHERE object_type_id = '$OT';" >/dev/null; }
age_lock() { $PSQL -c "UPDATE funnel_state_locktest SET updated_at = now() - interval '$1' WHERE object_type_id = '$OT';" >/dev/null; }

echo "== setup: scratch table mirroring funnel_state (no FK) =="
$PSQL >/dev/null <<'SQL'
DROP TABLE IF EXISTS funnel_state_locktest;
CREATE TABLE funnel_state_locktest (
  funnel_state_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type_id  uuid NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'not_indexed'
                  CHECK (status = ANY (ARRAY['not_indexed','indexing','indexed','failed','stale','cancelled'])),
  error_message   text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
SQL

echo "== 1. first claim on a fresh object type inserts and wins =="
reset
check "claim returns the id" "$OT" "$(claim false)"
check "row created" "1" "$(rows)"
check "status is indexing" "indexing" "$(status_of)"

echo "== 2. second claim while the holder is live LOSES (zero rows, no error) =="
check "loser gets nothing" "" "$(claim false)"
check "still exactly one row" "1" "$(rows)"

echo "== 3. force cannot interrupt a LIVE run (heartbeat is fresh) =="
check "force loses against fresh lock" "" "$(claim true)"

echo "== 4. force STEALS a lock whose heartbeat has gone stale =="
age_lock "20 minutes"
check "force wins on stale lock" "$OT" "$(claim true 900)"
check "updated_at refreshed by the steal" "t" \
  "$($PSQL -c "SELECT updated_at > now() - interval '10 seconds' FROM funnel_state_locktest WHERE object_type_id='$OT';" | tr -d '[:space:]')"

echo "== 5. NON-force must never steal, however stale =="
age_lock "10 hours"
check "non-force loses on 10h-stale lock" "" "$(claim false)"
check "lock is still held" "indexing" "$(status_of)"

echo "== 6. a terminal status is re-claimable by both modes =="
for st in failed indexed not_indexed stale cancelled; do
  $PSQL -c "UPDATE funnel_state_locktest SET status='$st' WHERE object_type_id='$OT';" >/dev/null
  check "claim after status=$st" "$OT" "$(claim false)"
done

echo "== 7. releaseIndexingLock only clears a lock it still holds =="
$PSQL -c "UPDATE funnel_state_locktest SET status='indexing' WHERE object_type_id='$OT';" >/dev/null
$PSQL >/dev/null -c "UPDATE funnel_state_locktest SET status='failed', error_message='released', updated_at=now() WHERE object_type_id='$OT' AND status='indexing';"
check "release moves indexing -> failed" "failed" "$(status_of)"
# A run that DID start and wrote a terminal status must not be clobbered.
$PSQL -c "UPDATE funnel_state_locktest SET status='indexed', error_message=NULL WHERE object_type_id='$OT';" >/dev/null
$PSQL >/dev/null -c "UPDATE funnel_state_locktest SET status='failed', error_message='late release', updated_at=now() WHERE object_type_id='$OT' AND status='indexing';"
check "release cannot clobber status=indexed" "indexed" "$(status_of)"
check "and leaves error_message clean" "" \
  "$($PSQL -c "SELECT coalesce(error_message,'') FROM funnel_state_locktest WHERE object_type_id='$OT';" | tr -d '[:space:]')"

echo "== 8. TRUE concurrency: two overlapping transactions, exactly one winner =="
# Session A opens a txn, claims, and holds the row lock. Session B's claim must
# BLOCK on that row, then re-evaluate the predicate after A commits and lose.
reset
OUT_A=/tmp/lock-a.out; OUT_B=/tmp/lock-b.out
$PSQL > "$OUT_A" 2>&1 <<SQL &
BEGIN;
PREPARE c (uuid, boolean, interval) AS $CLAIM;
EXECUTE c ('$OT', false, '900 seconds');
SELECT pg_sleep(1.5);
COMMIT;
SQL
A_PID=$!
sleep 0.4
$PSQL > "$OUT_B" 2>&1 <<SQL &
PREPARE c (uuid, boolean, interval) AS $CLAIM;
EXECUTE c ('$OT', false, '900 seconds');
SQL
B_PID=$!
wait $A_PID; wait $B_PID
A_WON=$(grep -c "$OT" "$OUT_A"); B_WON=$(grep -c "$OT" "$OUT_B")
check "session A (first) won" "1" "$A_WON"
check "session B (blocked, then re-checked) lost" "0" "$B_WON"
check "no error raised in the loser" "0" "$(grep -ci 'error' "$OUT_B")"
check "exactly one row exists" "1" "$(rows)"

echo "== teardown =="
$PSQL -c "DROP TABLE IF EXISTS funnel_state_locktest;" >/dev/null
rm -f "$OUT_A" "$OUT_B"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
