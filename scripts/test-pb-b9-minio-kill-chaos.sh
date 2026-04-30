#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PB-B9 chaos — MinIO-down: /health/ready flips 503 within 5s and
# emits pipeline_health_check_failures_total{probe=s3}.
# ---------------------------------------------------------------------------
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
MINIO_CONTAINER="${MINIO_CONTAINER:-tellus-minio}"

log()  { printf '\033[36m[pb-b9 minio-chaos]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[pb-b9 minio-chaos FAIL]\033[0m %s\n' "$*" >&2; docker unpause "${MINIO_CONTAINER}" >/dev/null 2>&1 || true; exit 1; }
ok()   { printf '\033[32m[pb-b9 minio-chaos OK]\033[0m %s\n' "$*"; }

# `docker stop` properly closes the S3 listener so the HeadBucket
# probe fails deterministically within the 1s probe budget.
cleanup() { docker start "${MINIO_CONTAINER}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

BEFORE=$( (curl -sf "${BASE_URL}/api/v1/pipelines/metrics" || true) | \
  grep -E '^pipeline_health_check_failures_total\{probe="s3"\}' | \
  awk '{print $2}' | head -n1 || true )
BEFORE="${BEFORE:-0}"
log "baseline counter=${BEFORE}"

log "stopping MinIO container: ${MINIO_CONTAINER}"
docker stop -t 2 "${MINIO_CONTAINER}" >/dev/null

READY_FLIPPED=0
START_MS=$(python3 -c "import time; print(int(time.time()*1000))")
for i in $(seq 1 10); do
  HTTP=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "${BASE_URL}/health/ready" || echo "000")
  NOW_MS=$(python3 -c "import time; print(int(time.time()*1000))")
  ELAPSED=$(( NOW_MS - START_MS ))
  log "tick ${i}: http=${HTTP} elapsed=${ELAPSED}ms"
  if [[ "${HTTP}" == "503" ]]; then
    READY_FLIPPED=1
    log "health/ready returned 503 after ${ELAPSED}ms"
    break
  fi
  sleep 0.5
done

docker start "${MINIO_CONTAINER}" >/dev/null
log "restarted MinIO"

[[ "${READY_FLIPPED}" -eq 1 ]] || fail "/health/ready did not flip to 503 within 5s"

sleep 2
AFTER=$( (curl -sf "${BASE_URL}/api/v1/pipelines/metrics" || true) | \
  grep -E '^pipeline_health_check_failures_total\{probe="s3"\}' | \
  awk '{print $2}' | head -n1 || true )
AFTER="${AFTER:-0}"
log "post counter=${AFTER}"

python3 - "${BEFORE}" "${AFTER}" <<'PY'
import sys
before = float(sys.argv[1] or 0)
after  = float(sys.argv[2] or 0)
if after <= before:
    sys.stderr.write(f"[pb-b9 minio-chaos FAIL] counter did not increment: before={before} after={after}\n")
    sys.exit(1)
print(f"[pb-b9 minio-chaos OK] counter before={before} after={after}")
PY

ok "MinIO-kill chaos PASSED — /health/ready flipped within budget and counter incremented."
