#!/usr/bin/env bash
# B3.bf4 — Cypress E2E for filesystem v2 (mirrors B1.bf1 gate shape).
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true

FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/b3-cypress.log
: > "$LOG"

(cd "$FE" && CYPRESS_BASE_URL=http://localhost:3000 \
  npx cypress run --headless \
    --spec cypress/files-projects/e2e/filesystem-v2-b3.cy.ts \
    --config "specPattern=cypress/files-projects/e2e/**/*.cy.ts,video=true,videosFolder=cypress/videos/files-projects" \
    2>&1) | tee -a "$LOG"

# Sync video back into tellus tree so the v2-rooted gate can find it.
mkdir -p "$REPO_ROOT/cypress/videos/files-projects"
if [[ -f "$FE/cypress/videos/files-projects/filesystem-v2-b3.cy.ts.mp4" ]]; then
  cp "$FE/cypress/videos/files-projects/filesystem-v2-b3.cy.ts.mp4" \
     "$REPO_ROOT/cypress/videos/files-projects/filesystem-v2-b3.cy.ts.mp4"
fi

# Mirror B1.bf1 Exit Gate (literal):
if test -s "$LOG" \
   && find cypress/videos -name 'filesystem-v2-b3*.mp4' -newer /tmp/SESSION_START | grep -q .; then
  echo "B3.bf4 GREEN"
  exit 0
fi
echo "[verify-B3.bf4] gate failed" >&2
ls -la cypress/videos/files-projects/ >&2 || true
exit 1
