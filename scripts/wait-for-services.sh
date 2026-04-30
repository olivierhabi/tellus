#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# wait-for-services.sh — readiness gate for integration / e2e test suites
# ---------------------------------------------------------------------------
# Spec: Ontology Platform tasks.md §2.7 "Test Infrastructure Contract"
#
# Polls each dependent service until it returns a healthy response, or fails
# after `max_attempts * interval` seconds. Replaces ad-hoc `sleep` waits so
# CI and local e2e runs can reliably gate on real readiness.
#
# Env overrides:
#   POSTGRES_URL, OPENSEARCH_URL, KAFKA_REST_URL, KEYCLOAK_URL, API_URL,
#   FLINK_URL, SCHEMA_REGISTRY_URL
# ---------------------------------------------------------------------------

set -euo pipefail

POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
OPENSEARCH_URL="${OPENSEARCH_URL:-http://localhost:9200}"
KAFKA_BOOTSTRAP="${KAFKA_BOOTSTRAP:-localhost:9092}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8086}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-tellus}"
API_URL="${API_URL:-http://localhost:3000}"
FLINK_URL="${FLINK_URL:-http://localhost:8083}"
SCHEMA_REGISTRY_URL="${SCHEMA_REGISTRY_URL:-http://localhost:8081}"

GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m'

wait_for() {
  local name="$1" check="$2" max_attempts="${3:-30}" interval="${4:-2}"
  for i in $(seq 1 "$max_attempts"); do
    if eval "$check" >/dev/null 2>&1; then
      printf "${GREEN}✓${NC} %s ready\n" "$name"
      return 0
    fi
    printf "${DIM}  Waiting for %s (%d/%d)...${NC}\n" "$name" "$i" "$max_attempts"
    sleep "$interval"
  done
  printf "${RED}✗${NC} %s failed to start after %ds\n" "$name" "$((max_attempts * interval))"
  return 1
}

SKIP=("${SKIP_SERVICES:-}")

need() {
  local svc="$1"
  for s in ${SKIP[@]:-}; do [[ "$s" == "$svc" ]] && return 1; done
  return 0
}

failed=0

if need postgres; then
  wait_for "PostgreSQL" "bash -c '</dev/tcp/$POSTGRES_HOST/$POSTGRES_PORT'" 30 2 || failed=1
fi

if need opensearch; then
  wait_for "OpenSearch" "curl -sf '$OPENSEARCH_URL/_cluster/health?wait_for_status=yellow&timeout=1s'" 60 2 || failed=1
fi

if need kafka; then
  wait_for "Kafka" "bash -c '</dev/tcp/${KAFKA_BOOTSTRAP/:*/}/${KAFKA_BOOTSTRAP/*:/}'" 60 2 || failed=1
fi

if need schema-registry; then
  wait_for "Schema Registry" "curl -sf '$SCHEMA_REGISTRY_URL/subjects'" 30 2 || true
fi

if need keycloak; then
  wait_for "Keycloak" \
    "curl -sf '$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/.well-known/openid-configuration'" \
    60 3 || failed=1
fi

if need flink; then
  wait_for "Flink JobManager" "curl -sf '$FLINK_URL/overview'" 30 2 || true
fi

if need api; then
  wait_for "API Server" "curl -sf '$API_URL/api/v1/health'" 60 2 || failed=1
fi

exit "$failed"
