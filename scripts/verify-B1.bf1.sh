#!/usr/bin/env bash
# scripts/verify-B1.bf1.sh — Turn-level verify script for B1.bf1.
#
# Runs the Cypress E2E for the Compass resource model from tellus-fe, tees
# the run output to /tmp/b1-cypress.log, syncs the recorded .mp4 into
# tellus/cypress/videos/files-projects/ so the v2 §B1.bf1 Exit Gate (which
# is rooted at the tellus repo) can see it, then evaluates the literal
# Exit Gate from the v2 plan.
#
# Exits 0 only when the gate prints "B1.bf1 GREEN".

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FE_ROOT="${TELLUS_FE_ROOT:-$REPO_ROOT/../tellus-fe}"

if [[ ! -d "$FE_ROOT" ]]; then
  echo "[verify-B1.bf1] missing tellus-fe at $FE_ROOT" >&2
  exit 1
fi

# Ensure session marker is older than the spec run we're about to record.
[[ -f /tmp/SESSION_START ]] || date +%s > /tmp/SESSION_START

# Bring the stack up (idempotent).
bash "$REPO_ROOT/scripts/dc-up.sh" || true

# Run cypress and tee stdout for the gate.
echo "[verify-B1.bf1] running cypress in $FE_ROOT"
(
  cd "$FE_ROOT"
  CYPRESS_BASE_URL="${CYPRESS_BASE_URL:-http://localhost:3001}" \
    npx cypress run --headless \
      --spec cypress/files-projects/e2e/compass-b1.cy.ts \
      --reporter spec \
      --config "video=true,videosFolder=cypress/videos/files-projects,specPattern=cypress/files-projects/e2e/**/*.cy.ts" \
      2>&1 | tee /tmp/b1-cypress.log
) || true

# Sync the recorded .mp4 (if any) into the tellus repo so the v2-rooted
# Exit Gate's `find cypress/videos` invocation sees it.
mkdir -p "$REPO_ROOT/cypress/videos/files-projects"
if compgen -G "$FE_ROOT/cypress/videos/files-projects/compass-b1*.mp4" > /dev/null; then
  for f in "$FE_ROOT"/cypress/videos/files-projects/compass-b1*.mp4; do
    cp -p "$f" "$REPO_ROOT/cypress/videos/files-projects/$(basename "$f")"
    touch "$REPO_ROOT/cypress/videos/files-projects/$(basename "$f")"
  done
fi

# Literal Exit Gate from files-projects-tasks-v2.md §B1.bf1.
cd "$REPO_ROOT"
if test -s /tmp/b1-cypress.log && \
     find cypress/videos -name 'compass-b1*.mp4' -newer /tmp/SESSION_START | grep -q . ; then
  echo "B1.bf1 GREEN"
  exit 0
fi
echo "[verify-B1.bf1] gate failed — log size $(wc -c </tmp/b1-cypress.log 2>/dev/null || echo 0); videos:" >&2
find cypress/videos -name 'compass-b1*.mp4' 2>&1 | tee /dev/stderr | head >&2
exit 1
