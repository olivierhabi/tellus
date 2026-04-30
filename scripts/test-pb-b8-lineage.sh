#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PB-B8 — lineage endpoint HTTP smoke.
#
# (1) GET /api/v2/datasets/:id/lineage?direction=downstream&depth=3
#     returns {nodes,edges} for a valid dataset id.
# (2) depth > MAX_LINEAGE_DEPTH rejected with LINEAGE_DEPTH_TOO_LARGE.
# (3) Invalid dataset id returns VALIDATION_ERROR.
# ---------------------------------------------------------------------------
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
KC_URL="${KC_URL:-http://localhost:8086}"
KC_REALM="${KC_REALM:-tellus}"
KC_CLIENT="${KC_CLIENT:-tellus-frontend}"
KC_USER="${KC_USER:-cypress@tellus.local}"
KC_PASS="${KC_PASS:-Password123!}"
PG_CONTAINER="${PG_CONTAINER:-tellus-db}"

log()  { printf '\033[36m[pb-b8]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[pb-b8 FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m[pb-b8 OK]\033[0m %s\n' "$*"; }

psql_q() {
  docker exec -e PGPASSWORD=tellus123 "${PG_CONTAINER}" \
    psql -U tellus -d tellus_db -At -c "$1"
}

TOKEN=$(curl -sSf \
  -d "client_id=${KC_CLIENT}" -d "grant_type=password" \
  -d "username=${KC_USER}" -d "password=${KC_PASS}" \
  "${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
AUTH="Authorization: Bearer ${TOKEN}"

# Grab any foundry dataset id so the endpoint has something to walk.
DS_ID=$(psql_q "SELECT id FROM foundry_datasets ORDER BY created_at DESC LIMIT 1")
if [ -z "${DS_ID}" ]; then
  log "no foundry_datasets rows — creating a throwaway fixture"
  OWNER=$(psql_q "SELECT id FROM users LIMIT 1")
  PROJECT=$(psql_q "INSERT INTO projects(name, owner_id) VALUES ('pb-b8-smoke-$(date +%s)', '${OWNER}') RETURNING id")
  DS_ID=$(psql_q "INSERT INTO foundry_datasets(name, project_id, file_path, format) VALUES ('smoke-$(date +%s)', '${PROJECT}', 'fake/smoke.parquet', 'parquet') RETURNING id")
fi

log "(1) GET /api/v2/datasets/${DS_ID}/lineage?direction=downstream&depth=3"
R=$(curl -sSf -X GET \
  "${BASE_URL}/api/v2/datasets/${DS_ID}/lineage?direction=downstream&depth=3" \
  -H "${AUTH}")
NODES=$(echo "${R}" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["data"]["nodes"]))')
EDGES=$(echo "${R}" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["data"]["edges"]))')
ok "(1) nodes=${NODES} edges=${EDGES}"

log "(2) depth=99 → LINEAGE_DEPTH_TOO_LARGE"
R=$(curl -sS -X GET \
  "${BASE_URL}/api/v2/datasets/${DS_ID}/lineage?depth=99" \
  -H "${AUTH}")
CODE=$(echo "${R}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("errorCode",""))')
[ "${CODE}" = "LINEAGE_DEPTH_TOO_LARGE" ] || fail "(2) expected LINEAGE_DEPTH_TOO_LARGE got '${CODE}' body=${R}"
ok "(2) depth cap enforced"

log "(3) bogus id → VALIDATION_ERROR"
R=$(curl -sS -X GET \
  "${BASE_URL}/api/v2/datasets/not-a-uuid/lineage" \
  -H "${AUTH}")
CODE=$(echo "${R}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("errorCode",""))')
[ "${CODE}" = "VALIDATION_ERROR" ] || fail "(3) expected VALIDATION_ERROR got '${CODE}' body=${R}"
ok "(3) id validation enforced"

ok "PB-B8 HTTP smoke: lineage endpoint wired."
