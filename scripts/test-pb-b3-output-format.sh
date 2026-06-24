#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PB-B3 — output_format smoke.
#
# Pins the HTTP contract the frontend + BI consumers depend on:
#   (1) POST /pipelines creates rows with output_format='csv' by default
#       (backwards-compat; PB-B4 flips this to 'parquet').
#   (2) PUT /pipelines/:id can flip output_format='parquet' explicitly.
#   (3) POST /:id/migrate-output-format with target='parquet' on a
#       pipeline with no output nodes returns the NO_OUTPUTS validation
#       error (proves the endpoint routes to migrateOutputFormat →
#       startDeployment rather than a silent no-op). Full re-deploy
#       coverage is in the vitest integration suite.
#
# Preconditions: bootstrap-keycloak.sh test user + server on :3000 +
# PB-B3 migrations applied.
# ---------------------------------------------------------------------------
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
KC_URL="${KC_URL:-http://localhost:8086}"
KC_REALM="${KC_REALM:-tellus}"
KC_CLIENT="${KC_CLIENT:-tellus-frontend}"
KC_USER="${KC_USER:-cypress@tellus.local}"
KC_PASS="${KC_PASS:-Password123!}"

log()  { printf '\033[36m[pb-b3]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[pb-b3 FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m[pb-b3 OK]\033[0m %s\n' "$*"; }

# Prefer the shared token from run-all.sh (AUTH_TOKEN); re-acquiring per script
# trips Keycloak brute-force/quick-login throttling (HTTP 400). Fall back to a
# direct grant for standalone local runs.
TOKEN="${AUTH_TOKEN:-$(curl -sSf \
  -d "client_id=${KC_CLIENT}" -d "grant_type=password" \
  -d "username=${KC_USER}" -d "password=${KC_PASS}" \
  "${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')}"
[ -n "${TOKEN}" ] || fail "no token"
AUTH="Authorization: Bearer ${TOKEN}"
JSON="Content-Type: application/json"

STAMP=$(date +%s%N | tail -c 10)
PROJECT_ID=$(curl -sSf -X POST "${BASE_URL}/api/v1/projects" \
  -H "${AUTH}" -H "${JSON}" -d "{\"name\":\"pb-b3-${STAMP}\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
cleanup() { curl -s -X DELETE "${BASE_URL}/api/v1/projects/${PROJECT_ID}" -H "${AUTH}" >/dev/null || true; }
trap cleanup EXIT

PIPE_BODY=$(curl -sSf -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines" \
  -H "${AUTH}" -H "${JSON}" -d "{\"name\":\"pipe-${STAMP}\"}")
PIPE_ID=$(echo "${PIPE_BODY}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')
DEFAULT_FORMAT=$(echo "${PIPE_BODY}" | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print(d.get("output_format") or d.get("outputFormat"))')
[ "${DEFAULT_FORMAT}" = "csv" ] || fail "(1) expected default output_format=csv got '${DEFAULT_FORMAT}'"
ok "(1) default output_format=csv on new pipeline"

log "(2) PUT output_format=parquet"
UPD=$(curl -sSf -X PUT \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPE_ID}" \
  -H "${AUTH}" -H "${JSON}" -d '{"outputFormat":"parquet"}')
UF=$(echo "${UPD}" | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print(d.get("output_format") or d.get("outputFormat"))')
[ "${UF}" = "parquet" ] || fail "(2) PUT did not persist output_format=parquet, got '${UF}'"
ok "(2) output_format=parquet via PUT"

log "(3) migrate-output-format on empty pipeline rejects with NO_OUTPUTS"
MIG=$(curl -sS -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPE_ID}/migrate-output-format" \
  -H "${AUTH}" -H "${JSON}" -d '{"target":"parquet"}')
CODE=$(echo "${MIG}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("errorCode",""))')
[ "${CODE}" = "NO_OUTPUTS" ] || fail "(3) expected errorCode=NO_OUTPUTS, got '${CODE}' (body: ${MIG})"
ok "(3) migrate endpoint reaches supervised path and surfaces NO_OUTPUTS"

ok "PB-B3 HTTP smoke: output_format contract wired. Writer correctness in vitest suite."
