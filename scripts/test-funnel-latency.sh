#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# B6 latency SLO test — validates the "P99 < 500ms for typical filter+sort
# queries" acceptance criterion from tasks/ontology tasks.md.
#
# How it works:
#   1. Bootstrap a test object_type.
#   2. Seed N edits via direct PG insert (simulates Action writeback).
#   3. Drive them through the Funnel (signal + scheduler drain).
#   4. Wait for the merged snapshot to commit.
#   5. Run M search queries against /api/v1/objects/:type/search.
#   6. Compute P50 / P95 / P99 from the measured latencies.
#   7. Fail if P99 > 500ms.
#
# Default shape: 1,000 edits, 200 query probes. Override with:
#   N_EDITS=10000 N_QUERIES=1000 bash scripts/test-funnel-latency.sh
#
# This is a smoke-scale test — not 1B rows. It catches regressions where
# the hot path adds orders-of-magnitude overhead (a router bug, the
# overlay missing an index, N+1 queries in /search, etc.). The full
# 1B-row load test belongs in a staging environment where S3 is the
# warehouse and Quickwit hydration has warm caches.
# ---------------------------------------------------------------------------
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
PG_USER="${PGUSER:-tellus}"
PG_PASS="${PGPASSWORD:-tellus123}"
PG_DB="${PGDATABASE:-tellus_db}"
N_EDITS="${N_EDITS:-1000}"
N_QUERIES="${N_QUERIES:-200}"
P99_BUDGET_MS="${P99_BUDGET_MS:-500}"

OT_API_NAME="FunnelLatency$(date +%s | tail -c 5)"

log()  { printf '\033[36m[latency]\033[0m %s\n' "$*"; }
pass() { printf '\033[32m[ok]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

psql_q() { PGPASSWORD="$PG_PASS" docker exec -i tellus-db psql -U "$PG_USER" -d "$PG_DB" -t -A -c "$1"; }

curl -fsS "$BASE_URL/health" >/dev/null || fail "server not reachable"

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
log "seed ontology + object_type=$OT_API_NAME"
ONT_DISPLAY="FunnelLatency-$(date +%s)"
psql_q "INSERT INTO ontology (display_name, description) VALUES ('$ONT_DISPLAY','latency-test') ON CONFLICT DO NOTHING" >/dev/null
ONT_ID=$(psql_q "SELECT ontology_id FROM ontology WHERE display_name='$ONT_DISPLAY'" | tail -1)
[[ -n "$ONT_ID" ]] || fail "ontology bootstrap failed"
psql_q "INSERT INTO object_type (ontology_id, api_name, display_name) VALUES ('$ONT_ID','$OT_API_NAME','latency') ON CONFLICT DO NOTHING" >/dev/null
OT_ID=$(psql_q "SELECT object_type_id FROM object_type WHERE api_name='$OT_API_NAME'" | tail -1)
# Register 'status' + 'amount' properties so the search validator
# accepts the filter below. Minimal Palantir-parity shape.
psql_q "INSERT INTO property (object_type_id, api_name, display_name, base_type, is_required) VALUES ('$OT_ID','status','status','string',false), ('$OT_ID','amount','amount','integer',false), ('$OT_ID','primary_key','primary_key','string',true) ON CONFLICT DO NOTHING" >/dev/null

log "seed $N_EDITS ontology_edit rows"
# Build the VALUES list in a single psql call — orders of magnitude faster
# than N round-trips.
SEED_SQL=$(python3 -c "
n = $N_EDITS
ont = '$ONT_ID'
ot  = '$OT_API_NAME'
parts = []
for i in range(n):
    status = 'ACTIVE' if i % 4 != 0 else 'INACTIVE'
    parts.append(
        f\"('{ont}','{ot}','PK-{i:06d}','create',\"
        f\"'{{\\\"status\\\":\\\"{status}\\\",\\\"amount\\\":{i}}}'::jsonb,\"
        f\"'user_edit_wins')\"
    )
print('INSERT INTO ontology_edit (ontology_id, object_type_api_name, primary_key, operation, property_values, edit_strategy) VALUES ' + ','.join(parts))
")
printf '%s\n' "$SEED_SQL" | PGPASSWORD="$PG_PASS" docker exec -i tellus-db psql -U "$PG_USER" -d "$PG_DB" -q >/dev/null
pass "seeded $N_EDITS edits"

# ---------------------------------------------------------------------------
# Drive the Funnel
# ---------------------------------------------------------------------------
log "signal editBatchPending → drain"
curl -fsS -X POST "$BASE_URL/api/v1/funnel/signals" \
  -H 'content-type: application/json' \
  --data "{\"ontologyId\":\"$ONT_ID\",\"objectTypeApiName\":\"$OT_API_NAME\",\"signalType\":\"editBatchPending\"}" >/dev/null
curl -fsS -X POST "$BASE_URL/api/v1/funnel/drain" \
  -H 'content-type: application/json' \
  --data "{\"objectTypes\":[\"$OT_API_NAME\"]}" >/dev/null

log "wait for merged snapshot"
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  MERGED=$(psql_q "SELECT count(*) FROM object_instances WHERE object_type_api_name='$OT_API_NAME'")
  if [[ "$MERGED" -ge "$N_EDITS" ]]; then break; fi
  sleep 2
done
[[ "$MERGED" -ge "$N_EDITS" ]] || fail "merge didn't complete within 60s ($MERGED / $N_EDITS)"
pass "merged $MERGED rows into object_instances"

# ---------------------------------------------------------------------------
# Probe latencies
# ---------------------------------------------------------------------------
log "running $N_QUERIES /search probes (filter + pageSize=50)"
LATENCIES_FILE=$(mktemp)
# Each probe is a filter equality + pageSize. We include a warm-up of
# 10 queries to let Node's JIT settle; those are excluded from the
# histogram.
WARMUP=10
for i in $(seq 1 $((N_QUERIES + WARMUP))); do
  STATUS=$(( i % 2 == 0 ? 0 : 1 ))
  VAL=$([ $STATUS = 0 ] && echo ACTIVE || echo INACTIVE)
  T_START=$(python3 -c 'import time;print(int(time.time()*1000))')
  curl -fsS -o /dev/null -X POST "$BASE_URL/api/v1/objects/$OT_API_NAME/search" \
    -H 'content-type: application/json' \
    --data "{\"filter\":[{\"property\":\"status\",\"operator\":\"eq\",\"value\":\"$VAL\"}],\"\$pageSize\":50}"
  T_END=$(python3 -c 'import time;print(int(time.time()*1000))')
  if [[ $i -gt $WARMUP ]]; then
    echo "$((T_END - T_START))" >> "$LATENCIES_FILE"
  fi
done

# Compute percentiles.
STATS=$(python3 -c "
import sys, statistics
lats = sorted(int(x) for x in open('$LATENCIES_FILE'))
n = len(lats)
if n == 0:
    print('count=0 p50=0 p95=0 p99=0 max=0')
    sys.exit(0)
def pct(p):
    k = max(0, min(n-1, int(round((p/100.0)*(n-1)))))
    return lats[k]
print(f'count={n} p50={pct(50)} p95={pct(95)} p99={pct(99)} max={lats[-1]} mean={int(statistics.mean(lats))}')
")
log "latency: $STATS"

P99=$(printf '%s' "$STATS" | awk -F'p99=' '{print $2}' | awk '{print $1}')
if [[ -z "$P99" ]]; then fail "could not parse p99"; fi

if [[ "$P99" -gt "$P99_BUDGET_MS" ]]; then
  fail "B6 SLO violation: P99=${P99}ms > budget ${P99_BUDGET_MS}ms"
fi
pass "B6 P99=${P99}ms ≤ budget ${P99_BUDGET_MS}ms"

rm -f "$LATENCIES_FILE"

log ""
log "================================================================"
log "B6 latency SLO PASSED"
log "================================================================"
log "object_type   = $OT_API_NAME"
log "edits seeded  = $N_EDITS"
log "queries run   = $N_QUERIES (+ $WARMUP warm-up)"
log "$STATS"
log "budget        = ${P99_BUDGET_MS}ms"
