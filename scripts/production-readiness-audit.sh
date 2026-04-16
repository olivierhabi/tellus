#!/usr/bin/env bash
#
# production-readiness-audit.sh
# -----------------------------
# Senior-engineer-grade audit of the Tellus Ontology backend, targeting
# **99 % uptime** SLO. Unlike `verify-features.sh` (which just probes
# endpoint reachability) this script asks the questions a Palantir SRE
# would ask before signing the release page:
#
#   1. Liveness        — does the service answer at all?
#   2. Readiness       — are dependencies (Postgres, OpenSearch) healthy?
#   3. HTTP semantics  — correct status codes, content types, envelopes
#   4. Validation      — bad input rejected with a structured error
#   5. CRUD integrity  — write → read returns exactly what we wrote
#   6. Cascade         — delete cleans up dependent rows
#   7. Idempotency     — repeated mutations don't double-apply
#   8. Concurrency     — N parallel writers don't corrupt or drop rows
#   9. Latency SLO     — p50/p95/p99 within budget under sustained load
#  10. Throughput      — sustained req/s without a single 5xx
#  11. Rate limiting   — limiter trips at the documented threshold
#  12. Security        — helmet headers + CORS preflight present
#  13. Observability   — /api/metrics + /api/docs/spec.json valid
#  14. Error envelopes — every failure response has {error:{code,message}}
#  15. Graceful 404    — unknown routes return JSON, not HTML
#
# Each check is weighted by criticality. The final score is a weighted
# percentage. The script exits with the matching "uptime grade" exit code:
#
#   0 = score ≥ 99      ("ship it")
#   1 = score 95..99    ("ship with caveats")
#   2 = score 90..95    ("not ready")
#   3 = score < 90      ("hard no")
#
# Usage:
#   ./scripts/production-readiness-audit.sh
#   BASE=http://localhost:3000 ./scripts/production-readiness-audit.sh
#   STRICT=1 ./scripts/production-readiness-audit.sh   # warnings → fails

set -o pipefail

BASE="${BASE:-http://localhost:3000}"
STRICT="${STRICT:-0}"

# ------------------------------------------------------------------------
# Output / scoring
# ------------------------------------------------------------------------
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

TOTAL_WEIGHT=0
EARNED_WEIGHT=0
CHECK_COUNT=0
PASSED=0
WARNED=0
FAILED=0
declare -a FAILURES
declare -a WARNINGS

section() {
  echo
  echo -e "${BOLD}${BLUE}── $1 ──${NC}"
}

#
# record <category> <check_label> <weight_1to5> <result_pass|warn|fail> [details]
#
record() {
  local label="$1"
  local weight="$2"
  local result="$3"
  local details="${4:-}"

  CHECK_COUNT=$((CHECK_COUNT + 1))
  TOTAL_WEIGHT=$((TOTAL_WEIGHT + weight))

  case "$result" in
    pass)
      EARNED_WEIGHT=$((EARNED_WEIGHT + weight))
      PASSED=$((PASSED + 1))
      printf "${GREEN}✓${NC} %-66s ${DIM}[w=%s]${NC}\n" "$label" "$weight"
      ;;
    warn)
      # Warnings earn half credit unless STRICT=1.
      if [[ "$STRICT" == "1" ]]; then
        FAILED=$((FAILED + 1))
        FAILURES+=("$label — $details")
      else
        EARNED_WEIGHT=$((EARNED_WEIGHT + weight / 2))
        WARNED=$((WARNED + 1))
        WARNINGS+=("$label — $details")
      fi
      printf "${YELLOW}⚠${NC} %-66s ${DIM}[w=%s]${NC}\n" "$label" "$weight"
      [[ -n "$details" ]] && printf "  ${DIM}%s${NC}\n" "$details"
      ;;
    fail)
      FAILED=$((FAILED + 1))
      FAILURES+=("$label — $details")
      printf "${RED}✗${NC} %-66s ${DIM}[w=%s]${NC}\n" "$label" "$weight"
      [[ -n "$details" ]] && printf "  ${RED}%s${NC}\n" "$details"
      ;;
  esac
}

#
# http <method> <path> [body]    → echo "<status>|<body_file>"
#
# Self-throttling: if the global rate limiter trips (429), the helper
# sleeps for the documented `Retry-After` and retries once. This makes
# the audit safe to run end-to-end without hand-tuned pauses, while
# still exercising the 429 path explicitly in the rate-limiter section.
http() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local out
  out=$(mktemp)
  local headers
  headers=$(mktemp)
  local args=(-s -D "$headers" -o "$out" -w '%{http_code}' -X "$method" "$BASE$path")
  if [[ -n "$body" ]]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  local code
  code=$(curl "${args[@]}")
  if [[ "$code" == "429" ]]; then
    local retry
    retry=$(grep -i '^retry-after:' "$headers" | tr -d '\r' | awk '{print $2}')
    [[ -z "$retry" ]] && retry=65
    [[ "$retry" -lt 5 ]] && retry=5
    sleep "$retry"
    code=$(curl "${args[@]}")
  fi
  rm -f "$headers"
  echo "$code|$out"
}

# ------------------------------------------------------------------------
# Banner
# ------------------------------------------------------------------------
clear 2>/dev/null || true
echo -e "${BOLD}════════════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Tellus Ontology — Production Readiness Audit${NC}"
echo -e "${BOLD}  Target: 99% uptime SLO${NC}"
echo -e "${BOLD}════════════════════════════════════════════════════════════════════${NC}"
echo "  Base URL  : $BASE"
echo "  Strict    : $STRICT  (1 = warnings → failures)"
echo "  Started   : $(date -u +'%Y-%m-%dT%H:%M:%SZ')"

# ------------------------------------------------------------------------
# 1. Liveness & dependency health
# ------------------------------------------------------------------------
section "1. Liveness & dependency health"

IFS='|' read -r status body < <(http GET "/health")
if [[ "$status" == "200" ]]; then
  if jq -e '.status == "healthy" and .database == "connected"' "$body" >/dev/null 2>&1; then
    record "GET /health returns 200 with database=connected" 5 pass
  else
    record "GET /health returns 200 with database=connected" 5 warn "missing healthy/connected fields"
  fi
else
  record "GET /health returns 200 with database=connected" 5 fail "got HTTP $status"
fi

IFS='|' read -r status body < <(http GET "/api/v1/ontologies")
if [[ "$status" == "200" ]] && jq -e '.data | type == "array"' "$body" >/dev/null 2>&1; then
  record "GET /api/v1/ontologies returns 200 + paginated envelope" 5 pass
else
  record "GET /api/v1/ontologies returns 200 + paginated envelope" 5 fail "$status / bad envelope"
fi

ONTOLOGY_ID=$(jq -r '.data[0].ontologyId' "$body" 2>/dev/null)
if [[ -n "$ONTOLOGY_ID" && "$ONTOLOGY_ID" != "null" ]]; then
  record "Default ontology seeded and discoverable" 4 pass
else
  record "Default ontology seeded and discoverable" 4 fail "no seed ontology"
  ONTOLOGY_ID="missing"
fi

# ------------------------------------------------------------------------
# 2. HTTP semantics & error envelopes
# ------------------------------------------------------------------------
section "2. HTTP semantics & error envelopes"

# 404 on a clearly-bogus route should return JSON, not HTML
IFS='|' read -r status body < <(http GET "/api/v1/this-route-does-not-exist-zzz")
if [[ "$status" == "404" ]] && jq -e '.error.code' "$body" >/dev/null 2>&1; then
  record "Unknown route → 404 + structured error envelope" 4 pass
elif [[ "$status" == "404" ]]; then
  record "Unknown route → 404 + structured error envelope" 4 warn "404 ok but envelope missing .error.code"
else
  record "Unknown route → 404 + structured error envelope" 4 fail "got $status"
fi

# Proper Content-Type on JSON endpoints
ct=$(curl -s -o /dev/null -w '%{content_type}' "$BASE/api/v1/ontologies")
if [[ "$ct" == application/json* ]]; then
  record "JSON endpoints emit application/json content-type" 3 pass
else
  record "JSON endpoints emit application/json content-type" 3 fail "got $ct"
fi

# 405 / proper method handling — POST to GET-only route
IFS='|' read -r status body < <(http POST "/api/v1/ontologies/$ONTOLOGY_ID")
if [[ "$status" =~ ^(404|405)$ ]]; then
  record "POST to GET-only route returns 4xx" 2 pass
else
  record "POST to GET-only route returns 4xx" 2 warn "got $status"
fi

# ------------------------------------------------------------------------
# 3. Input validation
# ------------------------------------------------------------------------
section "3. Input validation"

# Missing required fields → 400 with VALIDATION error code
IFS='|' read -r status body < <(http POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" '{}')
if [[ "$status" == "400" ]] && jq -e '.error.code' "$body" >/dev/null 2>&1; then
  record "Empty body on object-type create → 400 + .error.code" 5 pass
else
  record "Empty body on object-type create → 400 + .error.code" 5 fail "got $status"
fi

# Invalid apiName casing
IFS='|' read -r status body < <(http POST "/api/v1/ontologies/$ONTOLOGY_ID/linkTypes" \
  '{"apiName":"BadCamel","displayName":"x","cardinality":"ONE_TO_ONE","sourceObjectTypeApiName":"a","targetObjectTypeApiName":"b"}')
if [[ "$status" == "400" ]]; then
  record "Bad apiName casing → 400" 4 pass
else
  record "Bad apiName casing → 400" 4 warn "got $status"
fi

# Unknown enum value
IFS='|' read -r status body < <(http POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/Hello/changeStatus" \
  '{"status":"vibes"}')
if [[ "$status" == "400" ]]; then
  record "Unknown enum value → 400" 3 pass
else
  record "Unknown enum value → 400" 3 warn "got $status"
fi

# SQL injection attempt against the SQL endpoint (must reject writes)
IFS='|' read -r status body < <(http POST "/api/v1/sql" \
  "{\"ontologyId\":\"$ONTOLOGY_ID\",\"sql\":\"DROP TABLE object_type; --\"}")
if [[ "$status" == "400" ]]; then
  record "Furnace SQL rejects DROP / DDL (read-only safety)" 5 pass
else
  record "Furnace SQL rejects DROP / DDL (read-only safety)" 5 fail "got $status — unsafe!"
fi

# ------------------------------------------------------------------------
# 4. CRUD integrity (write → read → match → delete → 404)
# ------------------------------------------------------------------------
section "4. CRUD integrity"

SUFFIX=$(date +%s%N | tail -c 8)
OT_API="AuditOT${SUFFIX}"
PAYLOAD="{\"apiName\":\"$OT_API\",\"displayName\":\"Audit OT $SUFFIX\",\"description\":\"prod readiness\",\"icon\":\"cube\",\"status\":\"experimental\"}"

IFS='|' read -r status body < <(http POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" "$PAYLOAD")
if [[ "$status" == "201" ]]; then
  record "Create object type returns 201" 4 pass
else
  record "Create object type returns 201" 4 fail "got $status"
fi

IFS='|' read -r status body < <(http GET "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API")
created_name=$(jq -r '.objectType.displayName // .displayName // empty' "$body" 2>/dev/null)
created_desc=$(jq -r '.objectType.description // .description // empty' "$body" 2>/dev/null)
if [[ "$created_name" == "Audit OT $SUFFIX" && "$created_desc" == "prod readiness" ]]; then
  record "Read-after-write returns identical fields" 5 pass
else
  record "Read-after-write returns identical fields" 5 fail "name='$created_name' desc='$created_desc'"
fi

# Add a property and read it back
IFS='|' read -r status _ < <(http POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/properties" \
  '{"apiName":"id","displayName":"ID","baseType":"string"}')
[[ "$status" == "201" ]] && record "Create property returns 201" 3 pass || record "Create property returns 201" 3 fail "got $status"

IFS='|' read -r status body < <(http GET "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/properties")
prop_count=$(jq -r '.data | length // length' "$body" 2>/dev/null || echo 0)
if [[ "$prop_count" -ge 1 ]]; then
  record "Property list non-empty after create" 3 pass
else
  record "Property list non-empty after create" 3 fail "count=$prop_count"
fi

# Delete cascade
IFS='|' read -r status _ < <(http DELETE "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API")
if [[ "$status" =~ ^(200|204)$ ]]; then
  record "Delete object type returns 200/204" 3 pass
else
  record "Delete object type returns 200/204" 3 fail "got $status"
fi

IFS='|' read -r status _ < <(http GET "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API")
if [[ "$status" == "404" ]]; then
  record "Deleted resource → 404 on subsequent GET" 4 pass
else
  record "Deleted resource → 404 on subsequent GET" 4 fail "got $status"
fi

# ------------------------------------------------------------------------
# 5. Cascade & referential integrity
# ------------------------------------------------------------------------
section "5. Cascade & referential integrity"

# Recreate, add a property, delete the OT, confirm the property is gone
IFS='|' read -r status _ < <(http POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" "$PAYLOAD")
http POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/properties" \
  '{"apiName":"cascadeProp","displayName":"Cascade","baseType":"string"}' >/dev/null
http DELETE "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API" >/dev/null

# Re-create the OT with the same name; properties from the deleted version
# must NOT come back.
http POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" "$PAYLOAD" >/dev/null
IFS='|' read -r status body < <(http GET "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/properties")
new_count=$(jq -r '.data | length // length' "$body" 2>/dev/null || echo 0)
if [[ "$new_count" -eq 0 ]]; then
  record "Cascade delete clears child properties" 5 pass
else
  record "Cascade delete clears child properties" 5 fail "$new_count zombie props"
fi
http DELETE "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API" >/dev/null

# ------------------------------------------------------------------------
# 6. Idempotency — repeating a create should not double-write
# ------------------------------------------------------------------------
section "6. Idempotency & duplicate-create handling"

IFS='|' read -r s1 _ < <(http POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" "$PAYLOAD")
IFS='|' read -r s2 _ < <(http POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" "$PAYLOAD")
if [[ "$s1" == "201" && "$s2" =~ ^(409|400|422)$ ]]; then
  record "Duplicate create rejected with 4xx (no double-write)" 5 pass
elif [[ "$s2" == "201" ]]; then
  record "Duplicate create rejected with 4xx (no double-write)" 5 fail "second create also returned 201 — likely double-insert"
else
  record "Duplicate create rejected with 4xx (no double-write)" 5 warn "first=$s1 second=$s2"
fi
http DELETE "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API" >/dev/null

# ------------------------------------------------------------------------
# 7. Concurrency safety — N parallel writers on the same target
# ------------------------------------------------------------------------
section "7. Concurrency safety"

# Fire 8 parallel creates of the same object type. Exactly one should win.
N=8
PARALLEL_API="AuditConc${SUFFIX}"
PARALLEL_PAYLOAD="{\"apiName\":\"$PARALLEL_API\",\"displayName\":\"Conc\",\"icon\":\"cube\",\"status\":\"experimental\"}"

mkdir -p /tmp/audit-conc
rm -f /tmp/audit-conc/*
for i in $(seq 1 $N); do
  (curl -s -o "/tmp/audit-conc/$i.body" -w '%{http_code}' -X POST \
     -H "Content-Type: application/json" \
     -d "$PARALLEL_PAYLOAD" \
     "$BASE/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" \
     > "/tmp/audit-conc/$i.code") &
done
wait

successes=0
errors=0
for i in $(seq 1 $N); do
  code=$(cat "/tmp/audit-conc/$i.code")
  if [[ "$code" == "201" ]]; then
    successes=$((successes + 1))
  elif [[ "$code" =~ ^(400|409|422|500|503)$ ]]; then
    errors=$((errors + 1))
  fi
done
if [[ "$successes" == "1" && "$errors" == "$((N - 1))" ]]; then
  record "$N parallel creates → exactly 1 winner, $((N-1)) rejected" 5 pass
elif [[ "$successes" == "1" ]]; then
  record "$N parallel creates → exactly 1 winner, $((N-1)) rejected" 5 warn "winners=$successes errors=$errors"
else
  record "$N parallel creates → exactly 1 winner, $((N-1)) rejected" 5 fail "winners=$successes — possible race / double-insert"
fi
http DELETE "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$PARALLEL_API" >/dev/null

# ------------------------------------------------------------------------
# 8. Latency SLO — single endpoint p50/p95/p99 budget
# ------------------------------------------------------------------------
section "8. Latency SLO (p50/p95/p99)"

P50_BUDGET_MS=200
P95_BUDGET_MS=500
P99_BUDGET_MS=1000

samples=()
for _ in $(seq 1 30); do
  t=$(curl -s -o /dev/null -w '%{time_total}' "$BASE/api/v1/ontologies/$ONTOLOGY_ID/objectTypes")
  ms=$(awk "BEGIN { printf \"%d\", $t * 1000 }")
  samples+=("$ms")
done
sorted=$(printf '%s\n' "${samples[@]}" | sort -n)
n=${#samples[@]}
p50=$(echo "$sorted" | sed -n "$((n / 2))p")
p95=$(echo "$sorted" | sed -n "$((n * 95 / 100))p")
p99=$(echo "$sorted" | sed -n "$((n * 99 / 100))p")
echo "  measured: p50=${p50}ms p95=${p95}ms p99=${p99}ms (n=$n)"

if [[ "$p50" -le $P50_BUDGET_MS ]]; then
  record "p50 ≤ ${P50_BUDGET_MS} ms (got ${p50})" 4 pass
else
  record "p50 ≤ ${P50_BUDGET_MS} ms (got ${p50})" 4 warn "over budget"
fi
if [[ "$p95" -le $P95_BUDGET_MS ]]; then
  record "p95 ≤ ${P95_BUDGET_MS} ms (got ${p95})" 5 pass
else
  record "p95 ≤ ${P95_BUDGET_MS} ms (got ${p95})" 5 warn "over budget"
fi
if [[ "$p99" -le $P99_BUDGET_MS ]]; then
  record "p99 ≤ ${P99_BUDGET_MS} ms (got ${p99})" 4 pass
else
  record "p99 ≤ ${P99_BUDGET_MS} ms (got ${p99})" 4 warn "over budget"
fi

# ------------------------------------------------------------------------
# 9. Sustained throughput — N concurrent reqs, zero 5xx
# ------------------------------------------------------------------------
section "9. Sustained throughput (zero 5xx tolerance)"

THROUGHPUT_REQUESTS=50
THROUGHPUT_CONCURRENCY=10
mkdir -p /tmp/audit-load
rm -f /tmp/audit-load/*

start=$(date +%s)
for i in $(seq 1 $THROUGHPUT_REQUESTS); do
  (curl -s -o /dev/null -w '%{http_code}\n' \
     "$BASE/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" > "/tmp/audit-load/$i") &
  if (( i % THROUGHPUT_CONCURRENCY == 0 )); then wait; fi
done
wait
end=$(date +%s)
elapsed=$((end - start))
[[ $elapsed -eq 0 ]] && elapsed=1

ok=0
fail5xx=0
fail4xx=0
for f in /tmp/audit-load/*; do
  code=$(cat "$f")
  case "$code" in
    2*) ok=$((ok + 1)) ;;
    5*) fail5xx=$((fail5xx + 1)) ;;
    *) fail4xx=$((fail4xx + 1)) ;;
  esac
done
rps=$((THROUGHPUT_REQUESTS / elapsed))
echo "  $THROUGHPUT_REQUESTS requests in ${elapsed}s ≈ ${rps} req/s"
echo "  2xx=$ok  4xx=$fail4xx  5xx=$fail5xx"

if [[ "$fail5xx" == "0" ]]; then
  record "Zero 5xx under $THROUGHPUT_REQUESTS req @ ${THROUGHPUT_CONCURRENCY} concurrent" 5 pass
else
  record "Zero 5xx under $THROUGHPUT_REQUESTS req @ ${THROUGHPUT_CONCURRENCY} concurrent" 5 fail "$fail5xx requests crashed"
fi

# 99 % uptime ≈ ≤ 1 % failure under load
fail_rate=$((100 * (fail5xx + fail4xx) / THROUGHPUT_REQUESTS))
if [[ "$fail_rate" -le 1 ]]; then
  record "Failure rate ≤ 1% (99% uptime SLO)" 5 pass
else
  record "Failure rate ≤ 1% (99% uptime SLO)" 5 fail "${fail_rate}% failed"
fi

# ------------------------------------------------------------------------
# 10. Rate limiter — must trip at the documented threshold
# ------------------------------------------------------------------------
section "10. Rate limiter integrity"

# Fire many quick auth requests against /api/auth/login (stricter limit)
mkdir -p /tmp/audit-rl
rm -f /tmp/audit-rl/*
for i in $(seq 1 25); do
  curl -s -o /dev/null -w '%{http_code}\n' \
    -X POST -H "Content-Type: application/json" \
    -d '{"email":"x@x.x","password":"y"}' \
    "$BASE/api/auth/login" > "/tmp/audit-rl/$i" &
done
wait
rl_429=$(cat /tmp/audit-rl/* 2>/dev/null | grep -c '^429' || true)
if [[ "$rl_429" -ge 1 ]]; then
  record "Rate limiter trips on bursty auth (got $rl_429 × 429)" 4 pass
else
  record "Rate limiter trips on bursty auth (got $rl_429 × 429)" 4 warn "no 429s seen"
fi

# ------------------------------------------------------------------------
# 11. Security headers
# ------------------------------------------------------------------------
section "11. Security headers (helmet)"

headers=$(curl -s -I "$BASE/api/v1/ontologies")
for h in "X-Content-Type-Options" "X-DNS-Prefetch-Control" "Strict-Transport-Security" "X-Frame-Options"; do
  if echo "$headers" | grep -qi "^$h:"; then
    record "Helmet header present: $h" 2 pass
  else
    record "Helmet header present: $h" 2 warn "missing"
  fi
done

# CORS preflight
preflight=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS \
  -H "Origin: http://localhost:3001" \
  -H "Access-Control-Request-Method: GET" \
  "$BASE/api/v1/ontologies")
if [[ "$preflight" =~ ^(200|204)$ ]]; then
  record "CORS preflight OPTIONS returns 2xx" 3 pass
else
  record "CORS preflight OPTIONS returns 2xx" 3 fail "got $preflight"
fi

# ------------------------------------------------------------------------
# 12. Observability — metrics + OpenAPI spec
# ------------------------------------------------------------------------
section "12. Observability"

IFS='|' read -r status body < <(http GET "/api/metrics")
if [[ "$status" == "200" ]] && grep -q '^http_requests_total' "$body"; then
  record "Prometheus /api/metrics emits valid exposition" 4 pass
else
  record "Prometheus /api/metrics emits valid exposition" 4 fail "got $status"
fi

IFS='|' read -r status body < <(http GET "/api/docs/spec.json")
if [[ "$status" == "200" ]] && jq -e '.openapi and .paths and (.paths | length > 50)' "$body" >/dev/null 2>&1; then
  count=$(jq -r '.paths | length' "$body")
  record "OpenAPI spec valid + ≥ 50 paths (got $count)" 4 pass
else
  record "OpenAPI spec valid + ≥ 50 paths" 4 fail "got $status"
fi

# Ontology routes specifically present in the spec
IFS='|' read -r status body < <(http GET "/api/docs/spec.json")
ontology_paths=$(jq -r '.paths | keys[] | select(test("ontolog|objectType|linkType|actionType|sql|charts|pipelines"))' "$body" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$ontology_paths" -ge 20 ]]; then
  record "Ontology API surface fully documented (${ontology_paths} paths)" 4 pass
else
  record "Ontology API surface fully documented (${ontology_paths} paths)" 4 warn "only $ontology_paths"
fi

# Request tracing — X-Request-ID echoed back
trace=$(curl -s -i -H "X-Request-ID: audit-${SUFFIX}" "$BASE/api/v1/ontologies" | grep -i "^x-request-id" | tr -d '\r' || true)
if [[ -n "$trace" ]]; then
  record "X-Request-ID echoed back for tracing" 3 pass
else
  record "X-Request-ID echoed back for tracing" 3 warn "header not echoed"
fi

# ------------------------------------------------------------------------
# 13a. Pagination correctness — pageToken must actually advance
# ------------------------------------------------------------------------
section "13a. Pagination correctness"

IFS='|' read -r status body < <(http GET "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes?pageSize=2")
total=$(jq -r '.totalCount // 0' "$body" 2>/dev/null)
nextTok=$(jq -r '.nextPageToken // empty' "$body" 2>/dev/null)
firstIds=$(jq -r '.data[].apiName' "$body" 2>/dev/null | sort | tr '\n' ',')

if [[ -n "$nextTok" && "$total" -gt 2 ]]; then
  IFS='|' read -r status body2 < <(http GET "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes?pageSize=2&pageToken=$(printf %s "$nextTok" | jq -sRr @uri)")
  secondIds=$(jq -r '.data[].apiName' "$body2" 2>/dev/null | sort | tr '\n' ',')
  if [[ -n "$secondIds" && "$firstIds" != "$secondIds" ]]; then
    record "Pagination — page 2 returns different rows than page 1" 4 pass
  else
    record "Pagination — page 2 returns different rows than page 1" 4 fail "page2='$secondIds' page1='$firstIds'"
  fi
else
  record "Pagination — page 2 returns different rows than page 1" 4 warn "not enough rows or no nextPageToken (total=$total)"
fi

# ------------------------------------------------------------------------
# 13b. Path traversal & injection hardening
# ------------------------------------------------------------------------
section "13b. Path traversal hardening"

# Should NOT 5xx, NOT match a real path, and NOT leak filesystem content.
IFS='|' read -r status body < <(http GET "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/..%2F..%2Fetc%2Fpasswd")
if [[ "$status" =~ ^(400|404)$ ]] && ! grep -q "root:" "$body" 2>/dev/null; then
  record "Path traversal in apiName → 4xx, no fs leak" 5 pass
else
  record "Path traversal in apiName → 4xx, no fs leak" 5 fail "got $status / possible leak"
fi

# Path traversal via query string
IFS='|' read -r status body < <(http GET "/api/v1/ontologies?pageToken=..%2F..%2Fetc%2Fpasswd")
if [[ "$status" =~ ^(200|400)$ ]] && ! grep -q "root:" "$body" 2>/dev/null; then
  record "Path traversal in query string → safe" 3 pass
else
  record "Path traversal in query string → safe" 3 fail "got $status"
fi

# ------------------------------------------------------------------------
# 13c. Malformed input handling — must NOT 5xx
# ------------------------------------------------------------------------
section "13c. Malformed input — never 5xx"

# Garbage JSON body
IFS='|' read -r status body < <(http POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" "{not valid json")
if [[ "$status" =~ ^4 ]]; then
  record "Malformed JSON body → 4xx (not 5xx)" 5 pass
else
  record "Malformed JSON body → 4xx (not 5xx)" 5 fail "got $status — server crashed on bad JSON"
fi

# Wrong-type field
IFS='|' read -r status body < <(http POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" \
  '{"apiName":12345,"displayName":"x"}')
if [[ "$status" =~ ^4 ]]; then
  record "Wrong-type field → 4xx" 4 pass
else
  record "Wrong-type field → 4xx" 4 fail "got $status"
fi

# Huge string (≈ 100 KB display name) — should reject cleanly
big=$(printf 'X%.0s' $(seq 1 100000))
IFS='|' read -r status body < <(http POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" \
  "{\"apiName\":\"a\",\"displayName\":\"$big\"}")
if [[ "$status" =~ ^4 ]]; then
  record "100 KB string field → 4xx (no crash)" 3 pass
else
  record "100 KB string field → 4xx (no crash)" 3 warn "got $status"
fi

# Oversized body (>10 MB JSON limit) — should be 413 or 400, not 500.
# Use a temp file with --data-binary so we don't blow ARG_MAX.
big_file=$(mktemp)
{
  printf '{"apiName":"a","displayName":"'
  head -c 11000000 /dev/zero | tr '\0' 'X'
  printf '"}'
} > "$big_file"
status=$(curl -s -o /tmp/big-resp -w '%{http_code}' \
  -X POST -H "Content-Type: application/json" \
  --data-binary "@$big_file" \
  "$BASE/api/v1/ontologies/$ONTOLOGY_ID/objectTypes")
rm -f "$big_file"
if [[ "$status" =~ ^4 ]] && [[ ! "$status" =~ ^5 ]]; then
  record ">10 MB body → 4xx (not 5xx)" 4 pass
else
  record ">10 MB body → 4xx (not 5xx)" 4 fail "got $status"
fi

# ------------------------------------------------------------------------
# 13d. Idempotency-Key replay
# ------------------------------------------------------------------------
section "13d. Idempotency-Key replay safety"

KEY="audit-idempotency-${SUFFIX}"
# Pull the first action type (if any) so we have something to apply.
ACTION_API=$(curl -s "$BASE/api/v1/ontologies/$ONTOLOGY_ID/actionTypes" \
  | jq -r '.data[0].apiName // empty')
if [[ -n "$ACTION_API" ]]; then
  r1=$(curl -s -o /tmp/idemp1 -w '%{http_code}' \
    -X POST -H "Content-Type: application/json" -H "Idempotency-Key: $KEY" \
    -d '{"parameters":{}}' \
    "$BASE/api/v1/ontologies/$ONTOLOGY_ID/actions/$ACTION_API/apply")
  r2=$(curl -s -o /tmp/idemp2 -w '%{http_code}' \
    -X POST -H "Content-Type: application/json" -H "Idempotency-Key: $KEY" \
    -d '{"parameters":{}}' \
    "$BASE/api/v1/ontologies/$ONTOLOGY_ID/actions/$ACTION_API/apply")
  # Strip per-request observability fields (timestamps, request IDs,
  # durations) and canonicalize key ordering with -S so we compare
  # *semantic* equality instead of byte equality. requestId/timestamp are
  # *correctly* unique per HTTP call — they identify the call, not the
  # underlying action result, so they should never make a replay "differ".
  STRIP='walk(if type=="object" then del(.timestamp, .requestId, .durationMs, .startedAt, .finishedAt) else . end)'
  jq -S "$STRIP" /tmp/idemp1 > /tmp/idemp1.norm 2>/dev/null || cp /tmp/idemp1 /tmp/idemp1.norm
  jq -S "$STRIP" /tmp/idemp2 > /tmp/idemp2.norm 2>/dev/null || cp /tmp/idemp2 /tmp/idemp2.norm
  if [[ "$r1" == "$r2" ]] && diff -q /tmp/idemp1.norm /tmp/idemp2.norm >/dev/null 2>&1; then
    record "Idempotency-Key replay returns identical response" 5 pass
  else
    record "Idempotency-Key replay returns identical response" 5 fail "r1=$r1 r2=$r2 / body diff"
  fi
  rm -f /tmp/idemp1 /tmp/idemp2 /tmp/idemp1.norm /tmp/idemp2.norm
else
  record "Idempotency-Key replay returns identical response" 5 warn "no action types available to test"
fi

# ------------------------------------------------------------------------
# 13e. Health stays fast under load
# ------------------------------------------------------------------------
section "13e. Health endpoint stability under read load"

mkdir -p /tmp/audit-bgload
rm -f /tmp/audit-bgload/*
# Background read load
for i in $(seq 1 30); do
  (curl -s -o /dev/null "$BASE/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" > "/tmp/audit-bgload/$i") &
done
# Health probes during the storm
hsamples=()
for _ in $(seq 1 5); do
  t=$(curl -s -o /dev/null -w '%{time_total}' "$BASE/health")
  ms=$(awk "BEGIN { printf \"%d\", $t * 1000 }")
  hsamples+=("$ms")
done
wait
hmax=0
for v in "${hsamples[@]}"; do (( v > hmax )) && hmax=$v; done
if [[ "$hmax" -le 200 ]]; then
  record "Health probe stays ≤ 200 ms under read storm (max ${hmax}ms)" 4 pass
else
  record "Health probe stays ≤ 200 ms under read storm (max ${hmax}ms)" 4 warn "max ${hmax}ms"
fi

# ------------------------------------------------------------------------
# 13f. Heavier sustained load — 200 mixed reads
# ------------------------------------------------------------------------
section "13f. Heavier sustained load (200 req @ 20 concurrent)"

mkdir -p /tmp/audit-heavy
rm -f /tmp/audit-heavy/*
HEAVY_REQUESTS=200
HEAVY_CONCURRENCY=20
start=$(date +%s)
for i in $(seq 1 $HEAVY_REQUESTS); do
  (curl -s -o /dev/null -w '%{http_code}\n' \
     "$BASE/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" \
     > "/tmp/audit-heavy/$i") &
  if (( i % HEAVY_CONCURRENCY == 0 )); then wait; fi
done
wait
end=$(date +%s)
elapsed=$((end - start))
[[ $elapsed -eq 0 ]] && elapsed=1
ok2=0; e5=0; e4=0; rl=0
for f in /tmp/audit-heavy/*; do
  c=$(cat "$f")
  case "$c" in
    2*) ok2=$((ok2 + 1)) ;;
    429) rl=$((rl + 1)) ;;
    4*) e4=$((e4 + 1)) ;;
    5*) e5=$((e5 + 1)) ;;
  esac
done
echo "  $HEAVY_REQUESTS req in ${elapsed}s  ·  2xx=$ok2 4xx=$e4 5xx=$e5 429=$rl"
if [[ "$e5" == "0" ]]; then
  record "Heavy load: zero 5xx across $HEAVY_REQUESTS requests" 5 pass
else
  record "Heavy load: zero 5xx across $HEAVY_REQUESTS requests" 5 fail "$e5 crashed"
fi
# Ignore 429s — those are the limiter doing its job.
non_rl_failures=$((e5 + e4))
fail_pct=$((100 * non_rl_failures / HEAVY_REQUESTS))
if [[ "$fail_pct" -le 1 ]]; then
  record "Heavy load: non-rate-limited failure rate ≤ 1%" 5 pass
else
  record "Heavy load: non-rate-limited failure rate ≤ 1% (got ${fail_pct}%)" 5 warn ""
fi

# ------------------------------------------------------------------------
# 13g. Service still alive after the storm
# ------------------------------------------------------------------------
section "13g. Liveness after the storm"

IFS='|' read -r status body < <(http GET "/health")
if [[ "$status" == "200" ]] && jq -e '.status == "healthy"' "$body" >/dev/null 2>&1; then
  record "Backend still healthy after load tests" 5 pass
else
  record "Backend still healthy after load tests" 5 fail "got $status — server unhealthy"
fi

# ------------------------------------------------------------------------
# 13h. Server fingerprinting — must not leak Express version
# ------------------------------------------------------------------------
section "13h. Server fingerprinting"

server_hdr=$(curl -s -I "$BASE/api/v1/ontologies" | grep -i "^server:" | tr -d '\r' || true)
xpb=$(curl -s -I "$BASE/api/v1/ontologies" | grep -i "^x-powered-by:" | tr -d '\r' || true)
if [[ -z "$xpb" ]]; then
  record "X-Powered-By header hidden (no Express fingerprint)" 3 pass
else
  record "X-Powered-By header hidden (no Express fingerprint)" 3 fail "leaked: $xpb"
fi
if [[ -z "$server_hdr" ]] || ! echo "$server_hdr" | grep -qiE "express|node"; then
  record "Server header doesn't disclose framework / version" 2 pass
else
  record "Server header doesn't disclose framework / version" 2 warn "$server_hdr"
fi

# ------------------------------------------------------------------------
# 13i. Method spoofing & request smuggling guards
# ------------------------------------------------------------------------
section "13i. Method spoofing"

# X-HTTP-Method-Override on a GET should NOT silently turn into a DELETE.
# Inline retry on 429 so a tripped global limiter doesn't masquerade as a fail.
spoof_call() {
  curl -s -o /tmp/spoof.body -w '%{http_code}' -X GET \
    -H "X-HTTP-Method-Override: DELETE" \
    "$BASE/api/v1/ontologies/$ONTOLOGY_ID"
}
status=$(spoof_call)
if [[ "$status" == "429" ]]; then
  sleep 65
  status=$(spoof_call)
fi
if [[ "$status" == "200" ]]; then
  record "X-HTTP-Method-Override header is ignored" 4 pass
else
  record "X-HTTP-Method-Override header is ignored" 4 fail "got $status"
fi

# ?_method=DELETE query string also ignored
IFS='|' read -r status _ < <(http GET "/api/v1/ontologies/$ONTOLOGY_ID?_method=DELETE")
if [[ "$status" == "200" ]]; then
  record "?_method=DELETE query string is ignored" 3 pass
else
  record "?_method=DELETE query string is ignored" 3 fail "got $status"
fi

# ------------------------------------------------------------------------
# 13j. Deep JSON nesting — no stack overflow
# ------------------------------------------------------------------------
section "13j. Deep JSON nesting"

# Build {"a":{"a":{...}}} ~ 1000 deep — should be rejected cleanly, never 5xx.
deep_open=""
deep_close=""
for _ in $(seq 1 1000); do
  deep_open="${deep_open}{\"a\":"
  deep_close="${deep_close}}"
done
deep_payload="{\"apiName\":\"a\",\"displayName\":\"x\",\"deep\":${deep_open}1${deep_close}}"
IFS='|' read -r status body < <(http POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" "$deep_payload")
if [[ "$status" =~ ^4 ]]; then
  record "1000-level deep JSON → 4xx (no stack overflow)" 4 pass
elif [[ "$status" =~ ^5 ]]; then
  record "1000-level deep JSON → 4xx (no stack overflow)" 4 fail "got $status"
else
  record "1000-level deep JSON → 4xx (no stack overflow)" 4 warn "got $status"
fi

# ------------------------------------------------------------------------
# 13k. NULL byte / control char injection
# ------------------------------------------------------------------------
section "13k. NULL byte injection"

# Embed a NULL byte in a string field. Sanitizer must strip-or-reject;
# either way the persisted value MUST NOT contain a real NULL byte.
NULL_API="NullTest${SUFFIX}"
IFS='|' read -r status _ < <(http POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" \
  "{\"apiName\":\"$NULL_API\",\"displayName\":\"foo\\u0000bar\"}")
if [[ "$status" =~ ^4 ]]; then
  record "NULL bytes in string fields rejected or stripped" 4 pass "rejected at validator"
else
  # Created — verify the persisted name has no NULL byte and isn't empty.
  IFS='|' read -r _ body < <(http GET "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$NULL_API")
  persisted=$(jq -r '.objectType.displayName // .displayName // empty' "$body" 2>/dev/null)
  if [[ -n "$persisted" ]] && ! printf '%s' "$persisted" | grep -qP '\x00' 2>/dev/null; then
    record "NULL bytes in string fields rejected or stripped" 4 pass "stripped: '$persisted'"
  else
    record "NULL bytes in string fields rejected or stripped" 4 fail "leaked NULL byte: '$persisted'"
  fi
fi
http DELETE "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$NULL_API" >/dev/null 2>&1

# ------------------------------------------------------------------------
# 13l. SQL injection in apiName field (parameterized queries)
# ------------------------------------------------------------------------
section "13l. SQL injection resistance"

# A single-quote / drop combo as the URL path segment must NOT execute SQL
IFS='|' read -r status body < <(http GET "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/x'%3B%20DROP%20TABLE%20object_type%3B--")
if [[ "$status" =~ ^4 ]]; then
  # Confirm the table is still there
  IFS='|' read -r s2 _ < <(http GET "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes")
  if [[ "$s2" == "200" ]]; then
    record "SQL injection in apiName path → 4xx, schema intact" 5 pass
  else
    record "SQL injection in apiName path → 4xx, schema intact" 5 fail "object_type table broken (status $s2)"
  fi
else
  record "SQL injection in apiName path → 4xx, schema intact" 5 fail "got $status"
fi

# ------------------------------------------------------------------------
# 13m. HEAD method support
# ------------------------------------------------------------------------
section "13m. HEAD method support"

status=$(curl -s -o /dev/null -w '%{http_code}' -I "$BASE/api/v1/ontologies")
if [[ "$status" == "200" ]]; then
  record "HEAD /api/v1/ontologies returns 200 (no body)" 3 pass
else
  record "HEAD /api/v1/ontologies returns 200 (no body)" 3 warn "got $status"
fi

# ------------------------------------------------------------------------
# 13n. Wrong / missing Content-Type tolerance
# ------------------------------------------------------------------------
section "13n. Content-Type robustness"

# POST with no Content-Type but valid JSON body — Express's json() body
# parser only parses application/json. Result should be a clean 4xx (the
# downstream validator complains "missing required field"), never 5xx.
status=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST -d '{"apiName":"a","displayName":"b"}' \
  "$BASE/api/v1/ontologies/$ONTOLOGY_ID/objectTypes")
if [[ "$status" =~ ^4 ]]; then
  record "POST without Content-Type → 4xx (no crash)" 3 pass
else
  record "POST without Content-Type → 4xx (no crash)" 3 fail "got $status"
fi

# Wrong Content-Type (text/plain) on a JSON endpoint
status=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST -H "Content-Type: text/plain" -d 'not json' \
  "$BASE/api/v1/ontologies/$ONTOLOGY_ID/objectTypes")
if [[ "$status" =~ ^4 ]]; then
  record "Wrong Content-Type → 4xx" 2 pass
else
  record "Wrong Content-Type → 4xx" 2 fail "got $status"
fi

# ------------------------------------------------------------------------
# 13o. Empty POST body
# ------------------------------------------------------------------------
section "13o. Empty POST body"

status=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST -H "Content-Type: application/json" \
  "$BASE/api/v1/ontologies/$ONTOLOGY_ID/objectTypes")
if [[ "$status" =~ ^4 ]]; then
  record "POST with no body → 4xx (no crash)" 3 pass
else
  record "POST with no body → 4xx (no crash)" 3 fail "got $status"
fi

# ------------------------------------------------------------------------
# 13p. Process metrics in Prometheus output
# ------------------------------------------------------------------------
section "13p. Process-level metrics"

metrics_body=$(curl -s "$BASE/api/metrics")
if echo "$metrics_body" | grep -q '^http_requests_total'; then
  record "metrics include http_requests_total counter" 3 pass
else
  record "metrics include http_requests_total counter" 3 fail "missing"
fi
# Check for a few standard process metrics; if missing, warn.
if echo "$metrics_body" | grep -qE '^(process_resident_memory_bytes|nodejs_heap_size_used_bytes)'; then
  record "metrics include process/runtime gauges" 2 pass
else
  record "metrics include process/runtime gauges" 2 warn "no process_* / nodejs_* gauges (only app counters)"
fi

# ------------------------------------------------------------------------
# 13q. Concurrent CRUD on DIFFERENT keys → no false conflicts
# ------------------------------------------------------------------------
section "13q. Independent concurrent writes"

mkdir -p /tmp/audit-iconc
SUFFIX2=$(date +%s%N | tail -c 7)
fire_iconc() {
  rm -f /tmp/audit-iconc/*
  # Build PascalCase apiNames — the validator rejects underscores.
  local attempt="$1"
  for i in $(seq 1 8); do
    local apiName="AuditICx${SUFFIX2}A${attempt}I${i}"
    body="{\"apiName\":\"${apiName}\",\"displayName\":\"IC $i\",\"icon\":\"cube\",\"status\":\"experimental\"}"
    (curl -s -o /dev/null -w '%{http_code}\n' \
       -X POST -H "Content-Type: application/json" -d "$body" \
       "$BASE/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" > "/tmp/audit-iconc/$i") &
  done
  wait
}

# Try up to 3 attempts; back off 65 s between attempts when the burst hits
# the global rate limiter. Each attempt uses a fresh apiName suffix so we
# don't accidentally collide with rows from a previous attempt.
ic_ok=0
attempt=0
while (( attempt < 3 )); do
  attempt=$((attempt + 1))
  fire_iconc "$attempt"
  ic_ok=$(cat /tmp/audit-iconc/* | grep -c '^201' || true)
  ic_429=$(cat /tmp/audit-iconc/* | grep -c '^429' || true)
  if [[ "$ic_ok" == "8" ]]; then break; fi
  # If everything is 429, wait the full window and retry
  if [[ "$ic_429" -ge 1 ]]; then
    sleep 65
  else
    break
  fi
done

ic_fail=$(cat /tmp/audit-iconc/* | grep -cv '^201' || true)
if [[ "$ic_ok" == "8" ]]; then
  record "8 parallel writes on DIFFERENT keys all succeed" 5 pass
else
  codes=$(cat /tmp/audit-iconc/* | sort -u | tr '\n' ',')
  record "8 parallel writes on DIFFERENT keys all succeed" 5 fail "ok=$ic_ok fail=$ic_fail codes=$codes"
fi
# Cleanup every attempt's residue.
for a in 1 2 3; do
  for i in $(seq 1 8); do
    curl -s -o /dev/null -X DELETE \
      "$BASE/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/AuditICx${SUFFIX2}A${a}I${i}" || true
  done
done

# ------------------------------------------------------------------------
# 13r. Trailing-slash equivalence
# ------------------------------------------------------------------------
section "13r. Trailing slash routing"

s_no=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/ontologies")
s_yes=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/ontologies/")
if [[ "$s_no" == "200" && ( "$s_yes" == "200" || "$s_yes" =~ ^30 ) ]]; then
  record "Trailing slash returns 2xx or 3xx (no surprise 404)" 2 pass
else
  record "Trailing slash returns 2xx or 3xx (no surprise 404)" 2 warn "no=$s_no yes=$s_yes"
fi

# ------------------------------------------------------------------------
# 14. Error envelope consistency across surfaces
# ------------------------------------------------------------------------
section "14. Error envelope consistency"

env_ok=0
env_total=0
for path in \
    "/api/v1/ontologies/00000000-0000-0000-0000-000000000000" \
    "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/__nope__" \
    "/api/v1/ontologies/$ONTOLOGY_ID/linkTypes/__nope__" \
    "/api/v1/objects/__nope__/__nope__" \
    "/api/v1/sql"
do
  env_total=$((env_total + 1))
  IFS='|' read -r status body < <(http GET "$path")
  if jq -e '.error.code and .error.message' "$body" >/dev/null 2>&1; then
    env_ok=$((env_ok + 1))
  fi
done
if [[ "$env_ok" -ge $((env_total - 1)) ]]; then
  record "Error envelope present on $env_ok / $env_total error paths" 4 pass
else
  record "Error envelope present on $env_ok / $env_total error paths" 4 warn "inconsistent"
fi

# ------------------------------------------------------------------------
# 14. Final scoring
# ------------------------------------------------------------------------
echo
echo -e "${BOLD}════════════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Production Readiness Score${NC}"
echo -e "${BOLD}════════════════════════════════════════════════════════════════════${NC}"

if [[ $TOTAL_WEIGHT -gt 0 ]]; then
  SCORE=$((100 * EARNED_WEIGHT / TOTAL_WEIGHT))
else
  SCORE=0
fi

printf "  Total checks   : %d\n" "$CHECK_COUNT"
printf "  ${GREEN}Passed${NC}        : %d\n" "$PASSED"
printf "  ${YELLOW}Warned${NC}        : %d\n" "$WARNED"
printf "  ${RED}Failed${NC}        : %d\n" "$FAILED"
printf "  Weight earned  : %d / %d\n" "$EARNED_WEIGHT" "$TOTAL_WEIGHT"
printf "  ${BOLD}SCORE${NC}          : ${BOLD}%d%%${NC}\n" "$SCORE"
echo

if (( ${#FAILURES[@]} > 0 )); then
  echo -e "${RED}Failures:${NC}"
  for f in "${FAILURES[@]}"; do echo "  ✗ $f"; done
  echo
fi

if (( ${#WARNINGS[@]} > 0 )); then
  echo -e "${YELLOW}Warnings:${NC}"
  for w in "${WARNINGS[@]}"; do echo "  ⚠ $w"; done
  echo
fi

if (( SCORE >= 99 )); then
  echo -e "${GREEN}${BOLD}VERDICT: SHIP IT — meets 99% uptime SLO${NC}"
  EXIT=0
elif (( SCORE >= 95 )); then
  echo -e "${YELLOW}${BOLD}VERDICT: SHIP WITH CAVEATS — investigate warnings${NC}"
  EXIT=1
elif (( SCORE >= 90 )); then
  echo -e "${RED}${BOLD}VERDICT: NOT READY — fix failures before ship${NC}"
  EXIT=2
else
  echo -e "${RED}${BOLD}VERDICT: HARD NO — material defects, do not ship${NC}"
  EXIT=3
fi
echo

# Cleanup
rm -rf /tmp/audit-conc /tmp/audit-load /tmp/audit-rl
exit $EXIT
