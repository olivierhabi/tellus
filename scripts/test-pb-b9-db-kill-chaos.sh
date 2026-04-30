#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PB-B9 acceptance (b) — DB-kill chaos: /health/ready flips 503 within 5s
# and emits pipeline_health_check_failures_total{probe=postgres}.
#
# Pauses the tellus-db container, polls /health/ready until it reports
# ready=false OR status=503 (whichever comes first, within 5s),
# unpauses the container, asserts the SRE counter incremented.
# ---------------------------------------------------------------------------
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
PG_CONTAINER="${PG_CONTAINER:-tellus-db}"

log()  { printf '\033[36m[pb-b9 chaos]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[pb-b9 chaos FAIL]\033[0m %s\n' "$*" >&2; docker unpause "${PG_CONTAINER}" >/dev/null 2>&1 || true; exit 1; }
ok()   { printf '\033[32m[pb-b9 chaos OK]\033[0m %s\n' "$*"; }

cleanup() { docker unpause "${PG_CONTAINER}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Baseline metric count (counter may not yet exist on cold start).
BEFORE=$( (curl -sf "${BASE_URL}/api/v1/pipelines/metrics" || true) | \
  grep -E '^pipeline_health_check_failures_total\{probe="postgres"\}' | \
  awk '{print $2}' | head -n1 || true )
BEFORE=${BEFORE:-0}
log "baseline pipeline_health_check_failures_total{probe=postgres}=${BEFORE}"

log "pausing ${PG_CONTAINER}"
docker pause "${PG_CONTAINER}" >/dev/null

# Poll /health/ready until we see ready=false OR a 503.
DEADLINE=$((SECONDS + 5))
FLIPPED=0
while [ $SECONDS -lt $DEADLINE ]; do
  R=$(curl -sS -w "\n__code=%{http_code}" "${BASE_URL}/health/ready" 2>&1 || true)
  CODE=$(printf '%s' "${R}" | awk -F= '/__code=/{print $2}')
  BODY=$(printf '%s' "${R}" | sed '/__code=/d')
  READY=$(echo "${BODY}" | python3 -c 'import sys,json;
try:
  d=json.load(sys.stdin)
  print(d.get("ready"))
except Exception:
  print("parse_err")
' 2>/dev/null)
  if [ "${CODE}" = "503" ] || [ "${READY}" = "False" ]; then
    FLIPPED=1
    log "/health/ready code=${CODE} ready=${READY} (elapsed=$((SECONDS - (DEADLINE - 5)))s)"
    break
  fi
  sleep 1
done

log "unpausing ${PG_CONTAINER}"
docker unpause "${PG_CONTAINER}" >/dev/null

[ "${FLIPPED}" = "1" ] || fail "/health/ready did not flip within 5 seconds"
ok "/health/ready flipped to 503/ready=false within SLO"

# Give the metric a scrape window to record.
sleep 2
AFTER=$( (curl -sf "${BASE_URL}/api/v1/pipelines/metrics" || true) | \
  grep -E '^pipeline_health_check_failures_total\{probe="postgres"\}' | \
  awk '{print $2}' | head -n1 || true )
AFTER=${AFTER:-0}
log "post-chaos counter=${AFTER}"
python3 - <<EOF
before = float("${BEFORE}")
after = float("${AFTER}")
if after <= before:
    raise SystemExit(f"counter did not increment ({before} -> {after})")
print("counter incremented")
EOF
ok "pipeline_health_check_failures_total{probe=postgres} incremented"

ok "PB-B9 chaos: DB-down → /health/ready flip verified."
