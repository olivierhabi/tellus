#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# migrate-split-dbs.sh — move Lakekeeper's catalog off the app Postgres onto
# its dedicated instance (one-time, idempotent-ish).
#
# Temporal is intentionally NOT migrated: its workflow history is ephemeral
# (the PG-backed dispatcher is the source of truth), so temporal-postgres
# starts fresh and temporal-init re-registers the namespace.
#
# Lakekeeper's catalog (warehouses, namespaces, table registrations) IS worth
# preserving, so we pg_dump the `lakekeeper` DB out of the app Postgres and
# restore it into lakekeeper-postgres. Safe to re-run: restore is into a fresh
# DB; if the target already has data the migrate step reconciles it.
#
# Usage: scripts/migrate-split-dbs.sh
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PGPASSWORD="$(sed -n 's/^PGPASSWORD=//p' .env)"; PGPASSWORD="${PGPASSWORD:-changeme}"
LK_PW="$(sed -n 's/^LAKEKEEPER_PG_PASSWORD=//p' .env)"; LK_PW="${LK_PW:-lakekeeper_pw}"

dc() { docker compose "$@"; }

echo "[1/4] Ensuring lakekeeper-postgres is up and healthy…"
dc up -d lakekeeper-postgres
for i in $(seq 1 30); do
  if dc exec -T lakekeeper-postgres pg_isready -U lakekeeper -d lakekeeper >/dev/null 2>&1; then break; fi
  sleep 1
done

# Does the source DB still exist on the app Postgres? (It won't after a clean
# rebuild — in that case there's nothing to migrate and the app re-bootstraps.)
if ! dc exec -T postgres psql -U tellus -d tellus_db -tAc \
     "SELECT 1 FROM pg_database WHERE datname='lakekeeper'" 2>/dev/null | grep -q 1; then
  echo "[skip] No 'lakekeeper' DB on the app Postgres — nothing to migrate."
  echo "       lakekeeper-migrate will build a fresh schema; the app re-creates the warehouse on boot."
  exit 0
fi

echo "[2/4] Checking target is empty (avoid clobbering an already-migrated catalog)…"
TARGET_TABLES="$(dc exec -T lakekeeper-postgres psql -U lakekeeper -d lakekeeper -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null | tr -d '[:space:]')"
if [[ "${TARGET_TABLES:-0}" -gt 0 ]]; then
  echo "[skip] lakekeeper-postgres already has ${TARGET_TABLES} tables — assuming already migrated."
  exit 0
fi

echo "[3/4] pg_dump app.lakekeeper → restore into lakekeeper-postgres.lakekeeper…"
# --no-owner/--no-acl so objects re-own to the 'lakekeeper' role on restore.
dc exec -T postgres pg_dump -U tellus -d lakekeeper --no-owner --no-acl \
  | dc exec -T lakekeeper-postgres psql -U lakekeeper -d lakekeeper -v ON_ERROR_STOP=0 >/dev/null

echo "[4/4] Verifying row counts on a couple of catalog tables…"
for t in warehouse namespace; do
  src="$(dc exec -T postgres psql -U tellus -d lakekeeper -tAc "SELECT count(*) FROM $t" 2>/dev/null | tr -d '[:space:]' || echo NA)"
  dst="$(dc exec -T lakekeeper-postgres psql -U lakekeeper -d lakekeeper -tAc "SELECT count(*) FROM $t" 2>/dev/null | tr -d '[:space:]' || echo NA)"
  printf "    %-12s src=%s dst=%s %s\n" "$t" "$src" "$dst" "$([[ "$src" == "$dst" ]] && echo OK || echo DIFF)"
done

echo "Done. lakekeeper-migrate/serve now point at lakekeeper-postgres."
