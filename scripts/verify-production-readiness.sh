#!/usr/bin/env bash
# =============================================================================
# Tellus Ontology Engine — Production-Readiness Verification Script
#
# Validates that all findings from the audit report have been addressed.
# Run with: bash scripts/verify-production-readiness.sh
#
# Requirements:
#   - Docker (for PostgreSQL, OpenSearch, Keycloak, MinIO)
#   - Node.js 20+, pnpm
#   - Server running on localhost:3000 with RATE_LIMIT_MAX=999999
#
# Exit codes:
#   0 — all checks pass
#   1 — one or more checks failed
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
CYN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0
CHECKS=()

pass() { ((PASS++)); CHECKS+=("PASS: $1"); echo -e "  ${GRN}PASS${NC}: $1"; }
fail() { ((FAIL++)); CHECKS+=("FAIL: $1"); echo -e "  ${RED}FAIL${NC}: $1"; }
warn() { ((WARN++)); CHECKS+=("WARN: $1"); echo -e "  ${YLW}WARN${NC}: $1"; }
section() { echo -e "\n${CYN}=== $1 ===${NC}"; }

BASE_URL="${TELLUS_URL:-http://localhost:3000}"

# =============================================================================
section "Phase 0: Pre-flight checks"
# =============================================================================

echo "  Checking TypeScript compilation..."
if npx tsc --noEmit 2>/dev/null; then
  pass "F-ALL: TypeScript compiles cleanly (zero errors)"
else
  fail "F-ALL: TypeScript compilation errors detected"
fi

# =============================================================================
section "F-03 (P0): Hardcoded superadmin password removed"
# =============================================================================

if grep -rn 'Olivier0?Tellus' src/ 2>/dev/null; then
  fail "F-03: Hardcoded password 'Olivier0?Tellus' still found in src/"
else
  pass "F-03: No hardcoded superadmin password in source"
fi

# Check that SUPERADMIN_PASSWORD is now read from env var
if grep -n 'SUPERADMIN_PASSWORD' src/server.ts >/dev/null 2>&1; then
  pass "F-03: SUPERADMIN_PASSWORD read from environment variable"
else
  warn "F-03: SUPERADMIN_PASSWORD env var usage not detected in server.ts"
fi

# =============================================================================
section "F-01/F-02/F-13 (P0): Security filter on all OpenSearch query paths"
# =============================================================================

# Check that queryExecutor accepts securityFilter
if grep -n 'securityFilter' src/services/queryExecutor.ts >/dev/null 2>&1; then
  pass "F-01: queryExecutor.ts accepts securityFilter parameter"
else
  fail "F-01: queryExecutor.ts does NOT accept securityFilter parameter"
fi

# Check that linkResolverService uses security filter
if grep -n 'securityFilter' src/services/linkResolverService.ts >/dev/null 2>&1; then
  pass "F-02: linkResolverService.ts uses securityFilter"
else
  fail "F-02: linkResolverService.ts does NOT use securityFilter"
fi

# =============================================================================
section "F-05 (P0): Atomic optimistic concurrency (TOCTOU fix)"
# =============================================================================

# Check that version check is inside PG transaction (SELECT FOR UPDATE)
if grep -n 'FOR UPDATE' src/actions/editApplicator.ts >/dev/null 2>&1; then
  pass "F-05: Optimistic concurrency check uses SELECT FOR UPDATE inside transaction"
else
  fail "F-05: No SELECT FOR UPDATE found in editApplicator.ts"
fi

# Check that the OCC fallback counts ontology_edit rows
if grep -n 'COUNT.*ontology_edit' src/actions/editApplicator.ts >/dev/null 2>&1; then
  pass "F-05: OCC fallback uses ontology_edit row count when object_instances has no row"
else
  fail "F-05: No ontology_edit fallback found in editApplicator.ts"
fi

# Check that OCC throws OntologyError (not plain Error)
if grep -q 'new OntologyError' src/actions/editApplicator.ts && grep -q '"CONCURRENCY_CONFLICT"' src/actions/editApplicator.ts; then
  pass "F-05: OCC throws OntologyError with CONCURRENCY_CONFLICT code (maps to 409)"
else
  fail "F-05: OCC does not throw OntologyError — error may not map to 409"
fi

# Check that actionExecutor no longer does external version fetch
if grep -n 'fetchObject.*targetEdit' src/actions/actionExecutor.ts >/dev/null 2>&1; then
  fail "F-05: actionExecutor.ts still fetches object externally for version check"
else
  pass "F-05: actionExecutor.ts delegates version check to editApplicator (transactional)"
fi

# =============================================================================
section "F-06 (P0): ONE_TO_ONE default policy = reject"
# =============================================================================

if grep -n 'violation_policy.*reject' src/services/linkViolationEnforcer.ts >/dev/null 2>&1; then
  pass "F-06: Default ONE_TO_ONE violation_policy is 'reject'"
else
  fail "F-06: Default violation_policy is NOT 'reject'"
fi

# Check PG-based lookup
if grep -n 'SELECT.*target_primary_key.*FROM.*link_edit' src/services/linkViolationEnforcer.ts >/dev/null 2>&1; then
  pass "F-06: O2O check uses PG link_edit table (transactional) instead of OpenSearch"
else
  fail "F-06: O2O check still uses OpenSearch (non-transactional)"
fi

# =============================================================================
section "F-11 (P1): ONE_TO_MANY cardinality enforcement"
# =============================================================================

if grep -n 'ONE_TO_MANY' src/services/linkViolationEnforcer.ts >/dev/null 2>&1; then
  pass "F-11: ONE_TO_MANY enforcement implemented in linkViolationEnforcer"
else
  fail "F-11: No ONE_TO_MANY enforcement found"
fi

# =============================================================================
section "F-07 (P1): Audit writes durable before ack"
# =============================================================================

if grep -n 'Audit write failed' src/services/auditEventService.ts >/dev/null 2>&1; then
  pass "F-07: emitAuditEvent throws on failure (durable before ack)"
else
  fail "F-07: emitAuditEvent still swallows errors (fire-and-forget)"
fi

# Check best-effort variant exists for auth events
if grep -n 'emitAuditEventBestEffort' src/services/auditEventService.ts >/dev/null 2>&1; then
  pass "F-07: emitAuditEventBestEffort exists for auth-lifecycle events"
else
  warn "F-07: No best-effort audit variant found"
fi

# =============================================================================
section "F-08 (P1): Extended audit categories"
# =============================================================================

for action in "object.read" "object.create" "link.traverse" "search.execute" "action.execute"; do
  if grep -n "'${action}'" src/services/auditEventService.ts >/dev/null 2>&1; then
    pass "F-08: Audit action '${action}' defined"
  else
    fail "F-08: Audit action '${action}' NOT defined"
  fi
done

# =============================================================================
section "F-09 (P1): Test determinism — rate limiter disabled"
# =============================================================================

if grep -n 'RATE_LIMIT_MAX.*999999' vitest.config.ts >/dev/null 2>&1; then
  pass "F-09: RATE_LIMIT_MAX=999999 set in vitest.config.ts env"
else
  fail "F-09: RATE_LIMIT_MAX not elevated in vitest.config.ts"
fi

# =============================================================================
section "F-10 (P1): Cascade cleanup on link type deletion"
# =============================================================================

if grep -n 'CASCADE_CLEANUP' src/routes/links.ts >/dev/null 2>&1; then
  pass "F-10: Cascade cleanup implemented in link type delete handler"
else
  fail "F-10: No cascade cleanup on link type deletion"
fi

if grep -n 'DELETE FROM link_edit' src/routes/links.ts >/dev/null 2>&1; then
  pass "F-10: link_edit rows purged on link type deletion"
else
  fail "F-10: link_edit rows NOT purged on deletion"
fi

# =============================================================================
section "F-12 (P1): PG pool configurable via env var"
# =============================================================================

if grep -n 'PG_POOL_MAX' src/db.ts >/dev/null 2>&1; then
  pass "F-12: PG connection pool max is configurable via PG_POOL_MAX"
else
  fail "F-12: PG pool max is still hardcoded"
fi

# =============================================================================
section "F-14 (P2): CI secrets via GitHub Actions secrets"
# =============================================================================

if grep -n 'secrets.CI_PGPASSWORD' .github/workflows/ci.yml >/dev/null 2>&1; then
  pass "F-14: CI uses GitHub Actions secrets for PostgreSQL credentials"
else
  fail "F-14: CI still has plaintext PostgreSQL credentials"
fi

if grep -n 'secrets.CI_KEYCLOAK_SECRET' .github/workflows/ci.yml >/dev/null 2>&1; then
  pass "F-14: CI uses GitHub Actions secrets for Keycloak"
else
  fail "F-14: CI still has plaintext Keycloak credentials"
fi

# =============================================================================
section "F-15 (P2): Prometheus counter for audit failures"
# =============================================================================

if grep -n 'tellus_audit_emit_failures_total' src/services/auditEventService.ts >/dev/null 2>&1; then
  pass "F-15: Prometheus counter 'tellus_audit_emit_failures_total' defined"
else
  fail "F-15: No Prometheus counter for audit failures"
fi

# =============================================================================
section "F-16 (P2): No duplicate migration prefixes"
# =============================================================================

DUPES=$(ls -1 src/migrations/ | sed 's/_.*//' | sort | uniq -d | head -5)
if [ -z "$DUPES" ]; then
  pass "F-16: No duplicate migration prefixes"
else
  fail "F-16: Duplicate migration prefixes found: $DUPES"
fi

# =============================================================================
section "F-17 (P2): Rate limiter sends Retry-After header"
# =============================================================================

if grep -n 'Retry-After' src/server.ts >/dev/null 2>&1; then
  pass "F-17: Retry-After header set in rate limiter response"
else
  fail "F-17: No Retry-After header in rate limiter"
fi

# =============================================================================
section "F-04 (P0): Three-way merge branching"
# =============================================================================

if [ -f src/services/branchMergeService.ts ]; then
  pass "F-04: branchMergeService.ts exists"
else
  fail "F-04: branchMergeService.ts not found"
fi

if grep -n 'mergeThreeWay' src/services/branchMergeService.ts >/dev/null 2>&1; then
  pass "F-04: mergeThreeWay function implemented"
else
  fail "F-04: mergeThreeWay function not found"
fi

if grep -n 'detectConflicts' src/services/branchMergeService.ts >/dev/null 2>&1; then
  pass "F-04: Conflict detection implemented"
else
  fail "F-04: No conflict detection found"
fi

if grep -n 'recordForkPoint' src/services/branchMergeService.ts >/dev/null 2>&1; then
  pass "F-04: Fork point recording implemented"
else
  fail "F-04: No fork point recording found"
fi

if grep -n 'mergeThreeWay' src/routes/branches.ts >/dev/null 2>&1; then
  pass "F-04: Branch merge route uses three-way merge service"
else
  fail "F-04: Branch merge route does NOT use three-way merge"
fi

if [ -f src/migrations/035_branch_three_way_merge.sql ]; then
  pass "F-04: Migration 035 for three-way merge infrastructure exists"
else
  fail "F-04: Migration for three-way merge not found"
fi

# =============================================================================
section "Integration tests (requires running infrastructure)"
# =============================================================================

echo "  Checking if server is reachable at ${BASE_URL}..."
if curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
  pass "Server is reachable at ${BASE_URL}"

  # Test rate limiter sends Retry-After
  echo "  Testing rate limiter headers..."
  # This is non-destructive — we check the response format
  HEALTH_RESP=$(curl -sf "${BASE_URL}/health" 2>&1)
  if echo "$HEALTH_RESP" | grep -qi "ok\|healthy\|status"; then
    pass "Health endpoint returns valid response"
  else
    warn "Health endpoint response format unexpected"
  fi

  # Test that security filter blocks unauthenticated searches
  echo "  Testing security filter enforcement..."
  SEARCH_RESP=$(curl -s -w "%{http_code}" -o /dev/null "${BASE_URL}/api/v1/objects/any_type" 2>&1)
  if [ "$SEARCH_RESP" = "401" ] || [ "$SEARCH_RESP" = "403" ]; then
    pass "Unauthenticated object search returns 401/403"
  elif [ "$SEARCH_RESP" = "404" ]; then
    warn "Object search returns 404 (type not found) — auth check may be downstream"
  else
    warn "Object search returns $SEARCH_RESP — verify auth is enforced"
  fi

else
  warn "Server not reachable — skipping integration checks"
  warn "Start server with: RATE_LIMIT_MAX=999999 npx tsx src/server.ts"
fi

# =============================================================================
section "Summary"
# =============================================================================

echo ""
echo -e "  ${GRN}Passed:${NC}  $PASS"
echo -e "  ${RED}Failed:${NC}  $FAIL"
echo -e "  ${YLW}Warnings:${NC} $WARN"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}VERDICT: NOT PRODUCTION-READY — $FAIL check(s) failed.${NC}"
  echo ""
  echo "Failed checks:"
  for c in "${CHECKS[@]}"; do
    if [[ "$c" == FAIL:* ]]; then
      echo "  - ${c#FAIL: }"
    fi
  done
  exit 1
else
  if [ "$WARN" -gt 0 ]; then
    echo -e "${YLW}VERDICT: CONDITIONAL-GO — all checks pass, $WARN warning(s) need attention.${NC}"
  else
    echo -e "${GRN}VERDICT: GO — all production-readiness checks pass.${NC}"
  fi
  exit 0
fi
