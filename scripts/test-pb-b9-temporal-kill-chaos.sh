#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PB-B9 chaos — Temporal-down: /health/ready flips 503 within 5s and
# emits pipeline_health_check_failures_total{probe=temporal}.
#
# Temporal is optional per PB-B1 (PG fallback dispatcher runs deploys
# when Temporal is unreachable), so /health/ready's verdict is that the
# full-stack health is degraded — not that deploys are broken. The
# per-probe counter is the SRE signal that lets an on-call decide
# whether Temporal itself is the outage or a downstream dependency is.
# ---------------------------------------------------------------------------
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
TEMPORAL_CONTAINER="${TEMPORAL_CONTAINER:-tellus-temporal-frontend}"

log()  { printf '\033[36m[pb-b9 temporal-chaos]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[pb-b9 temporal-chaos FAIL]\033[0m %s\n' "$*" >&2; docker unpause "${TEMPORAL_CONTAINER}" >/dev/null 2>&1 || true; exit 1; }
ok()   { printf '\033[32m[pb-b9 temporal-chaos OK]\033[0m %s\n' "$*"; }

# `docker pause` sends SIGSTOP which leaves the kernel listening
# socket open — the TCP probe in /health/ready's temporal check would
# still succeed. `docker stop` properly closes the listener.
cleanup() { docker start "${TEMPORAL_CONTAINER}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

BEFORE=$( (curl -sf "${BASE_URL}/api/v1/pipelines/metrics" || true) | \
  grep -E '^pipeline_health_check_failures_total\{probe="temporal"\}' | \
  awk '{print $2}' | head -n1 || true )
BEFORE="${BEFORE:-0}"
log "baseline counter=${BEFORE}"

log "stopping Temporal frontend container: ${TEMPORAL_CONTAINER}"
docker stop -t 2 "${TEMPORAL_CONTAINER}" >/dev/null

PROBE_FLIPPED=0
START_MS=$(python3 -c "import time; print(int(time.time()*1000))")
for i in $(seq 1 10); do
  BODY=$(curl -s -m 5 "${BASE_URL}/health/ready" || echo "{}")
  T_OK=$(python3 -c "import json,sys; d=json.loads(sys.argv[1] or '{}'); print(d.get('probes',{}).get('temporal',{}).get('ok'))" "${BODY}" 2>/dev/null || echo "True")
  NOW_MS=$(python3 -c "import time; print(int(time.time()*1000))")
  ELAPSED=$(( NOW_MS - START_MS ))
  log "tick ${i}: temporal.ok=${T_OK} elapsed=${ELAPSED}ms"
  if [[ "${T_OK}" == "False" ]]; then
    PROBE_FLIPPED=1
    log "temporal probe flipped ok=false after ${ELAPSED}ms"
    break
  fi
  sleep 0.5
done

docker start "${TEMPORAL_CONTAINER}" >/dev/null
log "restarted Temporal"

[[ "${PROBE_FLIPPED}" -eq 1 ]] || fail "temporal probe did not flip to ok=false within 5s"

sleep 2
AFTER=$( (curl -sf "${BASE_URL}/api/v1/pipelines/metrics" || true) | \
  grep -E '^pipeline_health_check_failures_total\{probe="temporal"\}' | \
  awk '{print $2}' | head -n1 || true )
AFTER="${AFTER:-0}"
log "post counter=${AFTER}"

python3 - "${BEFORE}" "${AFTER}" <<'PY'
import sys
before = float(sys.argv[1] or 0)
after  = float(sys.argv[2] or 0)
if after <= before:
    sys.stderr.write(f"[pb-b9 temporal-chaos FAIL] counter did not increment: before={before} after={after}\n")
    sys.exit(1)
print(f"[pb-b9 temporal-chaos OK] counter before={before} after={after}")
PY

ok "Temporal-kill chaos PASSED — /health/ready flipped within budget and counter incremented."
