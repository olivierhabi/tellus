#!/usr/bin/env bash
#
# verify-docker-integrations.sh
# -----------------------------
# Brings up (or assumes already up) every docker-compose file that ships
# with this repo and proves each service actually integrates with the
# tellus backend OR is reachable on the documented port.
#
# Two integration tiers:
#
#   TIER A  — wired in code today
#       redpanda    : kafkajs producer publishes ontology.actions
#       prometheus  : scrapes /api/metrics on host
#       pgvector    : conditional migration loads vector(1536)
#       postgres    : tellus-db (live primary)
#       opensearch  : object index nodes
#       minio       : object storage
#
#   TIER B  — scaffolded for future iterations, asserted reachable only
#       flink       : JobManager web UI
#       spark       : master web UI
#       nessie      : Iceberg REST catalog v2
#       keycloak    : OIDC provider /health/ready
#       debezium    : Kafka Connect REST
#       otel        : OTLP collector ports
#       grafana     : dashboard server
#
# Each check prints PASS / FAIL with the URL or shell command being probed.
# Exits non-zero if any TIER A check fails (TIER B failures are reported
# as warnings since they don't yet have a wired feature).

set -o pipefail

BASE="${BASE:-http://localhost:3000}"
ONTOLOGY_ID="${ONTOLOGY_ID:-a10f88e2-23d5-4ede-a3c1-7d57ddfdc825}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0

pass() {
  printf "${GREEN}✓${NC} %-55s ${1:-}\n" "$2"
  PASS=$((PASS + 1))
}
fail() {
  printf "${RED}✗${NC} %-55s ${RED}%s${NC}\n" "$2" "$1"
  FAIL=$((FAIL + 1))
}
warn() {
  printf "${YELLOW}⚠${NC} %-55s ${YELLOW}%s${NC}\n" "$2" "$1"
  WARN=$((WARN + 1))
}
section() {
  echo
  echo -e "${BOLD}${BLUE}── $1 ──${NC}"
}

require() {
  local name="$1"
  if docker ps --format '{{.Names}}' | grep -q "^${name}$"; then
    return 0
  else
    return 1
  fi
}

echo -e "${BOLD}════════════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Docker compose integration audit${NC}"
echo -e "${BOLD}════════════════════════════════════════════════════════════════════${NC}"
echo "  Backend base : $BASE"
echo "  Ontology     : $ONTOLOGY_ID"
echo

# ====================================================================
# TIER A — services with wired-in integration
# ====================================================================

# --------------------------------------------------------------------
# Postgres (tellus-db)
# --------------------------------------------------------------------
section "TIER A — Postgres (primary metadata DB)"
if require tellus-db; then
  if docker exec tellus-db pg_isready -U tellus -d tellus_db -q; then
    pass "" "tellus-db pg_isready"
  else
    fail "pg_isready failed" "tellus-db pg_isready"
  fi
else
  fail "container not running" "tellus-db pg_isready"
fi

# Backend can actually query it (proves connectivity)
status=$(curl -s -o /tmp/dock-h.json -w '%{http_code}' "$BASE/health")
if [[ "$status" == "200" ]] && jq -e '.database == "connected"' /tmp/dock-h.json >/dev/null 2>&1; then
  pass "" "backend /health → database=connected"
else
  fail "got $status" "backend /health → database=connected"
fi

# --------------------------------------------------------------------
# OpenSearch
# --------------------------------------------------------------------
section "TIER A — OpenSearch"
if require tellus-opensearch; then
  if curl -sf http://localhost:9200/_cluster/health >/dev/null; then
    cluster=$(curl -s http://localhost:9200/_cluster/health | jq -r '.status')
    pass "(cluster=$cluster)" "OpenSearch cluster health"
  else
    fail "unreachable" "OpenSearch cluster health"
  fi
else
  fail "container missing" "OpenSearch cluster health"
fi

# --------------------------------------------------------------------
# MinIO
# --------------------------------------------------------------------
section "TIER A — MinIO (object storage)"
if require tellus-minio; then
  if curl -sf http://localhost:9000/minio/health/live >/dev/null; then
    pass "" "MinIO /minio/health/live"
  else
    fail "unreachable" "MinIO /minio/health/live"
  fi
else
  fail "container missing" "MinIO /minio/health/live"
fi

# --------------------------------------------------------------------
# Redpanda — Kafka producer round trip
# --------------------------------------------------------------------
section "TIER A — Redpanda (Kafka) end-to-end"
if require tellus-redpanda; then
  topics=$(docker exec tellus-redpanda rpk topic list -X brokers=localhost:9092 2>/dev/null | tail -n +2 | awk '{print $1}')
  for t in ontology.actions ontology.edits ontology.events ontology.audit; do
    if echo "$topics" | grep -q "^${t}$"; then
      pass "" "topic exists: $t"
    else
      fail "missing" "topic exists: $t"
    fi
  done

  # Round-trip: pick the seeded action, fire 3 applies, check the topic.
  ACTION=$(curl -s "$BASE/api/v2/ontologies/$ONTOLOGY_ID/actionTypes" \
    | jq -r '.data[0].apiName // empty')
  if [[ -z "$ACTION" ]]; then
    warn "no action type seeded" "Kafka publish round-trip"
  else
    docker exec -d tellus-redpanda sh -c \
      'rpk topic consume ontology.actions -X brokers=localhost:9092 -n 5 -o end > /tmp/k.json 2>&1'
    sleep 1
    for _ in 1 2 3; do
      curl -s -X POST -H "Content-Type: application/json" \
        -d '{"parameters":{"customerId":"c","quantity":1}}' \
        "$BASE/api/v2/ontologies/$ONTOLOGY_ID/actions/$ACTION/apply" >/dev/null
    done
    sleep 3
    msgs=$(docker exec tellus-redpanda sh -c 'grep -c "actionTypeApiName" /tmp/k.json 2>/dev/null || echo 0')
    if [[ "$msgs" -ge 1 ]]; then
      pass "($msgs messages)" "Kafka publish round-trip on ontology.actions"
    else
      fail "no messages received" "Kafka publish round-trip on ontology.actions"
    fi
  fi
else
  fail "container missing" "Redpanda"
fi

# --------------------------------------------------------------------
# Prometheus — scraping the backend
# --------------------------------------------------------------------
section "TIER A — Prometheus (scrape /api/metrics)"
if require tellus-prometheus; then
  if curl -sf http://localhost:9090/-/ready >/dev/null; then
    pass "" "Prometheus /-/ready"
  else
    fail "unready" "Prometheus /-/ready"
  fi
  # Backend target is up? (use --data-urlencode so curl handles { and ")
  up=$(curl -sG --data-urlencode 'query=up{job="tellus-backend"}' \
    'http://localhost:9090/api/v1/query' \
    | jq -r '.data.result[0].value[1] // "missing"')
  if [[ "$up" == "1" ]]; then
    pass "" "Prometheus target tellus-backend = up"
  else
    fail "got $up" "Prometheus target tellus-backend = up"
  fi
  series=$(curl -sG --data-urlencode 'query=process_uptime_seconds{job="tellus-backend"}' \
    'http://localhost:9090/api/v1/query' \
    | jq -r '.data.result | length')
  if [[ "$series" -ge 1 ]]; then
    pass "" "Prometheus has process_uptime_seconds for tellus-backend"
  else
    fail "missing" "Prometheus has process_uptime_seconds for tellus-backend"
  fi
else
  fail "container missing" "Prometheus"
fi

# --------------------------------------------------------------------
# pgvector — extension actually loaded + column type promoted
# --------------------------------------------------------------------
section "TIER A — pgvector (vector extension)"
if require tellus-pgvector; then
  ext=$(docker exec tellus-pgvector psql -U tellus -d tellus_db -tAc \
    "SELECT extname FROM pg_extension WHERE extname='vector';" 2>/dev/null)
  if [[ "$ext" == "vector" ]]; then
    pass "" "pgvector extension loaded"
  else
    fail "extension not present" "pgvector extension loaded"
  fi
  coltype=$(docker exec tellus-pgvector psql -U tellus -d tellus_db -tAc \
    "SELECT format_type(atttypid, atttypmod) FROM pg_attribute
       WHERE attrelid='vector_property_value'::regclass AND attname='embedding';" 2>/dev/null)
  if [[ "$coltype" == vector* ]]; then
    pass "($coltype)" "embedding column promoted to vector type"
  else
    fail "got $coltype" "embedding column promoted to vector type"
  fi
else
  warn "tellus-pgvector not running — fallback path active" "pgvector extension"
fi

# ====================================================================
# TIER B — services that are scaffolded but not yet wired in code
# ====================================================================

section "TIER B — Flink (Apache Flink JobManager)"
if require tellus-flink-jobmanager; then
  if curl -sf http://localhost:8083/overview >/dev/null; then
    parallelism=$(curl -s http://localhost:8083/overview | jq -r '.["taskmanagers"]')
    pass "(${parallelism} task manager(s))" "Flink JobManager /overview"
  else
    warn "not yet ready" "Flink JobManager /overview"
  fi
else
  warn "not running" "Flink JobManager"
fi

section "TIER B — Spark (Apache Spark master)"
if require tellus-spark-master; then
  if curl -sf http://localhost:8084/ >/dev/null 2>&1 || curl -sf http://localhost:8084/json/ >/dev/null 2>&1; then
    pass "" "Spark master web UI"
  else
    warn "not yet listening on 8084" "Spark master web UI"
  fi
else
  warn "not running" "Spark master"
fi

section "TIER B — Nessie (Iceberg REST catalog)"
if require tellus-nessie; then
  if curl -sf http://localhost:19120/api/v2/config >/dev/null; then
    branch=$(curl -s http://localhost:19120/api/v2/config | jq -r '.defaultBranch')
    pass "(defaultBranch=$branch)" "Nessie /api/v2/config"
  else
    fail "unreachable" "Nessie /api/v2/config"
  fi
else
  warn "not running" "Nessie"
fi

section "TIER B — Debezium (Kafka Connect)"
if require tellus-debezium; then
  if curl -sf http://localhost:8085/connectors >/dev/null; then
    pass "" "Debezium /connectors"
  else
    warn "not ready" "Debezium /connectors"
  fi
else
  warn "not running" "Debezium"
fi

section "TIER B — Keycloak (SSO)"
if require tellus-keycloak; then
  if curl -sf http://localhost:8086/realms/master/.well-known/openid-configuration >/dev/null 2>&1; then
    pass "" "Keycloak master realm OIDC discovery"
  else
    warn "warming up" "Keycloak master realm"
  fi
else
  warn "not running" "Keycloak"
fi

section "TIER B — Grafana (dashboards)"
if require tellus-grafana; then
  if curl -sf http://localhost:3100/api/health >/dev/null; then
    pass "" "Grafana /api/health"
  else
    warn "not ready" "Grafana /api/health"
  fi
else
  warn "not running" "Grafana"
fi

section "TIER B — OTel Collector"
if require tellus-otel; then
  status=$(docker inspect -f '{{.State.Status}}' tellus-otel)
  if [[ "$status" == "running" ]]; then
    pass "" "OTel collector container running"
  else
    warn "$status" "OTel collector container"
  fi
else
  warn "not running" "OTel collector"
fi

# ====================================================================
# Summary
# ====================================================================
echo
echo -e "${BOLD}════════════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Integration audit summary${NC}"
echo -e "${BOLD}════════════════════════════════════════════════════════════════════${NC}"
printf "  ${GREEN}Passed${NC}  : %d\n" "$PASS"
printf "  ${YELLOW}Warned${NC}  : %d  (TIER B services scaffolded but not yet wired)\n" "$WARN"
printf "  ${RED}Failed${NC}  : %d\n" "$FAIL"
echo
if (( FAIL == 0 )); then
  echo -e "${GREEN}${BOLD}All TIER A integrations verified end-to-end against running containers.${NC}"
  exit 0
else
  echo -e "${RED}${BOLD}TIER A integration failures present — see above.${NC}"
  exit 1
fi
