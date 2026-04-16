#!/usr/bin/env bash
#
# verify-flink.sh
# ---------------
# End-to-end test of the Flink integration:
#
#   docker (Flink JM + TM)  → cluster healthy
#   backend (tellus)        → /api/v2/flink/* proxies the Flink REST API
#   parity check            → backend response matches direct REST call
#
# Run:
#
#   ./scripts/verify-flink.sh

BASE="${BASE:-http://localhost:3000}"
FLINK="${FLINK_URL:-http://localhost:8083}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0

check() {
  local label="$1"; local expected="$2"; local actual="$3"; local body="$4"
  if [[ "$actual" == "$expected" ]]; then
    printf "${GREEN}✓${NC} %-58s ${GREEN}%s${NC}\n" "$label" "$actual"
    PASS=$((PASS + 1))
  else
    printf "${RED}✗${NC} %-58s ${RED}%s${NC} (want ${YELLOW}%s${NC})\n" "$label" "$actual" "$expected"
    [[ -n "$body" ]] && printf "  %s\n" "${body:0:300}"
    FAIL=$((FAIL + 1))
  fi
}

echo -e "${BOLD}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║  Flink JobManager end-to-end verification                        ║${NC}"
echo -e "${BOLD}╚════════════════════════════════════════════════════════════════╝${NC}"
echo "  Backend     : $BASE"
echo "  Flink JM    : $FLINK"
echo

# 1. Flink direct
status=$(curl -s -o /tmp/f-overview.json -w '%{http_code}' "$FLINK/overview")
check "GET flink /overview (direct)" "200" "$status"
fv=$(jq -r '.["flink-version"]' /tmp/f-overview.json)
tms=$(jq -r '.taskmanagers' /tmp/f-overview.json)
slots=$(jq -r '.["slots-total"]' /tmp/f-overview.json)
echo "    flinkVersion=$fv  taskmanagers=$tms  slotsTotal=$slots"

# 2. Backend proxy /flink/overview
status=$(curl -s -o /tmp/b-overview.json -w '%{http_code}' "$BASE/api/v2/flink/overview")
check "GET /api/v2/flink/overview" "200" "$status"
b_fv=$(jq -r '.data.flinkVersion' /tmp/b-overview.json)
if [[ "$b_fv" == "$fv" ]]; then
  printf "${GREEN}✓${NC} %s\n" "backend.flinkVersion == direct flink-version ($fv)"
  PASS=$((PASS + 1))
else
  printf "${RED}✗${NC} %s\n" "backend.flinkVersion mismatch ($b_fv vs $fv)"
  FAIL=$((FAIL + 1))
fi
b_tms=$(jq -r '.data.taskmanagers' /tmp/b-overview.json)
b_slots=$(jq -r '.data.slotsTotal' /tmp/b-overview.json)
if [[ "$b_tms" == "$tms" && "$b_slots" == "$slots" ]]; then
  printf "${GREEN}✓${NC} %s\n" "backend taskmanagers/slots match Flink direct"
  PASS=$((PASS + 1))
else
  printf "${RED}✗${NC} %s\n" "backend taskmanagers/slots mismatch (got $b_tms/$b_slots, want $tms/$slots)"
  FAIL=$((FAIL + 1))
fi

# 3. Backend proxy /flink/taskmanagers
status=$(curl -s -o /tmp/b-tm.json -w '%{http_code}' "$BASE/api/v2/flink/taskmanagers")
check "GET /api/v2/flink/taskmanagers" "200" "$status"
tm_count=$(jq -r '.data | length' /tmp/b-tm.json)
if [[ "$tm_count" -ge 1 ]]; then
  printf "${GREEN}✓${NC} %s\n" "backend returned $tm_count task manager(s)"
  PASS=$((PASS + 1))
else
  printf "${RED}✗${NC} %s\n" "backend returned no task managers"
  FAIL=$((FAIL + 1))
fi

# 4. Backend proxy /flink/jobs
status=$(curl -s -o /tmp/b-jobs.json -w '%{http_code}' "$BASE/api/v2/flink/jobs")
check "GET /api/v2/flink/jobs" "200" "$status"
jobs_field=$(jq -r '.data.jobs | type' /tmp/b-jobs.json)
if [[ "$jobs_field" == "array" ]]; then
  printf "${GREEN}✓${NC} %s\n" ".data.jobs is an array"
  PASS=$((PASS + 1))
else
  printf "${RED}✗${NC} %s\n" ".data.jobs missing or wrong type ($jobs_field)"
  FAIL=$((FAIL + 1))
fi

echo
printf "${BOLD}Pass: ${GREEN}%d${NC}${BOLD}   Fail: ${RED}%d${NC}\n" "$PASS" "$FAIL"
exit $FAIL
