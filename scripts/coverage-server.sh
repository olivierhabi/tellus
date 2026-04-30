#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# F-12 / F-P2-02 — Critical-path branch coverage (unit + server).
#
# Runs the full vitest suite with COVERAGE_COLLECT_SERVER=1 so
# tests/globalSetup.ts sets NODE_V8_COVERAGE on the spawned server process.
# After vitest exits, c8 reports against those profiles to produce branch
# coverage for server-executed modules (editApplicator, actionExecutor,
# queryExecutor, branchMergeService, linkViolationEnforcer, route handlers)
# — the critical paths named in the remediation brief's Phase A exit gate.
#
# Vitest's own coverage-v8 provider uses `inspector.takePreciseCoverage` on
# the worker V8 isolate and cannot see the subprocess. Running both
# collectors in the same invocation gives us:
#   coverage/             — vitest (unit coverage, in-worker modules)
#   coverage/server/      — c8 (integration coverage, spawned-server modules)
#
# Both artifacts are used together to evaluate the ≥80% branch-coverage
# gate per critical-path module.
#
# ---------------------------------------------------------------------------
# F-P2-02 fix (this session):
#   The original script used `set -euo pipefail` and would halt the instant
#   vitest exited non-zero — which happens whenever any integration test
#   fails (flaky docker service, absent Keycloak user, etc.). That meant a
#   single red test left the c8 report un-generated and the critical-path
#   coverage numbers unknowable, which is the opposite of what the gate
#   should do. It also meant the worker-profile directory filled but the
#   summary file was never written, so the coverage-gate.yml workflow saw
#   an empty report and emitted a confusing "no coverage" failure instead
#   of the real vitest failure.
#
#   The rewrite below:
#     * Separates the vitest exit code from the c8 report step — vitest
#       failures are captured in $VITEST_EXIT and surfaced at the end of
#       the script but do not short-circuit the report.
#     * Runs c8 on whatever server profiles were flushed (even a partial
#       run gives useful critical-path coverage).
#     * Also surfaces the vitest coverage artifacts that the
#       coverage-v8 provider writes to ./coverage for in-worker modules.
#     * Exits with the vitest exit code so CI still fails on test
#       regressions — but with the coverage report on disk for review.
#     * Supports a UNIT_ONLY=1 override so Block H's coverage ratchet
#       can pin on the deterministic unit suite without waiting on the
#       docker-backed integration half (CI uses the split in the
#       coverage-gate workflow).
# ---------------------------------------------------------------------------

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE_DIR="$ROOT/coverage/server-profiles"
REPORT_DIR="$ROOT/coverage/server"
UNIT_CONFIG="$ROOT/vitest.unit.config.ts"

rm -rf "$PROFILE_DIR" "$REPORT_DIR"
mkdir -p "$PROFILE_DIR"

if [[ "${UNIT_ONLY:-0}" == "1" ]]; then
  echo "[coverage-server] UNIT_ONLY=1 — running unit vitest config only (server profiles will be empty)."
  # Force json-summary + explicit reportsDirectory so the gate script (and
  # local tooling) can read coverage/coverage-summary.json without caring
  # about vitest.unit.config.ts's default reportsDirectory.
  pnpm exec vitest run --coverage \
    --config "$UNIT_CONFIG" \
    --coverage.reporter=json-summary \
    --coverage.reporter=text \
    --coverage.reporter=text-summary \
    --coverage.reporter=lcov \
    --coverage.reporter=json \
    --coverage.reportsDirectory=coverage
  VITEST_EXIT=$?
else
  echo "[coverage-server] Running full vitest suite with server-side v8 profiling..."
  COVERAGE_COLLECT_SERVER=1 pnpm exec vitest run --coverage
  VITEST_EXIT=$?
fi

echo
echo "[coverage-server] vitest exit code: $VITEST_EXIT"
echo "[coverage-server] v8 profiles captured: $(ls -1 "$PROFILE_DIR" 2>/dev/null | wc -l | tr -d ' ')"

if ls "$PROFILE_DIR"/coverage-*.json >/dev/null 2>&1; then
  echo
  echo "[coverage-server] Generating c8 report for critical-path modules..."
  pnpm exec c8 report \
    --temp-directory="$PROFILE_DIR" \
    --reports-dir="$REPORT_DIR" \
    --reporter=text \
    --reporter=text-summary \
    --reporter=lcov \
    --reporter=json-summary \
    --include='src/actions/**/*.ts' \
    --include='src/services/queryExecutor.ts' \
    --include='src/services/branchMergeService.ts' \
    --include='src/services/linkViolationEnforcer.ts' \
    --include='src/services/linkResolverService.ts' \
    --include='src/services/auditEventService.ts' \
    --include='src/services/security/**/*.ts' \
    --include='src/services/opensearch/client.ts' \
    --include='src/middleware/globalAuth.ts' \
    --include='src/middleware/keycloakAuth.ts' \
    --include='src/middleware/securityContext.ts' \
    --include='src/middleware/patSecurityGate.ts' \
    --include='src/middleware/rateLimiter.ts' \
    --include='src/middleware/errorHandler.ts' \
    --include='src/routes/objects.ts' \
    --include='src/routes/actions.ts' \
    --include='src/routes/links.ts' \
    --include='src/routes/search.ts' \
    --include='src/routes/ontology.ts' \
    --include='src/routes/audit.ts' \
    --exclude='**/*.d.ts' || {
    echo "[coverage-server] WARN: c8 report exited non-zero (partial profiles); continuing." >&2
  }
  echo "[coverage-server] Critical-path report: $REPORT_DIR/lcov.info"
  echo "[coverage-server] Summary:              $REPORT_DIR/coverage-summary.json"
else
  echo "[coverage-server] NOTE: no server profiles written in $PROFILE_DIR." >&2
  echo "[coverage-server]       Expected when UNIT_ONLY=1, or when the server subprocess never started." >&2
  echo "[coverage-server]       Critical-path report will be built from vitest worker coverage only." >&2
fi

echo
for candidate in "$ROOT/coverage/coverage-summary.json" "$ROOT/coverage/unit/coverage-summary.json"; do
  if [[ -f "$candidate" ]]; then
    echo "[coverage-server] Vitest worker coverage summary: $candidate"
  fi
done
if [[ ! -f "$ROOT/coverage/coverage-summary.json" && ! -f "$ROOT/coverage/unit/coverage-summary.json" ]]; then
  echo "[coverage-server] NOTE: no vitest worker coverage summary file found (neither coverage/ nor coverage/unit/)." >&2
fi

if [[ "$VITEST_EXIT" != "0" ]]; then
  echo "[coverage-server] vitest reported failures (exit $VITEST_EXIT); coverage artifacts still written." >&2
fi

exit "$VITEST_EXIT"
