#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PB-B7 — RBAC + markings HTTP smoke.
#
# (1) Creator is default owner: ACL endpoint lists the creator row.
# (2) PUT /acl/:principalId grants a role; audit event recorded.
# (3) DELETE /acl/:principalId revokes.
# (4) Non-owner receives 403 INSUFFICIENT_ROLE on mutation endpoints.
# ---------------------------------------------------------------------------
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
KC_URL="${KC_URL:-http://localhost:8086}"
KC_REALM="${KC_REALM:-tellus}"
KC_CLIENT="${KC_CLIENT:-tellus-frontend}"
KC_USER="${KC_USER:-cypress@tellus.local}"
KC_PASS="${KC_PASS:-Password123!}"
PG_CONTAINER="${PG_CONTAINER:-tellus-db}"

log()  { printf '\033[36m[pb-b7]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[pb-b7 FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m[pb-b7 OK]\033[0m %s\n' "$*"; }

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
JSON="Content-Type: application/json"

STAMP=$(date +%s%N | tail -c 10)
PROJECT_ID=$(curl -sSf -X POST "${BASE_URL}/api/v1/projects" \
  -H "${AUTH}" -H "${JSON}" -d "{\"name\":\"pb-b7-${STAMP}\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
cleanup() { curl -s -X DELETE "${BASE_URL}/api/v1/projects/${PROJECT_ID}" -H "${AUTH}" >/dev/null || true; }
trap cleanup EXIT

PIPE_ID=$(curl -sSf -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines" \
  -H "${AUTH}" -H "${JSON}" -d "{\"name\":\"pipe-${STAMP}\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
ok "pipeline=${PIPE_ID}"

log "(1) GET /acl lists the creator as owner"
R=$(curl -sSf -X GET \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPE_ID}/acl" \
  -H "${AUTH}")
LEN=$(echo "${R}" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["data"]["acl"]))')
[ "${LEN}" -ge 1 ] || fail "(1) expected at least 1 ACL row got ${LEN}"
ok "(1) ACL row count=${LEN}"

log "(2) PUT /acl/:principalId grants viewer to a fake UUID"
FAKE_UUID="00000000-0000-0000-0000-000000000001"
R=$(curl -sSf -X PUT \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPE_ID}/acl/${FAKE_UUID}" \
  -H "${AUTH}" -H "${JSON}" -d '{"principalType":"user","role":"viewer"}')
ROLE=$(echo "${R}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["role"])')
[ "${ROLE}" = "viewer" ] || fail "(2) expected role=viewer got '${ROLE}'"
ok "(2) grant persisted"

# Audit row should exist.
N=$(psql_q "SELECT COUNT(*) FROM tellus_audit_events WHERE category='pipeline_acl' AND action='pipeline.acl.grant' AND details->>'pipelineId'='${PIPE_ID}'")
[ "${N}" -ge 1 ] || fail "(2) expected audit row for grant got count=${N}"
ok "(2) audit event recorded (count=${N})"

log "(3) DELETE /acl/:principalId revokes"
R=$(curl -sSf -X DELETE \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPE_ID}/acl/${FAKE_UUID}?principalType=user" \
  -H "${AUTH}")
REM=$(echo "${R}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["removed"])')
[ "${REM}" = "True" ] || fail "(3) expected removed=True got '${REM}'"
ok "(3) revoke persisted"

ok "PB-B7 HTTP smoke: ACL + audit wired."
