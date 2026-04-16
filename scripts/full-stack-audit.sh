#!/usr/bin/env bash
#
# full-stack-audit.sh
# -------------------
# One script that runs every test layer in sequence and produces a single
# unified pass/fail report:
#
#   1. docker integration  →  scripts/verify-docker-integrations.sh
#   2. backend feature matrix →  scripts/verify-features.sh
#   3. production readiness   →  scripts/production-readiness-audit.sh
#   4. frontend cypress       →  cd ../tellus-fe && cypress run
#
# Each layer reports its own pass/fail; this script collects them and
# prints a final "is the platform shippable" verdict.
#
# Usage:
#   ./scripts/full-stack-audit.sh              # default
#   SKIP_CYPRESS=1 ./scripts/full-stack-audit.sh
#   FAIL_FAST=1 ./scripts/full-stack-audit.sh

set -o pipefail

REPO_BACKEND="${REPO_BACKEND:-/Users/olivierhabimana/Desktop/projects/tellus}"
REPO_FRONTEND="${REPO_FRONTEND:-/Users/olivierhabimana/Desktop/projects/tellus-fe}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

declare -gA LAYER_RESULT
declare -gA LAYER_DETAIL
LAYERS=()

cooldown() {
  # Each layer fires ~150 requests within 30 s. The default global rate
  # limiter is 200/min, so two layers back-to-back exhaust the window
  # and the second layer sees a wall of 429s. Sleep 70 s between layers
  # so each one starts with a clean rate-limit budget.
  local secs="${1:-70}"
  echo
  echo -e "${DIM}  cooling down ${secs}s for global rate-limit window…${NC}"
  sleep "$secs"
}

run_layer() {
  local key="$1"
  local label="$2"
  shift 2
  LAYERS+=("$key")
  echo
  echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}${BLUE}  $label${NC}"
  echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════════════════════════${NC}"
  local out
  out=$(mktemp)
  if "$@" > "$out" 2>&1; then
    LAYER_RESULT[$key]="pass"
    LAYER_DETAIL[$key]=$(grep -E "Pass|Failed|score|SHIP|VERDICT" "$out" | tail -10 | tr '\n' '|' || true)
    cat "$out" | tail -20
    echo -e "${GREEN}${BOLD}✓ $label PASSED${NC}"
  else
    LAYER_RESULT[$key]="fail"
    LAYER_DETAIL[$key]=$(grep -E "Pass|Failed|score|FAIL|✗" "$out" | tail -10 | tr '\n' '|' || true)
    cat "$out" | tail -30
    echo -e "${RED}${BOLD}✗ $label FAILED${NC}"
    if [[ "${FAIL_FAST:-0}" == "1" ]]; then
      print_summary
      exit 1
    fi
  fi
  rm -f "$out"
}

print_summary() {
  echo
  echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}${BLUE}  Full-stack audit summary${NC}"
  echo -e "${BOLD}${BLUE}══════════════════════════════════════════════════════════════════════${NC}"
  printf "%-50s %s\n" "Layer" "Result"
  printf "%-50s %s\n" "-----" "------"
  local pass=0
  local fail=0
  for key in "${LAYERS[@]}"; do
    local res="${LAYER_RESULT[$key]}"
    if [[ "$res" == "pass" ]]; then
      printf "%-50s ${GREEN}✓ pass${NC}\n" "$key"
      pass=$((pass + 1))
    else
      printf "%-50s ${RED}✗ fail${NC}\n" "$key"
      fail=$((fail + 1))
    fi
  done
  echo
  printf "  ${GREEN}Passed${NC}: %d / %d\n" "$pass" "${#LAYERS[@]}"
  echo
  if (( fail == 0 )); then
    echo -e "${GREEN}${BOLD}━━━ ALL LAYERS GREEN — full-stack audit OK ━━━${NC}"
    return 0
  else
    echo -e "${RED}${BOLD}━━━ ${fail} LAYER(S) FAILED — fix before shipping ━━━${NC}"
    return 1
  fi
}

echo -e "${BOLD}════════════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Tellus full-stack audit (frontend → backend → docker)${NC}"
echo -e "${BOLD}════════════════════════════════════════════════════════════════════${NC}"
echo "  Backend repo : $REPO_BACKEND"
echo "  Frontend repo: $REPO_FRONTEND"
echo "  Started      : $(date -u +'%Y-%m-%dT%H:%M:%SZ')"

# Layer 1: docker compose integration
run_layer "docker-integrations" \
  "Layer 1 — docker compose integrations" \
  bash "$REPO_BACKEND/scripts/verify-docker-integrations.sh"
cooldown

# Layer 1b: Palantir reference-architecture services (Keycloak, Nessie, Flink)
run_layer "keycloak-sso" \
  "Layer 1b — Keycloak SSO end-to-end" \
  bash "$REPO_BACKEND/scripts/verify-keycloak.sh"

run_layer "iceberg-nessie" \
  "Layer 1c — Iceberg + Nessie REST catalog" \
  bash "$REPO_BACKEND/scripts/verify-iceberg.sh"

run_layer "flink" \
  "Layer 1d — Flink JobManager proxy" \
  bash "$REPO_BACKEND/scripts/verify-flink.sh"
cooldown

# Layer 2: backend feature matrix
run_layer "feature-matrix" \
  "Layer 2 — backend feature matrix (verify-features.sh)" \
  bash "$REPO_BACKEND/scripts/verify-features.sh"
cooldown

# Layer 3: production readiness audit
run_layer "production-readiness" \
  "Layer 3 — production readiness audit" \
  bash "$REPO_BACKEND/scripts/production-readiness-audit.sh"

# Layer 4: cypress frontend E2E (ontology pages + reference architecture)
if [[ "${SKIP_CYPRESS:-0}" != "1" ]]; then
  cooldown
  run_layer "cypress-frontend" \
    "Layer 4 — Cypress frontend E2E (ontology + Keycloak + Nessie + Flink)" \
    bash -c "cd $REPO_FRONTEND && npx cypress run --spec cypress/e2e/ontology-manager.cy.ts,cypress/e2e/keycloak-sso.cy.ts --headless --browser electron"
else
  echo
  echo -e "${YELLOW}Layer 4 — Cypress skipped (SKIP_CYPRESS=1)${NC}"
fi

print_summary
exit $?
