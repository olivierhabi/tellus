#!/usr/bin/env bash
#
# verify-stage-pacing-e2e.sh
# --------------------------
# End-to-end verification that the 5-second stage delay is real on
# BOTH layers:
#
#   backend  — each funnel stage_run's finished_at - started_at ≥ 4.5 s
#              (plus the aggregate ≥ 15 s + 4 distinct stages observed)
#   frontend — the WorkflowDiagram flips each node's data-state to
#              "running" in sequence, with inter-transition gaps
#              of 4 – 8 s, driven by the 1 Hz UUID-runs poll
#
# Orchestration:
#   1. Restart the backend with FUNNEL_STAGE_DELAY_MS=5000.
#   2. Run scripts/verify-funnel-stage-delay.sh — validates per-stage
#      durations server-side.
#   3. Run cypress/e2e/frontend-stage-pacing.cy.ts — validates
#      DOM-level transitions browser-side.
#   4. Restart the backend with FUNNEL_STAGE_DELAY_MS=0 to restore
#      the production default.
#
# Fails on the first red step so CI lights up with a specific cause.

set -o pipefail

# Default to the repo root inferred from this script's location so the
# same script works on CI and on any developer machine.
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# tellus-fe sits as a sibling to tellus by convention.
FE_ROOT="${FE_ROOT:-$(cd "$REPO_ROOT/../tellus-fe" 2>/dev/null && pwd || echo "$REPO_ROOT/../tellus-fe")}"
API="${API_URL:-http://localhost:3000/api}"

GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m'
hdr()  { printf "\n${DIM}━━━ %s ━━━${NC}\n" "$1"; }
ok()   { printf "${GREEN}✓${NC} %s\n" "$1"; }
die()  { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }

start_backend() {
  local delay="$1"
  local pid
  pid=$(lsof -nP -iTCP:3000 -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $2}')
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 1
  done
  (
    cd "$REPO_ROOT"
    FUNNEL_STAGE_DELAY_MS="$delay" \
      nohup npx tsx src/server.ts \
      >/tmp/tellus-server.log 2>&1 &
    disown $!
  )
  for _ in $(seq 1 30); do
    if curl -sf --max-time 2 "$API/v1/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  die "backend did not become healthy within 30 s (FUNNEL_STAGE_DELAY_MS=$delay)"
}

# ---------- Step 1: restore-on-exit guarantees prod default -------------
cleanup_default_delay() {
  hdr "Restoring production default (FUNNEL_STAGE_DELAY_MS=0)"
  start_backend "0" && ok "backend back on prod default"
}
trap cleanup_default_delay EXIT

# ---------- Step 2: boot paced ------------------------------------------
hdr "Starting backend with FUNNEL_STAGE_DELAY_MS=5000"
start_backend "5000"
ok "backend paced at 5 s per stage"

# ---------- Step 3: backend per-stage assertions ------------------------
hdr "Backend: verify-funnel-stage-delay.sh (per-stage ≥ 4.5 s)"
if ! "$REPO_ROOT/scripts/verify-funnel-stage-delay.sh"; then
  die "backend pacing verification FAILED — see output above"
fi
ok "backend per-stage pacing verified"

# `verify-funnel-stage-delay.sh` finished by restarting to delay=0.
# The Cypress spec needs delay=5000 — bring it back up paced.
hdr "Re-pacing backend at 5 s for the Cypress pass"
start_backend "5000"
ok "backend paced again"

# ---------- Step 4: Cypress DOM-level assertions ------------------------
hdr "Frontend: cypress/e2e/frontend-stage-pacing.cy.ts (DOM gaps 4–8 s)"
(
  cd "$FE_ROOT"
  npx cypress run \
    --spec cypress/e2e/frontend-stage-pacing.cy.ts \
    --reporter spec
) || die "cypress FE pacing spec FAILED — see output above"
ok "frontend DOM pacing verified"

# ---------- All green ---------------------------------------------------
hdr "All layers green"
printf "${GREEN}5-second stage pacing is production-safe on backend + frontend.${NC}\n"
printf "  The trap handler will now restore FUNNEL_STAGE_DELAY_MS=0.\n"
