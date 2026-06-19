#!/usr/bin/env bash
# scripts/quiver-verify.sh — Quiver verification harness (CONTRACT v1 §4).
#
# Single source of truth for VERIFIED-GREEN.  Exit 0 = green.  Any other exit
# code indicates the specific stage that failed.
#
# Stages:
#   1.  docker compose down (clean slate)
#   2.  docker compose up --build --wait
#   3.  npm ci (host-side; toolchain for vitest + cypress)
#   4.  vitest integration (json reporter; ≥407 tests, 0 failures)
#   5.  cypress run against live app (≥4 specs, all green, ≥1 video each)
#   6.  bash scripts/quiver-coverage-check.sh (266/266 covered)
#   7.  bash scripts/verify-handoff.sh (HANDOFF_INDEX integrity)
#   8.  Negative-test gate (stash impl → tests fail → restore → tests pass)
#   9.  BUILD_HASH (sha256 over src + tests + cypress + scripts + compose)
#  10.  docker compose down -v
#  11.  emit GREEN line
#  12.  exit 0
#
# Set -x is enabled for stages 1–10 so the transcript is fully auditable.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ARTIFACTS="$ROOT/artifacts"
NEG="$ARTIFACTS/negative-tests"
LOG="$ROOT/logs/quiver-verify.$(date -u +%Y%m%d-%H%M%SZ).log"
mkdir -p "$ARTIFACTS" "$NEG" "$ROOT/logs" "$ROOT/cypress/videos/quiver" "$ROOT/cypress/screenshots/quiver"

exec > >(tee -a "$LOG") 2>&1

COMPOSE="docker compose -f docker-compose.verify.yml"
INT_TOTAL=0
CY_TOTAL=0
NEG_FAILED_TESTS=0

dump_logs() {
  echo "::group::FAILURE — last 200 lines of compose logs"
  $COMPOSE logs --no-color --tail=200 > "$ARTIFACTS/failure.log" 2>&1 || true
  tail -200 "$ARTIFACTS/failure.log" 2>/dev/null || true
  echo "::endgroup::"
}

on_err() {
  rc=$?
  set +x
  echo "[verify] FAIL — stage error rc=${rc} at line ${BASH_LINENO[0]}"
  dump_logs
  exit "${rc:-99}"
}
trap on_err ERR

cleanup_compose() {
  set +e
  echo "::group::Cleanup — docker compose down -v"
  $COMPOSE down -v --remove-orphans >/dev/null 2>&1
  echo "::endgroup::"
  set -e
}

# Restore any negative-test stash that survived a crash.
on_exit() {
  rc=$?
  set +e
  set +x
  if git stash list 2>/dev/null | grep -q "verify-negative\|verify-gate-"; then
    echo "[cleanup] restoring negative-test stashes …"
    while git stash list 2>/dev/null | grep -qE "verify-(negative|gate-)"; do
      idx=$(git stash list | grep -nE "verify-(negative|gate-)" | head -1 | cut -d: -f1)
      [ -z "$idx" ] && break
      git stash pop "stash@{$((idx-1))}" >/dev/null 2>&1 || break
    done
  fi
  exit "${rc:-0}"
}
trap on_exit EXIT

assert() {
  local actual="$1" expected="$2" what="$3"
  if [ "$actual" != "$expected" ]; then
    echo "[assert] $what: expected '$expected', got '$actual'"
    return 1
  fi
}

assert_ge() {
  local actual="$1" min="$2" what="$3"
  if [ "$actual" -lt "$min" ]; then
    echo "[assert] $what: expected >= '$min', got '$actual'"
    return 1
  fi
}

stage_1_down() {
  echo "::group::1. compose down -v"
  set -x
  $COMPOSE down -v --remove-orphans
  set +x
  echo "::endgroup::"
}

stage_2_up() {
  echo "::group::2. compose up --build --wait"
  set -x
  if ! $COMPOSE up -d --build --wait --wait-timeout 300; then
    set +x
    echo "[stage 2] compose --wait failed"
    dump_logs
    exit 10
  fi
  $COMPOSE ps
  set +x
  echo "::endgroup::"
}

stage_3_ci() {
  echo "::group::3. npm ci"
  set -x
  npm ci --prefer-offline --no-audit --no-fund
  set +x
  echo "::endgroup::"
}

stage_4_integration() {
  echo "::group::4. vitest integration (json reporter)"
  local out="$ARTIFACTS/integration.json"
  set -x
  PGHOST=127.0.0.1 PGPORT=32432 PGUSER=tellus PGPASSWORD=tellus123 PGDATABASE=tellus_db \
    REDIS_HOST=127.0.0.1 REDIS_PORT=32379 \
    QUIVER_ALLOW_TEST_AUTH=1 TELLUS_QUIVER_PHASE=5 \
    npx vitest run --config vitest.quiver.config.ts \
      --reporter=json --outputFile="$out" \
      --reporter=default
  set +x
  if ! command -v jq >/dev/null 2>&1; then
    echo "[stage 4] jq missing — cannot validate integration.json"
    exit 30
  fi
  local fails total
  fails="$(jq -r '.numFailedTests // 0' "$out")"
  total="$(jq -r '.numTotalTests // 0' "$out")"
  echo "[stage 4] integration: total=$total failed=$fails"
  assert "$fails" 0 "numFailedTests" || exit 30
  assert_ge "$total" 407 "numTotalTests" || exit 30
  INT_TOTAL="$total"
  echo "::endgroup::"
}

stage_5_cypress() {
  echo "::group::5. cypress run (4 specs, spec reporter + synthesized cypress.json)"
  local out="$ARTIFACTS/cypress.json"
  local log="$ARTIFACTS/cypress.stdout.log"
  if [ ! -x node_modules/.bin/cypress ]; then
    echo "[stage 5] node_modules/.bin/cypress missing after npm ci — listing devDependencies"
    node -e "console.log(require('./package.json').devDependencies)" || true
    exit 40
  fi
  # The Mocha-style JSON reporter (cypress 13's `--reporter json`) only writes
  # one file per spec invocation; with N specs the file is overwritten or never
  # finalized, so we cannot rely on it. Instead: run with the default `spec`
  # reporter, capture stdout, and synthesize a minimal cypress.json from the
  # final summary table that lists per-spec pass/fail/duration.
  set -x
  CYPRESS_baseUrl="${CYPRESS_baseUrl:-http://localhost:32000}" \
  KEYCLOAK_URL="http://localhost:32080" \
  KEYCLOAK_REALM="tellus" \
  KEYCLOAK_CLIENT_ID="tellus-app" \
  KEYCLOAK_USER="verify-user" KEYCLOAK_PASS="verify-password" \
  KEYCLOAK_USER_NO_ACTION="verify-user-no-action" KEYCLOAK_PASS_NO_ACTION="verify-password" \
    node_modules/.bin/cypress run \
      --spec 'cypress/e2e/quiver/**/*.cy.ts' \
      2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  set +x
  if [ "$rc" -ne 0 ]; then
    echo "[stage 5] cypress run rc=$rc"
    exit 40
  fi
  # Cypress 13 wraps every word in ANSI color escapes (\e[01;31m, \e[K, etc.)
  # which makes regex parsing inside the box-drawing summary fragile. The
  # robust signals we *do* trust on this output:
  #   1. cypress's exit code (already checked above; rc=0 means green)
  #   2. presence of the literal "All specs passed!" footer
  #   3. "Spec Ran:" line per spec — `grep -c` works even with ANSI present
  # We also peek the final summary row for a tests count, but we only
  # use it for reporting; the assertion lives on signals 1+2+3.
  local cy_specs cy_passed_marker
  cy_specs=$(grep -c "Spec Ran:" "$log" || true)
  cy_specs=${cy_specs:-0}
  cy_passed_marker=$(grep -c "All specs passed!" "$log" || true)
  cy_passed_marker=${cy_passed_marker:-0}
  if [ "$cy_passed_marker" -lt 1 ]; then
    echo "[stage 5] FAIL: 'All specs passed!' footer absent from cypress stdout"
    exit 40
  fi
  # cypress exit 0 + "All specs passed!" + ≥4 spec-ran lines ⇒ green.
  # 1 test per spec by construction (one it() per spec file).
  local cy_total cy_failures
  cy_total="$cy_specs"
  cy_failures=0
  # Synthesize cypress.json so downstream tooling can consume it.
  jq -n \
    --argjson tests "$cy_total" \
    --argjson failures "$cy_failures" \
    --argjson specs "$cy_specs" \
    '{stats: {tests: $tests, failures: $failures, specs: $specs}, source: "synthesized from cypress stdout"}' \
    > "$out"
  echo "[stage 5] cypress: specs=$cy_specs tests=$cy_total failures=$cy_failures"
  assert "$cy_failures" 0 "cypress failures" || exit 40
  assert_ge "$cy_total" 4 "cypress tests" || exit 40
  assert_ge "$cy_specs" 4 "cypress specs ran" || exit 40
  local videos
  videos=$(find cypress/videos/quiver -name '*.mp4' -type f 2>/dev/null | wc -l | tr -d ' ')
  assert_ge "$videos" 4 "cypress videos" || exit 40
  CY_TOTAL="$cy_total"
  echo "::endgroup::"
}

stage_6_coverage() {
  echo "::group::6. quiver-coverage-check"
  set -x
  bash scripts/quiver-coverage-check.sh
  set +x
  echo "::endgroup::"
}

stage_7_handoff() {
  echo "::group::7. verify-handoff"
  set -x
  bash scripts/verify-handoff.sh
  set +x
  echo "::endgroup::"
}

# ----- 8. NEGATIVE-TEST GATE ---------------------------------------------------
# Olivier's standing rule: a test that cannot fail when the implementation is
# removed is not a test. We stash one core implementation file per gate and
# the "global" foundryUploadService stash from §4 step 8.
stage_8_negative() {
  echo "::group::8. Negative-test gate"
  # Disable set -e + ERR trap for the duration of this stage. The negative
  # gate intentionally runs commands that exit nonzero (vitest with stashed
  # implementation, etc.); we manage exit codes manually with explicit guards.
  trap - ERR
  set +e
  local pairs=(
    "global|src/services/quiver/analysisService.ts|tests/quiver/integration/b1-routes-integration.test.ts"
    "gate-01|src/services/quiver/ot/transform.ts|tests/quiver/unit/b3-convergence-unit.test.ts tests/quiver/integration/gate-01-ot-convergence-integration.test.ts"
    "gate-02|src/services/quiver/compute/cache.ts|tests/quiver/integration/gate-02-compute-cache-deadline-integration.test.ts"
    "gate-04|src/services/quiver/branchHeader.ts|tests/quiver/integration/gate-04-auth-branch-propagation-integration.test.ts tests/quiver/integration/b1-routes-integration.test.ts"
    "b9-aip|src/services/quiver/aip/inProcessAip.ts|tests/quiver/integration/b9-aip-route-integration.test.ts"
  )
  local stage8_rc=0
  for entry in "${pairs[@]}"; do
    local label impl_file test_paths
    label="$(echo "$entry" | cut -d'|' -f1)"
    impl_file="$(echo "$entry" | cut -d'|' -f2)"
    test_paths="$(echo "$entry" | cut -d'|' -f3)"
    echo "--- negative gate: $label (stash $impl_file) ---"
    if [ ! -f "$impl_file" ]; then
      echo "[stage 8] $label: $impl_file missing — cannot stash"
      stage8_rc=50
      break
    fi
    local backup="$NEG/${label}.bak"
    cp -p "$impl_file" "$backup" || { echo "[neg/$label] cp backup failed"; stage8_rc=50; break; }
    # Replace with a stub that throws at runtime so test failures are
    # runtime assertions, not type errors.
    cat > "$impl_file" <<'EOF_STUB'
// negative-test stub installed by scripts/quiver-verify.sh — DO NOT COMMIT.
// All exports throw at runtime so callers fail on assertion, not on import.
const __NEGATIVE_STUB__ = (...args: unknown[]): never => {
  throw new Error("[negative-stub] implementation stashed by quiver-verify");
};
export default __NEGATIVE_STUB__;
export const noop = __NEGATIVE_STUB__;
EOF_STUB
    PGHOST=127.0.0.1 PGPORT=32432 PGUSER=tellus PGPASSWORD=tellus123 PGDATABASE=tellus_db \
      REDIS_HOST=127.0.0.1 REDIS_PORT=32379 \
      QUIVER_ALLOW_TEST_AUTH=1 TELLUS_QUIVER_PHASE=5 \
      npx vitest run --config vitest.quiver.config.ts \
        --reporter=json --outputFile="$NEG/${label}.stashed.json" \
        $test_paths > "$NEG/${label}.stashed.txt" 2>&1
    # Always restore from backup, regardless of vitest exit code.
    cp -p "$backup" "$impl_file"
    rm -f "$backup"
    if [ ! -s "$NEG/${label}.stashed.json" ]; then
      echo '{"numFailedTests": 0}' > "$NEG/${label}.stashed.json"
    fi
    local fails
    fails="$(jq -r '.numFailedTests // 0' "$NEG/${label}.stashed.json" 2>/dev/null)"
    fails="${fails:-0}"
    echo "[neg/$label] stashed-run failed tests = $fails"
    if [ "$fails" -lt 1 ]; then
      echo "[neg/$label] FRAUD: removing $impl_file broke 0 tests."
      stage8_rc=50
      break
    fi
    NEG_FAILED_TESTS=$((NEG_FAILED_TESTS + fails))
    # Restore-pass:
    PGHOST=127.0.0.1 PGPORT=32432 PGUSER=tellus PGPASSWORD=tellus123 PGDATABASE=tellus_db \
      REDIS_HOST=127.0.0.1 REDIS_PORT=32379 \
      QUIVER_ALLOW_TEST_AUTH=1 TELLUS_QUIVER_PHASE=5 \
      npx vitest run --config vitest.quiver.config.ts \
        --reporter=json --outputFile="$NEG/${label}.restored.json" \
        $test_paths > "$NEG/${label}.restored.txt" 2>&1
    local rfails
    rfails="$(jq -r '.numFailedTests // 0' "$NEG/${label}.restored.json" 2>/dev/null)"
    rfails="${rfails:-0}"
    if [ "$rfails" -ne 0 ]; then
      echo "[neg/$label] restored-run had $rfails failures — implementation not cleanly restored"
      stage8_rc=50
      break
    fi
    echo "[neg/$label] OK — stashed=$fails failed → restored=0 failed"
  done
  # Re-enable strict mode + ERR trap before returning to the harness flow.
  set -e
  trap on_err ERR
  echo "::endgroup::"
  if [ "$stage8_rc" -ne 0 ]; then
    exit "$stage8_rc"
  fi
}

stage_9_hash() {
  echo "::group::9. BUILD_HASH"
  local hashbin
  hashbin="$(command -v sha256sum || command -v shasum)"
  if [ -z "$hashbin" ]; then
    echo "[stage 9] no sha256sum / shasum available"
    exit 99
  fi
  if [[ "$hashbin" == */shasum ]]; then
    HASH_CMD="$hashbin -a 256"
  else
    HASH_CMD="$hashbin"
  fi
  local h
  h=$(find src tests cypress/e2e/quiver scripts/quiver-verify.sh \
              docker-compose.verify.yml otel-collector-config.yaml \
              keycloak/realm-tellus.json \
        -type f 2>/dev/null \
      | sort \
      | xargs $HASH_CMD \
      | $HASH_CMD \
      | awk '{print $1}')
  echo "$h" > "$ARTIFACTS/BUILD_HASH"
  echo "[stage 9] BUILD_HASH=$h"
  echo "::endgroup::"
}

stage_10_down() {
  echo "::group::10. compose down -v (final)"
  set -x
  $COMPOSE down -v --remove-orphans
  set +x
  echo "::endgroup::"
}

# ============================== main ==========================================
echo "[verify] starting at $(date -u +%FT%TZ) — log=$LOG"

stage_1_down
stage_2_up
stage_3_ci
stage_4_integration
stage_5_cypress
stage_6_coverage
stage_7_handoff
stage_8_negative
stage_9_hash
stage_10_down

BUILD_HASH="$(cat "$ARTIFACTS/BUILD_HASH")"
echo "[verify] GREEN build=$BUILD_HASH integration=$INT_TOTAL cypress=$CY_TOTAL coverage=266"
exit 0
