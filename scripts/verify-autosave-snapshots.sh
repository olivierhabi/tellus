#!/usr/bin/env bash
# verify-autosave-snapshots.sh — gate for the autosave snapshot feature.
# Exits 0 only when:
#   1. dev server is on :3001
#   2. backend tsc clean for src/{routes,services,types}/autosave* + workshop versionService
#   3. frontend tsc clean for app/projects/[projectId]/autosaved
#   4. autosave_snapshots table exists with the expected columns + indexes
#   5. /api/v1/projects/<id>/autosave-snapshots returns 401 without auth
#   6. /api/v1/resources/<rid>/autosave-snapshots/<id>/restore returns 401 without auth
#   7. cypress spec passes 5/5 against the live dev server
set -uo pipefail
# Make sure node/npx are on PATH when run via nohup or cron — nvm-installed
# binaries live under ~/.nvm/versions/node/<version>/bin and aren't in the
# default PATH inherited by daemonized shells.
NODE_BIN="$(/bin/ls -td "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | /usr/bin/head -1 || echo "")"
[ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/verify-autosave-snapshots.log
: > "$LOG"

PROJ="36271681-65d7-4c55-a6d0-20137f8212dc"

# 1. dev server must be on :3001. (lsof lives at /usr/sbin/lsof on macOS,
# which isn't always in PATH for nohup'd shells.)
LSOF=$(command -v lsof || echo /usr/sbin/lsof)
if ! "$LSOF" -nP -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[verify] dev server not on :3001" >&2; exit 2
fi

# 2. backend tsc.
echo "=== backend tsc (autosave + workshop versionService) ===" | tee -a "$LOG"
(cd "$REPO_ROOT" && npx tsc --noEmit -p tsconfig.json 2>&1) \
  | grep -E '^src/(routes/autosaveSnapshots|services/autosaveService|services/workshop/versionService|types/autosaveSnapshot|server)' \
  > /tmp/autosave-tsc-be.log || true
if [[ -s /tmp/autosave-tsc-be.log ]]; then
  echo "[verify] backend tsc errors:" >&2; cat /tmp/autosave-tsc-be.log >&2; exit 3
fi
echo "  ok" | tee -a "$LOG"

# 3. frontend tsc.
echo "=== frontend tsc (autosaved page) ===" | tee -a "$LOG"
(cd "$FE" && npx tsc --noEmit -p tsconfig.json 2>&1) \
  | grep -E '^app/projects/\[projectId\]/autosaved/page' \
  > /tmp/autosave-tsc-fe.log || true
if [[ -s /tmp/autosave-tsc-fe.log ]]; then
  echo "[verify] frontend tsc errors:" >&2; cat /tmp/autosave-tsc-fe.log >&2; exit 4
fi
echo "  ok" | tee -a "$LOG"

# 4. DDL — autosave_snapshots table + 4 indexes must exist.
echo "=== DDL check (autosave_snapshots) ===" | tee -a "$LOG"
TABLE_EXISTS=$(docker exec tellus-postgres-1 psql -U tellus -d tellus_db -tAc \
  "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='autosave_snapshots')")
if [[ "$TABLE_EXISTS" != "t" ]]; then
  echo "[verify] autosave_snapshots table is missing — run npx tsx src/migrate.ts" >&2; exit 5
fi
INDEX_COUNT=$(docker exec tellus-postgres-1 psql -U tellus -d tellus_db -tAc \
  "SELECT count(*) FROM pg_indexes WHERE tablename='autosave_snapshots' AND indexname LIKE 'idx_autosave_%'")
if [[ "$INDEX_COUNT" != "4" ]]; then
  echo "[verify] expected 4 idx_autosave_% indexes, got $INDEX_COUNT" >&2; exit 6
fi
echo "  table + 4 indexes present" | tee -a "$LOG"

# 5. live endpoint smoke — both endpoints expect 401 without auth.
echo "=== HTTP smoke (auth-gated) ===" | tee -a "$LOG"
LIST_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
  "http://localhost:3001/api/v1/projects/$PROJ/autosave-snapshots?pageSize=5")
echo "  list endpoint returns $LIST_CODE (expect 401)" | tee -a "$LOG"
if [[ "$LIST_CODE" != "401" ]]; then
  echo "[verify] list endpoint expected 401, got $LIST_CODE" >&2; exit 7
fi
RESTORE_CODE=$(curl -sS -X POST -o /dev/null -w '%{http_code}' --max-time 30 \
  "http://localhost:3001/api/v1/resources/ri.workshop.main.module.test/autosave-snapshots/00000000-0000-0000-0000-000000000000/restore")
echo "  restore endpoint returns $RESTORE_CODE (expect 401)" | tee -a "$LOG"
if [[ "$RESTORE_CODE" != "401" ]]; then
  echo "[verify] restore endpoint expected 401, got $RESTORE_CODE" >&2; exit 8
fi

# 6. cypress.
echo "=== cypress ===" | tee -a "$LOG"
rm -rf "$FE/cypress/screenshots/autosave-snapshots.cy.ts" 2>/dev/null
(cd "$FE" && CYPRESS_BASE_URL=http://localhost:3001 \
  npx cypress run --headless \
    --spec cypress/files-projects/e2e/autosave-snapshots.cy.ts \
    --config "specPattern=cypress/files-projects/e2e/**/*.cy.ts,video=true,videosFolder=cypress/videos/files-projects" \
    --reporter min 2>&1) | tee -a "$LOG"
status=${PIPESTATUS[0]}

# Spec ships 5 tests; both totals must match (avoids "0 passing" false-green).
if [[ $status -eq 0 ]] \
  && grep -qE 'All specs passed!' "$LOG" \
  && grep -qE '5 +passing' "$LOG"; then
  mkdir -p "$REPO_ROOT/cypress/videos/files-projects"
  if [[ -f "$FE/cypress/videos/files-projects/autosave-snapshots.cy.ts.mp4" ]]; then
    cp "$FE/cypress/videos/files-projects/autosave-snapshots.cy.ts.mp4" \
       "$REPO_ROOT/cypress/videos/files-projects/autosave-snapshots.cy.ts.mp4"
  fi
  echo "AUTOSAVE-SNAPSHOTS GREEN"
  exit 0
fi
echo "[verify] cypress failed (exit=$status)" >&2
exit 1
