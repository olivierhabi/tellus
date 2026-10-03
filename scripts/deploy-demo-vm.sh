#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy-demo-vm.sh — publish a built GHCR image to the demo VM by hand.
#
# The GitHub Actions workflow now BUILDS AND PUSHES ONLY. Deploying to the live
# demo is a deliberate, reviewable step, performed with this script against an
# image tag that CI already produced. It mirrors the retired `deploy` job
# exactly: pull the tag, retag it to the names the compose files reference, and
# `up -d --no-build` (never build on the 2-vCPU VM).
#
# Usage:
#   ./scripts/deploy-demo-vm.sh <tag>              # e.g. r12
#   ./scripts/deploy-demo-vm.sh r12 --skip-fe      # backend only
#
# Requires: ssh access to the VM, and the deploy key at $DEPLOY_SSH_KEY
#           (default /tmp/telos-server_key-test.pem).
#
# Exit codes: 0 healthy, 1 pull/recreate failed, 2 never became healthy.
# ---------------------------------------------------------------------------
set -euo pipefail

TAG="${1:-}"
SKIP_FE="${2:-}"

if [[ -z "$TAG" ]]; then
  echo "usage: $0 <tag> [--skip-fe]" >&2
  exit 1
fi

DEPLOY_HOST="${DEPLOY_HOST:-20.51.243.30}"
DEPLOY_USER="${DEPLOY_USER:-azureuser}"
KEY="${DEPLOY_SSH_KEY:-/tmp/telos-server_key-test.pem}"
OWNER="${GHCR_OWNER:-olivierhabi}"
APP_IMAGE="ghcr.io/${OWNER}/tellus/app"
FE_IMAGE="ghcr.io/${OWNER}/tellus/fe"

if [[ ! -f "$KEY" ]]; then
  echo "deploy key not found: $KEY (override with DEPLOY_SSH_KEY=)" >&2
  exit 1
fi

echo "==> deploying ${APP_IMAGE}:${TAG}$([[ -n "$SKIP_FE" ]] || echo " + ${FE_IMAGE}:${TAG}") to ${DEPLOY_USER}@${DEPLOY_HOST}"

ssh -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=30 \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
    "${DEPLOY_USER}@${DEPLOY_HOST}" bash -s -- "$TAG" "$APP_IMAGE" "$FE_IMAGE" "$SKIP_FE" <<'REMOTE_EOF'
set -euo pipefail
TAG="$1"; APP_IMAGE="$2"; FE_IMAGE="$3"; SKIP_FE="${4:-}"

docker pull "${APP_IMAGE}:${TAG}"
docker tag "${APP_IMAGE}:${TAG}" tellus-app:latest

if [[ -z "$SKIP_FE" ]]; then
  docker pull "${FE_IMAGE}:${TAG}"
  docker tag "${FE_IMAGE}:${TAG}" tellus-fe:workshop-demo
fi

# --no-build so compose never rebuilds on the small VM.
cd ~/tellus  && docker compose up -d --no-build app
if [[ -z "$SKIP_FE" ]]; then
  cd ~/tellus-fe && docker compose up -d --no-build fe
fi

echo "--- waiting for app health ---"
for i in $(seq 1 60); do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' tellus-app-1 2>/dev/null)" = "healthy" ]; then
    echo "app healthy after $((i * 10))s"; break
  fi
  sleep 10
done

if [ "$(docker inspect --format '{{.State.Health.Status}}' tellus-app-1 2>/dev/null)" != "healthy" ]; then
  echo "FAIL: tellus-app-1 did not become healthy" >&2
  docker logs --tail 60 tellus-app-1 >&2 || true
  exit 2
fi

docker ps --filter name=tellus-app-1 --format '{{.Names}} {{.Status}}'

# Same disk guard the retired workflow job used: a full 29G root fs pushes
# OpenSearch past its 95% flood-stage watermark, which blocks EVERY index
# write and presents as missing data rather than as an infra fault.
echo "--- disk usage ---"
df -h / | tail -1
DISK_PCT=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "$DISK_PCT" -ge 75 ]; then
  echo "root fs at ${DISK_PCT}% — pruning stale r* image tags (keeping ${TAG})"
  for img in "$APP_IMAGE" "$FE_IMAGE"; do
    docker images --format '{{.Repository}} {{.Tag}}' "$img" \
      | awk -v keep="$TAG" '$2 != keep && $2 ~ /^r[0-9]+$/ {print $2}' \
      | while read -r old; do
          [ -n "$old" ] && docker rmi "$img:$old" >/dev/null 2>&1 || true
        done
  done
  docker builder prune -af >/dev/null 2>&1 || true
  df -h / | tail -1
fi
REMOTE_EOF

echo "==> done: ${TAG}"