#!/usr/bin/env bash
# verify-dataset-delete-mirror.sh — gate for the dataset delete → trash
# mirror flow.
#
# Exits 0 only when:
#   1. backend tsc clean for the touched files
#   2. /v1/datasets/<id> DELETE returns 401 unauth (route mounted)
#   3. integration test (scripts/test-dataset-delete-mirror.ts) passes
#      every assertion against the live DB
#   4. cypress project-trash.cy.ts still 5/5 (regression check — the
#      restore-route changes shouldn't have broken the existing trash
#      flow)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/verify-dataset-delete-mirror.log
: > "$LOG"

# Find npx without assuming a fixed path.
NPX="$(which npx 2>/dev/null)"
if [[ -z "$NPX" ]]; then
  for candidate in /opt/homebrew/bin/npx /usr/local/bin/npx ~/.nvm/versions/node/*/bin/npx; do
    if [[ -x "$candidate" ]]; then NPX="$candidate"; break; fi
  done
fi
if [[ -z "$NPX" ]]; then
  echo "[verify] npx not found" >&2; exit 2
fi

# 1. dev server must be on :3001.
if ! lsof -nP -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[verify] dev server not on :3001" >&2; exit 2
fi

# 2. tsc on the surface this PR touched.
echo "=== tsc ===" | tee -a "$LOG"
(cd "$REPO_ROOT" && "$NPX" tsc --noEmit -p tsconfig.json 2>&1) \
  | grep -E "^src/(services/datasetService|routes/projectWorkspace|controllers/datasetController)" \
  > /tmp/v-dd-tsc.log || true
if [[ -s /tmp/v-dd-tsc.log ]]; then
  echo "[verify] tsc errors:" >&2; cat /tmp/v-dd-tsc.log >&2; exit 3
fi
echo "  ok" | tee -a "$LOG"

# 3. live HTTP smoke — DELETE /v1/datasets/<random> must be auth-gated.
echo "=== HTTP smoke ===" | tee -a "$LOG"
SMOKE=$(curl -sS -X DELETE -o /dev/null -w '%{http_code}' --max-time 10 \
  "http://localhost:3001/api/v1/datasets/00000000-0000-0000-0000-000000000000")
echo "  DELETE /v1/datasets/<id> → $SMOKE (expect 401)" | tee -a "$LOG"
if [[ "$SMOKE" != "401" ]]; then
  echo "[verify] expected 401, got $SMOKE" >&2; exit 4
fi

# 4. integration test — exercise the service + restore handler logic
# end-to-end against the live DB.
echo "=== integration test ===" | tee -a "$LOG"
"$NPX" tsx "$REPO_ROOT/scripts/test-dataset-delete-mirror.ts" 2>&1 | tee -a "$LOG"
INTEG_EXIT=${PIPESTATUS[0]}
if [[ $INTEG_EXIT -ne 0 ]]; then
  echo "[verify] integration test failed (exit=$INTEG_EXIT)" >&2; exit 5
fi

# 5. cypress regression check — the existing project-trash spec must still pass.
echo "=== cypress regression: project-trash.cy.ts ===" | tee -a "$LOG"
rm -rf "$FE/cypress/screenshots/project-trash.cy.ts" 2>/dev/null
(cd "$FE" && CYPRESS_BASE_URL=http://localhost:3001 \
  "$NPX" cypress run --headless \
    --spec cypress/files-projects/e2e/project-trash.cy.ts \
    --config "specPattern=cypress/files-projects/e2e/**/*.cy.ts" \
    --reporter min 2>&1) | tee -a "$LOG"
CYP_EXIT=${PIPESTATUS[0]}

if [[ $CYP_EXIT -eq 0 ]] \
   && grep -qE 'All specs passed!' "$LOG" \
   && grep -qE '5 +passing' "$LOG"; then
  echo "" | tee -a "$LOG"
  echo "DATASET-DELETE-MIRROR GREEN" | tee -a "$LOG"
  exit 0
fi
echo "[verify] cypress regression failed (exit=$CYP_EXIT)" >&2
exit 6
