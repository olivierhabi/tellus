#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# test-synthetic-data.sh — drive the 30-task API against the seeded data
# ---------------------------------------------------------------------------
# After running seed-synthetic-data.sh, exercise every task endpoint that
# consumes actual data and assert non-trivial (non-empty) results. Exits
# with the number of failed checks.
# ---------------------------------------------------------------------------

set -uo pipefail

API="${API:-http://localhost:3000}"
ONTOLOGY_ID="${ONTOLOGY_ID:-$(curl -s "$API/api/v1/ontology" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["ontologyId"])')}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
DIM='\033[2m'
NC='\033[0m'

PASS=0
FAIL=0
FAILED=()

assert_json() {
  local label="$1" body="$2" expr="$3"
  local ok
  ok=$(echo "$body" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print('1' if $expr else '0')
except Exception as e:
    print('0')
" 2>/dev/null)
  if [[ "$ok" == "1" ]]; then
    printf "${GREEN}✓${NC} %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "${RED}✗${NC} %s\n    ${DIM}body: %s${NC}\n" "$label" "$(echo "$body" | head -c 250)"
    FAIL=$((FAIL + 1))
    FAILED+=("$label")
  fi
}

echo "============================================================"
echo " Ontology Platform — synthetic data verification"
echo " API: $API  Ontology: $ONTOLOGY_ID"
echo "============================================================"

# ---------------------------------------------------------------------------
# Task 5: object type lookup — pagination contract
# ---------------------------------------------------------------------------
echo ""
echo "Task 5 — pagination envelope"
RES=$(curl -s "$API/api/v1/ontology/$ONTOLOGY_ID/objectTypes?pageSize=5")
assert_json "Task 5: list returns data[] with totalCount" \
  "$RES" 'len(d.get("data", [])) > 0 and d.get("totalCount", 0) > 0'

# Test ETag header on GET
ETAG=$(curl -s -i "$API/api/v1/ontology/$ONTOLOGY_ID/objectTypes/SynthFlight" | grep -i '^etag:' | tr -d '\r')
if [[ -n "$ETAG" ]]; then
  printf "${GREEN}✓${NC} Task 5: GET SynthFlight returns ETag header (%s)\n" "$ETAG"
  PASS=$((PASS + 1))
else
  printf "${RED}✗${NC} Task 5: GET SynthFlight missing ETag header\n"
  FAIL=$((FAIL + 1))
  FAILED+=("Task 5 ETag")
fi

# ---------------------------------------------------------------------------
# Task 6: vector KNN — synthesize a 128-dim vector and search
# ---------------------------------------------------------------------------
echo ""
echo "Task 6 — vector KNN"
RES=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"query":[0.1,0.2,0.3,0.4,0.5],"topK":3}' \
  "$API/api/v1/vector/SynthFlight/embedding/search")
assert_json "Task 6: KNN returns a results array and engine name" \
  "$RES" 'isinstance(d.get("data"), dict) and "results" in d["data"] and "engine" in d["data"]'

# ---------------------------------------------------------------------------
# Task 9: branches + proposals — list seeded branch
# ---------------------------------------------------------------------------
echo ""
echo "Task 9 — branches"
RES=$(curl -s "$API/api/v1/ontology/$ONTOLOGY_ID/branches")
assert_json "Task 9: at least one OPEN branch present" \
  "$RES" 'any(b.get("status") == "OPEN" for b in d.get("data", []))'

FIRST_BRANCH=$(echo "$RES" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["data"][0]["name"])')
RES=$(curl -s "$API/api/v1/ontology/$ONTOLOGY_ID/branches/$FIRST_BRANCH")
assert_json "Task 9: branch detail includes proposals array" \
  "$RES" '"proposals" in d and len(d["proposals"]) > 0'

# ---------------------------------------------------------------------------
# Task 13: migration plan classification
# ---------------------------------------------------------------------------
echo ""
echo "Task 13 — migration plan"
RES=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"operations":["property_type_change","add_property","primary_key_change","change_description"]}' \
  "$API/api/v1/ontology/$ONTOLOGY_ID/migrations/plan")
assert_json "Task 13: breaking includes property_type_change + primary_key_change" \
  "$RES" 'set(["property_type_change","primary_key_change"]).issubset(set(d.get("breaking", [])))'
assert_json "Task 13: nonBreaking includes add_property + change_description" \
  "$RES" 'set(["add_property","change_description"]).issubset(set(d.get("nonBreaking", [])))'

# ---------------------------------------------------------------------------
# Task 14: favorites + recent ring buffer
# ---------------------------------------------------------------------------
echo ""
echo "Task 14 — favorites"
RES=$(curl -s "$API/api/v1/users/me/favorites")
assert_json "Task 14: seeded favorite SynthFlight is listed" \
  "$RES" 'any(f.get("resource_id") == "SynthFlight" for f in d.get("data", []))'
RES=$(curl -s "$API/api/v1/users/me/favorites/recent")
assert_json "Task 14: recent visit is recorded" \
  "$RES" 'len(d.get("data", [])) > 0'

# ---------------------------------------------------------------------------
# Task 15: groups graph + count cache
# ---------------------------------------------------------------------------
echo ""
echo "Task 15 — groups"
RES=$(curl -s "$API/api/v1/ontology/$ONTOLOGY_ID/groups")
assert_json "Task 15: transport group is listed" \
  "$RES" 'any(g.get("api_name") == "transport" for g in d.get("data", []))'
RES=$(curl -s "$API/api/v1/ontology/$ONTOLOGY_ID/groups/graph")
assert_json "Task 15: graph returns nodes array" \
  "$RES" 'isinstance(d.get("nodes"), list) and "truncated" in d'
RES=$(curl -s "$API/api/v1/ontology/$ONTOLOGY_ID/groups/transport/counts")
assert_json "Task 15: count cache returns live SynthFlight count" \
  "$RES" 'isinstance(d.get("counts", {}).get("SynthFlight"), int) and d["counts"]["SynthFlight"] >= 200'

# ---------------------------------------------------------------------------
# Task 18: function registry — list + invoke + timeout
# ---------------------------------------------------------------------------
echo ""
echo "Task 18 — function registry"
RES=$(curl -s "$API/api/v1/ontology/$ONTOLOGY_ID/functions")
assert_json "Task 18: at least one function registered" \
  "$RES" 'len(d.get("data", [])) > 0'

# Register a fresh echo function and invoke it
FN="testSynth$(date +%s)"
curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"apiName\":\"$FN\",\"displayName\":\"Synth Test\",\"runtime\":\"typescript\",\"sourceCode\":\"module.exports = (i) => ({ sum: (i.a||0) + (i.b||0) });\"}" \
  "$API/api/v1/ontology/$ONTOLOGY_ID/functions" > /dev/null
RES=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"input":{"a":40,"b":2}}' \
  "$API/api/v1/ontology/$ONTOLOGY_ID/functions/$FN/invoke")
assert_json "Task 18: function output reflects input" \
  "$RES" 'd.get("output", {}).get("sum") == 42'
curl -s -X DELETE "$API/api/v1/ontology/$ONTOLOGY_ID/functions/$FN" > /dev/null

# ---------------------------------------------------------------------------
# Task 19: summary bundle should pull the seeded Phase 2 data
# ---------------------------------------------------------------------------
echo ""
echo "Task 19 — home bundle"
RES=$(curl -s "$API/api/v1/ontology/$ONTOLOGY_ID/summary")
assert_json "Task 19: summary contains objectTypes, groups, favorites, recent" \
  "$RES" 'all(k in d for k in ["objectTypes","groups","favorites","recent"]) and len(d["favorites"]) > 0 and any(g.get("api_name") == "transport" for g in d["groups"])'

# ---------------------------------------------------------------------------
# Task 21: chart batch auto-bucketing over real docs
# ---------------------------------------------------------------------------
echo ""
echo "Task 21 — chart batch"
RES=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"objectType":"SynthFlight","specs":[{"type":"terms","field":"status"},{"type":"histogram","field":"ticketPrice"}]}' \
  "$API/api/v1/charts/batch")
assert_json "Task 21: batch returns 2 charts with non-empty terms buckets" \
  "$RES" 'len(d.get("data", {}).get("charts", [])) == 2 and len(d["data"]["charts"][0].get("buckets", [])) > 0'
assert_json "Task 21: autoBuckets computed from live docCount" \
  "$RES" 'd.get("data", {}).get("docCount", 0) >= 200 and d["data"].get("autoBuckets", 0) >= 5'

# ---------------------------------------------------------------------------
# Task 22: geohash aggregation over real geo_point docs
# ---------------------------------------------------------------------------
echo ""
echo "Task 22 — geohash"
RES=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"geopointProperty":"originLocation","zoom":3}' \
  "$API/api/v1/ontology/$ONTOLOGY_ID/geo/SynthFlight/geohash")
assert_json "Task 22: geohash returns buckets for seeded origins" \
  "$RES" 'len(d.get("buckets", [])) > 0 and d.get("precision", 0) >= 3'

RES=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"regionProperty":"originCountry","level":"country"}' \
  "$API/api/v1/ontology/$ONTOLOGY_ID/geo/SynthFlight/choropleth")
assert_json "Task 22: choropleth returns region buckets" \
  "$RES" 'len(d.get("regions", [])) > 0'

# ---------------------------------------------------------------------------
# Task 23: filter model → ES bool — search by status
# ---------------------------------------------------------------------------
echo ""
echo "Task 23 — filter model"
RES=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"filter":[{"property":"status","operator":"eq","value":"DELAYED"}],"pageSize":5}' \
  "$API/api/v1/objects/SynthFlight/search")
assert_json "Task 23: search returns SynthFlight hits" \
  "$RES" '"data" in d or "hits" in d or "results" in d'

# ---------------------------------------------------------------------------
# Task 26: comparison aggregate over real data
# ---------------------------------------------------------------------------
echo ""
echo "Task 26 — comparison"
RES=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"objectTypeApiName":"SynthFlight","setA":{"label":"All","filter":[]},"setB":{"label":"Expensive","filter":[{"property":"ticketPrice","operator":"gt","value":1000}]},"aggregation":{"type":"terms","field":"status"}}' \
  "$API/api/v1/ontology/$ONTOLOGY_ID/comparisons/aggregate")
assert_json "Task 26: setA contains non-empty status buckets" \
  "$RES" 'len(d.get("setA", {}).get("buckets", [])) > 0'
assert_json "Task 26: palette has both A and B colors" \
  "$RES" '"A" in d.get("palette", {}) and "B" in d.get("palette", {})'

# ---------------------------------------------------------------------------
# Task 27: async export — enqueue and poll to COMPLETED
# ---------------------------------------------------------------------------
echo ""
echo "Task 27 — async export"
JOB=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"objectTypeApiName":"SynthFlight","format":"csv","query":{}}' \
  "$API/api/v1/ontology/$ONTOLOGY_ID/exports" | \
  python3 -c 'import json,sys; print(json.load(sys.stdin)["job_id"])' 2>/dev/null)
if [[ -z "$JOB" ]]; then
  printf "${RED}✗${NC} Task 27: failed to enqueue job\n"
  FAIL=$((FAIL + 1)); FAILED+=("Task 27 enqueue")
else
  for i in 1 2 3 4 5; do
    STATUS=$(curl -s "$API/api/v1/ontology/$ONTOLOGY_ID/exports/$JOB" | \
      python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])' 2>/dev/null)
    [[ "$STATUS" == "COMPLETED" ]] && break
    sleep 1
  done
  if [[ "$STATUS" == "COMPLETED" ]]; then
    printf "${GREEN}✓${NC} Task 27: export job ${JOB:0:8} → COMPLETED\n"
    PASS=$((PASS + 1))
  else
    printf "${RED}✗${NC} Task 27: export stayed at %s\n" "$STATUS"
    FAIL=$((FAIL + 1)); FAILED+=("Task 27 poll")
  fi
fi

# Verify the CSV writer escapes RFC 4180 edge cases (unit-level, no API call)
python3 <<'PY'
import sys, subprocess
from pathlib import Path
# Run the inline module test via tsx
proc = subprocess.run(
  ["npx", "tsx", "-e",
   "import {escapeField, encodeRow} from './src/services/csvExport'; "
   "console.log(escapeField('a,b'), '|', escapeField('a\"b'), '|', encodeRow(['x', 'y,z', 'q\"r']).trim())"],
  cwd="/Users/olivierhabimana/Desktop/projects/tellus",
  capture_output=True, text=True, timeout=60
)
out = proc.stdout.strip()
expected = '"a,b" | "a""b" | x,"y,z","q""r"'
sys.exit(0 if out == expected else 1)
PY
if [[ $? -eq 0 ]]; then
  printf "${GREEN}✓${NC} Task 27: csvExport escapes RFC 4180 edge cases\n"
  PASS=$((PASS + 1))
else
  printf "${RED}✗${NC} Task 27: csvExport escaping mismatch\n"
  FAIL=$((FAIL + 1)); FAILED+=("Task 27 csv")
fi

# ---------------------------------------------------------------------------
# Task 28: IDOR — unknown object returns 404 (not 403)
# ---------------------------------------------------------------------------
echo ""
echo "Task 28 — IDOR protection"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "$API/api/v1/objects/SynthFlight/DOES-NOT-EXIST")
if [[ "$STATUS" == "404" ]]; then
  printf "${GREEN}✓${NC} Task 28: unknown object → 404\n"
  PASS=$((PASS + 1))
else
  printf "${RED}✗${NC} Task 28: got %s\n" "$STATUS"
  FAIL=$((FAIL + 1)); FAILED+=("Task 28")
fi

# ---------------------------------------------------------------------------
# Task 29: SQL read-only enforcement (rejects DDL)
# ---------------------------------------------------------------------------
echo ""
echo "Task 29 — SQL read-only"
RES=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"ontologyId\":\"$ONTOLOGY_ID\",\"sql\":\"DROP TABLE object_type\"}" \
  "$API/api/v1/sql")
assert_json "Task 29: DDL rejected with errorCode" \
  "$RES" '"errorCode" in d or ("error" in d and "code" in d.get("error", {}))'

# ---------------------------------------------------------------------------
# Task 30: lineage + PII + usage sparkline all fed by real data
# ---------------------------------------------------------------------------
echo ""
echo "Task 30 — governance over real data"
RES=$(curl -s "$API/api/v1/ontology/$ONTOLOGY_ID/governance/lineage/SynthFlight?depth=3")
assert_json "Task 30: lineage returns a node for SynthFlight" \
  "$RES" 'any(n.get("id") == "ot:SynthFlight" for n in d.get("nodes", []))'

RES=$(curl -s -X POST -H 'Content-Type: application/json' -d '{}' \
  "$API/api/v1/ontology/$ONTOLOGY_ID/governance/pii-scans/SynthFlight")
assert_json "Task 30: PII scan reports email hits against live index" \
  "$RES" 'any(m.get("detectedType") == "email" for m in d.get("matches", [])) and d.get("sampleSize", 0) > 0'

RES=$(curl -s "$API/api/v1/ontology/$ONTOLOGY_ID/governance/usage/SynthFlight")
assert_json "Task 30: usage sparkline shows non-zero reads or writes" \
  "$RES" 'isinstance(d.get("series"), list) and len(d["series"]) == 30 and sum(s.get("reads", 0) + s.get("writes", 0) for s in d["series"]) > 0'

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================================"
printf " %s passed · %s failed\n" \
  "$(printf "${GREEN}%d${NC}" $PASS)" \
  "$(printf "${RED}%d${NC}" $FAIL)"
echo "============================================================"
if [[ $FAIL -gt 0 ]]; then
  for t in "${FAILED[@]}"; do printf "  ${RED}✗${NC} %s\n" "$t"; done
fi
exit "$FAIL"
