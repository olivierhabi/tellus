#!/usr/bin/env bash
# ===========================================================================
# Run ALL E2E Test Suites (Monday through Sunday)
#
# This script:
#   1. Kills any running server on port 3000
#   2. Restarts the server with RATE_LIMIT_MAX=10000 to avoid rate-limit
#      interference across suites
#   3. Re-seeds the database (idempotent) so tests have predictable state
#   4. Runs each day's E2E suite sequentially
#   5. Stops the server on exit
#
# Usage:
#   pnpm run test:e2e
#   bash tests/e2e/run-all.sh
# ===========================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

# ---------------------------------------------------------------------------
# Restart server with elevated rate limit
# ---------------------------------------------------------------------------
echo -e "${BOLD}Restarting server with RATE_LIMIT_MAX=10000 ...${NC}"
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
sleep 1

export DATA_DIR="${DATA_DIR:-${ROOT}/data}"
RATE_LIMIT_MAX=10000 DATA_DIR="$DATA_DIR" nohup npx tsx "${ROOT}/src/server.ts" > /tmp/tellus-e2e-server.log 2>/tmp/tellus-e2e-server-err.log &
SERVER_PID=$!

# Ensure server is killed on script exit
cleanup() {
  echo ""
  echo -e "${BOLD}Stopping server (PID ${SERVER_PID}) ...${NC}"
  kill "$SERVER_PID" 2>/dev/null || true
  # Also kill anything left on port 3000
  lsof -ti:3000 | xargs kill -9 2>/dev/null || true
}
trap cleanup EXIT

# Wait for server to be ready
echo -n "Waiting for server..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:3000/health" >/dev/null 2>&1; then
    echo " ready (PID ${SERVER_PID})."
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo " TIMEOUT."
    echo "Server log:"
    tail -20 /tmp/tellus-e2e-server.log
    exit 1
  fi
  sleep 1
  echo -n "."
done

echo ""

# ---------------------------------------------------------------------------
# Re-seed the database so that tests have a clean, predictable state.
# The seed scripts are idempotent (delete-then-recreate).
# ---------------------------------------------------------------------------
echo -e "${BOLD}Running migrations ...${NC}"
npx tsx "${ROOT}/src/migrate.ts" > /tmp/tellus-migrate.log 2>&1 || {
  echo -e "${RED}Migration failed. Log:${NC}"
  tail -20 /tmp/tellus-migrate.log
  exit 1
}
echo "  Migrations complete."

echo -e "${BOLD}Re-seeding database ...${NC}"
DATA_DIR=/tmp/ontology-testdata npx tsx "${ROOT}/src/seed.ts" > /tmp/tellus-seed.log 2>&1 || {
  echo -e "${RED}Seed failed. Log:${NC}"
  tail -20 /tmp/tellus-seed.log
  exit 1
}
echo "  Base seed complete."

DATA_DIR=/tmp/ontology-testdata npx tsx "${ROOT}/src/seeds/actionTypes.seed.ts" > /tmp/tellus-action-seed.log 2>&1 || {
  echo -e "${RED}Action types seed failed. Log:${NC}"
  tail -20 /tmp/tellus-action-seed.log
  exit 1
}
echo "  Action types seed complete."
echo ""

# ---------------------------------------------------------------------------
# Run each day's E2E suite
# ---------------------------------------------------------------------------
DAYS=(monday tuesday wednesday thursday friday saturday sunday coverage)
EXIT_CODE=0

for day in "${DAYS[@]}"; do
  SUITE="${ROOT}/tests/${day}/e2e/suite.sh"
  if [[ ! -f "$SUITE" ]]; then
    echo -e "${RED}SKIP${NC}  ${day} — suite.sh not found"
    continue
  fi

  echo -e "${BOLD}========================================${NC}"
  echo -e "${BOLD}  Running ${day} E2E suite${NC}"
  echo -e "${BOLD}========================================${NC}"

  if bash "$SUITE"; then
    echo -e "${GREEN}${BOLD}${day}: PASS${NC}"
  else
    echo -e "${RED}${BOLD}${day}: FAIL${NC}"
    EXIT_CODE=1
  fi

  echo ""
done

# ---------------------------------------------------------------------------
# Final summary
# ---------------------------------------------------------------------------
echo -e "${BOLD}========================================${NC}"
if [[ $EXIT_CODE -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}ALL E2E SUITES PASSED${NC}"
else
  echo -e "${RED}${BOLD}SOME E2E SUITES FAILED${NC}"
  echo ""
  echo -e "${BOLD}Server 500 errors:${NC}"
  grep -i '"statusCode":500\|"status":500\|Error\|error.*500\|INTERNAL\|stack.*at ' /tmp/tellus-e2e-server.log 2>/dev/null | head -30 || true
  echo ""
  echo -e "${BOLD}Server log (first batch create attempt):${NC}"
  grep -A2 'batch\|500' /tmp/tellus-e2e-server.log 2>/dev/null | head -40 || true
  echo ""
  echo -e "${BOLD}Server stderr:${NC}"
  cat /tmp/tellus-e2e-server-err.log 2>/dev/null | head -50 || true
fi
echo -e "${BOLD}========================================${NC}"

exit $EXIT_CODE
