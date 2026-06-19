#!/usr/bin/env bash
# ===========================================================================
# consolidate.sh — production consolidation: backup → batched merge → verify
# ===========================================================================
# The supported path for consolidating a LARGE / production multi-ontology
# database that migration 100's gate refuses to auto-merge. It:
#   1. Takes a timestamped pg_dump backup and ABORTS unless it succeeds.
#   2. Runs consolidate_single_ontology(BATCH) in autocommit so the large
#      tables are re-pointed in chunks (short locks, scales to millions).
#   3. Records migrations 099 + 100 in the ledger so the migrate runner
#      treats them as applied.
#   4. Verifies the single-ontology invariants; on failure, points at the backup.
#
# Usage:
#   bash scripts/single-ontology/consolidate.sh [DB_NAME] [BATCH_SIZE]
# Env:
#   TELLUS_PG_CONTAINER (default tellus-postgres-1), TELLUS_PG_USER (tellus),
#   BACKUP_DIR (default ./backups)
# ===========================================================================
set -euo pipefail

CONTAINER="${TELLUS_PG_CONTAINER:-tellus-postgres-1}"
PGUSER="${TELLUS_PG_USER:-tellus}"
DB="${1:-${TELLUS_PG_DB:-tellus_db}}"
BATCH="${2:-5000}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROC_SQL="$HERE/../../src/migrations/099_consolidate_procedure.sql"
BACKUP_DIR="${BACKUP_DIR:-$HERE/../../backups}"
STAMP="$(date +%Y%m%d-%H%M%S 2>/dev/null || echo manual)"
BACKUP="$BACKUP_DIR/${DB}-pre-consolidation-${STAMP}.sql"

q(){ docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$DB" -tAc "$1"; }

echo "── 1/5  Backing up '$DB' → $BACKUP ──"
mkdir -p "$BACKUP_DIR"
docker exec -i "$CONTAINER" sh -c "pg_dump -U $PGUSER -d $DB --no-owner --no-privileges" > "$BACKUP"
BYTES=$(wc -c < "$BACKUP" | tr -d ' ')
if [[ ! -s "$BACKUP" || "$BYTES" -lt 1000 ]]; then
  echo "❌ Backup failed or suspiciously small ($BYTES bytes). Aborting — no changes made."
  exit 1
fi
echo "   backup ok ($BYTES bytes)"

echo "── 2/5  Installing/refreshing consolidation procedure (099) ──"
docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$DB" -v ON_ERROR_STOP=1 < "$PROC_SQL" >/dev/null
echo "   procedure ready"

echo "── 3/5  Running batched consolidation (batch_size=$BATCH) ──"
BEFORE_ONT=$(q "SELECT count(*) FROM ontology;")
BEFORE_INST=$(q "SELECT count(*) FROM object_instances;")
echo "   before: ontologies=$BEFORE_ONT instances=$BEFORE_INST"
docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$DB" -v ON_ERROR_STOP=1 \
  -c "CALL consolidate_single_ontology($BATCH);"

echo "── 4/5  Recording migration ledger rows ──"
docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$DB" -c \
  "INSERT INTO schema_migrations_applied(migration_name, applied_at) VALUES
     ('099_consolidate_procedure.sql', now()),
     ('100_single_enterprise_ontology.sql', now())
   ON CONFLICT DO NOTHING;" >/dev/null

echo "── 5/5  Verifying invariants ──"
bash "$HERE/verify-invariants.sh" "$DB" --expect-instances "$BEFORE_INST"

echo "✅ Consolidated '$DB': $BEFORE_ONT ontologies → 1, $BEFORE_INST instances preserved."
echo "   Rollback if needed:  docker exec -i $CONTAINER psql -U $PGUSER -d $DB < $BACKUP"
