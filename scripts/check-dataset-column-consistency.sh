#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# check-dataset-column-consistency.sh
#
# CI / runbook invariant: assert that every `foundry_datasets` row with a
# non-null `column_count` has exactly that many rows in `dataset_columns`.
#
# Why we run this
# ---------------
# Two surfaces in the Pipeline Builder read from these two tables:
#   - Dataset node card        → foundry_datasets.column_count
#   - Transform / Cast panel   → SELECT … FROM dataset_columns
# When they diverge the UI silently shows two different numbers for the
# same dataset and downstream transforms operate on a partial schema.
# This script catches the drift loudly. Wire it into the nightly
# scheduled CI pipeline alongside the chaos suite.
#
# Recovery for any divergence flagged here:
#   pnpm tsx scripts/backfill-dataset-columns.ts
#
# Exit codes
#   0 — fully consistent
#   1 — at least one divergent dataset (table printed to stderr)
#   2 — environment / connection failure (cannot evaluate)
#
# Env vars (with sensible defaults so this just runs against the local
# docker compose stack):
#   PG_CONTAINER  docker container name (default: tellus-postgres-1)
#   DB_USER       postgres role         (default: tellus)
#   DB_NAME       database              (default: tellus_db)
#   PGPASSWORD    password              (required — no default)
# ---------------------------------------------------------------------------
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-tellus-postgres-1}"
DB_USER="${DB_USER:-tellus}"
DB_NAME="${DB_NAME:-tellus_db}"
: "${PGPASSWORD:?PGPASSWORD env var is required}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found in PATH" >&2
  exit 2
fi

if ! docker exec "$PG_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
  echo "postgres container $PG_CONTAINER is not reachable / not ready" >&2
  exit 2
fi

psql_cmd() {
  docker exec -e PGPASSWORD="$PGPASSWORD" "$PG_CONTAINER" \
    psql -U "$DB_USER" -d "$DB_NAME" -P pager=off -At "$@"
}

# Count divergent rows. Plain-text output so we can decide cheaply.
DIVERGENT=$(psql_cmd -c "
  SELECT count(*) FROM foundry_datasets fd
  WHERE fd.column_count IS NOT NULL
    AND fd.column_count <> (
      SELECT count(*) FROM dataset_columns dc WHERE dc.dataset_id = fd.id
    );
" 2>&1) || {
  echo "psql query failed: $DIVERGENT" >&2
  exit 2
}

if [[ "$DIVERGENT" -eq 0 ]]; then
  echo "OK — every foundry_datasets.column_count matches its dataset_columns row count."
  exit 0
fi

echo "FAIL: $DIVERGENT dataset(s) have foundry_datasets.column_count != count(dataset_columns)" >&2
docker exec -e PGPASSWORD="$PGPASSWORD" "$PG_CONTAINER" \
  psql -U "$DB_USER" -d "$DB_NAME" -P pager=off -c "
    SELECT
      fd.id,
      fd.original_filename,
      fd.column_count AS meta_count,
      (SELECT count(*) FROM dataset_columns dc WHERE dc.dataset_id = fd.id) AS actual_count,
      fd.status,
      fd.updated_at
    FROM foundry_datasets fd
    WHERE fd.column_count IS NOT NULL
      AND fd.column_count <> (
        SELECT count(*) FROM dataset_columns dc WHERE dc.dataset_id = fd.id
      )
    ORDER BY fd.updated_at DESC;
  " >&2

echo "" >&2
echo "Recovery: pnpm tsx scripts/backfill-dataset-columns.ts" >&2
exit 1
