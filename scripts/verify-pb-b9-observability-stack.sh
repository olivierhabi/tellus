#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PB-B9 end-to-end observability validation.
#
# Brings up docker-compose-files/monitoring.docker-compose.yml and
# asserts the full HTTP → API → OTLP Collector → Prometheus → Grafana
# chain works against a running tellus API (port 3000).
#
# Usage:
#   ./scripts/verify-pb-b9-observability-stack.sh          # assume stack up
#   UP=1 ./scripts/verify-pb-b9-observability-stack.sh     # bring up first
# ---------------------------------------------------------------------------
set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"
COLLECTOR_URL="${COLLECTOR_URL:-http://localhost:13133}"
PROM_URL="${PROM_URL:-http://localhost:9090}"
GRAFANA_URL="${GRAFANA_URL:-http://localhost:3003}"
GRAFANA_USER="${GRAFANA_USER:-admin}"
GRAFANA_PASSWORD="${GRAFANA_PASSWORD:-admin}"

log()  { printf '\033[36m[pb-b9 obs]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[pb-b9 obs FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m[pb-b9 obs OK]\033[0m %s\n' "$*"; }

if [[ "${UP:-0}" == "1" ]]; then
  log "bringing up monitoring stack"
  (cd docker-compose-files && docker compose -f monitoring.docker-compose.yml up -d)
  sleep 10
fi

# 1. Collector reachability via its Prometheus self-telemetry endpoint.
# (The opt-in /health extension requires explicit config; the
# metrics endpoint is always on and is a strong liveness signal.)
curl -sf -m 3 "http://localhost:8888/metrics" >/dev/null || fail "otel collector self-metrics endpoint unreachable"
ok "collector reachable (self-metrics endpoint)"

# 2. Prometheus ready
curl -sf -m 3 "${PROM_URL}/-/ready" >/dev/null || fail "prometheus not ready"
ok "prometheus ready"

# 3. Grafana database ok
STATUS=$(curl -sf -m 3 "${GRAFANA_URL}/api/health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('database'))" 2>/dev/null || echo "down")
[[ "${STATUS}" == "ok" ]] || fail "grafana health database=${STATUS}"
ok "grafana database=ok"

# 4. Generate traffic so the API emits metrics + spans.
for _ in $(seq 1 10); do
  curl -sf -m 2 "${API_URL}/health" >/dev/null 2>&1 || true
  curl -sf -m 5 "${API_URL}/health/ready" >/dev/null 2>&1 || true
  curl -sf -m 2 "${API_URL}/api/v1/pipelines/metrics" >/dev/null 2>&1 || true
done
ok "traffic emitted to API (30 requests)"
sleep 5

# 5. Verify all 3 scrape targets are UP in Prometheus.
UP_COUNT=$(curl -sf "${PROM_URL}/api/v1/query?query=up" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(sum(int(r['value'][1]) for r in d['data']['result']))")
[[ "${UP_COUNT}" -ge 3 ]] || fail "prometheus scrape: up=${UP_COUNT} expected >=3"
ok "prometheus scrape: up=${UP_COUNT} (all targets)"

# 6. Verify the auto-provisioned dashboard loaded.
DASH=$(curl -sf -u "${GRAFANA_USER}:${GRAFANA_PASSWORD}" "${GRAFANA_URL}/api/search?type=dash-db" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(next((x['uid'] for x in d if 'pipeline-builder' in x['uid']), None))")
[[ "${DASH}" == "pipeline-builder-slo" ]] || fail "dashboard pipeline-builder-slo not found (got '${DASH}')"
ok "dashboard pipeline-builder-slo provisioned"

# 7. Verify burn-rate rules loaded.
RULE_COUNT=$(curl -sf "${PROM_URL}/api/v1/rules" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(sum(len(g['rules']) for g in d['data']['groups']))")
[[ "${RULE_COUNT}" -ge 8 ]] || fail "burn-rate rules loaded=${RULE_COUNT} expected >=8"
ok "burn-rate rules loaded: ${RULE_COUNT}"

# 8. Verify spans have been received by the collector.
SPAN_RECEIVED=$(docker logs tellus-otel-collector 2>&1 | \
  grep -c '"spans":' || echo "0")
[[ "${SPAN_RECEIVED}" -ge 1 ]] || fail "no span batches observed in collector logs"
ok "collector received ${SPAN_RECEIVED} span batches"

# 9. Verify pipeline_* metric is queryable in Prometheus (the health
# check counter is always present after probes run).
HC=$(curl -sf "${PROM_URL}/api/v1/query?query=pipeline_health_check_failures_total" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['data']['result']))")
[[ "${HC}" -ge 1 ]] || fail "pipeline_health_check_failures_total not queryable (result=${HC})"
ok "pipeline metric scraped (${HC} series)"

ok "ALL CHECKS PASSED — PB-B9 observability stack is live and healthy."
