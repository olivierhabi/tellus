#!/usr/bin/env bash
# ===========================================================================
# Funnel E2E Suite
# ===========================================================================
# Exercises the full Funnel commit-to-indexing flow + per-save reset
# semantics against a live stack (API, Postgres, Keycloak, Temporal).
#
# Wraps three pre-existing `scripts/verify-funnel-*.sh` orchestrators
# so the whole suite is reachable via `npm run test:e2e` (the daily
# runner iterates `tests/<day>/e2e/suite.sh`; this is the non-day
# equivalent for task B1–B10 coverage).
#
# What runs, in order:
#
#   1. verify-save-to-ontology.sh — UUID-keyed commit endpoint contract
#      (happy path, idempotency, bogus UUID, back-compat).
#      Runs against whatever backend is already up; does NOT restart it.
#
#   2. verify-funnel-reset.sh — repeat-click contract. Starts its own
#      backend paced at FUNNEL_STAGE_DELAY_MS=5000, asserts a second
#      commit produces a fresh funnel_run row starting from changelog,
#      and restores FUNNEL_STAGE_DELAY_MS=0 on exit via its trap.
#
#   3. verify-funnel-stage-delay.sh — per-stage pacing contract. Same
#      self-managed backend lifecycle as (2); verifies each stage
#      runs ≥ 4.5 s when paced and < 5 s total when the knob is off.
#
# The trap handlers inside each child script restore the backend to
# FUNNEL_STAGE_DELAY_MS=0 on exit, so whatever state they left is
# safe for any test that runs after this suite in the parent runner.
#
# This script is INTENDED to be the LAST entry in the daily e2e runner
# (tests/e2e/run-all.sh's DAYS array), because the embedded orchestrators
# restart the backend — downstream suites would otherwise race against
# the respawn.
# ===========================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

GREEN='\033[0;32m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

EXIT_CODE=0

run() {
  local label="$1"; shift
  echo -e "${BOLD}========================================${NC}"
  echo -e "${BOLD}  Funnel e2e → ${label}${NC}"
  echo -e "${BOLD}========================================${NC}"
  if "$@"; then
    echo -e "${GREEN}${BOLD}${label}: PASS${NC}"
  else
    echo -e "${RED}${BOLD}${label}: FAIL${NC}"
    EXIT_CODE=1
  fi
  echo ""
}

# ---------------------------------------------------------------------------
# Temporal gate for the two reset / stage-delay contracts.
#
# verify-funnel-reset.sh and verify-funnel-stage-delay.sh restart the backend
# and assert a funnel_run reaches `status == "completed"` — that requires the
# Temporal dispatcher (signal-with-start → worker → pipeline). The e2e CI job
# (.github/workflows/ci.yml `e2e`) provisions postgres / opensearch / keycloak
# / minio but NOT Temporal, so against CI a paced run polls for a `completed`
# row that never arrives and dies after 60 s, turning the whole funnel suite
# red for a reason unrelated to the implementation. verify-save-to-ontology.sh
# is CI-safe — it treats a missing funnel_run as a non-fatal warning — so it
# always runs. The two Temporal-dependent contracts are skipped when Temporal
# is unreachable, mirroring run-all.sh's `pb_dep_available` skip pattern for
# Lakekeeper / docker-dependent PB smokes. Override the probe target via
# TEMPORAL_ADDRESS (default mirrors src: TEMPORAL_ADDRESS ?? "localhost:7233").
# A bare bash /dev/tcp probe is used (no nc dependency on the runner host).
# ---------------------------------------------------------------------------
TEMPORAL_ADDR="${TEMPORAL_ADDRESS:-localhost:7233}"
temporal_reachable() {
  local host="${TEMPORAL_ADDR%%:*}" port="${TEMPORAL_ADDR##*:}"
  # Subshell so the opened fd is scoped + auto-closed on exit. Connection to
  # a closed localhost port fails fast (RST); returns 0 only if the TCP
  # handshake completes — i.e. something is listening on the Temporal gRPC port.
  (exec 3<>/dev/tcp/"$host"/"$port") >/dev/null 2>&1
}
skip() {
  local label="$1"; local reason="$2"
  echo -e "${BOLD}SKIP${NC}  ${label} — ${reason}"
  echo ""
}

run "save-to-ontology (UUID commit contract)" \
  "${REPO_ROOT}/scripts/verify-save-to-ontology.sh"

if temporal_reachable; then
  run "funnel-reset (repeat-save → fresh run_id)" \
    "${REPO_ROOT}/scripts/verify-funnel-reset.sh"
  run "stage-delay (per-stage pacing + prod baseline)" \
    "${REPO_ROOT}/scripts/verify-funnel-stage-delay.sh"
else
  skip "funnel-reset (repeat-save → fresh run_id)" \
    "Temporal unreachable at ${TEMPORAL_ADDR} (CI e2e job has no Temporal)"
  skip "stage-delay (per-stage pacing + prod baseline)" \
    "Temporal unreachable at ${TEMPORAL_ADDR} (CI e2e job has no Temporal)"
fi

echo -e "${BOLD}========================================${NC}"
if [[ $EXIT_CODE -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}FUNNEL E2E: ALL PASSED${NC}"
else
  echo -e "${RED}${BOLD}FUNNEL E2E: ONE OR MORE FAILED${NC}"
fi
echo -e "${BOLD}========================================${NC}"

exit $EXIT_CODE
