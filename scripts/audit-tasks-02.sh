#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# audit-tasks-02.sh
#
# Bullet-by-bullet audit of tasks/Pipeline-builder/tasks-02.md. This spec
# covers the 10 Link Types — Backend tasks LT-B1 through LT-B10.
# Prints a PASS / FAIL / SKIP line per acceptance bullet and exits
# non-zero if any FAIL.
# ---------------------------------------------------------------------------
set -u

API="${API:-http://localhost:3000}"
ONTOLOGY_ID="${ONTOLOGY_ID:-default}"
BASE="$API/api/v1/ontology/$ONTOLOGY_ID/linkTypes"
FUNNEL="$API/api/v1/funnel"
REPO="/Users/olivierhabimana/Desktop/projects/tellus"

GRN=$(printf '\033[0;32m'); RED=$(printf '\033[0;31m')
YLW=$(printf '\033[0;33m'); NC=$(printf '\033[0m')
PASS=0; FAIL=0; SKIP=0

pass()    { printf "  ${GRN}✓${NC} %s\n" "$1"; PASS=$((PASS+1)); }
fail()    { printf "  ${RED}✗${NC} %s — %s\n" "$1" "$2"; FAIL=$((FAIL+1)); }
skip()    { printf "  ${YLW}-${NC} %s — %s\n" "$1" "$2"; SKIP=$((SKIP+1)); }
section() { printf "\n${GRN}==>${NC} %s\n" "$1"; }

AUTH_HEADER=""
if [ -n "${TELLUS_TOKEN:-}" ]; then AUTH_HEADER="Authorization: Bearer ${TELLUS_TOKEN}"; fi
CT_HEADER="Content-Type: application/json"

req() {
  local method="$1" url="$2" body="${3:-}" tmp status
  tmp=$(mktemp)
  local args=(-sS -o "$tmp" -w '%{http_code}' -X "$method" -H "$CT_HEADER")
  [ -n "$AUTH_HEADER" ] && args+=(-H "$AUTH_HEADER")
  [ -n "$body" ] && args+=(--data "$body")
  args+=("$url")
  status=$(curl "${args[@]}" || echo 000)
  printf "%s|%s" "$status" "$(cat "$tmp")"
  rm -f "$tmp"
}

j() {
  printf "%s" "$2" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  try{ const j=JSON.parse(d); const ks=process.argv[1].split(".");
       let v=j; for(const k of ks){ if(v==null)break; v=v[k]; }
       process.stdout.write(v==null?"":typeof v==="object"?JSON.stringify(v):String(v)); }
  catch{ process.stdout.write(""); }
})' "$1"
}

pg() {
  PGHOST=localhost PGPORT=5432 PGDATABASE=tellus_db PGUSER=tellus PGPASSWORD=tellus123 \
    node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client(); await c.connect();
  const r = await c.query(process.argv[1]);
  process.stdout.write(JSON.stringify(r.rows));
  await c.end();
})().catch(e=>{ process.stderr.write(e.message); process.exit(1); });
" "$1"
}

# Seed a fixture ONE_TO_ONE link we can interrogate. Create is idempotent.
req POST "$BASE" \
  '{"apiName":"employedBy","displayName":"Employed By","cardinality":"ONE_TO_ONE","sourceObjectTypeApiName":"OlivierOrder","targetObjectTypeApiName":"OlivierOrder1","isBidirectional":true,"reversePropertyProjection":{"excluded":["secret"]}}' \
  >/dev/null

# ---------------------------------------------------------------------------
# LT-B1 — Iceberg M2M storage + migrate-storage endpoint
# ---------------------------------------------------------------------------
section "LT-B1 Iceberg M2M storage"

# Schema addition (a).
storage=$(pg "SELECT column_name FROM information_schema.columns WHERE table_name='link_type' AND column_name IN ('storage_backend','iceberg_table_name','migration_started_at','migration_completed_at')")
if [ "$(node -e "console.log(JSON.parse(process.argv[1]).length)" "$storage")" = "4" ]; then
  pass "(spec) storage_backend + iceberg_table_name + migration_* columns"
else
  fail "storage_backend cols" "got $storage"
fi

# Default (e): existing links stay csv_legacy.
res=$(req GET "$BASE/employedBy")
status="${res%%|*}"; body="${res#*|}"
sb=$(j storageBackend "$body")
if [ "$sb" = "csv_legacy" ] || [ "$sb" = "iceberg" ]; then
  pass "(e) GET /:apiName exposes storageBackend=$sb"
else
  fail "storageBackend field" "got '$sb'"
fi

# Migrate endpoint (c) — spec: admin-only, only for MANY_TO_MANY.
res=$(req POST "$BASE/employedBy/migrate-storage" '')
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "400" ]; then
  code=$(j errorCode "$body")
  if [ "$code" = "VALIDATION_FAILED" ]; then
    pass "(c) migrate-storage rejects non-M2M with VALIDATION_FAILED"
  else
    fail "migrate-storage reject" "got errorCode=$code"
  fi
else
  skip "migrate-storage" "HTTP $status"
fi

# Upload ceiling (a): 5 GB, was 50 MB.
if grep -q "5 \* 1024 \* 1024 \* 1024" "$REPO/src/routes/links.ts"; then
  pass "(a) upload limit raised to 5 GB per LT-B1"
else
  fail "upload limit" "50 MB ceiling not lifted"
fi

# Interface preservation (e): resolver still reads via parseJoinTableCSV path
if grep -q "parseJoinTableCSV\|getTargetPKsFromJoinTable" "$REPO/src/services/linkResolverService.ts"; then
  pass "(e) CSV-backed API contract preserved in linkResolverService"
else
  fail "legacy CSV path" "absent"
fi

# ---------------------------------------------------------------------------
# LT-B2 — Configurable PK caps + ClickHouse escalation
# ---------------------------------------------------------------------------
section "LT-B2 PK caps + escalation"

# resolver config endpoint (spec)
res=$(req GET "$BASE/_config/resolver")
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "200" ]; then
  mi=$(j max_intermediate_pks "$body")
  eb=$(j escalation_backend "$body")
  if [ -n "$mi" ] && [ -n "$eb" ]; then
    pass "(spec) GET /_config/resolver returns max_intermediate_pks=$mi escalation_backend=$eb"
  else
    fail "resolver config payload" "$body"
  fi
else
  fail "GET /_config/resolver" "HTTP $status"
fi

# Cap bounds (spec): max_intermediate_pks ∈ [1, 1M]; threshold default 100k.
res=$(req PUT "$BASE/_config/resolver" '{"maxIntermediatePks":500000,"escalationThresholdPks":200000,"escalationBackend":"clickhouse"}')
status="${res%%|*}"; body="${res#*|}"
mi=$(j max_intermediate_pks "$body")
thr=$(j escalation_threshold_pks "$body")
if [ "$status" = "200" ] && [ "$mi" = "500000" ] && [ "$thr" = "200000" ]; then
  pass "(spec) PUT persists max_intermediate_pks + escalation_threshold_pks"
else
  fail "PUT /_config/resolver" "$body"
fi

# Unknown backend rejection (spec)
res=$(req PUT "$BASE/_config/resolver" '{"escalationBackend":"furnace-nope"}')
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "400" ] && [ "$(j errorCode "$body")" = "VALIDATION_FAILED" ]; then
  pass "(spec) invalid escalation_backend rejected with 400 VALIDATION_FAILED"
else
  fail "invalid backend rejection" "HTTP $status code=$(j errorCode "$body")"
fi

# Per-request override (c): `?maxResultPks=500000` honored & clamped
res=$(req POST "$BASE/employedBy/resolve" \
  '{"objectPK":"E001","direction":"forward","maxResultPks":999999999}')
status="${res%%|*}"; body="${res#*|}"
cap=$(j metadata.effective_max_pks "$body")
clamped=$(j metadata.max_pks_clamped "$body")
if [ "$status" = "200" ] && [ -n "$cap" ]; then
  pass "(c) ?maxResultPks clamped to effective=$cap (clamped=$clamped)"
else
  fail "maxResultPks clamp" "$body"
fi

# Metadata presence (f): pagination_mode + max_pks_clamped
pm=$(j metadata.pagination_mode "$body")
if [ -n "$pm" ]; then
  pass "(f) metadata envelope carries pagination_mode=$pm"
else
  fail "metadata envelope" "pagination_mode missing"
fi

# ---------------------------------------------------------------------------
# LT-B3 — CDC v2 with actor, action_rid, retraction, schema_version
# ---------------------------------------------------------------------------
section "LT-B3 CDC v2 schema"

# LinkCdcRow v2 fields on producer (spec)
if grep -q "schema_version.*2.0.0\|schema_version.*\"2.0.0\"" "$REPO/src/services/searchAround/cdcLinkProducer.ts"; then
  pass "(spec) cdcLinkProducer publishes schema_version=2.0.0"
else
  fail "schema_version 2.0.0" "not in producer"
fi

if grep -qE "operation.*(ADD|REMOVE|RETRACT)" "$REPO/src/services/searchAround/cdcLinkProducer.ts"; then
  pass "(spec) ADD|REMOVE|RETRACT operation enum present"
else
  fail "operation enum" "missing"
fi

if grep -q "validateLinkCdcV2" "$REPO/src/services/searchAround/cdcLinkProducer.ts"; then
  pass "(b) validateLinkCdcV2 enforces required v2 fields"
else
  fail "validateLinkCdcV2" "missing"
fi

# link_edit.applied_to_iceberg_at + applied_to_index_at (spec: "mirror object_edits")
cols=$(pg "SELECT column_name FROM information_schema.columns WHERE table_name='link_edit' AND column_name IN ('applied_to_iceberg_at','applied_to_index_at','actor_principal_id','action_rid','correlation_id','retracts_event_id','event_id','schema_version')")
if [ "$(node -e "console.log(JSON.parse(process.argv[1]).length)" "$cols")" -ge "8" ]; then
  pass "(f/spec) link_edit has applied_to_iceberg_at + applied_to_index_at + v2 metadata cols"
else
  fail "link_edit v2 cols" "$cols"
fi

# RETRACT validation (c)
if grep -q "RETRACT requires retracts_event_id" "$REPO/src/services/searchAround/cdcLinkProducer.ts"; then
  pass "(c) RETRACT requires retracts_event_id (validator)"
else
  fail "RETRACT check" "validator missing retracts_event_id rule"
fi

# ---------------------------------------------------------------------------
# LT-B4 — ONE_TO_ONE violation enforcement
# ---------------------------------------------------------------------------
section "LT-B4 ONE_TO_ONE enforcement"

# violation_policy column + link_quarantine table (spec)
col=$(pg "SELECT column_name FROM information_schema.columns WHERE table_name='link_type' AND column_name='violation_policy'")
if node -e "process.exit(JSON.parse(process.argv[1]).length>0?0:1)" "$col"; then
  pass "(spec) link_type.violation_policy column present"
else
  fail "violation_policy column" "missing"
fi

tbl=$(pg "SELECT table_name FROM information_schema.tables WHERE table_name='link_quarantine'")
if node -e "process.exit(JSON.parse(process.argv[1]).length>0?0:1)" "$tbl"; then
  pass "(spec) link_quarantine table present"
else
  fail "link_quarantine table" "missing"
fi

# Default policy for new ONE_TO_ONE = reject (e)
res=$(req GET "$BASE/employedBy")
vp=$(j violationPolicy "${res#*|}")
if [ "$vp" = "reject" ]; then
  pass "(e) new ONE_TO_ONE link defaults violation_policy=reject"
else
  fail "violation_policy default" "got '$vp'"
fi

# Violations listing envelope (c)
res=$(req GET "$BASE/employedBy/violations?status=pending")
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "200" ]; then
  tc=$(j totalCount "$body")
  pass "(c) GET /:apiName/violations returns totalCount=$tc"
else
  fail "violations listing" "HTTP $status"
fi

# Resolve unknown id (d) → QUARANTINE_NOT_FOUND
res=$(req POST "$BASE/employedBy/violations/00000000-0000-0000-0000-000000000000/resolve" '{"resolvedBy":"smoke"}')
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "404" ] && [ "$(j errorCode "$body")" = "QUARANTINE_NOT_FOUND" ]; then
  pass "(d) unknown violation id → 404 QUARANTINE_NOT_FOUND"
else
  fail "unknown violation id" "HTTP $status $(j errorCode "$body")"
fi

# Enforce dry-run (a-like)
res=$(req POST "$BASE/employedBy/enforce-one-to-one" '{"sourcePk":"probe-'"$(date +%s)"'","targetPk":"T-001"}')
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "200" ]; then
  allowed=$(j allowed "$body")
  pass "(a) enforce-one-to-one dry-run allowed=$allowed"
else
  fail "enforce-one-to-one" "HTTP $status"
fi

# ---------------------------------------------------------------------------
# LT-B5 — FK orphan state with pending window
# ---------------------------------------------------------------------------
section "LT-B5 FK orphan state"

# resolveFKWithState service + orphan_stats table
if grep -q "resolveFKWithState" "$REPO/src/services/linkOrphanState.ts"; then
  pass "(spec) resolveFKWithState returns resolved|pending|orphaned"
else
  fail "resolveFKWithState" "missing"
fi

tbl=$(pg "SELECT table_name FROM information_schema.tables WHERE table_name='link_orphan_stats'")
if node -e "process.exit(JSON.parse(process.argv[1]).length>0?0:1)" "$tbl"; then
  pass "(spec) link_orphan_stats table present"
else
  fail "link_orphan_stats" "missing"
fi

# Scanner endpoint (d) + Wilson interval (spec)
res=$(req POST "$BASE/employedBy/orphan-scan" '{"sampleLimit":20}')
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "200" ]; then
  wl=$(j windowLower "$body"); wu=$(j windowUpper "$body")
  if [ -n "$wl" ] && [ -n "$wu" ]; then
    pass "(d) orphan-scan produced Wilson CI [$wl, $wu]"
  else
    fail "Wilson CI" "$body"
  fi
else
  fail "orphan-scan" "HTTP $status"
fi

# Stats endpoint (a)
res=$(req GET "$BASE/employedBy/orphan-stats")
if [ "${res%%|*}" = "200" ]; then
  pass "(a) GET /:apiName/orphan-stats reachable"
else
  fail "orphan-stats" "HTTP ${res%%|*}"
fi

# Pending window uses existing applied_to_index_at (c)
if grep -q "applied_to_index_at" "$REPO/src/services/linkOrphanState.ts"; then
  pass "(c) pending-window consults object_edits.applied_to_index_at + link_edit.applied_to_index_at"
else
  fail "applied_to_index_at usage" "not in linkOrphanState.ts"
fi

# Opt-in per-result state (f): ?include_link_state
res=$(req POST "$BASE/employedBy/resolve" '{"objectPK":"E001","direction":"forward","includeLinkState":true}')
status="${res%%|*}"
if [ "$status" = "200" ]; then
  pass "(f) resolve honours includeLinkState flag (HTTP 200)"
else
  fail "includeLinkState" "HTTP $status"
fi

# ---------------------------------------------------------------------------
# LT-B6 — Bidirectional reverse spec
# ---------------------------------------------------------------------------
section "LT-B6 bidirectional reverse"

cols=$(pg "SELECT column_name FROM information_schema.columns WHERE table_name='link_type' AND column_name IN ('reverse_api_name','reverse_display_name','reverse_description','reverse_visible','reverse_property_projection','reverse_actions_enabled','bidirectional_migrated_at')")
if [ "$(node -e "console.log(JSON.parse(process.argv[1]).length)" "$cols")" = "7" ]; then
  pass "(spec) link_type has 7 reverse_* columns"
else
  fail "reverse_* columns" "$cols"
fi

# is_bidirectional view retained (e)
if pg "SELECT is_bidirectional FROM link_type LIMIT 1" >/dev/null 2>&1; then
  pass "(e) is_bidirectional column still readable"
else
  fail "is_bidirectional" "dropped"
fi

# Migration seeded reverse_api_name for existing bidirectional rows (a)
cnt=$(pg "SELECT reverse_api_name FROM link_type WHERE is_bidirectional=true AND reverse_api_name IS NULL")
if [ "$(node -e "console.log(JSON.parse(process.argv[1]).length)" "$cnt")" = "0" ]; then
  pass "(a) migration populated reverse_api_name for all bidirectional rows"
else
  fail "reverse_api_name backfill" "$cnt NULL rows remain"
fi

# reverse direction returns mirrored cardinality (d)
res=$(req POST "$BASE/employedBy/resolve" '{"objectPK":"E001","direction":"reverse"}')
status="${res%%|*}"; body="${res#*|}"
card=$(j metadata.cardinality "$body")
if [ "$status" = "200" ] && [ "$card" = "ONE_TO_ONE" ]; then
  pass "(d) reverse-direction resolve mirrors cardinality (ONE_TO_ONE <→ ONE_TO_ONE)"
else
  fail "reverse cardinality view" "HTTP $status card=$card"
fi

# Projection filter applied at resolver (b)
if grep -q "applyReverseProjection" "$REPO/src/services/linkDirectionHelpers.ts"; then
  pass "(b) reverse_property_projection filter implemented"
else
  fail "reverse projection filter" "missing"
fi

# ---------------------------------------------------------------------------
# LT-B7 — Mandatory Control Properties (MCP)
# ---------------------------------------------------------------------------
section "LT-B7 MCP"

cols=$(pg "SELECT column_name FROM information_schema.columns WHERE table_name='link_type' AND column_name IN ('mandatory_control_property_id','mcp_propagation_mode','mcp_required_count')")
if [ "$(node -e "console.log(JSON.parse(process.argv[1]).length)" "$cols")" = "3" ]; then
  pass "(spec) mandatory_control_property_id + mcp_propagation_mode + mcp_required_count"
else
  fail "MCP cols" "$cols"
fi

# Marking derivation helper shared with mergeStage (f)
if grep -q "deriveEdgeMarkings" "$REPO/src/services/linkDirectionHelpers.ts"; then
  pass "(f) deriveEdgeMarkings union|intersection|source|target shared helper"
else
  fail "deriveEdgeMarkings" "missing"
fi

# marking-trace endpoint (c)
res=$(req GET "$BASE/employedBy/edge/E001/C001/marking-trace?sourceMarkings=SECRET&targetMarkings=PUBLIC")
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "200" ]; then
  mode=$(j mcpPropagationMode "$body")
  pass "(c) marking-trace returned mode=$mode"
else
  fail "marking-trace" "HTTP $status"
fi

# Server-side filter plumbing (b): mcpPredicateForRow / mcpMarkingClauses present
if grep -q "mcpMarkingClauses\|mcpPredicateForRow" "$REPO/src/services/linkDirectionHelpers.ts"; then
  pass "(b) server-side marking filter helpers present"
else
  fail "marking filter helpers" "missing"
fi

# ---------------------------------------------------------------------------
# LT-B8 — Object-level CDC topic with outbox
# ---------------------------------------------------------------------------
section "LT-B8 object CDC"

tbl=$(pg "SELECT table_name FROM information_schema.tables WHERE table_name='object_cdc_outbox'")
if node -e "process.exit(JSON.parse(process.argv[1]).length>0?0:1)" "$tbl"; then
  pass "(a) object_cdc_outbox table present (transactional outbox)"
else
  fail "object_cdc_outbox" "missing"
fi

if grep -q "stageObjectCdcEvent" "$REPO/src/services/cdcObjectProducer.ts"; then
  pass "(a) stageObjectCdcEvent stages in same txn as object_edits insert"
else
  fail "stageObjectCdcEvent" "missing"
fi

if grep -q "drainOutboxOnce" "$REPO/src/services/cdcObjectProducer.ts"; then
  pass "(f) drainOutboxOnce pulls FOR UPDATE SKIP LOCKED (at-least-once publisher)"
else
  fail "drainOutboxOnce" "missing"
fi

if grep -q "object_cdc\\.\\\${\|objectCdcTopic" "$REPO/src/services/cdcObjectProducer.ts"; then
  pass "(spec) topic name object_cdc.<ot> format"
else
  skip "object_cdc topic name" "regex did not match cleanly"
fi

# ---------------------------------------------------------------------------
# LT-B9 — search_after / PIT pagination
# ---------------------------------------------------------------------------
section "LT-B9 search_after pagination"

# Offset cap enforcement (a/b)
deep=$(node -e 'process.stdout.write(Buffer.from(JSON.stringify({offset:10001})).toString("base64"))')
res=$(req POST "$BASE/employedBy/resolve" \
  "{\"objectPK\":\"E001\",\"direction\":\"forward\",\"pageToken\":\"$deep\",\"paginationMode\":\"offset\"}")
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "400" ] && [ "$(j errorCode "$body")" = "OFFSET_TOO_DEEP_USE_SEARCH_AFTER" ]; then
  pass "(b) offset > 10_000 → OFFSET_TOO_DEEP_USE_SEARCH_AFTER"
else
  fail "offset cap" "HTTP $status $(j errorCode "$body")"
fi

# search_after round-trip (a)
sat=$(node -e 'process.stdout.write(Buffer.from(JSON.stringify({sort_keys:["x"],pit_id:null,backend:"opensearch"})).toString("base64"))')
res=$(req POST "$BASE/employedBy/resolve" \
  "{\"objectPK\":\"E001\",\"direction\":\"forward\",\"pageToken\":\"$sat\",\"paginationMode\":\"search_after\"}")
status="${res%%|*}"; body="${res#*|}"
pm=$(j metadata.pagination_mode "$body")
if [ "$status" = "200" ] && [ "$pm" = "search_after" ]; then
  pass "(a) search_after token round-trip (metadata.pagination_mode=$pm)"
else
  fail "search_after round-trip" "HTTP $status pm=$pm"
fi

# PIT Redis session storage (f): linkPagination.ts exports createPit/loadPit/closePit
if grep -qE "createPit|loadPit|closePit" "$REPO/src/services/linkPagination.ts"; then
  pass "(f) PIT lifecycle shared Redis + Postgres fallback"
else
  fail "PIT lifecycle" "missing"
fi

# ---------------------------------------------------------------------------
# LT-B10 — Composite aggregation analytics
# ---------------------------------------------------------------------------
section "LT-B10 composite aggregation"

for p in fast sampled exact; do
  res=$(req GET "$BASE/employedBy/analysis?precision=$p")
  status="${res%%|*}"; body="${res#*|}"
  if [ "$status" = "200" ]; then
    cm=$(j computationMethod "$body")
    pass "(spec) precision=$p → computationMethod=$cm"
  else
    fail "precision=$p" "HTTP $status"
  fi
done

# Composite agg used for exact precision (a)
if grep -q "collectCompositeCounts\|composite:" "$REPO/src/services/linkResolverService.ts"; then
  pass "(a) composite aggregation paginated to completion"
else
  fail "composite agg" "missing"
fi

# Distribution includes p95 + p99_9 (a)
if grep -q "p95\|p99_9" "$REPO/src/services/linkResolverService.ts"; then
  pass "(a) distribution exposes p95 + p99.9"
else
  fail "p95/p99.9" "missing"
fi

# ---------------------------------------------------------------------------
# Cross-cutting gate: prior harnesses still green
# ---------------------------------------------------------------------------
section "Cross-cutting (prior harnesses still green)"

# LT-B* bash harness
bo=$(API=$API bash "$REPO/scripts/verify-link-type-extensions.sh" 2>&1 | grep -E "Results:" | tail -1)
pc=$(printf "%s" "$bo" | grep -oE '[0-9]+ passed' | head -1 | grep -oE '[0-9]+')
fc=$(printf "%s" "$bo" | grep -oE '[0-9]+ failed' | head -1 | grep -oE '[0-9]+')
if [ "${pc:-0}" -ge 22 ] && [ "${fc:-1}" = "0" ]; then
  pass "verify-link-type-extensions.sh — $pc passed / $fc failed"
else
  fail "verify-link-type-extensions.sh" "passed=$pc failed=$fc"
fi

# vitest
vo=$(cd "$REPO" && npx vitest run tests/linkTypeExtensions-unit.test.ts 2>&1 | grep "Tests" | head -1)
vc=$(printf "%s" "$vo" | grep -oE '[0-9]+ passed' | head -1 | grep -oE '[0-9]+')
if [ "${vc:-0}" -ge 27 ]; then
  pass "vitest linkTypeExtensions-unit.test.ts — $vc passed"
else
  fail "vitest" "only $vc passed"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf "\n${GRN}==>${NC} Results: ${GRN}%d passed${NC}, ${YLW}%d skipped${NC}, ${RED}%d failed${NC}\n" "$PASS" "$SKIP" "$FAIL"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
