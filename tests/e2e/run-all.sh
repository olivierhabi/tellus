#!/usr/bin/env bash
# ===========================================================================
# Run ALL E2E Test Suites (Monday through Friday)
#
# This script:
#   1. Kills any running server on port 3000
#   2. Restarts the server with RATE_LIMIT_MAX=10000 to avoid rate-limit
#      interference across suites
#   3. Runs each day's E2E suite sequentially
#   4. Stops the server on exit
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

RATE_LIMIT_MAX=10000 nohup npx tsx "${ROOT}/src/server.ts" > /tmp/tellus-e2e-server.log 2>&1 &
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
# Run each day's E2E suite
# ---------------------------------------------------------------------------
DAYS=(monday tuesday wednesday thursday friday)
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
fi
echo -e "${BOLD}========================================${NC}"

exit $EXIT_CODE
