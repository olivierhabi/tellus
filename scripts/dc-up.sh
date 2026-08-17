#!/usr/bin/env bash
# scripts/dc-up.sh — bring up the Tellus Docker stack required by the
# files-projects v2 turn protocol.
#
# Required services (per the turn directive):
#   cassandra, postgres, keycloak, kafka, minio,
#   otel-collector
#
# This repo's docker-compose.yml does not expose all of those (cassandra +
# otel-collector live in docker-compose.verify.yml + docker-compose.quiver.yml).
# This script is a thin idempotent wrapper that:
#   1. Brings up the base compose project (docker-compose.yml) if not running.
#   2. Brings up the verify compose project (which includes cassandra,
#      otel-collector) if not running.
#   3. Prints a single docker compose ps --format json snapshot to stdout
#      (used as the integration-log header).
#
# Exits 0 if every required service is healthy; non-zero otherwise.

set -euo pipefail

REQUIRED=(cassandra postgres keycloak kafka minio otel-collector)

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

echo "[dc-up] bringing up base compose stack" >&2
docker compose -f docker-compose.yml up -d --remove-orphans postgres opensearch zookeeper kafka keycloak minio minio-init >&2 || true

if [[ -f docker-compose.verify.yml ]]; then
  echo "[dc-up] bringing up verify compose stack (cassandra, otel-collector)" >&2
  docker compose -f docker-compose.verify.yml up -d cassandra otel-collector >&2 || true
fi

echo "[dc-up] waiting up to 90s for required services to be healthy" >&2
deadline=$(( $(date +%s) + 90 ))
all_ok=0
while (( $(date +%s) < deadline )); do
  ps_json=$(docker ps --format '{{json .}}')
  all_ok=1
  for svc in "${REQUIRED[@]}"; do
    if ! echo "$ps_json" | grep -E "\"Names\":\"[^\"]*${svc}[^\"]*\"" | grep -q '(healthy)'; then
      all_ok=0
      break
    fi
  done
  (( all_ok == 1 )) && break
  sleep 3
done

# Final report
docker ps --format '{{json .}}' | tee /tmp/dc-up-ps.json >/dev/null
echo "[dc-up] required service health:" >&2
for svc in "${REQUIRED[@]}"; do
  status=$(docker ps --format '{{.Names}}\t{{.Status}}' | awk -v s="$svc" 'index($1,s){print $0; exit}')
  if [[ -z "$status" ]]; then
    echo "  ${svc}: MISSING" >&2
    all_ok=0
  else
    echo "  ${status}" >&2
    if ! echo "$status" | grep -q 'healthy'; then
      all_ok=0
    fi
  fi
done

if (( all_ok == 1 )); then
  echo "[dc-up] all required services healthy"
  exit 0
fi
echo "[dc-up] one or more required services not healthy" >&2
exit 1
