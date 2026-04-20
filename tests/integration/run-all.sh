#!/usr/bin/env bash
# ===========================================================================
# Run ALL Integration Test Suites (Monday through Friday)
#
# This script:
#   1. Kills any running server on port 3000
#   2. Restarts the server with elevated rate limits to avoid interference
#   3. Runs each day's integration suite sequentially via vitest
#   4. For Tuesday's rate-limiter test, restarts with default rate limits
#   5. Stops the server on exit
#
# Usage:
#   pnpm run test:integration
#   bash tests/integration/run-all.sh
# ===========================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

SERVER_PID=""

# ---------------------------------------------------------------------------
# Server management helpers
# ---------------------------------------------------------------------------

kill_server() {
  lsof -ti:3000 | xargs kill -9 2>/dev/null || true
  SERVER_PID=""
}

start_server() {
  local label="$1"
  shift
  echo -e "${BOLD}Starting server ($label) ...${NC}"
  kill_server
  sleep 1

  env "$@" nohup npx tsx "${ROOT}/src/server.ts" > /tmp/tellus-integration-server.log 2>&1 &
  SERVER_PID=$!

  echo -n "Waiting for server..."
  for i in $(seq 1 30); do
    if curl -sf "http://localhost:3000/health" >/dev/null 2>&1; then
      # Also verify DB connectivity by checking ontologies endpoint
      if curl -sf "http://localhost:3000/api/v1/ontology" | grep -q "ontologyId" 2>/dev/null; then
        echo " ready (PID ${SERVER_PID})."
        return 0
      fi
    fi
    if [[ $i -eq 30 ]]; then
      echo " TIMEOUT."
      echo "Server log:"
      tail -20 /tmp/tellus-integration-server.log
      return 1
    fi
    sleep 1
    echo -n "."
  done
}

# Ensure server is killed on script exit
cleanup() {
  echo ""
  echo -e "${BOLD}Stopping server ...${NC}"
  kill_server
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Run a vitest suite and track result
# ---------------------------------------------------------------------------

EXIT_CODE=0

run_vitest() {
  local label="$1"
  local dir="$2"

  echo -e "${BOLD}========================================${NC}"
  echo -e "${BOLD}  Running ${label} integration suite${NC}"
  echo -e "${BOLD}========================================${NC}"

  if npx vitest run "$dir" 2>&1; then
    echo -e "${GREEN}${BOLD}${label}: PASS${NC}"
  else
    echo -e "${RED}${BOLD}${label}: FAIL${NC}"
    EXIT_CODE=1
  fi
  echo ""
}

# ---------------------------------------------------------------------------
# Phase 1: Start server with elevated rate limits
#
# This lets Monday, Wednesday, Thursday, Friday run without hitting
# the action-specific rate limiter (100/min default).
# ---------------------------------------------------------------------------

start_server "elevated rate limits" \
  RATE_LIMIT_MAX=10000 \
  ACTION_RATE_LIMIT_MAX=10000 \
  USER_RATE_LIMIT_MAX=50000 \
  GLOBAL_ACTION_RATE_LIMIT_MAX=100000 \
  BATCH_RATE_LIMIT_MAX=1000

echo ""

# ---------------------------------------------------------------------------
# Run non-Tuesday suites with elevated rate limits
# ---------------------------------------------------------------------------

DAYS_NO_TUESDAY=(monday wednesday thursday friday)

for day in "${DAYS_NO_TUESDAY[@]}"; do
  ACTION_RATE_LIMIT_MAX=10000 run_vitest "$day" "${ROOT}/tests/${day}/integration"
done

# ---------------------------------------------------------------------------
# Phase 2: Tuesday integration tests
#
# Tuesday has a rate-limiter integration test that deliberately exhausts
# the per-action-type limit (100/min). We need to:
#   a) Run rate-limiter test with DEFAULT action rate limits
#   b) Run all other Tuesday tests with elevated rate limits
#
# Strategy: run the rate-limiter test FIRST with default limits, then
# restart the server with elevated limits for the remaining tests.
# ---------------------------------------------------------------------------

echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}  Running tuesday integration suite${NC}"
echo -e "${BOLD}========================================${NC}"

# Phase 2a: rate-limiter test with default limits
# Explicitly set ACTION_RATE_LIMIT_MAX=100 and BATCH_RATE_LIMIT_MAX=10 to ensure
# default behavior even on CI where the workflow sets elevated global values.
start_server "default rate limits for rate-limiter test" \
  RATE_LIMIT_MAX=10000 \
  ACTION_RATE_LIMIT_MAX=100 \
  BATCH_RATE_LIMIT_MAX=10

echo -e "${YELLOW}  Phase 2a: rate-limiter integration test (default action limits)${NC}"
if npx vitest run "${ROOT}/tests/tuesday/integration/rate-limiter-integration.test.ts" 2>&1; then
  echo -e "${GREEN}${BOLD}  rate-limiter: PASS${NC}"
else
  echo -e "${RED}${BOLD}  rate-limiter: FAIL${NC}"
  EXIT_CODE=1
fi

# Phase 2b: remaining Tuesday tests with elevated limits
start_server "elevated rate limits for remaining Tuesday tests" \
  RATE_LIMIT_MAX=10000 \
  ACTION_RATE_LIMIT_MAX=10000 \
  USER_RATE_LIMIT_MAX=50000 \
  GLOBAL_ACTION_RATE_LIMIT_MAX=100000 \
  BATCH_RATE_LIMIT_MAX=1000

echo -e "${YELLOW}  Phase 2b: remaining Tuesday integration tests${NC}"

# Run all Tuesday integration tests EXCEPT rate-limiter
TUESDAY_FILES=(
  "${ROOT}/tests/tuesday/integration/tuesday-integration.test.ts"
  "${ROOT}/tests/tuesday/integration/seed-action-types-integration.test.ts"
  "${ROOT}/tests/tuesday/integration/error-standardization-integration.test.ts"
  "${ROOT}/tests/tuesday/integration/batch-actions-integration.test.ts"
  "${ROOT}/tests/tuesday/integration/action-validate-integration.test.ts"
  "${ROOT}/tests/tuesday/integration/action-clone-integration.test.ts"
  "${ROOT}/tests/tuesday/integration/action-impact-integration.test.ts"
  "${ROOT}/tests/tuesday/integration/optimistic-concurrency-integration.test.ts"
  "${ROOT}/tests/tuesday/integration/idempotency-integration.test.ts"
  "${ROOT}/tests/tuesday/integration/multi-rule-actions-integration.test.ts"
  "${ROOT}/tests/tuesday/integration/schema-migration-integration.test.ts"
  "${ROOT}/tests/tuesday/integration/openapi-spec-integration.test.ts"
)

if npx vitest run "${TUESDAY_FILES[@]}" 2>&1; then
  echo -e "${GREEN}${BOLD}  tuesday (remaining): PASS${NC}"
else
  echo -e "${RED}${BOLD}  tuesday (remaining): FAIL${NC}"
  EXIT_CODE=1
fi

echo -e "${BOLD}========================================${NC}"
if [[ $EXIT_CODE -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}tuesday: PASS${NC}"
else
  echo -e "${RED}${BOLD}tuesday: FAIL (or partial)${NC}"
fi
echo ""

# ---------------------------------------------------------------------------
# Phase 3: Non-day-keyed funnel integration tests
#
# The Funnel work (tasks B1–B10) spans several days of the plan, so its
# tests live under tests/funnel/ rather than a weekday folder. These
# tests talk to Postgres directly via the shared `query` helper — the
# already-running server isn't required for this subsuite, but starting
# one first doesn't hurt either.
# ---------------------------------------------------------------------------
run_vitest "funnel" "${ROOT}/tests/funnel/integration"

# ---------------------------------------------------------------------------
# Phase 4: Pipeline Builder / Funnel Hardening / Link Types integration
#
# PB-B1..B10 + FNL-H + LT-B integration tests live under tests/foundry/
# alongside the funnel unit tests. They talk to Lakekeeper + MinIO +
# Temporal + the PyIceberg sidecar; the shared env is already up from
# Phase 1's server restart, so vitest is run against the same pod.
# Running after `funnel` keeps the two Iceberg-adjacent suites
# sequential so they don't race for Lakekeeper warehouses.
# ---------------------------------------------------------------------------
run_vitest "foundry (pb-b + fnl-h + lt-b)" "${ROOT}/tests/foundry/integration"

# ---------------------------------------------------------------------------
# Final summary
# ---------------------------------------------------------------------------
echo -e "${BOLD}========================================${NC}"
if [[ $EXIT_CODE -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}ALL INTEGRATION SUITES PASSED${NC}"
else
  echo -e "${RED}${BOLD}SOME INTEGRATION SUITES FAILED${NC}"
fi
echo -e "${BOLD}========================================${NC}"

exit $EXIT_CODE
