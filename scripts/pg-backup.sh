#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# pg-backup.sh — on-demand logical backup of ALL Postgres instances.
#
# The pg-backup compose sidecar handles SCHEDULED backups of the app DB only.
# This script is the manual/full hammer: it pg_dumps every Postgres instance
# (app, temporal, lakekeeper), gzips, timestamps, and prunes dumps older than
# RETENTION_DAYS. Pair it with host cron or Claude's /schedule for off-hours
# runs, or run it before a risky change.
#
# Usage: scripts/pg-backup.sh [RETENTION_DAYS]   (default 14)
# Output: backups/manual/<instance>-<db>-<UTC timestamp>.sql.gz
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RETENTION_DAYS="${1:-14}"
OUT="backups/manual"
mkdir -p "$OUT"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

PGPASSWORD="$(sed -n 's/^PGPASSWORD=//p' .env)"; PGPASSWORD="${PGPASSWORD:-changeme}"
TMP_PW="$(sed -n 's/^TEMPORAL_PG_PASSWORD=//p' .env)"; TMP_PW="${TMP_PW:-temporal_pw}"
LK_PW="$(sed -n 's/^LAKEKEEPER_PG_PASSWORD=//p' .env)"; LK_PW="${LK_PW:-lakekeeper_pw}"

dc() { docker compose "$@"; }

# dump <compose-service> <pg-user> <db>
dump() {
  local svc="$1" user="$2" db="$3"
  if [[ -z "$(dc ps -q "$svc" 2>/dev/null)" ]]; then
    echo "  [skip] $svc not running"; return 0
  fi
  local f="${OUT}/${svc}-${db}-${TS}.sql.gz"
  if dc exec -T "$svc" pg_dump -U "$user" -d "$db" --no-owner --no-acl 2>/dev/null | gzip > "$f"; then
    echo "  [ok]   $svc/$db → $f ($(du -h "$f" | cut -f1))"
  else
    echo "  [FAIL] $svc/$db"; rm -f "$f"; return 1
  fi
}

echo "Backing up all Postgres instances (UTC $TS):"
rc=0
dump postgres            tellus     tellus_db          || rc=1
dump temporal-postgres   temporal   temporal           || rc=1
dump temporal-postgres   temporal   temporal_visibility || rc=1
dump lakekeeper-postgres lakekeeper lakekeeper         || rc=1

echo "Pruning dumps older than ${RETENTION_DAYS} days…"
find "$OUT" -name '*.sql.gz' -type f -mtime "+${RETENTION_DAYS}" -print -delete 2>/dev/null || true

echo "Current backups:"; ls -lh "$OUT"/*.sql.gz 2>/dev/null | awk '{print "  "$5"  "$9}' || echo "  (none)"
exit $rc
