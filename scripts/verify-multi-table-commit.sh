#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# FOUNDRY-GAPS §6 — LIVE proof harness for atomic multi-table commits.
#
# Runs verify-multi-table-commit.py INSIDE the tellus docker network, which is
# the production topology: `minio:9000` / `lakekeeper:8181` resolve natively, so
# Lakekeeper remote-signing works exactly as it does in a deployed instance (the
# host-only getaddrinfo dev hack conflicts with remote-signing, so we avoid it).
#
#   bash scripts/verify-multi-table-commit.sh
# Requires the tellus stack up + S3 creds in .env.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env 2>/dev/null || true; set +a
: "${S3_ACCESS_KEY_ID:?set S3_ACCESS_KEY_ID (source .env)}"
: "${S3_SECRET_ACCESS_KEY:?set S3_SECRET_ACCESS_KEY}"

NET="${TELLUS_DOCKER_NET:-tellus_default}"

# Use a cached image with pyiceberg pre-installed if present; otherwise build it
# once (subsequent runs are instant).
IMG="${MTC_PY_IMAGE:-mtc-pyiceberg:latest}"
if ! docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "building $IMG (one-time)…"
  docker build -q -t "$IMG" - <<'DOCKER'
FROM python:3.11-slim
RUN pip install --no-cache-dir "pyiceberg==0.11.1" pyarrow s3fs
DOCKER
fi

docker run --rm --network "$NET" -v "$PWD:/app" -w /app \
  -e LAKEKEEPER_URL=http://lakekeeper:8181 \
  -e MTC_S3_ENDPOINT=http://minio:9000 \
  -e S3_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" \
  -e S3_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" \
  -e S3_REGION="${S3_REGION:-us-east-1}" \
  "$IMG" python3 scripts/verify-multi-table-commit.py
