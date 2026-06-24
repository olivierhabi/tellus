#!/usr/bin/env bash
# ===========================================================================
# apply-to-db.sh — back up and apply the consolidation to a real database
# ===========================================================================
# For environments that have NOT yet been consolidated (the local tellus_db was
# already migrated by the migrate runner). Takes a timestamped pg_dump backup
# first, applies the migration in a single transaction, records the ledger row,
# then verifies the invariants. Idempotent: safe to re-run.
#
# Usage:  bash apply-to-db.sh [DB_NAME]
# ===========================================================================
set -euo pipefail

CONTAINER="${TELLUS_PG_CONTAINER:-tellus-postgres-1}"
PGUSER="${TELLUS_PG_USER:-tellus}"
DB="${1:-${TELLUS_PG_DB:-tellus_db}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION="$HERE/../../src/migrations/100_single_enterprise_ontology.sql"
NAME="100_single_enterprise_ontology.sql"
BACKUP="/tmp/${DB}-pre-single-ontology.sql"

echo "── Backing up '$DB' → $BACKUP (host) ──"
docker exec -i "$CONTAINER" sh -c "pg_dump -U $PGUSER -d $DB --no-owner --no-privileges" > "$BACKUP"
echo "  backup size: $(wc -c < "$BACKUP" | tr -d ' ') bytes"

echo "── Applying migration (single transaction) ──"
docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$DB" -v ON_ERROR_STOP=1 \
  --single-transaction < "$MIGRATION"

echo "── Recording migration ledger row ──"
docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$DB" -c \
  "INSERT INTO schema_migrations_applied(migration_name, applied_at) VALUES ('$NAME', now()) ON CONFLICT DO NOTHING;" >/dev/null

echo "── Verifying invariants ──"
bash "$HERE/verify-invariants.sh" "$DB"

echo "✅ Consolidation applied to '$DB'. Restore with: psql -d $DB < $BACKUP"
