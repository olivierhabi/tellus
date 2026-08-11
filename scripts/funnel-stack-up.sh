#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Bring up the full Funnel stack — every dependency B1-B10 needs.
#
# User's list was: postgres, minio, opensearch, redpanda, keycloak,
# lakekeeper, temporal. We additionally add redis (B7 overlay), quickwit
# (B6/B8 indexing + search), and clickhouse (B10 large-hop traversals).
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Pin the compose project name. Without -p, docker compose derives it from
# the working directory ("tellus") for one compose file and from a
# different basename ("docker-compose-filesprod") if invoked elsewhere,
# which creates two disjoint `*_default` networks and the services that
# need to talk to each other (temporal -> postgres, lakekeeper ->
# postgres, etc.) silently fail with "no such host". Pinning here means
# every service joins one network: `tellus_default`.
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-tellus}"

COMPOSE_FILES=(
  -p "$PROJECT_NAME"
  -f docker-compose-files.prod/postgres.docker-compose.yml
  -f docker-compose-files.prod/minio.docker-compose.yml
  -f docker-compose-files.prod/opensearch.docker-compose.yml
  -f docker-compose-files.prod/redpanda.docker-compose.yml
  -f docker-compose-files.prod/keycloak.docker-compose.yml
  -f docker-compose-files.prod/lakekeeper.docker-compose.yml
  -f docker-compose-files.prod/temporal.docker-compose.yml
  -f docker-compose-files.prod/redis.docker-compose.yml
  -f docker-compose-files.prod/quickwit.docker-compose.yml
  -f docker-compose-files.prod/clickhouse.docker-compose.yml
)

log() { printf '\033[36m[stack-up]\033[0m %s\n' "$*"; }

log "bringing up stack (project=$PROJECT_NAME)"
docker compose "${COMPOSE_FILES[@]}" up -d "$@"

log "waiting for postgres"
timeout 120 bash -c '
  until docker exec tellus-db pg_isready -U tellus -d tellus_db >/dev/null 2>&1; do
    sleep 2; echo "  ...still waiting for postgres";
  done
'

log "waiting for opensearch"
timeout 180 bash -c '
  until curl -fsS http://127.0.0.1:9200/_cluster/health >/dev/null 2>&1; do
    sleep 3; echo "  ...still waiting for opensearch";
  done
'

log "waiting for minio"
timeout 60 bash -c '
  until curl -fsS http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; do
    sleep 2; echo "  ...still waiting for minio";
  done
'

log "waiting for redis"
timeout 60 bash -c '
  until docker exec tellus-redis redis-cli -a "${REDIS_PASSWORD:-tellus_overlay_pw}" --no-auth-warning ping 2>/dev/null | grep -q PONG; do
    sleep 2; echo "  ...still waiting for redis";
  done
'

log "waiting for redpanda"
timeout 120 bash -c '
  until docker exec tellus-redpanda rpk cluster health -X brokers=localhost:9092 2>/dev/null | grep -q "Healthy:.*true"; do
    sleep 3; echo "  ...still waiting for redpanda";
  done
'

log "waiting for quickwit"
timeout 180 bash -c '
  until curl -fsS http://127.0.0.1:7280/api/v1/version >/dev/null 2>&1; do
    sleep 3; echo "  ...still waiting for quickwit";
  done
'

log "waiting for clickhouse"
timeout 120 bash -c '
  until curl -fsS http://127.0.0.1:8123/ping 2>/dev/null | grep -q Ok; do
    sleep 3; echo "  ...still waiting for clickhouse";
  done
'

log "waiting for temporal frontend (up to 5 min — schema bootstrap is slow)"
timeout 300 bash -c '
  until docker exec tellus-temporal-frontend sh -c "nc -z \"\$(hostname)\" 7233" >/dev/null 2>&1; do
    sleep 5; echo "  ...still waiting for temporal";
  done
' || log "temporal not fully ready — continuing (Funnel falls back to PG-backed workflow)"

log "stack is up"
docker compose "${COMPOSE_FILES[@]}" ps
