#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PB-B6 — preview pinning HTTP smoke.
#
# (1) POST /deploy on a pipeline with a drifted previewSnapshot is
#     rejected with PREVIEW_STALE (acceptance b).
# (2) POST /deploy with body {force:true} bypasses the stale check.
# (3) POST /deploy?ignorePreviewSnapshot=true records divergence_warning
#     on the deployment row (acceptance e).
#
# Full deploy-side write path + Iceberg pinned reads are verified by
# the vitest integration suites.
# ---------------------------------------------------------------------------
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
KC_URL="${KC_URL:-http://localhost:8086}"
KC_REALM="${KC_REALM:-tellus}"
KC_CLIENT="${KC_CLIENT:-tellus-frontend}"
KC_USER="${KC_USER:-cypress@tellus.local}"
KC_PASS="${KC_PASS:-Password123!}"
PG_CONTAINER="${PG_CONTAINER:-tellus-db}"

log()  { printf '\033[36m[pb-b6]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[pb-b6 FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m[pb-b6 OK]\033[0m %s\n' "$*"; }

psql_q() {
  docker exec -e PGPASSWORD=tellus123 "${PG_CONTAINER}" \
    psql -U tellus -d tellus_db -At -c "$1"
}

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
  -H "${AUTH}" -H "${JSON}" -d "{\"name\":\"pb-b6-${STAMP}\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
cleanup() { curl -s -X DELETE "${BASE_URL}/api/v1/projects/${PROJECT_ID}" -H "${AUTH}" >/dev/null || true; }
trap cleanup EXIT

PIPE_ID=$(curl -sSf -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines" \
  -H "${AUTH}" -H "${JSON}" -d "{\"name\":\"pipe-${STAMP}\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')

NODE_ID=$(curl -sSf -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPE_ID}/nodes" \
  -H "${AUTH}" -H "${JSON}" \
  -d '{"nodeType":"output","label":"out","positionX":0,"positionY":0,"config":{}}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')

# Seed a drifted previewSnapshot directly into the node config via SQL
# (the controller-side preview API would require realistic source data
# we don't want to stand up for a smoke test). Drift = chainHash on the
# previewSnapshot doesn't match the live transforms on the node.
log "seeding node with drifted previewSnapshot"
psql_q "UPDATE pipeline_nodes SET config = '{
  \"transforms\": [{\"function\":\"Drop\",\"columns\":[\"live_col\"]}],
  \"previewSnapshot\": {
    \"columns\": [{\"name\":\"x\",\"type\":\"string\"}],
    \"rows\": [],
    \"rowCount\": 0,
    \"transforms\": [{\"function\":\"Drop\",\"columns\":[\"preview_col\"]}],
    \"chainHash\": \"00deadbeef00deadbeef00deadbeef00deadbeef00deadbeef00deadbeef0000\",
    \"schemaFingerprint\": \"deadbeef\",
    \"savedAt\": \"2026-04-20T00:00:00.000Z\"
  }
}'::jsonb WHERE id = '${NODE_ID}'"

log "(1) deploy without force → PREVIEW_STALE"
R=$(curl -sS -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPE_ID}/deploy" \
  -H "${AUTH}" -H "${JSON}" -d "{\"outputNodeIds\":[\"${NODE_ID}\"]}")
CODE=$(echo "${R}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("errorCode",""))')
[ "${CODE}" = "PREVIEW_STALE" ] || fail "(1) expected PREVIEW_STALE got '${CODE}' body=${R}"
ok "(1) drifted chain rejected with PREVIEW_STALE"

log "(2) deploy with force:true succeeds"
R=$(curl -sSf -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPE_ID}/deploy" \
  -H "${AUTH}" -H "${JSON}" \
  -d "{\"outputNodeIds\":[\"${NODE_ID}\"],\"force\":true}")
D1=$(echo "${R}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["deploymentId"])')
[ -n "${D1}" ] || fail "(2) expected deploymentId in response body=${R}"
ok "(2) force=true bypassed stale check (deploy ${D1})"

log "(3) deploy?ignorePreviewSnapshot=true records divergence_warning"
R=$(curl -sSf -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPE_ID}/deploy?ignorePreviewSnapshot=true" \
  -H "${AUTH}" -H "${JSON}" \
  -d "{\"outputNodeIds\":[\"${NODE_ID}\"]}")
D2=$(echo "${R}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["deploymentId"])')
FLAG=$(psql_q "SELECT divergence_warning FROM pipeline_deployments WHERE id = '${D2}'")
[ "${FLAG}" = "t" ] || fail "(3) expected divergence_warning=t got '${FLAG}'"
IPS=$(psql_q "SELECT ignore_preview_snapshot FROM pipeline_deployments WHERE id = '${D2}'")
[ "${IPS}" = "t" ] || fail "(3) expected ignore_preview_snapshot=t got '${IPS}'"
ok "(3) divergence_warning + ignore_preview_snapshot recorded"

ok "PB-B6 HTTP smoke: stale guard + force + ignorePreviewSnapshot wired."
