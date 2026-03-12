#!/usr/bin/env bash
# ===========================================================================
# Thursday E2E Bash Test Helpers
# Copied from Tuesday helpers with Thursday-specific extensions.
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

section() {
  SECTION="$1"
  echo ""
  echo -e "${CYAN}${BOLD}=== $1 ===${NC}"
}

pass() {
  PASSED=$((PASSED + 1))
  TOTAL=$((TOTAL + 1))
  echo -e "  ${GREEN}PASS${NC}  $1"
}

fail() {
  FAILED=$((FAILED + 1))
  TOTAL=$((TOTAL + 1))
  echo -e "  ${RED}FAIL${NC}  $1"
}

assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label (expected '$expected', got '$actual')"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -q "$needle"; then
    pass "$label"
  else
    fail "$label (expected to contain '$needle')"
  fi
}

assert_not_empty() {
  local val="$1" label="$2"
  if [[ -n "$val" ]]; then
    pass "$label"
  else
    fail "$label (was empty)"
  fi
}

assert_status() {
  local actual="$1" expected="$2" label="$3"
  assert_eq "$actual" "$expected" "$label [HTTP $expected]"
}

json_field() {
  local json="$1" key="$2"
  echo "$json" | grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed "s/\"$key\"[[:space:]]*:[[:space:]]*\"//;s/\"$//" || true
}

json_field_raw() {
  local json="$1" key="$2"
  echo "$json" | grep -o "\"$key\"[[:space:]]*:[[:space:]]*[^,}\"]*" | head -1 | sed "s/\"$key\"[[:space:]]*:[[:space:]]*//" || true
}

json_error_code() {
  local json="$1"
  echo "$json" | grep -o '"code"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/"code"[[:space:]]*:[[:space:]]*"//;s/"$//' || true
}

do_request() {
  local method="$1" path="$2" data="${3:-}"
  local attempt

  for attempt in 1 2; do
    local tmpfile
    tmpfile=$(mktemp)

    local curl_args=(-s -w "\n%{http_code}" -D "$tmpfile" -X "$method")
    curl_args+=(-H "Content-Type: application/json")

    if [[ -n "$data" ]]; then
      curl_args+=(-d "$data")
    fi

    local response
    response=$(curl "${curl_args[@]}" "${BASE_URL}${path}" 2>/dev/null) || true

    HTTP_STATUS=$(echo "$response" | tail -1)
    HTTP_BODY=$(echo "$response" | sed '$d')
    HTTP_HEADERS=$(cat "$tmpfile")
    rm -f "$tmpfile"

    if [[ "$HTTP_STATUS" == "429" && $attempt -eq 1 ]]; then
      sleep 5
      continue
    fi
    break
  done
}

do_upload() {
  local path="$1" filepath="$2"
  local tmpfile
  tmpfile=$(mktemp)

  local response
  response=$(curl -s -w "\n%{http_code}" -D "$tmpfile" -X POST \
    -F "file=@${filepath}" \
    "${BASE_URL}${path}" 2>/dev/null) || true

  HTTP_STATUS=$(echo "$response" | tail -1)
  HTTP_BODY=$(echo "$response" | sed '$d')
  HTTP_HEADERS=$(cat "$tmpfile")
  rm -f "$tmpfile"
}

print_report() {
  echo ""
  echo -e "${BOLD}========================================${NC}"
  echo -e "${BOLD}  Thursday E2E Test Report${NC}"
  echo -e "${BOLD}========================================${NC}"
  echo ""
  echo -e "  Total:   ${TOTAL}"
  echo -e "  ${GREEN}Passed:  ${PASSED}${NC}"
  if [[ $FAILED -gt 0 ]]; then
    echo -e "  ${RED}Failed:  ${FAILED}${NC}"
  else
    echo -e "  Failed:  0"
  fi
  echo ""

  if [[ $FAILED -gt 0 ]]; then
    echo -e "${RED}${BOLD}RESULT: FAIL${NC} — ${FAILED} test(s) failed"
    exit 1
  else
    echo -e "${GREEN}${BOLD}RESULT: PASS${NC} — All ${PASSED} tests passed"
    exit 0
  fi
}
