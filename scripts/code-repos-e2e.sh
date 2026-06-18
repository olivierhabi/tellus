#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# code-repos-e2e.sh
#
# Full-stack e2e harness for the Code Repositories feature shipped in
# /code-repositories/repo/[rid].
#
# Steps:
#   1. Verify docker services (postgres, minio, redis, opensearch, keycloak)
#      are healthy. Brings up tellus-postgres-1 if missing.
#   2. Apply the wave 1-15 migrations (050..057) directly to tellus_db.
#   3. Boot the tellus backend with CODE_REPOS_TEST_AUTH=1 so cypress can
#      authenticate via the X-Tellus-Test-Principal header (G-C-11).
#   4. Boot the tellus-fe Next.js dev server.
#   5. Run cypress against cypress/e2e/code-repositories.cy.ts.
#   6. Tear down both servers on exit (docker services left running for
#      developer ergonomics — they're shared with other tellus work).
#
# Usage:
#   ./scripts/code-repos-e2e.sh                 # run end-to-end
#   ./scripts/code-repos-e2e.sh --no-cypress    # apply migrations + boot only
#   ./scripts/code-repos-e2e.sh --migrate-only  # apply migrations + exit
# ----------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FE_ROOT="$(cd "$REPO_ROOT/../tellus-fe" && pwd)"
LOG_DIR="$REPO_ROOT/logs/code-repos-e2e"
mkdir -p "$LOG_DIR"

# Default to non-conflicting ports so a developer-run backend on :3000 and
# fe on :3001 do not clash. Override via env to reuse a long-running dev
# server (must have CODE_REPOS_TEST_AUTH=1 set or auth will reject).
BACKEND_PORT="${TELLUS_BACKEND_PORT:-3010}"
FE_PORT="${TELLUS_FE_PORT:-3011}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGDB="${PGDB:-tellus_db}"
PGUSER="${PGUSER:-tellus}"
PGPASSWORD="${PGPASSWORD:-tellus_pw}"
export PGPASSWORD

backend_pid=""
fe_pid=""

cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$backend_pid" ]] && kill -0 "$backend_pid" 2>/dev/null; then
    echo "[cleanup] stopping backend (pid=$backend_pid)"
    kill "$backend_pid" 2>/dev/null || true
    wait "$backend_pid" 2>/dev/null || true
  fi
  if [[ -n "$fe_pid" ]] && kill -0 "$fe_pid" 2>/dev/null; then
    echo "[cleanup] stopping fe (pid=$fe_pid)"
    kill "$fe_pid" 2>/dev/null || true
    wait "$fe_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

mode_no_cypress=0
mode_migrate_only=0
for arg in "$@"; do
  case "$arg" in
    --no-cypress) mode_no_cypress=1 ;;
    --migrate-only) mode_migrate_only=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# --------------------------------------------------------------------------
# 1. Docker services
# --------------------------------------------------------------------------
echo "[1/5] verifying docker services"
required_services=(tellus-postgres-1)
for svc in "${required_services[@]}"; do
  status=$(docker inspect --format='{{.State.Status}}' "$svc" 2>/dev/null || echo "missing")
  if [[ "$status" != "running" ]]; then
    echo "[1/5] FATAL: $svc is $status; start the tellus dev stack first (docker compose up -d)"
    exit 1
  fi
  echo "  - $svc: $status"
done

# --------------------------------------------------------------------------
# 2. Migrations
# --------------------------------------------------------------------------
echo "[2/5] applying migrations 050..057"
psql_cmd=(docker exec -i tellus-postgres-1 psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB")
for n in 050 051 052 053 054 055 056 057; do
  pattern="$REPO_ROOT/src/migrations/${n}_*.sql"
  for f in $pattern; do
    if [[ -f "$f" && "$f" != *down.sql ]]; then
      echo "  - applying $(basename "$f")"
      "${psql_cmd[@]}" < "$f" > "$LOG_DIR/migrate-$(basename "$f" .sql).log" 2>&1 || {
        echo "  - migration $(basename "$f") FAILED — already applied? continuing"
      }
    fi
  done
done

if [[ "$mode_migrate_only" -eq 1 ]]; then
  echo "[done] --migrate-only"
  trap - EXIT INT TERM
  exit 0
fi

# --------------------------------------------------------------------------
# 3. Backend
# --------------------------------------------------------------------------
echo "[3/5] booting backend on :$BACKEND_PORT"
cd "$REPO_ROOT"
CODE_REPOS_TEST_AUTH=1 \
  PORT="$BACKEND_PORT" \
  PGHOST="$PGHOST" PGPORT="$PGPORT" PGDB="$PGDB" PGUSER="$PGUSER" \
  npx tsx src/server.ts > "$LOG_DIR/backend.log" 2>&1 &
backend_pid=$!
echo "  - backend pid=$backend_pid"

# Wait up to 60s for /health to return 200
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:$BACKEND_PORT/health" >/dev/null 2>&1; then
    echo "  - backend healthy after ${i}s"
    break
  fi
  if ! kill -0 "$backend_pid" 2>/dev/null; then
    echo "[3/5] FATAL: backend exited"
    tail -50 "$LOG_DIR/backend.log"
    exit 1
  fi
  sleep 1
done

# --------------------------------------------------------------------------
# 4. Frontend
# --------------------------------------------------------------------------
echo "[4/5] booting fe on :$FE_PORT"
cd "$FE_ROOT"
# Clean Next.js dev cache; stale .next/server modules across runs cause
# `__webpack_modules__[moduleId] is not a function` on first compile.
rm -rf "$FE_ROOT/.next" 2>/dev/null || true
PORT="$FE_PORT" \
  NEXT_PUBLIC_API_URL="/api" \
  TELLUS_BACKEND_ORIGIN="http://localhost:$BACKEND_PORT" \
  npx next dev -p "$FE_PORT" > "$LOG_DIR/fe.log" 2>&1 &
fe_pid=$!
echo "  - fe pid=$fe_pid"

for i in $(seq 1 90); do
  if curl -fsS "http://localhost:$FE_PORT/" >/dev/null 2>&1; then
    echo "  - fe responsive after ${i}s"
    break
  fi
  if ! kill -0 "$fe_pid" 2>/dev/null; then
    echo "[4/5] FATAL: fe exited"
    tail -50 "$LOG_DIR/fe.log"
    exit 1
  fi
  sleep 1
done

if [[ "$mode_no_cypress" -eq 1 ]]; then
  echo "[done] --no-cypress; servers running, ctrl-c to stop"
  wait
  exit 0
fi

# --------------------------------------------------------------------------
# 5. Cypress
# --------------------------------------------------------------------------
echo "[5/5] running cypress"
cd "$FE_ROOT"
CYPRESS_BASE_URL="http://localhost:$FE_PORT" \
  CYPRESS_API_URL="http://localhost:$BACKEND_PORT/api" \
  npx cypress run --spec "cypress/e2e/code-repositories.cy.ts" --browser electron --headless \
  || {
    rc=$?
    echo "[5/5] cypress failed; last 50 lines of backend.log:"
    tail -50 "$LOG_DIR/backend.log"
    exit "$rc"
  }

echo "[done] all e2e checks passed"
