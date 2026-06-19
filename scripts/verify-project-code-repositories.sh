#!/usr/bin/env bash
# verify-project-code-repositories.sh — gate for /projects/<id>/code-repositories
# Pass conditions:
#   1. dev server up on :3001
#   2. tsc clean for the touched FE files
#   3. /projects/<id>/code-repositories returns 307 (auth-gated)
#   4. /api/v1/compass/folders/<rid>/children returns 401 unauthenticated
#   5. cypress headless: 4/4 passing
set -uo pipefail

REPO=/Users/olivierhabimana/Desktop/projects/tellus
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
NODE_BIN=/Users/olivierhabimana/.nvm/versions/node/v24.12.0/bin
NPX="$NODE_BIN/npx"

# Cypress shells out to plain `node`; ensure the nvm bin is on PATH so
# `env node ...` resolves. The system PATH alone misses it.
export PATH="$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin"

PROJECT_ID=36271681-65d7-4c55-a6d0-20137f8212dc
PROJECT_RID=ri.compass.main.folder.${PROJECT_ID}

if ! /usr/sbin/lsof -nP -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[verify] dev server not on :3001" >&2; exit 2
fi

LOG=/tmp/verify-project-code-repositories.log
: > "$LOG"

echo "=== tsc check ===" | tee -a "$LOG"
(cd "$FE" && "$NPX" tsc --noEmit -p tsconfig.json 2>&1) \
  | grep -E '^(app/projects/\[projectId\]/code-repositories|components/projects-detail/ProjectWorkspaceShell)' \
  > /tmp/cr-tsc.log || true
if [[ -s /tmp/cr-tsc.log ]]; then
  echo "[verify] tsc errors:" >&2
  cat /tmp/cr-tsc.log >&2
  exit 3
fi
echo "  ok" | tee -a "$LOG"

echo "=== HTTP smoke (auth-gated; expected: FE 307, API 401) ===" | tee -a "$LOG"
ENCODED_RID=$(printf '%s' "$PROJECT_RID" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read(),safe=""))')
FE_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:3001/projects/$PROJECT_ID/code-repositories")
API_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:3001/api/v1/compass/folders/$ENCODED_RID/children?kinds=code-repository&pageSize=5")
echo "  FE  /projects/<id>/code-repositories: $FE_CODE" | tee -a "$LOG"
echo "  API /v1/compass/folders/<rid>/children: $API_CODE" | tee -a "$LOG"
if [[ "$FE_CODE" != "307" ]]; then echo "[verify] expected FE 307, got $FE_CODE" >&2; exit 4; fi
if [[ "$API_CODE" != "401" ]]; then echo "[verify] expected API 401, got $API_CODE" >&2; exit 4; fi

echo "=== cypress ===" | tee -a "$LOG"
rm -rf "$FE/cypress/screenshots/project-code-repositories.cy.ts" 2>/dev/null || true
(cd "$FE" && CYPRESS_BASE_URL=http://localhost:3001 \
  "$NPX" cypress run --headless \
    --spec cypress/files-projects/e2e/project-code-repositories.cy.ts \
    --config "specPattern=cypress/files-projects/e2e/project-code-repositories.cy.ts,video=false" \
    --reporter min 2>&1) | tee -a "$LOG"
status=${PIPESTATUS[0]}

if [[ $status -eq 0 ]] \
   && grep -qE 'All specs passed!' "$LOG" \
   && grep -qE '4 +passing' "$LOG"; then
  echo "PROJECT-CODE-REPOSITORIES GREEN"
  exit 0
fi

echo "[verify] cypress failed (exit=$status)" >&2
exit 1
