#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PB-B5 — streaming pipeline HTTP smoke.
#
# Creates a pipeline with pipeline_type='streaming', confirms the
# schema accepts it, and verifies the new endpoints answer on non-
# existent deployments with the typed errors the frontend relies on.
# Full Flink submission is exercised by the vitest integration suite
# against the NoopFlinkAdapter; end-to-end with a live Flink cluster
# lives in PB-B5.follow-live.
# ---------------------------------------------------------------------------
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
KC_URL="${KC_URL:-http://localhost:8086}"
KC_REALM="${KC_REALM:-tellus}"
KC_CLIENT="${KC_CLIENT:-tellus-frontend}"
KC_USER="${KC_USER:-cypress@tellus.local}"
KC_PASS="${KC_PASS:-Password123!}"

log()  { printf '\033[36m[pb-b5]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[pb-b5 FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m[pb-b5 OK]\033[0m %s\n' "$*"; }

# Prefer the shared token from run-all.sh (AUTH_TOKEN); re-acquiring per script
# trips Keycloak brute-force/quick-login throttling (HTTP 400). Fall back to a
# direct grant for standalone local runs.
TOKEN="${AUTH_TOKEN:-$(curl -sSf \
  -d "client_id=${KC_CLIENT}" -d "grant_type=password" \
  -d "username=${KC_USER}" -d "password=${KC_PASS}" \
  "${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')}"
AUTH="Authorization: Bearer ${TOKEN}"
JSON="Content-Type: application/json"

STAMP=$(date +%s%N | tail -c 10)
PROJECT_ID=$(curl -sSf -X POST "${BASE_URL}/api/v1/projects" \
  -H "${AUTH}" -H "${JSON}" -d "{\"name\":\"pb-b5-${STAMP}\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
cleanup() { curl -s -X DELETE "${BASE_URL}/api/v1/projects/${PROJECT_ID}" -H "${AUTH}" >/dev/null || true; }
trap cleanup EXIT

log "(1) create pipeline with pipelineType=streaming"
PB=$(curl -sSf -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines" \
  -H "${AUTH}" -H "${JSON}" \
  -d "{\"name\":\"pipe-${STAMP}\",\"pipelineType\":\"streaming\"}")
PIPE_ID=$(echo "${PB}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
PT=$(echo "${PB}" | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print(d.get("pipeline_type") or d.get("pipelineType"))')
[ "${PT}" = "streaming" ] || fail "(1) expected pipeline_type=streaming got '${PT}'"
ok "(1) streaming pipeline created ${PIPE_ID}"

log "(2) streaming-stats on unknown deployment returns NOT_FOUND"
STATS=$(curl -sS -X GET \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPE_ID}/deployments/00000000-0000-0000-0000-000000000000/streaming-stats" \
  -H "${AUTH}")
CODE=$(echo "${STATS}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("errorCode",""))')
[ "${CODE}" = "NOT_FOUND" ] || fail "(2) expected NOT_FOUND got '${CODE}' body=${STATS}"
ok "(2) streaming-stats returns NOT_FOUND on unknown deployment"

log "(3) restart on unknown deployment returns NOT_FOUND"
RS=$(curl -sS -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPE_ID}/deployments/00000000-0000-0000-0000-000000000000/restart" \
  -H "${AUTH}")
CODE=$(echo "${RS}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("errorCode",""))')
[ "${CODE}" = "NOT_FOUND" ] || fail "(3) expected NOT_FOUND got '${CODE}' body=${RS}"
ok "(3) restart returns NOT_FOUND on unknown deployment"

ok "PB-B5 HTTP smoke: streaming plumbing reachable. Full submit+cancel coverage in vitest suite."
