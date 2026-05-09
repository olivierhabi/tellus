#!/usr/bin/env bash
# verify-project-trash.sh — gate for the project trash listing feature.
# Exits 0 only when:
#   1. dev server is on :3001
#   2. backend tsc clean for src/routes/projectWorkspace + server
#   3. frontend tsc clean for app/projects/[projectId]/trash + ProjectWorkspaceShell
#   4. /api/v1/projects/<id>/trashed returns 401 without auth (route mounted)
#   5. /api/v1/resources/<rid>/restore returns 401 without auth
#   6. /api/v1/resources/<rid>/permanently-delete returns 401 without auth
#   7. cypress spec passes 6/6 against the live dev server
set -uo pipefail
# Make sure node/npx are on PATH when run via nohup or cron — nvm-installed
# binaries live under ~/.nvm/versions/node/<version>/bin and aren't in the
# default PATH inherited by daemonized shells.
NODE_BIN="$(/bin/ls -td "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | /usr/bin/head -1 || echo "")"
[ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/verify-project-trash.log
: > "$LOG"

PROJ="36271681-65d7-4c55-a6d0-20137f8212dc"

# 1. dev server must be on :3001.
LSOF=$(command -v lsof || echo /usr/sbin/lsof)
if ! "$LSOF" -nP -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[verify] dev server not on :3001" >&2; exit 2
fi

# 2. backend tsc — projectWorkspace router + server wiring.
echo "=== backend tsc (projectWorkspace + server) ===" | tee -a "$LOG"
(cd "$REPO_ROOT" && npx tsc --noEmit -p tsconfig.json 2>&1) \
  | grep -E '^src/(routes/projectWorkspace|server)' \
  > /tmp/trash-tsc-be.log || true
if [[ -s /tmp/trash-tsc-be.log ]]; then
  echo "[verify] backend tsc errors:" >&2; cat /tmp/trash-tsc-be.log >&2; exit 3
fi
echo "  ok" | tee -a "$LOG"

# 3. frontend tsc — trash page + the shared shell.
echo "=== frontend tsc (trash page + ProjectWorkspaceShell) ===" | tee -a "$LOG"
(cd "$FE" && npx tsc --noEmit -p tsconfig.json 2>&1) \
  | grep -E '^(app/projects/\[projectId\]/trash/page|components/projects-detail/ProjectWorkspaceShell)' \
  > /tmp/trash-tsc-fe.log || true
if [[ -s /tmp/trash-tsc-fe.log ]]; then
  echo "[verify] frontend tsc errors:" >&2; cat /tmp/trash-tsc-fe.log >&2; exit 4
fi
echo "  ok" | tee -a "$LOG"

# 4. live endpoint smoke — three endpoints, all expect 401 without auth.
echo "=== HTTP smoke (auth-gated) ===" | tee -a "$LOG"
LIST_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
  "http://localhost:3001/api/v1/projects/$PROJ/trashed")
echo "  list endpoint returns $LIST_CODE (expect 401)" | tee -a "$LOG"
if [[ "$LIST_CODE" != "401" ]]; then
  echo "[verify] list endpoint expected 401, got $LIST_CODE" >&2; exit 5
fi
RESTORE_CODE=$(curl -sS -X POST -o /dev/null -w '%{http_code}' --max-time 30 \
  "http://localhost:3001/api/v1/resources/ri.compass.main.folder.test/restore")
echo "  restore endpoint returns $RESTORE_CODE (expect 401)" | tee -a "$LOG"
if [[ "$RESTORE_CODE" != "401" ]]; then
  echo "[verify] restore endpoint expected 401, got $RESTORE_CODE" >&2; exit 6
fi
PERMDEL_CODE=$(curl -sS -X POST -o /dev/null -w '%{http_code}' --max-time 30 \
  "http://localhost:3001/api/v1/resources/ri.compass.main.folder.test/permanently-delete")
echo "  permanently-delete endpoint returns $PERMDEL_CODE (expect 401)" | tee -a "$LOG"
if [[ "$PERMDEL_CODE" != "401" ]]; then
  echo "[verify] permdel endpoint expected 401, got $PERMDEL_CODE" >&2; exit 7
fi

# 5. cypress.
echo "=== cypress ===" | tee -a "$LOG"
rm -rf "$FE/cypress/screenshots/project-trash.cy.ts" 2>/dev/null
(cd "$FE" && CYPRESS_BASE_URL=http://localhost:3001 \
  npx cypress run --headless \
    --spec cypress/files-projects/e2e/project-trash.cy.ts \
    --config "specPattern=cypress/files-projects/e2e/**/*.cy.ts,video=true,videosFolder=cypress/videos/files-projects" \
    --reporter min 2>&1) | tee -a "$LOG"
status=${PIPESTATUS[0]}

# Spec ships 6 tests; both totals must match (avoids "0 passing" false-green).
if [[ $status -eq 0 ]] \
  && grep -qE 'All specs passed!' "$LOG" \
  && grep -qE '6 +passing' "$LOG"; then
  mkdir -p "$REPO_ROOT/cypress/videos/files-projects"
  if [[ -f "$FE/cypress/videos/files-projects/project-trash.cy.ts.mp4" ]]; then
    cp "$FE/cypress/videos/files-projects/project-trash.cy.ts.mp4" \
       "$REPO_ROOT/cypress/videos/files-projects/project-trash.cy.ts.mp4"
  fi
  echo "PROJECT-TRASH GREEN"
  exit 0
fi
echo "[verify] cypress failed (exit=$status)" >&2
exit 1
