#!/usr/bin/env bash
# ===========================================================================
# test-on-clone.sh — test the consolidation migration on a throwaway DB clone
# ===========================================================================
# Clones tellus_db into a scratch database, applies ONLY the
# 100_single_enterprise_ontology.sql migration (in a single transaction, the
# way the migrate runner does), then asserts the invariants AND that no object
# instances were lost. Drops the scratch DB at the end. The real database is
# never touched.
# ===========================================================================
set -euo pipefail

CONTAINER="${TELLUS_PG_CONTAINER:-tellus-postgres-1}"
PGUSER="${TELLUS_PG_USER:-tellus}"
SRC_DB="${TELLUS_PG_DB:-tellus_db}"
SCRATCH="tellus_so_scratch"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROC="$HERE/../../src/migrations/099_consolidate_procedure.sql"
MIGRATION="$HERE/../../src/migrations/100_single_enterprise_ontology.sql"

q()  { docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$1" -tAc "$2"; }
adm(){ docker exec -i "$CONTAINER" psql -U "$PGUSER" -d postgres -c "$1"; }

[[ -f "$MIGRATION" ]] || { echo "migration not found: $MIGRATION"; exit 1; }

echo "── Capturing pre-consolidation baseline from '$SRC_DB' ──"
BEFORE_ONT=$(q "$SRC_DB" "SELECT count(*) FROM ontology;")
BEFORE_INST=$(q "$SRC_DB" "SELECT count(*) FROM object_instances;")
BEFORE_OT=$(q "$SRC_DB" "SELECT count(*) FROM object_type;")
BEFORE_LT=$(q "$SRC_DB" "SELECT count(*) FROM link_type;")
echo "  ontologies=$BEFORE_ONT object_types=$BEFORE_OT link_types=$BEFORE_LT instances=$BEFORE_INST"

echo "── Cloning '$SRC_DB' → '$SCRATCH' (pg_dump | psql) ──"
adm "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null
adm "CREATE DATABASE $SCRATCH;" >/dev/null
docker exec -i "$CONTAINER" sh -c \
  "pg_dump -U $PGUSER -d $SRC_DB --no-owner --no-privileges | psql -U $PGUSER -d $SCRATCH -q" \
  >/dev/null

echo "── Applying consolidation procedure (099) ──"
docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$SCRATCH" -v ON_ERROR_STOP=1 < "$PROC" >/dev/null
echo "── Applying migration to clone (single transaction) ──"
docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$SCRATCH" -v ON_ERROR_STOP=1 \
  --single-transaction < "$MIGRATION"

echo "── Asserting invariants on clone ──"
bash "$HERE/verify-invariants.sh" "$SCRATCH" --expect-instances "$BEFORE_INST"

echo "── Re-running migration to prove idempotency ──"
docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$SCRATCH" -v ON_ERROR_STOP=1 \
  --single-transaction < "$MIGRATION"
bash "$HERE/verify-invariants.sh" "$SCRATCH" --expect-instances "$BEFORE_INST" >/dev/null \
  && echo "  idempotent re-run OK"

echo "── Dropping scratch DB ──"
adm "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null

echo "✅ Clone test passed: $BEFORE_ONT ontologies → 1, $BEFORE_INST instances preserved."
