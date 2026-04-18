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

run "save-to-ontology (UUID commit contract)" \
  "${REPO_ROOT}/scripts/verify-save-to-ontology.sh"

run "funnel-reset (repeat-save → fresh run_id)" \
  "${REPO_ROOT}/scripts/verify-funnel-reset.sh"

run "stage-delay (per-stage pacing + prod baseline)" \
  "${REPO_ROOT}/scripts/verify-funnel-stage-delay.sh"

echo -e "${BOLD}========================================${NC}"
if [[ $EXIT_CODE -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}FUNNEL E2E: ALL PASSED${NC}"
else
  echo -e "${RED}${BOLD}FUNNEL E2E: ONE OR MORE FAILED${NC}"
fi
echo -e "${BOLD}========================================${NC}"

exit $EXIT_CODE
