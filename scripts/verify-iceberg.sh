#!/usr/bin/env bash
#
# verify-iceberg.sh
# -----------------
# End-to-end test of the Iceberg / Nessie integration:
#
#   docker (Nessie)        → Iceberg REST catalog v2 reachable
#   backend (tellus)       → /api/v2/iceberg/* commits namespaces + tables
#   Nessie direct API      → confirms the entries actually landed
#
# Run:
#
#   ./scripts/verify-iceberg.sh

BASE="${BASE:-http://localhost:3000}"
NESSIE="${NESSIE_URL:-http://localhost:19120/api/v2}"
NAMESPACE="${ICEBERG_NAMESPACE:-ontology}"
TABLE="iceberg_check_$(date +%s%N | tail -c 6)"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0

check() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  local body="$4"
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
echo -e "${BOLD}║  Iceberg + Nessie end-to-end verification                        ║${NC}"
echo -e "${BOLD}╚════════════════════════════════════════════════════════════════╝${NC}"
echo "  Backend     : $BASE"
echo "  Nessie      : $NESSIE"
echo

# 1. Nessie container reachable
status=$(curl -s -o /tmp/n-config.json -w '%{http_code}' "$NESSIE/config")
check "Nessie /config reachable" "200" "$status"
default_branch=$(jq -r '.defaultBranch // empty' /tmp/n-config.json)
api_v=$(jq -r '.actualApiVersion // empty' /tmp/n-config.json)
echo "    defaultBranch=$default_branch  actualApiVersion=$api_v"

# 2. Backend /iceberg/config returns the warehouse + Nessie config
status=$(curl -s -o /tmp/b-config.json -w '%{http_code}' "$BASE/api/v2/iceberg/config")
check "GET /api/v2/iceberg/config" "200" "$status"
warehouse=$(jq -r '.data.warehouse // empty' /tmp/b-config.json)
echo "    warehouse=$warehouse"

# 3. Backend lists branches
status=$(curl -s -o /tmp/b-branches.json -w '%{http_code}' "$BASE/api/v2/iceberg/branches")
check "GET /api/v2/iceberg/branches" "200" "$status"
main_present=$(jq -r '.data[] | select(.name == "main") | .name' /tmp/b-branches.json)
if [[ "$main_present" == "main" ]]; then
  printf "${GREEN}✓${NC} %s\n" "main branch exists in backend response"
  PASS=$((PASS + 1))
else
  printf "${RED}✗${NC} %s\n" "main branch missing"
  FAIL=$((FAIL + 1))
fi

# 4. Create namespace via backend
status=$(curl -s -o /tmp/b-ns.json -w '%{http_code}' \
  -X POST -H "Content-Type: application/json" \
  -d "{\"namespace\":[\"$NAMESPACE\"]}" \
  "$BASE/api/v2/iceberg/namespace")
check "POST /api/v2/iceberg/namespace ($NAMESPACE)" "201" "$status" "$(cat /tmp/b-ns.json)"

# 5. Create table via backend
status=$(curl -s -o /tmp/b-tbl.json -w '%{http_code}' \
  -X POST -H "Content-Type: application/json" \
  -d "{\"namespace\":[\"$NAMESPACE\"],\"name\":\"$TABLE\"}" \
  "$BASE/api/v2/iceberg/table")
check "POST /api/v2/iceberg/table ($TABLE)" "201" "$status" "$(cat /tmp/b-tbl.json)"

# 6. The new table appears in backend's entries listing
status=$(curl -s -o /tmp/b-entries.json -w '%{http_code}' "$BASE/api/v2/iceberg/entries")
check "GET /api/v2/iceberg/entries" "200" "$status"
found_via_backend=$(jq -r ".data[] | select(.name.elements == [\"$NAMESPACE\", \"$TABLE\"]) | .type" /tmp/b-entries.json)
if [[ "$found_via_backend" == "ICEBERG_TABLE" ]]; then
  printf "${GREEN}✓${NC} %s\n" "table $NAMESPACE.$TABLE present via backend"
  PASS=$((PASS + 1))
else
  printf "${RED}✗${NC} %s\n" "table $NAMESPACE.$TABLE missing in backend response"
  FAIL=$((FAIL + 1))
fi

# 7. The same table appears via the Nessie API directly (proves we
# committed to the actual catalog, not the backend's in-memory state)
status=$(curl -s -o /tmp/n-entries.json -w '%{http_code}' "$NESSIE/trees/main/entries")
check "GET nessie /trees/main/entries (direct)" "200" "$status"
found_via_nessie=$(jq -r ".entries[] | select(.name.elements == [\"$NAMESPACE\", \"$TABLE\"]) | .type" /tmp/n-entries.json)
if [[ "$found_via_nessie" == "ICEBERG_TABLE" ]]; then
  printf "${GREEN}✓${NC} %s\n" "table $NAMESPACE.$TABLE present in Nessie directly"
  PASS=$((PASS + 1))
else
  printf "${RED}✗${NC} %s\n" "table $NAMESPACE.$TABLE not visible to Nessie"
  FAIL=$((FAIL + 1))
fi

# Summary
echo
printf "${BOLD}Pass: ${GREEN}%d${NC}${BOLD}   Fail: ${RED}%d${NC}\n" "$PASS" "$FAIL"
exit $FAIL
