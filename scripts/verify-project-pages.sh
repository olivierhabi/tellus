#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-project-pages.sh — production verification for the project sub-pages.
#
# Verifies the production replacements for the project workspace pages
# end-to-end:
#
#   1. Frontend TypeScript clean for the changed pages (cover, catalog,
#      folder-trash) and the modified backend route (projectWorkspace).
#   2. Frontend ESLint clean for the same files.
#   3. Backend smoke tests via curl:
#       - GET /v1/projects/:projectId            → 200, returns project shape
#       - GET /v1/projects/:projectId/trashed    → 200, returns items[]
#       - GET /v1/projects/:projectId/trashed?parentRid=…  → 200 (regression
#         test for the `r.trashed_at?.toISOString is not a function` bug)
#       - GET /v1/compass/folders/<projectRoot>/children   → 200
#   4. Cypress: runs cypress/files-projects/e2e/project-pages-production.cy.ts
#      against the running frontend dev server. Skipped with a warning when
#      cypress isn't installed locally.
#
# Requirements:
#   - tellus-fe dev server running on http://localhost:3001
#   - tellus backend running and proxied at http://localhost:3001/api
#   - JWT_TOKEN env var (Bearer token from a logged-in browser session) for
#     the curl smoke tests. When unset, smoke tests are SKIPPED with a
#     warning rather than failing — the typecheck/lint/cypress steps still
#     run.
#
# Exit codes:
#   0 — every requested step passed (or was explicitly skipped).
#   1 — at least one required step failed.
#
# Usage:
#   JWT_TOKEN=eyJ… bash scripts/verify-project-pages.sh
#   bash scripts/verify-project-pages.sh --skip-cypress
#   bash scripts/verify-project-pages.sh --skip-curl
# ---------------------------------------------------------------------------
set -uo pipefail

# Colors (only when stdout is a TTY).
if [[ -t 1 ]]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'
  CYAN=$'\033[0;36m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; CYAN=""; BOLD=""; RESET=""
fi

# CLI flags.
SKIP_CYPRESS=0
SKIP_CURL=0
SKIP_TSC=0
SKIP_LINT=0
for arg in "$@"; do
  case "$arg" in
    --skip-cypress) SKIP_CYPRESS=1 ;;
    --skip-curl)    SKIP_CURL=1 ;;
    --skip-tsc)     SKIP_TSC=1 ;;
    --skip-lint)    SKIP_LINT=1 ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "${RED}Unknown flag: $arg${RESET}" >&2
      exit 1
      ;;
  esac
done

# Resolve the workspace roots. The script lives in tellus/scripts/, but the
# frontend lives at $PROJECTS/tellus-fe/.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TELLUS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECTS_DIR="$(cd "$TELLUS_DIR/.." && pwd)"
TELLUS_FE_DIR="$PROJECTS_DIR/tellus-fe"

if [[ ! -d "$TELLUS_FE_DIR" ]]; then
  echo "${RED}tellus-fe not found at $TELLUS_FE_DIR${RESET}" >&2
  exit 1
fi

PROJECT_ID="${PROJECT_ID:-36271681-65d7-4c55-a6d0-20137f8212dc}"
FOLDER_ID="${FOLDER_ID:-4a94852a-def0-422b-8a55-98fcabc86277}"
FOLDER_RESOURCE_RID="ri.compass.main.compass-folder.${FOLDER_ID}"
PROJECT_ROOT_RID="ri.compass.main.folder.${PROJECT_ID}"
API_BASE="${API_BASE:-http://localhost:3001/api}"

# Track per-step results.
declare -a STEP_NAMES=()
declare -a STEP_RESULTS=()  # PASS | FAIL | SKIP
RC=0

step() {
  local name="$1"
  local result="$2"
  STEP_NAMES+=("$name")
  STEP_RESULTS+=("$result")
  case "$result" in
    PASS) echo "  ${GREEN}✓${RESET} $name" ;;
    FAIL) echo "  ${RED}✗${RESET} $name"; RC=1 ;;
    SKIP) echo "  ${YELLOW}—${RESET} $name (skipped)" ;;
  esac
}

heading() {
  echo
  echo "${BOLD}${CYAN}== $1 ==${RESET}"
}

# ---------------------------------------------------------------------------
# 1. TypeScript
# ---------------------------------------------------------------------------
heading "TypeScript"
if [[ "$SKIP_TSC" == "1" ]]; then
  step "tellus-fe tsc --noEmit" SKIP
  step "tellus tsc --noEmit"    SKIP
else
  TSC_FE_LOG="$(mktemp)"
  if (cd "$TELLUS_FE_DIR" && npx --no-install tsc --noEmit) > "$TSC_FE_LOG" 2>&1; then
    step "tellus-fe tsc --noEmit" PASS
  else
    # The repo carries some pre-existing errors outside our scope; only fail
    # when one of OUR files has a complaint.
    if grep -E "(folders/\[folderId\]/(trash/)?page|cover/page|catalog/page|compassChildren\.ts)" "$TSC_FE_LOG" > /dev/null; then
      step "tellus-fe tsc --noEmit (changed files)" FAIL
      grep -E "(folders/\[folderId\]/(trash/)?page|cover/page|catalog/page|compassChildren\.ts)" "$TSC_FE_LOG" | head -10 | sed 's/^/    /'
    else
      step "tellus-fe tsc --noEmit (changed files)" PASS
      echo "    ${YELLOW}(pre-existing tsc errors in unrelated files; ignored)${RESET}"
    fi
  fi
  rm -f "$TSC_FE_LOG"

  TSC_BE_LOG="$(mktemp)"
  if (cd "$TELLUS_DIR" && npx --no-install tsc --noEmit) > "$TSC_BE_LOG" 2>&1; then
    step "tellus tsc --noEmit" PASS
  else
    if grep -E "src/routes/projectWorkspace\.ts" "$TSC_BE_LOG" > /dev/null; then
      step "tellus tsc --noEmit (projectWorkspace.ts)" FAIL
      grep -E "src/routes/projectWorkspace\.ts" "$TSC_BE_LOG" | head -10 | sed 's/^/    /'
    else
      step "tellus tsc --noEmit (projectWorkspace.ts)" PASS
      echo "    ${YELLOW}(pre-existing tsc errors in unrelated files; ignored)${RESET}"
    fi
  fi
  rm -f "$TSC_BE_LOG"
fi

# ---------------------------------------------------------------------------
# 2. ESLint
# ---------------------------------------------------------------------------
heading "ESLint (changed files only)"
if [[ "$SKIP_LINT" == "1" ]]; then
  step "ESLint" SKIP
else
  LINT_LOG="$(mktemp)"
  if (cd "$TELLUS_FE_DIR" && npx --no-install eslint \
      "app/projects/[projectId]/cover/page.tsx" \
      "app/projects/[projectId]/catalog/page.tsx" \
      "app/projects/[projectId]/folders/[folderId]/trash/page.tsx" \
      "app/projects/[projectId]/folders/[folderId]/page.tsx" \
      "types/compassChildren.ts") > "$LINT_LOG" 2>&1; then
    step "ESLint clean on changed files" PASS
  else
    # ESLint exits 1 on warnings too. Distinguish errors from warnings.
    if grep -E "[0-9]+ error" "$LINT_LOG" > /dev/null; then
      step "ESLint (errors found)" FAIL
      tail -20 "$LINT_LOG" | sed 's/^/    /'
    else
      step "ESLint (warnings only — see log)" PASS
    fi
  fi
  rm -f "$LINT_LOG"
fi

# ---------------------------------------------------------------------------
# 3. Backend smoke tests via curl
# ---------------------------------------------------------------------------
heading "Backend smoke tests (curl)"

curl_check() {
  local label="$1"
  local url="$2"
  local expect_status="$3"           # e.g. 200
  local jq_filter="${4:-}"           # optional jq expression that must be truthy

  if ! command -v jq >/dev/null 2>&1; then
    step "$label" SKIP
    echo "    ${YELLOW}(jq not installed)${RESET}"
    return
  fi

  local tmp; tmp="$(mktemp)"
  local status
  status="$(curl -sS -o "$tmp" -w '%{http_code}' \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -H "Accept: application/json" \
    "$url" || true)"

  if [[ "$status" != "$expect_status" ]]; then
    step "$label  (expected HTTP $expect_status, got $status)" FAIL
    head -c 500 "$tmp" | sed 's/^/    /'
    echo
    rm -f "$tmp"
    return
  fi

  if [[ -n "$jq_filter" ]]; then
    if ! jq -e "$jq_filter" "$tmp" > /dev/null 2>&1; then
      step "$label  (jq filter failed: $jq_filter)" FAIL
      head -c 500 "$tmp" | sed 's/^/    /'
      echo
      rm -f "$tmp"
      return
    fi
  fi

  step "$label" PASS
  rm -f "$tmp"
}

if [[ "$SKIP_CURL" == "1" ]]; then
  step "curl backend smoke tests" SKIP
elif [[ -z "${JWT_TOKEN:-}" ]]; then
  step "curl backend smoke tests" SKIP
  echo "    ${YELLOW}(JWT_TOKEN env var not set — paste the Bearer token from your browser)${RESET}"
else
  curl_check \
    "GET /v1/projects/:id returns project metadata" \
    "${API_BASE}/v1/projects/${PROJECT_ID}" \
    "200" \
    '.id == "'"${PROJECT_ID}"'" or .data.id == "'"${PROJECT_ID}"'"'

  curl_check \
    "GET /v1/projects/:id/trashed returns items[]" \
    "${API_BASE}/v1/projects/${PROJECT_ID}/trashed" \
    "200" \
    '(.data.items // .items) | type == "array"'

  curl_check \
    "GET /v1/projects/:id/trashed?parentRid=… (regression: timestamp coercion)" \
    "${API_BASE}/v1/projects/${PROJECT_ID}/trashed?parentRid=${FOLDER_RESOURCE_RID}" \
    "200" \
    '(.data.items // .items) | type == "array"'

  curl_check \
    "GET /v1/compass/folders/<projectRoot>/children returns items[]" \
    "${API_BASE}/v1/compass/folders/${PROJECT_ROOT_RID}/children?pageSize=10" \
    "200" \
    '(.data.items // .items) | type == "array"'
fi

# ---------------------------------------------------------------------------
# 4. Cypress
# ---------------------------------------------------------------------------
heading "Cypress (project-pages-production.cy.ts)"
if [[ "$SKIP_CYPRESS" == "1" ]]; then
  step "cypress run" SKIP
elif ! [[ -d "$TELLUS_FE_DIR/node_modules/cypress" ]]; then
  step "cypress run" SKIP
  echo "    ${YELLOW}(cypress not installed at $TELLUS_FE_DIR/node_modules/cypress)${RESET}"
else
  CY_LOG="$(mktemp)"
  if (cd "$TELLUS_FE_DIR" && npx --no-install cypress run \
      --headless \
      --spec "cypress/files-projects/e2e/project-pages-production.cy.ts" \
      --config "specPattern=cypress/files-projects/e2e/**/*.cy.ts") \
      > "$CY_LOG" 2>&1; then
    step "cypress run" PASS
    grep -E "(passing|failing|All specs passed)" "$CY_LOG" | sed 's/^/    /' | head -5
  else
    step "cypress run" FAIL
    tail -50 "$CY_LOG" | sed 's/^/    /'
  fi
  rm -f "$CY_LOG"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
heading "Summary"
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
for r in "${STEP_RESULTS[@]}"; do
  case "$r" in
    PASS) ((PASS_COUNT++)) ;;
    FAIL) ((FAIL_COUNT++)) ;;
    SKIP) ((SKIP_COUNT++)) ;;
  esac
done
echo "  ${GREEN}${PASS_COUNT} passed${RESET}, ${RED}${FAIL_COUNT} failed${RESET}, ${YELLOW}${SKIP_COUNT} skipped${RESET}"

if [[ $RC -eq 0 ]]; then
  echo "  ${GREEN}${BOLD}OK${RESET}"
else
  echo "  ${RED}${BOLD}FAILED${RESET}"
fi
exit $RC
