#!/usr/bin/env bash
# verify-v2-routes.sh — runs cypress against /v2/* routes on localhost:3001.
# Exits 0 only when all 34 tests pass and every visited route returned 200.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/v2-routes.log
HTTP_LOG=/tmp/v2-routes-http.log
: > "$LOG"
: > "$HTTP_LOG"

# Step 1 — confirm the dev server is on :3001.
if ! lsof -nP -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[verify-v2-routes] dev server not on :3001 — start it (cd tellus-fe && npm run dev)" >&2
  exit 2
fi

# Step 2 — HTTP smoke (every route must return 200).
ROUTES=(
  /v2 /v2/files
  /v2/projects/demo-project /v2/projects/demo-project/autosaved
  /v2/projects/demo-project/references /v2/projects/demo-project/trash
  /v2/projects/demo-project/settings
  /v2/explorer /v2/share-demo /v2/quick-open-demo /v2/trash
  /v2/branches /v2/branches/demo-branch /v2/proposals/demo-proposal
  /v2/ontology /v2/ontology/default/object-types
  /v2/ontology/default/object-types/employee /v2/ontology/default/link-types/new
  /v2/object-explorer /v2/canvas
)
echo "=== HTTP smoke (expect all 200) ===" | tee -a "$HTTP_LOG"
fail_http=0
for r in "${ROUTES[@]}"; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "http://localhost:3001$r")
  printf "  %-3s %s\n" "$code" "$r" | tee -a "$HTTP_LOG"
  if [[ "$code" != "200" ]]; then fail_http=$((fail_http + 1)); fi
done
if [[ $fail_http -gt 0 ]]; then
  echo "[verify-v2-routes] $fail_http route(s) returned non-200" >&2
  exit 3
fi

# Step 3 — TypeScript compile (v2 surface only).
echo "=== tsc v2 check ===" | tee -a "$LOG"
(cd "$FE" && npx tsc --noEmit -p tsconfig.json 2>&1) \
  | grep -E '^app/v2|^components/(files-projects|projects-detail|file-explorer|share-dialog|quick-open|trash|branches|ontology|object-explorer|canvas)/' \
  > /tmp/v2-tsc.log || true
if [[ -s /tmp/v2-tsc.log ]]; then
  echo "[verify-v2-routes] tsc errors in v2 surface:" >&2
  cat /tmp/v2-tsc.log >&2
  exit 4
fi
echo "  no v2 type errors" | tee -a "$LOG"

# Step 4 — Cypress headless run.
echo "=== cypress headless run ===" | tee -a "$LOG"
(cd "$FE" && CYPRESS_BASE_URL=http://localhost:3001 \
  npx cypress run --headless \
    --spec cypress/files-projects/e2e/v2-routes.cy.ts \
    --config "specPattern=cypress/files-projects/e2e/**/*.cy.ts,video=true,videosFolder=cypress/videos/files-projects" \
    2>&1) | tee -a "$LOG"
status=${PIPESTATUS[0]}

# Step 5 — assert on cypress output.
# Spec ships 34 tests (20 smoke + 14 interactive: F1, F2-subtab, F3
# multi-select, F4 share, F5 quick-open, F6 trash, F7 branch switcher,
# F8 OT-editor, F9 facet, F10 canvas, plus 4 Foundry-faithful project
# workspace tests).  All must pass.
if [[ $status -eq 0 ]] \
    && grep -qE 'All specs passed!' "$LOG" \
    && grep -qE '34 +passing' "$LOG"; then
  # Sync video into the tellus tree so the FINAL aggregate gate can see it.
  mkdir -p "$REPO_ROOT/cypress/videos/files-projects"
  if [[ -f "$FE/cypress/videos/files-projects/v2-routes.cy.ts.mp4" ]]; then
    cp "$FE/cypress/videos/files-projects/v2-routes.cy.ts.mp4" \
       "$REPO_ROOT/cypress/videos/files-projects/v2-routes.cy.ts.mp4"
  fi
  echo "V2-ROUTES GREEN"
  exit 0
fi
echo "[verify-v2-routes] gate failed: cypress exit=$status" >&2
exit 1
