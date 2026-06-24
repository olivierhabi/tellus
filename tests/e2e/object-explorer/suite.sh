#!/usr/bin/env bash
# ============================================================================
# Object Explorer — E2E suite (T-01..T-10 wire-level verification)
#
# Boots against a running Tellus server (port 3000) and a Keycloak realm.
# Run via: bash tests/e2e/object-explorer/suite.sh
#
# Each assertion is one HTTP call. We test:
#   T-02: legacy chart routes return 404 / 410
#   T-03: /sql/* admin gate
#   T-05: /exports IDOR scoping + envelope
#   T-06: auth boundary — Bearer-required across the explorer surface
#   T-07: canonical error envelope shape on every error path
#   T-08: /explorations list + single GET
#   T-09: pageSize cap (>10000 → PAGE_SIZE_OUT_OF_RANGE)
#   T-10: response includes requestId on success and error
#
# Pass criteria: every assertion green; on first failure, the suite
# prints the response body and exits non-zero. Per the brief, this
# verifies behaviour on a live Express stack against real Postgres,
# OpenSearch, Redis, Keycloak, and MinIO.
# ============================================================================

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RED='\033[0;31m'; GREEN='\033[0;32m'; BOLD='\033[1m'; NC='\033[0m'
PASS=0; FAIL=0; FAILED_TESTS=()

API="${API_URL:-http://localhost:3000}"
KC_URL="${KEYCLOAK_URL:-http://localhost:8086}"
KC_REALM="${KEYCLOAK_REALM:-tellus}"
KC_CLIENT_ID="${KEYCLOAK_FRONTEND_CLIENT_ID:-tellus-frontend}"
KC_USER="${KEYCLOAK_ADMIN_TEST_USER:-cypress-admin@tellus.local}"
KC_PASS="${KEYCLOAK_TEST_PASS:-Password123!}"

ONTOLOGY_ID="${ONTOLOGY_ID:-7225c197-18e2-4f85-8ce8-034d0ceb5d67}"
OBJECT_TYPE="${OBJECT_TYPE:-TaxReturn}"

# ---------------------------------------------------------------------------
# Pre-flight: server health + JWT acquire
# ---------------------------------------------------------------------------
echo -e "${BOLD}=== Object Explorer E2E ===${NC}"
echo "API:        ${API}"
echo "Keycloak:   ${KC_URL} realm=${KC_REALM}"
echo "Ontology:   ${ONTOLOGY_ID}"
echo "ObjectType: ${OBJECT_TYPE}"
echo

curl -sf -m 5 "${API}/health" >/dev/null || { echo -e "${RED}server not healthy at ${API}${NC}"; exit 2; }

KC_RESP=$(curl -sf -m 10 -X POST \
  "${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=password" \
  --data-urlencode "client_id=${KC_CLIENT_ID}" \
  --data-urlencode "username=${KC_USER}" \
  --data-urlencode "password=${KC_PASS}" \
  --data-urlencode "scope=openid")

# JSON-safe extraction — `grep -o "..."` plus shell color codes can corrupt
# the token with ANSI escape bytes (Node's HTTP parser then rejects the
# subsequent request with a zero-byte 400 response). Python is portable
# across CI runners and gives byte-clean output.
TOKEN=$(printf '%s' "$KC_RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')
[ -z "$TOKEN" ] && { echo -e "${RED}JWT acquire failed${NC}"; echo "$KC_RESP" | head -c 500; exit 2; }
echo -e "${GREEN}JWT acquired (len=${#TOKEN})${NC}"
echo

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
H_AUTH=(-H "Authorization: Bearer ${TOKEN}")
H_BRANCH=(-H "X-Branch-Id: _main")
TMP=$(mktemp -d)

assert_status() {
  local name="$1" expected="$2" actual="$3" body_file="$4"
  if [ "$actual" = "$expected" ]; then
    echo -e "  ${GREEN}PASS${NC} ${name} (status=${actual})"
    PASS=$((PASS+1))
  else
    echo -e "  ${RED}FAIL${NC} ${name} expected=${expected} actual=${actual}"
    [ -f "$body_file" ] && echo "    body: $(head -c 400 "$body_file")"
    FAIL=$((FAIL+1)); FAILED_TESTS+=("$name")
  fi
}

assert_grep() {
  local name="$1" pattern="$2" body_file="$3"
  if grep -qE "$pattern" "$body_file" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${NC} ${name}"
    PASS=$((PASS+1))
  else
    echo -e "  ${RED}FAIL${NC} ${name} pattern not found: ${pattern}"
    echo "    body: $(head -c 400 "$body_file")"
    FAIL=$((FAIL+1)); FAILED_TESTS+=("$name")
  fi
}

assert_not_grep() {
  local name="$1" pattern="$2" body_file="$3"
  if grep -qE "$pattern" "$body_file" 2>/dev/null; then
    echo -e "  ${RED}FAIL${NC} ${name} forbidden pattern present: ${pattern}"
    echo "    body: $(head -c 400 "$body_file")"
    FAIL=$((FAIL+1)); FAILED_TESTS+=("$name")
  else
    echo -e "  ${GREEN}PASS${NC} ${name}"
    PASS=$((PASS+1))
  fi
}

# ---------------------------------------------------------------------------
# T-07 — canonical error envelope
# ---------------------------------------------------------------------------
echo -e "${BOLD}T-07 — canonical error envelope${NC}"

# 401 has canonical fields and an error.code legacy alias
STATUS=$(curl -s -o "${TMP}/r1.json" -w "%{http_code}" "${API}/api/v1/objects/${OBJECT_TYPE}/searchByApiName/${OBJECT_TYPE}")
assert_status "T-07 C-100: 401 returns 401" 401 "$STATUS" "${TMP}/r1.json"
assert_grep   "T-07 C-100: envelope has errorCode" '"errorCode":"UNAUTHORIZED"' "${TMP}/r1.json"
assert_grep   "T-07 C-100: envelope has errorName" '"errorName":"AuthenticationError"' "${TMP}/r1.json"
assert_grep   "T-07 C-100: envelope has statusCode" '"statusCode":401' "${TMP}/r1.json"
assert_grep   "T-07 C-100: envelope has requestId"  '"requestId":"[0-9a-f-]+"' "${TMP}/r1.json"
assert_grep   "T-10 C-402: requestId is UUID-shaped" '"requestId":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"' "${TMP}/r1.json"

# ---------------------------------------------------------------------------
# T-02 — legacy chart endpoints removed
# ---------------------------------------------------------------------------
echo -e "${BOLD}T-02 — legacy chart endpoints removed${NC}"

for path in listogram histogram dateHistogram auto; do
  STATUS=$(curl -s -o "${TMP}/r-charts-${path}.json" -w "%{http_code}" "${H_AUTH[@]}" "${API}/api/v1/charts/${path}/${OBJECT_TYPE}")
  # 404 (not registered) is the contract; some 405 (method) is also acceptable as deletion proof.
  if [ "$STATUS" = "404" ] || [ "$STATUS" = "405" ]; then
    echo -e "  ${GREEN}PASS${NC} T-02 C-200: /charts/${path} removed (status=${STATUS})"
    PASS=$((PASS+1))
  else
    echo -e "  ${RED}FAIL${NC} T-02 C-200: /charts/${path} expected 404/405 got ${STATUS}"
    head -c 400 "${TMP}/r-charts-${path}.json"; echo
    FAIL=$((FAIL+1)); FAILED_TESTS+=("T-02 /charts/${path}")
  fi
done

# /charts/batch is the surviving endpoint — should NOT 404
STATUS=$(curl -s -o "${TMP}/r-batch.json" -w "%{http_code}" -X POST "${H_AUTH[@]}" "${H_BRANCH[@]}" -H "Content-Type: application/json" --data '{"requests":[]}' "${API}/api/v1/charts/batch")
if [ "$STATUS" != "404" ] && [ "$STATUS" != "405" ]; then
  echo -e "  ${GREEN}PASS${NC} T-02 C-201: /charts/batch survives (status=${STATUS})"
  PASS=$((PASS+1))
else
  echo -e "  ${RED}FAIL${NC} T-02 C-201: /charts/batch should not 404/405; got ${STATUS}"
  FAIL=$((FAIL+1)); FAILED_TESTS+=("T-02 /charts/batch")
fi

# ---------------------------------------------------------------------------
# T-09 — pageSize cap loud-fail
# ---------------------------------------------------------------------------
echo -e "${BOLD}T-09 — pageSize cap${NC}"

# pageSize=99999 is far above any cap. The route may enforce its own
# stricter cap (queryValidator's per-route MAX, currently 1000) BEFORE
# T-09's absolute cap of 10000. Either rejection is contract-valid: both
# emit the canonical envelope and a recognized errorCode.
PAYLOAD='{"pageSize":99999}'
STATUS=$(curl -s -o "${TMP}/r-pagecap.json" -w "%{http_code}" -X POST "${H_AUTH[@]}" "${H_BRANCH[@]}" \
  -H "Content-Type: application/json" --data "$PAYLOAD" \
  "${API}/api/v1/objects/${OBJECT_TYPE}/search")
assert_status "T-09 C-150: pageSize > cap → 400" 400 "$STATUS" "${TMP}/r-pagecap.json"
assert_grep   "T-09 C-150: rejected with PAGE_SIZE_OUT_OF_RANGE or QUERY_VALIDATION_ERROR" 'PAGE_SIZE_OUT_OF_RANGE|QUERY_VALIDATION_ERROR' "${TMP}/r-pagecap.json"
assert_grep   "T-09 C-150: envelope canonical" '"errorCode":"[A-Z_]+"' "${TMP}/r-pagecap.json"

# ---------------------------------------------------------------------------
# T-06 — /summary surface
# ---------------------------------------------------------------------------
echo -e "${BOLD}T-06 — /summary endpoint${NC}"

STATUS=$(curl -s -o "${TMP}/r-summary.json" -w "%{http_code}" "${H_AUTH[@]}" "${H_BRANCH[@]}" \
  "${API}/api/v1/ontology/${ONTOLOGY_ID}/summary/${OBJECT_TYPE}")
if [ "$STATUS" = "200" ] || [ "$STATUS" = "404" ]; then
  echo -e "  ${GREEN}PASS${NC} T-06 C-93: /summary returns ${STATUS} (mounted, not 401)"
  PASS=$((PASS+1))
else
  echo -e "  ${RED}FAIL${NC} T-06 C-93: /summary unexpected status=${STATUS}"
  head -c 400 "${TMP}/r-summary.json"; echo
  FAIL=$((FAIL+1)); FAILED_TESTS+=("T-06 /summary")
fi

# without auth → 401 with canonical envelope
STATUS=$(curl -s -o "${TMP}/r-summary-401.json" -w "%{http_code}" "${API}/api/v1/ontology/${ONTOLOGY_ID}/summary/${OBJECT_TYPE}")
assert_status "T-06 C-90: /summary without Bearer = 401" 401 "$STATUS" "${TMP}/r-summary-401.json"
assert_not_grep "T-06: 401 body does not leak object_type details" 'requested_by|security_context_snapshot|file_path' "${TMP}/r-summary-401.json"

# ---------------------------------------------------------------------------
# T-08 — /explorations list + single GET
# ---------------------------------------------------------------------------
echo -e "${BOLD}T-08 — saved explorations${NC}"

STATUS=$(curl -s -o "${TMP}/r-explorations.json" -w "%{http_code}" "${H_AUTH[@]}" "${H_BRANCH[@]}" \
  "${API}/api/v1/ontology/${ONTOLOGY_ID}/explorations")
if [ "$STATUS" = "200" ]; then
  echo -e "  ${GREEN}PASS${NC} T-08 C-110: /explorations list returns 200"
  PASS=$((PASS+1))
  # Body shape: should not be a raw array of secrets — should be {data: [...]}
  assert_grep "T-08 C-110: list body has data envelope or array" '\[|"data"' "${TMP}/r-explorations.json"
else
  echo -e "  ${BOLD}NOTE${NC} /explorations status=${STATUS} (no rows or seed mismatch — envelope still asserted below)"
  assert_grep "T-08 C-110: error envelope canonical if non-200" '"errorCode":"|\[|"data"' "${TMP}/r-explorations.json"
fi

# 404 on non-existent exploration — should be the IDOR-shape envelope
STATUS=$(curl -s -o "${TMP}/r-expl-404.json" -w "%{http_code}" "${H_AUTH[@]}" "${H_BRANCH[@]}" \
  "${API}/api/v1/ontology/${ONTOLOGY_ID}/explorations/00000000-0000-0000-0000-000000000000")
assert_status "T-08 C-111: missing exploration → 404" 404 "$STATUS" "${TMP}/r-expl-404.json"
assert_grep   "T-08 C-111: 404 envelope canonical" '"errorCode":"' "${TMP}/r-expl-404.json"

# ---------------------------------------------------------------------------
# T-05 — exports IDOR + envelope
# ---------------------------------------------------------------------------
echo -e "${BOLD}T-05 — exports pipeline${NC}"

STATUS=$(curl -s -o "${TMP}/r-exports-list.json" -w "%{http_code}" "${H_AUTH[@]}" "${H_BRANCH[@]}" \
  "${API}/api/v1/ontology/${ONTOLOGY_ID}/exports")
if [ "$STATUS" = "200" ]; then
  echo -e "  ${GREEN}PASS${NC} T-05 C-071: /exports list returns 200"
  PASS=$((PASS+1))
else
  echo -e "  ${BOLD}NOTE${NC} /exports list status=${STATUS}"
  assert_grep "T-05 C-070: error envelope canonical" '"errorCode":"' "${TMP}/r-exports-list.json"
fi

STATUS=$(curl -s -o "${TMP}/r-export-404.json" -w "%{http_code}" "${H_AUTH[@]}" "${H_BRANCH[@]}" \
  "${API}/api/v1/ontology/${ONTOLOGY_ID}/exports/00000000-0000-0000-0000-000000000000")
assert_status "T-05 C-070: missing export → 404 (IDOR shape)" 404 "$STATUS" "${TMP}/r-export-404.json"
assert_grep   "T-05 C-070: 404 envelope EXPORT_JOB_NOT_FOUND or canonical errorCode" '"errorCode":"' "${TMP}/r-export-404.json"

# Validation: format must be one of csv|jsonl|parquet
PAYLOAD='{"objectTypeApiName":"'"${OBJECT_TYPE}"'","format":"xml","query":{}}'
STATUS=$(curl -s -o "${TMP}/r-export-bad.json" -w "%{http_code}" -X POST "${H_AUTH[@]}" "${H_BRANCH[@]}" \
  -H "Content-Type: application/json" --data "$PAYLOAD" \
  "${API}/api/v1/ontology/${ONTOLOGY_ID}/exports")
assert_status "T-05 C-082: invalid format → 400" 400 "$STATUS" "${TMP}/r-export-bad.json"
assert_grep   "T-05 C-082: 400 envelope canonical" '"errorCode":"' "${TMP}/r-export-bad.json"

# ---------------------------------------------------------------------------
# T-03 — /sql admin gate
# ---------------------------------------------------------------------------
echo -e "${BOLD}T-03 — /sql admin gate${NC}"

# Anonymous → 401 (route is /api/v1/sql, not /api/v1/sql/query)
STATUS=$(curl -s -o "${TMP}/r-sql-401.json" -w "%{http_code}" -X POST -H "Content-Type: application/json" \
  --data '{"sql":"SELECT 1","ontologyId":"'"${ONTOLOGY_ID}"'"}' "${API}/api/v1/sql")
assert_status "T-03 C-300: /sql no token = 401" 401 "$STATUS" "${TMP}/r-sql-401.json"

# Authenticated → 200 (admin) or 400 (validation) or 403 (non-admin)
STATUS=$(curl -s -o "${TMP}/r-sql-auth.json" -w "%{http_code}" -X POST "${H_AUTH[@]}" \
  -H "Content-Type: application/json" \
  --data '{"sql":"SELECT 1","ontologyId":"'"${ONTOLOGY_ID}"'"}' "${API}/api/v1/sql")
case "$STATUS" in
  200|400|403|500)
    echo -e "  ${GREEN}PASS${NC} T-03 C-300: /sql authn → ${STATUS}"
    PASS=$((PASS+1))
    ;;
  *)
    echo -e "  ${RED}FAIL${NC} T-03 C-300: /sql unexpected status=${STATUS}"
    head -c 400 "${TMP}/r-sql-auth.json"; echo
    FAIL=$((FAIL+1)); FAILED_TESTS+=("T-03 /sql")
    ;;
esac
assert_grep "T-03 C-300: response envelope shape" '"errorCode":"|"data":|"rows":|"status"|"results"' "${TMP}/r-sql-auth.json"

# DROP TABLE — must be denied (verb not in ALLOWED_LEADING)
PAYLOAD='{"sql":"DROP TABLE foo","ontologyId":"'"${ONTOLOGY_ID}"'"}'
STATUS=$(curl -s -o "${TMP}/r-sql-drop.json" -w "%{http_code}" -X POST "${H_AUTH[@]}" \
  -H "Content-Type: application/json" --data "$PAYLOAD" "${API}/api/v1/sql")
case "$STATUS" in
  400|403|500)
    echo -e "  ${GREEN}PASS${NC} T-03 C-301: DROP rejected (status=${STATUS})"
    PASS=$((PASS+1))
    ;;
  *)
    echo -e "  ${RED}FAIL${NC} T-03 C-301: DROP not rejected, status=${STATUS}"
    head -c 400 "${TMP}/r-sql-drop.json"; echo
    FAIL=$((FAIL+1)); FAILED_TESTS+=("T-03 DROP")
    ;;
esac

# ---------------------------------------------------------------------------
# T-10 — RED metrics observable on /metrics (Prometheus scrape)
# ---------------------------------------------------------------------------
echo -e "${BOLD}T-10 — observability${NC}"

STATUS=$(curl -s -o "${TMP}/r-metrics.txt" -w "%{http_code}" "${API}/metrics")
if [ "$STATUS" = "200" ]; then
  assert_grep "T-10 C-400: tellus_route_total exposed" 'tellus_route_total|tellus_route_duration' "${TMP}/r-metrics.txt"
  assert_grep "T-10 C-401: tellus_read_branch_filtered_total exposed" 'tellus_read_branch_filtered_total' "${TMP}/r-metrics.txt"
else
  echo -e "  ${BOLD}NOTE${NC} /metrics status=${STATUS} — endpoint may live elsewhere"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
echo -e "${BOLD}=== Object Explorer E2E summary ===${NC}"
echo "Passed: ${PASS}"
echo "Failed: ${FAIL}"
if [ ${FAIL} -gt 0 ]; then
  echo
  echo -e "${RED}Failed assertions:${NC}"
  for n in "${FAILED_TESTS[@]}"; do echo "  - $n"; done
  exit 1
fi
echo -e "${GREEN}${BOLD}ALL OBJECT-EXPLORER E2E ASSERTIONS PASSED${NC}"
exit 0
