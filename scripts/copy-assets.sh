#!/usr/bin/env bash
# Copy non-TypeScript build assets into dist/ after `tsc`.
#   - src/templates/**     → dist/templates   (HTML/email/etc. templates)
#   - src/migrations/*.sql → dist/migrations  (raw-SQL forward migrations + the
#                            migration ledger 032_migration_ledger.sql). tsc only
#                            compiles .ts, so without this the prod image ships ZERO
#                            .sql migrations and the migration gate fails at boot
#                            ("schema_migrations_applied does not exist").
set -euo pipefail

copy_dir() {
  local src="$1" dest="$2"
  if [ ! -d "$src" ]; then
    echo "[build] No $src directory found, skipping."
    return 0
  fi
  mkdir -p "$dest"
  cp -R "$src"/* "$dest"/
  echo "[build] copied $src -> $dest"
}

copy_dir "src/templates" "dist/templates"

# Migrations: only the .sql assets (the .ts/.js are compiled by tsc).
if [ -d "src/migrations" ]; then
  mkdir -p "dist/migrations"
  if compgen -G "src/migrations/*.sql" > /dev/null; then
    cp src/migrations/*.sql dist/migrations/
    echo "[build] copied src/migrations/*.sql -> dist/migrations ($(ls -1 src/migrations/*.sql | wc -l | tr -d ' ') files)"
  else
    echo "[build] No src/migrations/*.sql found, skipping."
  fi
fi
