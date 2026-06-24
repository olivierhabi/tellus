#!/usr/bin/env bash
# verify-project-references.sh — gate for the project file-references and
# external-references sub-pages (PROJECT-REFERENCES vertical).
#
# Exits 0 only when:
#   1. dev server is on :3001
#   2. tsc clean for both pages
#   3. /api/v1/projects/<id>/file-references and /external-references both
#      return 401 unauthenticated (route mounted, auth gating correctly)
#   4. cypress spec passes (3 tests for file-refs + 3 for ext-refs = 6)
set -uo pipefail
# Make node/npx visible to the script when invoked via nohup — nvm-installed
# binaries aren't in the daemonized-shell default PATH.
NODE_BIN="$(/bin/ls -td "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | /usr/bin/head -1 || echo "")"
[ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/verify-project-references.log
: > "$LOG"

# 1. dev server.
LSOF=$(command -v lsof || echo /usr/sbin/lsof)
if ! "$LSOF" -nP -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[verify] dev server not on :3001" >&2; exit 2
fi

# 2. tsc.
echo "=== tsc ===" | tee -a "$LOG"
(cd "$FE" && npx tsc --noEmit -p tsconfig.json 2>&1) \
  | /usr/bin/grep -E '^app/projects/\[projectId\]/(file-references|external-references)|^components/projects-detail/ProjectWorkspaceShell' \
  > /tmp/v-pr-tsc.log || true
if [[ -s /tmp/v-pr-tsc.log ]]; then
  echo "[verify] tsc errors:" >&2; /bin/cat /tmp/v-pr-tsc.log >&2; exit 3
fi
echo "  ok" | tee -a "$LOG"

# 3. HTTP smoke.
echo "=== HTTP smoke ===" | tee -a "$LOG"
PROJ="36271681-65d7-4c55-a6d0-20137f8212dc"
for endpoint in file-references external-references; do
  CODE=$(/usr/bin/curl -sS -o /dev/null -w '%{http_code}' --max-time 8 \
    "http://localhost:3001/api/v1/projects/$PROJ/$endpoint")
  echo "  /api/v1/projects/$PROJ/$endpoint: $CODE" | tee -a "$LOG"
  if [[ "$CODE" != "401" ]]; then
    echo "[verify] expected 401, got $CODE" >&2; exit 5
  fi
done

# 4. cypress.
echo "=== cypress ===" | tee -a "$LOG"
/bin/rm -rf "$FE/cypress/screenshots/project-references.cy.ts" 2>/dev/null
(cd "$FE" && CYPRESS_BASE_URL=http://localhost:3001 \
  npx cypress run --headless \
    --spec cypress/files-projects/e2e/project-references.cy.ts \
    --config "specPattern=cypress/files-projects/e2e/**/*.cy.ts,video=true,videosFolder=cypress/videos/files-projects" \
    --reporter min 2>&1) | tee -a "$LOG"
status=${PIPESTATUS[0]}

# 6 tests = 3 file-refs + 3 ext-refs.
if [[ $status -eq 0 ]] \
  && /usr/bin/grep -qE 'All specs passed!' "$LOG" \
  && /usr/bin/grep -qE '6 +passing' "$LOG"; then
  /bin/mkdir -p "$REPO_ROOT/cypress/videos/files-projects"
  if [[ -f "$FE/cypress/videos/files-projects/project-references.cy.ts.mp4" ]]; then
    /bin/cp "$FE/cypress/videos/files-projects/project-references.cy.ts.mp4" \
       "$REPO_ROOT/cypress/videos/files-projects/project-references.cy.ts.mp4"
  fi
  echo "PROJECT-REFERENCES GREEN"
  exit 0
fi
echo "[verify] cypress failed (exit=$status)" >&2
exit 1
