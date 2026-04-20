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
npx tsx "${ROOT}/src/foundryMigrate.ts" >> /tmp/tellus-migrate.log 2>&1 || {
  echo -e "${RED}Foundry migration failed. Log:${NC}"
  tail -20 /tmp/tellus-migrate.log
  exit 1
}
npx tsx "${ROOT}/src/migrateAuth.ts" >> /tmp/tellus-migrate.log 2>&1 || {
  echo -e "${RED}Auth migration failed. Log:${NC}"
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
# `funnel` is appended LAST intentionally — its suite restarts the
# backend to toggle `FUNNEL_STAGE_DELAY_MS` for pacing tests, so it
# must come after anything that depends on the initial long-lived
# server instance above.
DAYS=(monday tuesday wednesday thursday friday saturday sunday coverage funnel)
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
# PB-B / FNL-H / LT-B E2E suites
#
# These run against the same long-lived server started above. Order:
#   1. Consolidated endpoint-coverage E2E (60 asserts / 39 endpoints).
#   2. Per-task curl smokes (test-pb-b1..b10) — each owns its fixture
#      bootstrap + teardown so they can run back-to-back.
#   3. Chaos scripts — docker stop/start containers; run last so a flaky
#      underlying dep doesn't poison earlier suites.
#   4. Observability stack verification (OTel Collector + Prometheus +
#      Grafana end-to-end). Opt-in via OBSERVABILITY_STACK_UP=1 since it
#      requires `docker compose -f docker-compose-files/monitoring.docker-compose.yml up`.
# ---------------------------------------------------------------------------
run_pb_script() {
  local label="$1"
  local script="$2"
  shift 2
  if [[ ! -x "$script" && ! -f "$script" ]]; then
    echo -e "${RED}SKIP${NC}  ${label} — ${script} not found"
    return 0
  fi
  echo -e "${BOLD}========================================${NC}"
  echo -e "${BOLD}  Running ${label}${NC}"
  echo -e "${BOLD}========================================${NC}"
  if bash "$script" "$@"; then
    echo -e "${GREEN}${BOLD}${label}: PASS${NC}"
  else
    echo -e "${RED}${BOLD}${label}: FAIL${NC}"
    EXIT_CODE=1
  fi
  echo ""
}

# Helper: skip a script when a required dependency (docker container,
# external service) is not reachable. Keeps local dev green without
# forcing CI to stand up the full docker-compose stack.
pb_dep_available() {
  local kind="$1"; local target="$2"
  case "${kind}" in
    container)
      docker inspect "${target}" >/dev/null 2>&1
      ;;
    http)
      curl -sf -m 2 "${target}" >/dev/null 2>&1
      ;;
    *)
      return 1
      ;;
  esac
}

skip() {
  echo -e "${BOLD}SKIP${NC}  $1"
  echo ""
}

# 1. Consolidated endpoint E2E covering all 39 created/modified endpoints.
# Runs against the same long-lived server above — no extra deps.
run_pb_script "pb-all-endpoints-e2e" "${ROOT}/scripts/test-pb-all-endpoints-e2e.sh"

# 2. Per-task smokes. Most hit only the API + keycloak, but six of them
# (b1, b6, b7, b8, b10) use `docker exec tellus-db psql ...` for direct
# DB assertions, and b4 requires a reachable Lakekeeper. In CI the DB
# runs as a GitHub Actions service container (no `tellus-db` name), and
# Lakekeeper isn't provisioned — so we skip those smokes when the
# dependency isn't reachable rather than failing the whole suite.
PB_DB_CONTAINER="${PG_CONTAINER:-tellus-db}"
PB_LAKEKEEPER_URL="${LAKEKEEPER_URL:-http://localhost:8181}"

PB_SMOKES_NO_DEP=(
  "test-pb-b2-duckdb-engine.sh"
  "test-pb-b3-output-format.sh"
  "test-pb-b5-streaming.sh"
  "test-pb-b9-observability.sh"
)
PB_SMOKES_NEED_DB_CONTAINER=(
  "test-pb-b1-supervised-deploys.sh"
  "test-pb-b6-preview-pinning.sh"
  "test-pb-b7-rbac.sh"
  "test-pb-b8-lineage.sh"
  "test-pb-b10-schema-evolution.sh"
)
PB_SMOKES_NEED_LAKEKEEPER=(
  "test-pb-b4-iceberg.sh"
)

for smoke in "${PB_SMOKES_NO_DEP[@]}"; do
  run_pb_script "pb-smoke: ${smoke}" "${ROOT}/scripts/${smoke}"
done

if pb_dep_available container "${PB_DB_CONTAINER}"; then
  for smoke in "${PB_SMOKES_NEED_DB_CONTAINER[@]}"; do
    run_pb_script "pb-smoke: ${smoke}" "${ROOT}/scripts/${smoke}"
  done
else
  for smoke in "${PB_SMOKES_NEED_DB_CONTAINER[@]}"; do
    skip "pb-smoke: ${smoke} — docker container '${PB_DB_CONTAINER}' not available (set PG_CONTAINER or run locally)"
  done
fi

if pb_dep_available http "${PB_LAKEKEEPER_URL}/management/v1/info"; then
  for smoke in "${PB_SMOKES_NEED_LAKEKEEPER[@]}"; do
    run_pb_script "pb-smoke: ${smoke}" "${ROOT}/scripts/${smoke}"
  done
else
  for smoke in "${PB_SMOKES_NEED_LAKEKEEPER[@]}"; do
    skip "pb-smoke: ${smoke} — Lakekeeper not reachable at ${PB_LAKEKEEPER_URL} (set LAKEKEEPER_URL or bring it up)"
  done
fi

# 3. Chaos suite — each script docker stops/starts one dep. In CI the
# deps don't run as docker containers so the whole set is opt-in via
# PB_CHAOS=1 (set locally when running against docker-compose-files/).
CHAOS_SCRIPTS=(
  "test-pb-b9-db-kill-chaos.sh"
  "test-pb-b9-lakekeeper-kill-chaos.sh"
  "test-pb-b9-minio-kill-chaos.sh"
  "test-pb-b9-temporal-kill-chaos.sh"
)
if [[ "${PB_CHAOS:-0}" == "1" ]] && pb_dep_available container "${PB_DB_CONTAINER}"; then
  for chaos in "${CHAOS_SCRIPTS[@]}"; do
    run_pb_script "pb-chaos: ${chaos}" "${ROOT}/scripts/${chaos}"
  done
else
  for chaos in "${CHAOS_SCRIPTS[@]}"; do
    skip "pb-chaos: ${chaos} — requires docker containers (set PB_CHAOS=1 to run)"
  done
fi

# 4. Observability stack verification — opt-in because it requires the
# monitoring docker-compose to be up (OTel Collector + Prometheus +
# Grafana). CI sets OBSERVABILITY_STACK_UP=1 on the observability job.
if [[ "${OBSERVABILITY_STACK_UP:-0}" == "1" ]]; then
  run_pb_script "pb-observability-stack" "${ROOT}/scripts/verify-pb-b9-observability-stack.sh"
else
  echo -e "${BOLD}SKIP${NC}  pb-observability-stack (set OBSERVABILITY_STACK_UP=1 to run)"
fi

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
