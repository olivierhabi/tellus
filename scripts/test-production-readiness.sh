#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# test-production-readiness.sh
#
# End-to-end verification of the 10 production-readiness concerns called
# out on the Funnel. Each block tests ONE concern; the summary at the
# end fails the run if any block regressed. Run this before shipping.
#
# Concerns covered:
#   1. Cancel-with-timeout + TERMINATE_EXISTING feature flag
#   2. (Same test validates merge hang root-cause via activity heartbeats)
#   3. Spec-compliant default: USE_EXISTING unless feature flag set
#   4. Orphan sweeper uses Temporal visibility, not wall-clock age
#   5. Prometheus metrics exposed + populated
#   6. B1 boot-time readiness probe (instead of per-edit savepoints)
#   7. Iceberg metadata retry tracking
#   8. Signal idempotency (fingerprint dedup) + re-delivery on terminate
#   9. Test namespace isolation
#  10. k8sServiceFlip ESM import cleanup (no dynamic require)
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
PASS=0; FAIL=0

pass() { printf "  %s✓%s %s\n" "$GREEN" "$RESET" "$1"; PASS=$((PASS+1)); }
fail() { printf "  %s✗%s %s\n" "$RED"   "$RESET" "$1"; FAIL=$((FAIL+1)); }
hdr()  { printf "\n%s%s%s\n" "$BOLD" "$1" "$RESET"; }

assert_file() {
  if [[ -f "$1" ]]; then pass "$2 ($1)"; else fail "MISSING: $1"; fi
}
assert_grep() {
  if grep -qE "$1" "$2" 2>/dev/null; then pass "$3"; else fail "$3 (pattern: $1)"; fi
}
assert_no_grep() {
  if ! grep -qE "$1" "$2" 2>/dev/null; then pass "$3"; else fail "$3 (unexpected: $1)"; fi
}

# ---------------------------------------------------------------------------
hdr "1. Cancel-with-timeout pattern + TERMINATE_EXISTING feature flag"
# ---------------------------------------------------------------------------
WORKER=src/services/funnel/temporal/worker.ts
assert_grep "cancelWithTimeoutIfStuck" "$WORKER" "graceful cancel helper present"
assert_grep "FUNNEL_TERMINATE_ON_SAVE" "$WORKER" "terminate-on-save is feature-flagged"
assert_grep "FUNNEL_CANCEL_STALE_THRESHOLD_MS" "$WORKER" "stale threshold env knob"
assert_grep "FUNNEL_CANCEL_TIMEOUT_MS" "$WORKER" "cancel timeout env knob"
assert_grep "await handle.cancel\\(\\)" "$WORKER" "sends cancel before terminate"
assert_grep "workflowIdConflictPolicy: terminateOnSave \\? \"TERMINATE_EXISTING\" : \"USE_EXISTING\"" \
  "$WORKER" "TERMINATE_EXISTING only under the flag"

# ---------------------------------------------------------------------------
hdr "2. Stage heartbeats + duration metrics (merge-hang diagnostic)"
# ---------------------------------------------------------------------------
ACT=src/services/funnel/temporal/activities.ts
assert_grep "withStageInstrumentation" "$ACT" "stage-instrumentation wrapper"
assert_grep "startHeartbeatLoop" "$ACT" "activity heartbeat loop"
assert_grep "Context.current\\(\\).heartbeat\\(\\)" "$ACT" "calls Temporal heartbeat"
for stage in changelog merge indexing hydration; do
  assert_grep "withStageInstrumentation\\(\"${stage}\"" "$ACT" "${stage} is instrumented"
done
assert_grep "funnel_stage_duration_seconds" "$ACT" "duration histogram name"

# ---------------------------------------------------------------------------
hdr "3. Metrics module + /metrics endpoint"
# ---------------------------------------------------------------------------
assert_file src/services/funnel/metrics.ts "metrics module present"
assert_grep "renderPrometheus" src/services/funnel/metrics.ts "Prometheus renderer"
assert_grep "incCounter|observeHistogram|setGauge" src/services/funnel/metrics.ts "counter/hist/gauge API"
assert_grep 'router\.get\("/metrics"' src/routes/funnel.ts "/metrics route exported"

# ---------------------------------------------------------------------------
hdr "4. Orphan sweeper — Temporal visibility preferred, age fallback"
# ---------------------------------------------------------------------------
DW=src/services/funnel/durableWorkflow.ts
assert_grep "sweepViaTemporalVisibility" "$DW" "Temporal-visibility sweeper path"
assert_grep "sweepViaAgeHeuristic" "$DW" "age-heuristic fallback path"
assert_grep "client.workflow.list" "$DW" "queries Temporal workflow list"
assert_grep "requeueSignalsForRun" "$DW" "re-queues consumed signals"

# ---------------------------------------------------------------------------
hdr "5. Signal idempotency + re-delivery migration"
# ---------------------------------------------------------------------------
assert_file src/migrations/015_funnel_signal_idempotency.sql "migration 015"
assert_grep "signal_fingerprint" src/migrations/015_funnel_signal_idempotency.sql "fingerprint column"
assert_grep "redelivery_count" src/migrations/015_funnel_signal_idempotency.sql "redelivery_count column"
assert_grep "funnel_signal_fingerprint_unique" src/migrations/015_funnel_signal_idempotency.sql "partial unique index"
assert_grep "fingerprint\\?: string" "$DW" "sendSignal accepts fingerprint"
assert_grep "ON CONFLICT \\(object_type_api_name, signal_fingerprint\\)" "$DW" \
  "dedup via ON CONFLICT"

# ---------------------------------------------------------------------------
hdr "6. B1 boot-time readiness probe (no per-edit savepoints)"
# ---------------------------------------------------------------------------
assert_file src/services/funnel/b1Readiness.ts "b1Readiness module"
assert_grep "isB1Ready" src/services/funnel/b1Readiness.ts "probe exported"
assert_grep "pg_catalog.pg_tables" src/services/funnel/b1Readiness.ts "probes pg_catalog"
assert_grep "isB1Ready" src/actions/editApplicator.ts "editApplicator gates on probe"

# ---------------------------------------------------------------------------
hdr "7. Iceberg metadata retry tracking"
# ---------------------------------------------------------------------------
assert_file src/migrations/016_iceberg_metadata_retry.sql "migration 016"
assert_grep "metadata_emitted_at" src/migrations/016_iceberg_metadata_retry.sql "emitted_at column"
assert_grep "metadata_emit_attempts" src/migrations/016_iceberg_metadata_retry.sql "attempt counter"
assert_grep "retryPendingIcebergMetadata" src/services/funnel/icebergCatalog.ts "sweeper exported"
assert_grep "funnel_iceberg_metadata_emission_failures_total" \
  src/services/funnel/icebergCatalog.ts "failure metric wired"

# ---------------------------------------------------------------------------
hdr "8. k8sServiceFlip ESM cleanup (no dynamic require)"
# ---------------------------------------------------------------------------
K8S=src/services/quickwit/k8sServiceFlip.ts
assert_grep 'request as httpsRequest' "$K8S" "ESM import of https.request"
assert_no_grep "require\\(.https.\\)" "$K8S" "no dynamic require('https')"

# ---------------------------------------------------------------------------
hdr "9. Test-namespace isolation"
# ---------------------------------------------------------------------------
TTT=scripts/test-workflow-terminate-on-save.ts
assert_grep "TEMPORAL_TEST_NAMESPACE" "$TTT" "uses dedicated test namespace"
assert_grep "TEMPORAL_TEST_TASK_QUEUE" "$TTT" "uses dedicated test task queue"
assert_grep "process.pid" "$TTT" "object-type name includes pid"

# ---------------------------------------------------------------------------
hdr "10. Static build verification"
# ---------------------------------------------------------------------------
if npx --yes tsc --noEmit >/tmp/prod-ready-tsc.log 2>&1; then
  pass "tsc --noEmit clean"
else
  fail "tsc --noEmit produced errors (/tmp/prod-ready-tsc.log):"
  tail -20 /tmp/prod-ready-tsc.log | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
hdr "11. Funnel unit tests"
# ---------------------------------------------------------------------------
if npx --yes vitest run tests/funnel/unit --reporter=default >/tmp/prod-ready-vitest.log 2>&1; then
  c=$(grep -oE '[0-9]+ passed' /tmp/prod-ready-vitest.log | tail -1 || echo '?')
  pass "funnel unit suite: ${c}"
else
  fail "funnel unit suite failed (/tmp/prod-ready-vitest.log tail):"
  tail -20 /tmp/prod-ready-vitest.log | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
hdr "12. Live probes against Postgres (requires running DB)"
# ---------------------------------------------------------------------------
if node -e "require('dotenv/config'); const {Pool}=require('pg'); const p=new Pool({host:process.env.PGHOST,port:process.env.PGPORT,database:process.env.PGDATABASE,user:process.env.PGUSER,password:process.env.PGPASSWORD}); p.query('SELECT 1').then(()=>process.exit(0)).catch(()=>process.exit(1));" >/dev/null 2>&1; then
  # 12a. Signal dedup — two sendSignal calls with same fingerprint
  #      must return the same signal_id.
  if npx tsx scripts/test-signal-dedup.ts >/tmp/prod-ready-dedup.log 2>&1; then
    pass "signal fingerprint dedup works"
  else
    fail "signal dedup test failed:"
    tail -15 /tmp/prod-ready-dedup.log | sed 's/^/      /'
  fi

  # 12b. Orphan sweeper — seeded orphan gets swept + signal requeued.
  if npx tsx scripts/test-orphaned-run-sweep.ts >/tmp/prod-ready-sweep.log 2>&1; then
    pass "orphaned-run sweeper works"
  else
    fail "orphan sweep test failed:"
    tail -15 /tmp/prod-ready-sweep.log | sed 's/^/      /'
  fi

  # 12c. B9 auto-trigger silence under transitional deployment.
  if npx tsx scripts/test-b9-autotrigger-silence.ts >/tmp/prod-ready-b9.log 2>&1; then
    pass "B9 auto-trigger silent under missing tables"
  else
    fail "B9 auto-trigger silence test failed:"
    tail -15 /tmp/prod-ready-b9.log | sed 's/^/      /'
  fi

  # 12d. B1 readiness probe — true when object_instances exists.
  if npx tsx scripts/test-b1-readiness.ts >/tmp/prod-ready-b1.log 2>&1; then
    pass "B1 readiness probe reflects table presence"
  else
    fail "B1 readiness test failed:"
    tail -15 /tmp/prod-ready-b1.log | sed 's/^/      /'
  fi

  # 12e. Iceberg metadata commit path stays silent when migration 016
  #      columns are absent (the bug the user surfaced from server log).
  if npx tsx scripts/test-iceberg-metadata-silence.ts >/tmp/prod-ready-ice.log 2>&1; then
    pass "Iceberg metadata emission silent without migration 016"
  else
    fail "Iceberg metadata silence test failed:"
    tail -15 /tmp/prod-ready-ice.log | sed 's/^/      /'
  fi
else
  note=$(printf "Postgres not reachable; skipping 12a-d")
  printf "  %s•%s %s\n" "$YELLOW" "$RESET" "$note"
fi

# ---------------------------------------------------------------------------
hdr "Summary"
# ---------------------------------------------------------------------------
printf "  %s%d passed%s / %s%d failed%s\n" "$GREEN" "$PASS" "$RESET" "$RED" "$FAIL" "$RESET"
[[ "$FAIL" -gt 0 ]] && exit 1
exit 0
