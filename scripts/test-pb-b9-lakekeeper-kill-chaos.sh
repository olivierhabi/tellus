#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PB-B9 chaos — Lakekeeper-down: /health/ready flips 503 within 5s and
# emits pipeline_health_check_failures_total{probe=lakekeeper}.
#
# Mirrors test-pb-b9-db-kill-chaos.sh semantics: docker pause, poll
# /health/ready, unpause, assert the per-probe counter incremented.
# ---------------------------------------------------------------------------
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
LK_CONTAINER="${LK_CONTAINER:-tellus-lakekeeper}"

log()  { printf '\033[36m[pb-b9 lk-chaos]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[pb-b9 lk-chaos FAIL]\033[0m %s\n' "$*" >&2; docker unpause "${LK_CONTAINER}" >/dev/null 2>&1 || true; exit 1; }
ok()   { printf '\033[32m[pb-b9 lk-chaos OK]\033[0m %s\n' "$*"; }

cleanup() { docker unpause "${LK_CONTAINER}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

BEFORE=$( (curl -sf "${BASE_URL}/api/v1/pipelines/metrics" || true) | \
  grep -E '^pipeline_health_check_failures_total\{probe="lakekeeper"\}' | \
  awk '{print $2}' | head -n1 || true )
BEFORE="${BEFORE:-0}"
log "baseline counter=${BEFORE}"

log "pausing Lakekeeper container: ${LK_CONTAINER}"
docker pause "${LK_CONTAINER}" >/dev/null

PROBE_FLIPPED=0
START_MS=$(python3 -c "import time; print(int(time.time()*1000))")
for i in $(seq 1 10); do
  BODY=$(curl -s -m 5 "${BASE_URL}/health/ready" || echo "{}")
  LK_OK=$(python3 -c "import json,sys; d=json.loads(sys.argv[1] or '{}'); print(d.get('probes',{}).get('lakekeeper',{}).get('ok'))" "${BODY}" 2>/dev/null || echo "True")
  NOW_MS=$(python3 -c "import time; print(int(time.time()*1000))")
  ELAPSED=$(( NOW_MS - START_MS ))
  log "tick ${i}: lakekeeper.ok=${LK_OK} elapsed=${ELAPSED}ms"
  if [[ "${LK_OK}" == "False" ]]; then
    PROBE_FLIPPED=1
    log "lakekeeper probe flipped ok=false after ${ELAPSED}ms"
    break
  fi
  sleep 0.5
done

docker unpause "${LK_CONTAINER}" >/dev/null
log "unpaused Lakekeeper"

[[ "${PROBE_FLIPPED}" -eq 1 ]] || fail "lakekeeper probe did not flip to ok=false within 5s"

# Wait for the probe to record the failure (next tick of readiness loop).
sleep 2
AFTER=$( (curl -sf "${BASE_URL}/api/v1/pipelines/metrics" || true) | \
  grep -E '^pipeline_health_check_failures_total\{probe="lakekeeper"\}' | \
  awk '{print $2}' | head -n1 || true )
AFTER="${AFTER:-0}"
log "post counter=${AFTER}"

python3 - "${BEFORE}" "${AFTER}" <<'PY'
import sys
before = float(sys.argv[1] or 0)
after  = float(sys.argv[2] or 0)
if after <= before:
    sys.stderr.write(f"[pb-b9 lk-chaos FAIL] counter did not increment: before={before} after={after}\n")
    sys.exit(1)
print(f"[pb-b9 lk-chaos OK] counter before={before} after={after}")
PY

ok "Lakekeeper-kill chaos PASSED — /health/ready flipped within budget and counter incremented."
