#!/usr/bin/env bash
# ===========================================================================
# Sunday E2E Bash Test Helpers
# Identical to Monday/Saturday helpers — reused for consistency.
# ===========================================================================

PASSED="${PASSED:-0}"
FAILED="${FAILED:-0}"
TOTAL="${TOTAL:-0}"
SECTION="${SECTION:-}"
BASE_URL="${BASE_URL:-http://localhost:3000}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

section() { SECTION="$1"; echo ""; echo -e "${CYAN}${BOLD}=== $1 ===${NC}"; }
pass() { PASSED=$((PASSED + 1)); TOTAL=$((TOTAL + 1)); echo -e "  ${GREEN}PASS${NC}  $1"; }
fail() { FAILED=$((FAILED + 1)); TOTAL=$((TOTAL + 1)); echo -e "  ${RED}FAIL${NC}  $1"; }

assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (expected '$2', got '$1')"; fi; }
assert_contains() { if echo "$1" | grep -q "$2"; then pass "$3"; else fail "$3 (expected to contain '$2')"; fi; }
assert_not_empty() { if [[ -n "$1" ]]; then pass "$2"; else fail "$2 (was empty)"; fi; }
assert_status() { assert_eq "$1" "$2" "$3 [HTTP $2]"; }

json_field() { echo "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed "s/\"$2\"[[:space:]]*:[[:space:]]*\"//;s/\"$//" || true; }
json_field_raw() { echo "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*[^,}\"]*" | head -1 | sed "s/\"$2\"[[:space:]]*:[[:space:]]*//" || true; }
json_error_code() { echo "$1" | grep -o '"code"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/"code"[[:space:]]*:[[:space:]]*"//;s/"$//' || true; }

do_request() {
  local method="$1" path="$2" data="${3:-}"
  for attempt in 1 2; do
    local tmpfile; tmpfile=$(mktemp)
    local curl_args=(-s -w "\n%{http_code}" -D "$tmpfile" -X "$method" -H "Content-Type: application/json")
    # F-01: attach JWT so globalAuth() does not 401 data-plane routes.
    if [[ -n "${AUTH_TOKEN:-}" ]]; then curl_args+=(-H "Authorization: Bearer ${AUTH_TOKEN}"); fi
    if [[ -n "$data" ]]; then curl_args+=(-d "$data"); fi
    local response; response=$(curl "${curl_args[@]}" "${BASE_URL}${path}" 2>/dev/null) || true
    HTTP_STATUS=$(echo "$response" | tail -1)
    HTTP_BODY=$(echo "$response" | sed '$d')
    HTTP_HEADERS=$(cat "$tmpfile")
    rm -f "$tmpfile"
    if [[ "$HTTP_STATUS" == "429" && $attempt -eq 1 ]]; then sleep 5; continue; fi
    break
  done
}

header_value() { echo "$HTTP_HEADERS" | grep -i "^${1}:" | head -1 | sed "s/^[^:]*:[[:space:]]*//" | tr -d '\r' || true; }

print_report() {
  echo ""; echo -e "${BOLD}========================================${NC}"
  echo -e "${BOLD}  Sunday E2E Test Report${NC}"
  echo -e "${BOLD}========================================${NC}"; echo ""
  echo -e "  Total:   ${TOTAL}"; echo -e "  ${GREEN}Passed:  ${PASSED}${NC}"
  if [[ $FAILED -gt 0 ]]; then echo -e "  ${RED}Failed:  ${FAILED}${NC}"; else echo -e "  Failed:  0"; fi
  echo ""
  if [[ $FAILED -gt 0 ]]; then echo -e "${RED}${BOLD}RESULT: FAIL${NC} — ${FAILED} test(s) failed"; exit 1
  else echo -e "${GREEN}${BOLD}RESULT: PASS${NC} — All ${PASSED} tests passed"; exit 0; fi
}
