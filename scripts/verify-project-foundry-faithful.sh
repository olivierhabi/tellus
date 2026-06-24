#!/usr/bin/env bash
# verify-project-foundry-faithful.sh — production-grade gate for the
# project + folder workspace pages.
#
# Asserts:
#   1. Dev server (FE + BE) are reachable on :3001.
#   2. The two project URLs the user supplied resolve (302/307 are fine
#      because the AuthGuard redirects unauthenticated visitors).
#   3. Backend exposes /api/v1/workshop/modules + /api/v1/code-repositories
#      (HTTP 401 from the auth gate proves the route is mounted; 404 fails).
#   4. TypeScript compiles clean over the changed files.
#   5. Cypress headless run reports `4 passing` + `All specs passed!`.
#
# Exit code 0 only when every step lands. Emits `PROJECT-FOUNDRY-FAITHFUL GREEN`.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/project-foundry-faithful.log
HTTP_LOG=/tmp/project-foundry-faithful-http.log
TSC_LOG=/tmp/project-foundry-faithful-tsc.log
: > "$LOG"
: > "$HTTP_LOG"
: > "$TSC_LOG"

PROJECT_ID="36271681-65d7-4c55-a6d0-20137f8212dc"
FOLDER_ID="8d04b840-e755-4a79-9900-d141ddc894ff"

# --- 1. Dev server reachable -------------------------------------------------
if ! lsof -nP -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[verify] dev server not on :3001 — start it (cd tellus-fe && npm run dev)" >&2
  exit 2
fi

# --- 2. FE pages resolve (307 redirect to /login is fine) -------------------
echo "=== FE page smoke (302/307 OK — auth gate; 200 also fine) ===" | tee -a "$HTTP_LOG"
fail=0
for r in "/projects/$PROJECT_ID" "/projects/$PROJECT_ID/folders/$FOLDER_ID"; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "http://localhost:3001$r")
  printf "  %-3s %s\n" "$code" "$r" | tee -a "$HTTP_LOG"
  case "$code" in
    200|302|307) ;;  # acceptable
    *) fail=$((fail + 1)) ;;
  esac
done
if [[ $fail -gt 0 ]]; then
  echo "[verify] $fail FE route(s) failed" >&2
  exit 3
fi

# --- 3. BE workshop + code-repo endpoints exist (401 = mounted) -------------
echo | tee -a "$HTTP_LOG"
echo "=== BE endpoint smoke (401 OK — auth gate; 200 also fine; 404 fails) ===" | tee -a "$HTTP_LOG"
PROJECT_RID="ri.compass.main.project.$PROJECT_ID"
PROJECT_RID_ENC=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$PROJECT_RID")
fail=0
for r in \
  "/api/v1/workshop/modules?parentFolderRid=$PROJECT_RID_ENC" \
  "/api/v1/code-repositories?parentFolderRid=$PROJECT_RID_ENC&state=ACTIVE"; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:3001$r")
  printf "  %-3s %s\n" "$code" "$r" | tee -a "$HTTP_LOG"
  case "$code" in
    200|401|403) ;;  # 401/403 prove the route is mounted + auth-gated
    *) fail=$((fail + 1)) ;;
  esac
done
if [[ $fail -gt 0 ]]; then
  echo "[verify] backend endpoint(s) missing — workshops or code-repos route is not mounted" >&2
  exit 4
fi

# --- 4. TypeScript compile filtered to changed files ------------------------
echo | tee -a "$LOG"
echo "=== tsc check (filter to changed files) ===" | tee -a "$LOG"
(cd "$FE" && npx tsc --noEmit -p tsconfig.json 2>&1) \
  | grep -E '^(types/api|components/folders/FileSystemTable|app/projects/\[projectId\])' \
  > "$TSC_LOG" || true
if [[ -s "$TSC_LOG" ]]; then
  echo "[verify] tsc errors in changed files:" >&2
  cat "$TSC_LOG" >&2
  exit 5
fi
echo "  no type errors in changed files" | tee -a "$LOG"

# --- 4b. Pre-warm Next.js routes -------------------------------------------
# Without this, the very first cy.visit() can spend 60-120 s waiting for
# Next.js to compile the route on demand, which blows past Cypress's
# default 60 s pageLoadTimeout. Hitting each route once via curl front-
# loads the compile cost into the verifier instead of into the test.
echo | tee -a "$LOG"
echo "=== pre-warm Next.js routes (compile + AuthGuard render) ===" | tee -a "$LOG"
for r in \
  "/login" \
  "/projects/$PROJECT_ID" \
  "/projects/$PROJECT_ID/folders/$FOLDER_ID"; do
  start=$(date +%s)
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 180 "http://localhost:3001$r")
  end=$(date +%s)
  printf "  %-3s %5ss %s\n" "$code" "$((end - start))" "$r" | tee -a "$LOG"
done

# --- 5. Cypress headless run ------------------------------------------------
echo | tee -a "$LOG"
echo "=== cypress headless run ===" | tee -a "$LOG"
(cd "$FE" && CYPRESS_BASE_URL=http://localhost:3001 \
  npx cypress run --headless \
    --spec cypress/files-projects/e2e/project-foundry-faithful.cy.ts \
    --config "specPattern=cypress/files-projects/e2e/**/*.cy.ts,video=true,videosFolder=cypress/videos/files-projects" \
    --reporter min \
    2>&1) | tee -a "$LOG"
status=${PIPESTATUS[0]}

if [[ $status -eq 0 ]] \
    && grep -qE 'All specs passed!' "$LOG" \
    && grep -qE '4 +passing' "$LOG"; then
  # Sync video into the tellus tree so the FINAL aggregate gate can see it.
  mkdir -p "$REPO_ROOT/cypress/videos/files-projects"
  if [[ -f "$FE/cypress/videos/files-projects/project-foundry-faithful.cy.ts.mp4" ]]; then
    cp "$FE/cypress/videos/files-projects/project-foundry-faithful.cy.ts.mp4" \
       "$REPO_ROOT/cypress/videos/files-projects/project-foundry-faithful.cy.ts.mp4"
  fi
  echo "PROJECT-FOUNDRY-FAITHFUL GREEN"
  exit 0
fi
echo "[verify] gate failed: cypress exit=$status (expected 4 passing)" >&2
exit 1
