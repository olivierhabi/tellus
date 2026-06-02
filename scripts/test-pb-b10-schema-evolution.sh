#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PB-B10 — schema evolution HTTP smoke.
#
# (1) POST /deploy?dryRun=true returns {success, data:{dryRun:true,
#     changed, willBeSafe, schemaDiff, blockingIssues}}.
# (2) POST /deploy with a narrowing schema is rejected with
#     SCHEMA_NARROWING_NOT_SAFE.
# (3) POST /deploy?force_schema_migration=true&accept_data_loss=true
#     overrides the narrowing guard.
# ---------------------------------------------------------------------------
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
KC_URL="${KC_URL:-http://localhost:8086}"
KC_REALM="${KC_REALM:-tellus}"
KC_CLIENT="${KC_CLIENT:-tellus-frontend}"
KC_USER="${KC_USER:-cypress@tellus.local}"
KC_PASS="${KC_PASS:-Password123!}"
PG_CONTAINER="${PG_CONTAINER:-tellus-db}"

log()  { printf '\033[36m[pb-b10]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[pb-b10 FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m[pb-b10 OK]\033[0m %s\n' "$*"; }

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
  -H "${AUTH}" -H "${JSON}" -d "{\"name\":\"pb-b10-${STAMP}\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
cleanup() { curl -s -X DELETE "${BASE_URL}/api/v1/projects/${PROJECT_ID}" -H "${AUTH}" >/dev/null || true; }
trap cleanup EXIT

PIPE_ID=$(curl -sSf -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines" \
  -H "${AUTH}" -H "${JSON}" -d "{\"name\":\"pipe-${STAMP}\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')

# Seed an output node with a narrowing schema change relative to a
# dataset we'll prime with a prior fingerprint — bypassing the full
# deploy stack for the smoke (we're pinning HTTP behaviour only).
USER_ID=$(psql_q "SELECT owner_id FROM projects WHERE id='${PROJECT_ID}'")
DS_ID=$(psql_q "INSERT INTO foundry_datasets(name, project_id, file_path, format, last_output_schema_fingerprint)
  VALUES ('pb-b10-out-${STAMP}', '${PROJECT_ID}', 'fake/pb-b10.parquet', 'parquet',
          encode(sha256(convert_to('[{\"name\":\"id\",\"type\":\"long\"},{\"name\":\"amount\",\"type\":\"int64\"}]','UTF8')), 'hex'))
  RETURNING id" | head -n1)
psql_q "INSERT INTO dataset_columns(dataset_id, column_name, column_type, ordinal_position, nullable)
  VALUES ('${DS_ID}', 'id', 'long', 1, true),
         ('${DS_ID}', 'amount', 'int64', 2, true)"
NODE_ID=$(curl -sSf -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPE_ID}/nodes" \
  -H "${AUTH}" -H "${JSON}" \
  -d "{\"nodeType\":\"output\",\"label\":\"out\",\"positionX\":0,\"positionY\":0,
       \"config\":{\"outputDatasetId\":\"${DS_ID}\",
                   \"columns\":[{\"name\":\"id\",\"type\":\"long\"},
                                 {\"name\":\"amount\",\"type\":\"int32\"}]}}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
psql_q "UPDATE pipeline_nodes SET dataset_id='${DS_ID}' WHERE id='${NODE_ID}'"

log "(1) POST /deploy?dryRun=true returns classified envelope"
R=$(curl -sSf -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPE_ID}/deploy?dryRun=true" \
  -H "${AUTH}" -H "${JSON}" -d "{\"outputNodeIds\":[\"${NODE_ID}\"]}")
CHANGED=$(echo "${R}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["changed"])')
WS=$(echo "${R}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["willBeSafe"])')
[ "${CHANGED}" = "True" ] || fail "(1) expected changed=True got '${CHANGED}'"
[ "${WS}" = "False" ] || fail "(1) expected willBeSafe=False got '${WS}'"
ok "(1) dryRun: changed=True willBeSafe=False"

log "(2) POST /deploy without force → SCHEMA_NARROWING_NOT_SAFE"
R=$(curl -sS -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPE_ID}/deploy" \
  -H "${AUTH}" -H "${JSON}" -d "{\"outputNodeIds\":[\"${NODE_ID}\"]}")
CODE=$(echo "${R}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("errorCode",""))')
[ "${CODE}" = "SCHEMA_NARROWING_NOT_SAFE" ] || fail "(2) expected SCHEMA_NARROWING_NOT_SAFE got '${CODE}' body=${R}"
ok "(2) narrowing rejected"

log "(3) POST /deploy?force_schema_migration=true&accept_data_loss=true overrides"
R=$(curl -sSf -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPE_ID}/deploy?force_schema_migration=true&accept_data_loss=true" \
  -H "${AUTH}" -H "${JSON}" -d "{\"outputNodeIds\":[\"${NODE_ID}\"]}")
DID=$(echo "${R}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["deploymentId"])')
[ -n "${DID}" ] || fail "(3) expected deploymentId body=${R}"
ok "(3) force override deployed ${DID}"

ok "PB-B10 HTTP smoke: dryRun + narrowing + force wired."
