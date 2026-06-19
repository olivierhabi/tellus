#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# FOUNDRY-GAPS §1 verification — ComputeEngine + Trino batch adapter.
#
# Static + unit verification (always):
#   1. TypeScript compiles cleanly.
#   2. Trino compiler / adapter / engine-selection unit tests pass.
#   3. The deploy seam is feature-flagged OFF by default (grep guard).
#
# Live verification (only when TRINO_URL is set):
#   4. Coordinator /v1/info answers and is not starting.
#   5. A round-trip statement executes via the REST protocol.
#
# Usage: ./scripts/verify-trino-compute.sh
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

pass() { printf '\033[32m✔ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✘ %s\033[0m\n' "$1"; exit 1; }

echo "── 1. TypeScript compile ──────────────────────────────────────"
npx tsc --noEmit || fail "tsc reported errors"
pass "tsc clean"

echo "── 2. Unit tests (compiler / adapter / engine selection) ─────"
npx vitest run --config vitest.unit.config.ts \
  tests/unit/services/trinoCompute-unit.test.ts \
  || fail "trino compute unit tests failed"
pass "unit tests green"

echo "── 3. Engine-default (auto) + safe-fallback guard ────────────"
grep -q 'TELLUS_BATCH_ENGINE ?? "auto"' src/services/pipelines/computeEngine.ts \
  || fail "batch engine no longer defaults to auto"
grep -q "engineMode === 'in-process'" src/services/deploymentService.ts \
  || fail "executeBuild seam lost its in-process opt-out"
grep -q "engineMode === 'auto' && !trinoCoordinatorConfigured()" src/services/deploymentService.ts \
  || fail "auto mode lost its coordinator gate (would route to the noop writer)"
pass "engine path is the default (auto), gated on a real coordinator, with in-process fallback"

if [[ -n "${TRINO_URL:-}" ]]; then
  echo "── 4. Live coordinator check (${TRINO_URL}) ──────────────────"
  info=$(curl -fsS --max-time 5 "${TRINO_URL%/}/v1/info") || fail "coordinator unreachable"
  echo "$info" | grep -q '"starting":false' || fail "coordinator still starting"
  pass "coordinator up"

  echo "── 5. Live statement round-trip ──────────────────────────────"
  next=$(curl -fsS -X POST "${TRINO_URL%/}/v1/statement" \
    -H "X-Trino-User: ${TRINO_USER:-tellus}" \
    -H "Content-Type: text/plain" \
    --data "SELECT 1" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("nextUri",""))')
  [[ -n "$next" ]] || fail "statement submit returned no nextUri"
  for _ in $(seq 1 20); do
    body=$(curl -fsS -H "X-Trino-User: ${TRINO_USER:-tellus}" "$next")
    state=$(echo "$body" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("stats",{}).get("state",""))')
    next=$(echo "$body" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("nextUri",""))')
    [[ "$state" == "FINISHED" || -z "$next" ]] && break
    sleep 0.5
  done
  [[ "$state" == "FINISHED" ]] || fail "statement did not finish (state=$state)"
  pass "SELECT 1 executed via REST protocol"
else
  echo "ℹ TRINO_URL not set — skipped live coordinator checks (4-5)."
fi

echo
pass "FOUNDRY-GAPS §1 Trino compute verification complete"
