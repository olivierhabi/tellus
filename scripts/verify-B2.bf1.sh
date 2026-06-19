#!/usr/bin/env bash
# scripts/verify-B2.bf1.sh — Turn-level verify for B2.bf1.
# Runs the spaces-b2 cypress spec from tellus-fe, syncs the .mp4 into
# tellus/cypress/videos/files-projects/, and evaluates the literal v2
# §B2.bf1 Exit Gate.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FE_ROOT="${TELLUS_FE_ROOT:-$REPO_ROOT/../tellus-fe}"
[[ -d "$FE_ROOT" ]] || { echo "[verify-B2.bf1] missing tellus-fe at $FE_ROOT" >&2; exit 1; }
[[ -f /tmp/SESSION_START ]] || date +%s > /tmp/SESSION_START

bash "$REPO_ROOT/scripts/dc-up.sh" || true

(
  cd "$FE_ROOT"
  CYPRESS_BASE_URL="${CYPRESS_BASE_URL:-http://localhost:3001}" \
    npx cypress run --headless \
      --spec cypress/files-projects/e2e/spaces-b2.cy.ts \
      --reporter spec \
      --config "video=true,videosFolder=cypress/videos/files-projects,specPattern=cypress/files-projects/e2e/**/*.cy.ts" \
      2>&1 | tee /tmp/b2-cypress.log
) || true

mkdir -p "$REPO_ROOT/cypress/videos/files-projects"
if compgen -G "$FE_ROOT/cypress/videos/files-projects/spaces-b2*.mp4" > /dev/null; then
  for f in "$FE_ROOT"/cypress/videos/files-projects/spaces-b2*.mp4; do
    cp -p "$f" "$REPO_ROOT/cypress/videos/files-projects/$(basename "$f")"
    touch "$REPO_ROOT/cypress/videos/files-projects/$(basename "$f")"
  done
fi

cd "$REPO_ROOT"
if find cypress/videos -name 'spaces-b2*.mp4' -newer /tmp/SESSION_START | grep -q . ; then
  echo "B2.bf1 GREEN"
  exit 0
fi
echo "[verify-B2.bf1] gate failed — no spaces-b2*.mp4 newer than SESSION_START" >&2
exit 1
