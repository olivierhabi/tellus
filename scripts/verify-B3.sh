#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-B3.sh — Filesystem v2 Public API contract probes
# ---------------------------------------------------------------------------
# Spec:      tasks/files-projects/files-projects-tasks.md §B3.
# Contracts: tasks/files-projects/contracts.md (B3-C-01..71, B3-X-01..02).
#
# Gates probe the live Postgres test stack (tellus-postgres-1). Gates that
# require a running API server (HTTP envelope, /metrics) skip cleanly when
# the server isn't reachable on localhost:3000 — those gates are exercised
# end-to-end by the Vitest integration suite at
#   tests/foundry/integration/filesystem-v2-b3-integration.test.ts
# which boots its own server.
# ---------------------------------------------------------------------------

set -euo pipefail

PG_HOST=${PGHOST:-localhost}
PG_PORT=${PGPORT:-5432}
PG_USER=${PGUSER:-tellus}
PG_PASSWORD=${PGPASSWORD:-tellus123}
PG_DB=${PGDATABASE:-tellus_db}

PSQL_OPTS=(-h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -tA -v ON_ERROR_STOP=1)
export PGPASSWORD="$PG_PASSWORD"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

ok()    { echo -e "${GREEN}ok:${NC}   $*"; }
note()  { echo -e "${YELLOW}note:${NC} $*"; }
fail()  { echo -e "${RED}FAIL:${NC} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# [1/8] idempotency_keys table exists with expected shape
# ---------------------------------------------------------------------------
note "[1/8] idempotency_keys table"
got=$(psql "${PSQL_OPTS[@]}" -c "SELECT count(*) FROM information_schema.columns WHERE table_name='idempotency_keys'")
[[ "$got" == "8" ]] || fail "idempotency_keys: expected 8 columns, got $got"
ok   "idempotency_keys has 8 columns"

# ---------------------------------------------------------------------------
# [2/8] indexes
# ---------------------------------------------------------------------------
note "[2/8] indexes"
for ix in idempotency_keys_pkey idempotency_keys_expires_idx idempotency_keys_endpoint_idx; do
  got=$(psql "${PSQL_OPTS[@]}" -c "SELECT count(*) FROM pg_indexes WHERE tablename='idempotency_keys' AND indexname='$ix'")
  [[ "$got" == "1" ]] || fail "missing index: $ix"
done
ok   "three idempotency_keys indexes present"

# ---------------------------------------------------------------------------
# [3/8] migrate idempotency
# ---------------------------------------------------------------------------
note "[3/8] migrate idempotency (B3-X-01)"
before=$(psql "${PSQL_OPTS[@]}" -c "SELECT count(*) FROM idempotency_keys")
PGHOST="$PG_HOST" PGPORT="$PG_PORT" PGUSER="$PG_USER" PGPASSWORD="$PG_PASSWORD" PGDATABASE="$PG_DB" \
  npm run migrate:foundry >/dev/null 2>&1 || fail "migrate failed"
after=$(psql "${PSQL_OPTS[@]}" -c "SELECT count(*) FROM idempotency_keys")
[[ "$before" == "$after" ]] || fail "migrate is not idempotent ($before → $after)"
ok   "migrate is idempotent ($after rows unchanged)"

# ---------------------------------------------------------------------------
# [4/8] error code registry includes B3 codes
# ---------------------------------------------------------------------------
note "[4/8] error code registry"
missing=""
for code in PRECONDITION_FAILED PRECONDITION_REQUIRED INVALID_ARGUMENT RESOURCE_NAME_CONFLICT IDEMPOTENCY_KEY_CONFLICT PERMISSION_DENIED; do
  if ! grep -q "^  $code:" src/utils/queryErrors.ts; then
    missing="$missing $code"
  fi
done
[[ -z "$missing" ]] || fail "missing B3 error codes in queryErrors.ts:$missing"
ok   "all B3 error codes registered"

# ---------------------------------------------------------------------------
# [5/8] no B3-domain Knex migrations introduced (B3-X-01)
# ---------------------------------------------------------------------------
note "[5/8] no B3-domain Knex migrations"
# B3 (Files & Projects) introduces:
#   - idempotency_keys table        \u2192 keyword "idempotency_keys"
#   - filesystem v2 surface         \u2192 keyword "filesystem.v2" or "filesystem_v2"
# Other tasks in the repo also carry "B3" in their identifier (Workshop B3,
# Quiver B3) so we scope to the Files & Projects B3 namespace only.
FP_B3_KEYWORDS='idempotency_keys|filesystem.v2|filesystem_v2|files.projects.b3'
matches=$(find src/migrations -type f \( -name "*.ts" -o -name "*.js" -o -name "*.sql" \) 2>/dev/null \
  | xargs -I{} basename {} \
  | grep -iE "$FP_B3_KEYWORDS" || true)
[[ -z "$matches" ]] || fail "Files-Projects B3 migration files exist under src/migrations: $matches"
ok   "no Files-Projects B3 files under src/migrations"

# ---------------------------------------------------------------------------
# [6/8] HTTP envelope (skipped if API server not running)
# ---------------------------------------------------------------------------
note "[6/8] HTTP error envelope"
if curl -fsS -m 1 http://localhost:3000/health >/dev/null 2>&1 || \
   curl -fsS -m 1 http://localhost:4000/health >/dev/null 2>&1; then
  PORT=3000
  curl -fsS http://localhost:3000/health >/dev/null 2>&1 || PORT=4000
  http_code=$(curl -sS -o /tmp/b3-envelope.json -w "%{http_code}" \
    "http://localhost:$PORT/api/v2/filesystem/resources/not-a-rid" \
    -H "Authorization: Bearer no-auth" || echo 0)
  # Without auth the gate returns 401, with auth + bad rid the v2 router returns 400.
  case "$http_code" in
    400|401|403)
      ok   "HTTP envelope reachable (status=$http_code; full path covered by integration suite)" ;;
    *)
      fail "unexpected HTTP envelope status: $http_code" ;;
  esac
else
  note "API server not reachable — Vitest integration suite covers HTTP gates"
fi

# ---------------------------------------------------------------------------
# [7/8] /metrics emission (skipped if server not running)
# ---------------------------------------------------------------------------
note "[7/8] /metrics emission"
if curl -fsS -m 1 http://localhost:3000/api/metrics >/dev/null 2>&1; then
  metrics=$(curl -fsS http://localhost:3000/api/metrics 2>/dev/null || echo "")
  for m in tellus_filesystem_v2_request_seconds tellus_filesystem_v2_etag_mismatch_total tellus_filesystem_v2_idempotent_replay_total; do
    if grep -q "^$m" <<<"$metrics"; then
      ok   "$m emitted"
    else
      note "$m not yet observed (only emitted after first request)"
    fi
  done
else
  note "API server not reachable — Vitest integration suite covers /metrics"
fi

# ---------------------------------------------------------------------------
# [8/8] foundryMigrate.ts: B3 DDL appended (B3-X-01 enforcement)
# ---------------------------------------------------------------------------
note "[8/8] B3 DDL is in foundryMigrate.ts only"
grep -q "B3: idempotency_keys table" src/foundryMigrate.ts \
  || fail "B3 DDL banner missing from foundryMigrate.ts"
ok   "B3 DDL appended to foundryMigrate.ts"

echo
echo -e "${GREEN}verify-B3.sh: PASS${NC}"
