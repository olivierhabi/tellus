#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/workshop-fullstack-test.sh
# ---------------------------------------------------------------------------
# Drive the entire Workshop test stack against Docker services:
#
#   1. docker compose up postgres + kafka + opensearch (existing services).
#   2. Wait for each container's healthcheck to report healthy.
#   3. Run Postgres migrations (058..060) into the live database.
#   4. Run vitest unit + integration + chaos suites against the live PG.
#   5. Optionally start the BE on :3000 and run Cypress workshop spec.
#   6. Tear down on exit (--keep-up to skip).
#
# Usage:
#   scripts/workshop-fullstack-test.sh                    # full stack
#   scripts/workshop-fullstack-test.sh --no-cypress       # skip cypress
#   scripts/workshop-fullstack-test.sh --keep-up          # don't tear down
#   scripts/workshop-fullstack-test.sh --only=unit        # only unit
# ---------------------------------------------------------------------------

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FE_ROOT="$(cd "${REPO_ROOT}/../tellus-fe" && pwd)"

KEEP_UP=0
RUN_CYPRESS=1
ONLY=""
for arg in "$@"; do
  case "$arg" in
    --keep-up) KEEP_UP=1 ;;
    --no-cypress) RUN_CYPRESS=0 ;;
    --only=*) ONLY="${arg#--only=}" ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

COMPOSE_FILE="${REPO_ROOT}/docker-compose.yml"
log()  { printf '\033[1;36m[fullstack]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[fullstack]\033[0m %s\n' "$*" >&2; exit 1; }

BE_PID=""
cleanup() {
  if [[ -n "$BE_PID" ]]; then
    log "stopping BE pid=$BE_PID"
    kill -TERM "$BE_PID" 2>/dev/null || true
    wait "$BE_PID" 2>/dev/null || true
  fi
  if [[ "$KEEP_UP" -eq 1 ]]; then
    log "skip docker teardown (--keep-up)"
    return
  fi
  log "tearing down docker services..."
  (cd "$REPO_ROOT" && docker compose -f "$COMPOSE_FILE" down -v --remove-orphans) || true
}
trap cleanup EXIT

# 1. Bring up dependencies.
if [[ -z "$ONLY" || "$ONLY" == "stack" || "$ONLY" == "all" ]]; then
  log "starting docker services (postgres only — workshop tests don't need kafka/opensearch)..."
  (cd "$REPO_ROOT" && docker compose -f "$COMPOSE_FILE" up -d postgres)

  log "waiting for postgres healthcheck..."
  for i in {1..60}; do
    if docker compose -f "$COMPOSE_FILE" ps postgres --format '{{.State}} {{.Status}}' | grep -q "healthy"; then
      log "postgres healthy"
      break
    fi
    [[ $i -eq 60 ]] && fail "postgres not healthy after 120s"
    sleep 2
  done
fi

# 2. Apply workshop migrations via the postgres container's own psql.
log "applying Workshop migrations 058..060 via docker exec..."
PG_CONTAINER="$(docker compose -f "$COMPOSE_FILE" ps -q postgres)"
[[ -z "$PG_CONTAINER" ]] && fail "postgres container not found"
for mig in 058_b1_workshop_module.sql 059_b1_workshop_idempotency.sql 060_b3_workshop_module_version.sql; do
  docker exec -i "$PG_CONTAINER" psql -U "${PGUSER:-tellus}" -d "${PGDATABASE:-tellus_db}" \
    -v ON_ERROR_STOP=1 < "${REPO_ROOT}/src/migrations/${mig}" >/dev/null \
    || log "(migration ${mig} likely already applied — continuing)"
done
log "migrations applied"

# 3. Vitest suites.
cd "$REPO_ROOT"
if [[ -z "$ONLY" || "$ONLY" == "unit" || "$ONLY" == "all" ]]; then
  log "running BE unit suite..."
  npx vitest run --config vitest.unit.config.ts tests/unit/workshop
fi
if [[ -z "$ONLY" || "$ONLY" == "integration" || "$ONLY" == "all" ]]; then
  log "running BE integration suite..."
  npx vitest run --config vitest.config.ts tests/integration/workshop \
    --testTimeout=30000 --hookTimeout=30000 --no-file-parallelism
fi
if [[ -z "$ONLY" || "$ONLY" == "chaos" || "$ONLY" == "all" ]]; then
  log "running BE chaos suite..."
  npx vitest run --config vitest.config.ts tests/chaos/workshop \
    --testTimeout=30000 --hookTimeout=30000 --no-file-parallelism
fi
if [[ -z "$ONLY" || "$ONLY" == "load" || "$ONLY" == "all" ]]; then
  log "running in-process SLO load runner (real Postgres, real router)..."
  npx tsx tests/load/in-process-load-runner.ts
fi

# 4. Cypress (requires the BE on :3000).
if [[ "$RUN_CYPRESS" -eq 1 && ( -z "$ONLY" || "$ONLY" == "cypress" || "$ONLY" == "all" ) ]]; then
  if [[ ! -d "$FE_ROOT" ]]; then
    log "tellus-fe not found at $FE_ROOT — skipping cypress"
  else
    log "starting BE on :3000 in background..."
    cd "$REPO_ROOT"
    nohup npm run dev > /tmp/workshop-be.log 2>&1 &
    BE_PID=$!
    log "BE pid=$BE_PID — waiting for /health..."
    for i in {1..60}; do
      if curl -fsS "http://localhost:3000/health" >/dev/null 2>&1; then
        log "BE up"
        break
      fi
      [[ $i -eq 60 ]] && { log "see /tmp/workshop-be.log"; fail "BE did not come up in 120s"; }
      sleep 2
    done

    log "bootstrapping Keycloak test users (idempotent)..."
    (cd "$REPO_ROOT" && npm run auth:bootstrap > /tmp/workshop-kc.log 2>&1) \
      || log "(auth:bootstrap exited non-zero — see /tmp/workshop-kc.log; continuing)"

    log "running Cypress workshop specs..."
    (cd "$FE_ROOT" && CYPRESS_API_URL="http://localhost:3000/api" \
      npx cypress run \
        --spec "cypress/e2e/workshop-orders-inbox.cy.ts,cypress/e2e/workshop-view-mode.cy.ts,cypress/e2e/workshop-seeded-data.cy.ts")

    log "stopping BE..."
    kill -TERM "$BE_PID" 2>/dev/null || true
    wait "$BE_PID" 2>/dev/null || true
  fi
fi

log "done — full stack tests passed"
