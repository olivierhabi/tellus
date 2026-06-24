#!/usr/bin/env bash
# verify-compass-children-v2.sh — gate for the unified Compass Gateway.
# Exits 0 only when:
#   1. backend tsc clean for src/{routes,services,types}/compassChildren*
#   2. frontend tsc clean for hooks/useCompassChildren, lib/compassChildrenAdapter,
#      types/compassChildren, app/projects/[projectId] (project + folder pages)
#   3. /api/v2/compass/folders/<rid>/children returns 401 without auth
#      (route mounted; access correctly gated)
#   4. cypress spec passes 5/5 against the live dev server
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/verify-compass-children-v2.log
: > "$LOG"

# 1. dev server must be on :3001.
if ! lsof -nP -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[verify] dev server not on :3001" >&2; exit 2
fi

# 2. backend tsc.
echo "=== backend tsc (compassChildren surface) ===" | tee -a "$LOG"
(cd "$REPO_ROOT" && npx tsc --noEmit -p tsconfig.json 2>&1) \
  | grep -E '^src/(routes|services|types)/compassChildren' \
  > /tmp/v2cc-tsc-be.log || true
if [[ -s /tmp/v2cc-tsc-be.log ]]; then
  echo "[verify] backend tsc errors:" >&2; cat /tmp/v2cc-tsc-be.log >&2; exit 3
fi
echo "  ok" | tee -a "$LOG"

# 3. frontend tsc.
echo "=== frontend tsc (touched files) ===" | tee -a "$LOG"
(cd "$FE" && npx tsc --noEmit -p tsconfig.json 2>&1) \
  | grep -E '^(app/projects/\[projectId\]|hooks/useCompassChildren|types/compassChildren|lib/compassChildrenAdapter)' \
  > /tmp/v2cc-tsc-fe.log || true
if [[ -s /tmp/v2cc-tsc-fe.log ]]; then
  echo "[verify] frontend tsc errors:" >&2; cat /tmp/v2cc-tsc-fe.log >&2; exit 4
fi
echo "  ok" | tee -a "$LOG"

# 4. live endpoint smoke — expect 401 without auth (proves route is mounted + gated).
echo "=== HTTP smoke (auth-gated) ===" | tee -a "$LOG"
RID=$(printf 'ri.compass.main.folder.36271681-65d7-4c55-a6d0-20137f8212dc' | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read(),safe=""))')
SMOKE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "http://localhost:3001/api/v2/compass/folders/$RID/children?pageSize=5")
echo "  unified endpoint returns $SMOKE (expect 401)" | tee -a "$LOG"
if [[ "$SMOKE" != "401" ]]; then
  echo "[verify] expected 401, got $SMOKE" >&2; exit 5
fi

# 5. cypress.
echo "=== cypress ===" | tee -a "$LOG"
rm -rf "$FE/cypress/screenshots/compass-children-v2.cy.ts" 2>/dev/null
(cd "$FE" && CYPRESS_BASE_URL=http://localhost:3001 \
  npx cypress run --headless \
    --spec cypress/files-projects/e2e/compass-children-v2.cy.ts \
    --config "specPattern=cypress/files-projects/e2e/**/*.cy.ts,video=true,videosFolder=cypress/videos/files-projects" \
    --reporter min 2>&1) | tee -a "$LOG"
status=${PIPESTATUS[0]}

# Spec ships 5 tests; both totals must match (avoids "0 passing" false-green).
if [[ $status -eq 0 ]] \
  && grep -qE 'All specs passed!' "$LOG" \
  && grep -qE '5 +passing' "$LOG"; then
  mkdir -p "$REPO_ROOT/cypress/videos/files-projects"
  if [[ -f "$FE/cypress/videos/files-projects/compass-children-v2.cy.ts.mp4" ]]; then
    cp "$FE/cypress/videos/files-projects/compass-children-v2.cy.ts.mp4" \
       "$REPO_ROOT/cypress/videos/files-projects/compass-children-v2.cy.ts.mp4"
  fi
  echo "COMPASS-CHILDREN-V2 GREEN"
  exit 0
fi
echo "[verify] cypress failed (exit=$status)" >&2
exit 1
