#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PB-B1 End-to-End Smoke — supervised pipeline deploys.
#
# Exercises the HTTP contract of the supervised deploy path against a
# live stack (server on :3000, Postgres on :5432, Keycloak on :8086).
# Pins the four acceptance criteria that map 1:1 to an HTTP observation:
#
#   (a) POST /deploy without Idempotency-Key echoes a server-generated
#       key in the `Idempotency-Key-Generated` response header and the
#       legacy response envelope is unchanged.
#   (b) Two POSTs with the same Idempotency-Key within 5s return the
#       same deploymentId and the second one reports `"reused":true`.
#   (c) DELETE /deployments/:id returns 200 with cancellationRequestedAt.
#   (d) Postgres: pipeline_signal row for the deploy gets consumed
#       (consumed_at IS NOT NULL) by the dispatcher within the SLO.
#
# Preconditions:
#   * ./scripts/bootstrap-keycloak.sh has run (cypress@tellus.local user).
#   * The server is running with PIPELINE_DISPATCHER_DISABLED unset.
#
# Exits non-zero on the first failed assertion.
# ---------------------------------------------------------------------------
set -euo pipefail

# NOTE: default to localhost (not 127.0.0.1) to match the JWT issuer the
# Keycloak realm bakes into tokens. Tellus auth middleware rejects tokens
# whose `iss` host doesn't equal its configured issuer URL.
BASE_URL="${BASE_URL:-http://localhost:3000}"
KC_URL="${KC_URL:-http://localhost:8086}"
KC_REALM="${KC_REALM:-tellus}"
# `tellus-frontend` is the public client used by the browser app. Direct-
# grant from it yields a JWT the Tellus middleware accepts without having
# to walk through the passkey enrollment step of /api/v1/auth/login.
KC_CLIENT="${KC_CLIENT:-tellus-frontend}"
KC_USER="${KC_USER:-cypress@tellus.local}"
KC_PASS="${KC_PASS:-Password123!}"
PG_HOST="${PGHOST:-127.0.0.1}"
PG_USER="${PGUSER:-tellus}"
PG_PASS="${PGPASSWORD:-tellus123}"
PG_DB="${PGDATABASE:-tellus_db}"
# Default to the docker-compose container if a local psql is not on PATH.
# The container name matches docker-compose.yml's `tellus-db`.
PG_CONTAINER="${PG_CONTAINER:-tellus-db}"

psql_query() {
  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="${PG_PASS}" psql -h "${PG_HOST}" -U "${PG_USER}" -d "${PG_DB}" -At -c "$1"
  elif command -v docker >/dev/null 2>&1; then
    docker exec -e PGPASSWORD="${PG_PASS}" "${PG_CONTAINER}" \
      psql -U "${PG_USER}" -d "${PG_DB}" -At -c "$1"
  else
    fail "neither psql nor docker available for (d) assertion"
  fi
}

log()   { printf '\033[36m[pb-b1]\033[0m %s\n' "$*"; }
fail()  { printf '\033[31m[pb-b1 FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
ok()    { printf '\033[32m[pb-b1 OK]\033[0m %s\n' "$*"; }

# ── 1. Auth ────────────────────────────────────────────────────────────────
# Keycloak direct-grant against the public `tellus-frontend` client. We do
# NOT go through /api/v1/auth/login because that path may require passkey
# enrollment depending on system_settings; direct-grant mints a plain JWT
# the middleware will accept so long as the issuer matches `KC_URL`.
log "Acquiring access token via Keycloak direct-grant (${KC_CLIENT})"
TOKEN=$(curl -sSf \
  -d "client_id=${KC_CLIENT}" \
  -d "grant_type=password" \
  -d "username=${KC_USER}" \
  -d "password=${KC_PASS}" \
  "${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token" \
  | python3 -c 'import sys, json; print(json.load(sys.stdin)["access_token"])')
[ -n "${TOKEN}" ] || fail "could not obtain access token"

AUTH_H="Authorization: Bearer ${TOKEN}"
JSON_H="Content-Type: application/json"

# ── 2. Fixture: project + pipeline + output node ──────────────────────────
STAMP=$(date +%s%N | tail -c 10)
PROJECT_NAME="pb-b1-smoke-${STAMP}"
PIPELINE_NAME="pipe-${STAMP}"

log "Creating project ${PROJECT_NAME}"
PROJECT_ID=$(curl -sSf -X POST "${BASE_URL}/api/v1/projects" \
  -H "${AUTH_H}" -H "${JSON_H}" \
  -d "{\"name\":\"${PROJECT_NAME}\"}" \
  | python3 -c 'import sys, json; print(json.load(sys.stdin)["data"]["id"])')
[ -n "${PROJECT_ID}" ] || fail "project create returned no id"
ok "project=${PROJECT_ID}"

cleanup() {
  curl -s -X DELETE "${BASE_URL}/api/v1/projects/${PROJECT_ID}" -H "${AUTH_H}" >/dev/null || true
}
trap cleanup EXIT

log "Creating pipeline ${PIPELINE_NAME}"
PIPELINE_ID=$(curl -sSf -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines" \
  -H "${AUTH_H}" -H "${JSON_H}" \
  -d "{\"name\":\"${PIPELINE_NAME}\"}" \
  | python3 -c 'import sys, json; print(json.load(sys.stdin)["data"]["id"])')
[ -n "${PIPELINE_ID}" ] || fail "pipeline create returned no id"
ok "pipeline=${PIPELINE_ID}"

log "Adding output node"
NODE_ID=$(curl -sSf -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPELINE_ID}/nodes" \
  -H "${AUTH_H}" -H "${JSON_H}" \
  -d '{"nodeType":"output","label":"out","positionX":0,"positionY":0,"config":{}}' \
  | python3 -c 'import sys, json; print(json.load(sys.stdin)["data"]["id"])')
[ -n "${NODE_ID}" ] || fail "node create returned no id"
ok "node=${NODE_ID}"

DEPLOY_URL="${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPELINE_ID}/deploy"

# ── (a) Idempotency auto-generation ───────────────────────────────────────
log "(a) POST /deploy without Idempotency-Key"
RESP_HEADERS=$(mktemp)
RESP_BODY=$(curl -sSf -X POST "${DEPLOY_URL}" \
  -H "${AUTH_H}" -H "${JSON_H}" \
  -D "${RESP_HEADERS}" \
  -d "{\"outputNodeIds\":[\"${NODE_ID}\"]}")
AUTO_ID=$(echo "${RESP_BODY}" | python3 -c 'import sys, json; print(json.load(sys.stdin)["data"]["deploymentId"])')
AUTO_KEY=$(echo "${RESP_BODY}" | python3 -c 'import sys, json; print(json.load(sys.stdin)["data"]["idempotencyKey"])')
AUTO_HDR=$(grep -i '^Idempotency-Key-Generated:' "${RESP_HEADERS}" | awk '{print $2}' | tr -d '\r\n')
[ -n "${AUTO_ID}" ]  || fail "(a) no deploymentId in response"
[ -n "${AUTO_KEY}" ] || fail "(a) no idempotencyKey in response body"
[ -n "${AUTO_HDR}" ] || fail "(a) missing Idempotency-Key-Generated header"
[ "${AUTO_KEY}" = "${AUTO_HDR}" ] || fail "(a) header/body key mismatch"
ok "(a) auto-generated key=${AUTO_KEY}"

# ── (b) Idempotent replay ─────────────────────────────────────────────────
KEY="pb-b1-smoke-${STAMP}-idem"
log "(b) Two POSTs with Idempotency-Key=${KEY}"
FIRST=$(curl -sSf -X POST "${DEPLOY_URL}" \
  -H "${AUTH_H}" -H "${JSON_H}" -H "Idempotency-Key: ${KEY}" \
  -d "{\"outputNodeIds\":[\"${NODE_ID}\"]}")
FIRST_ID=$(echo "${FIRST}" | python3 -c 'import sys, json; print(json.load(sys.stdin)["data"]["deploymentId"])')
FIRST_REUSED=$(echo "${FIRST}" | python3 -c 'import sys, json; print(json.load(sys.stdin)["data"]["reused"])')
[ "${FIRST_REUSED}" = "False" ] || fail "(b) first call must not be reused (got ${FIRST_REUSED})"

SECOND=$(curl -sSf -X POST "${DEPLOY_URL}" \
  -H "${AUTH_H}" -H "${JSON_H}" -H "Idempotency-Key: ${KEY}" \
  -d "{\"outputNodeIds\":[\"${NODE_ID}\"]}")
SECOND_ID=$(echo "${SECOND}" | python3 -c 'import sys, json; print(json.load(sys.stdin)["data"]["deploymentId"])')
SECOND_REUSED=$(echo "${SECOND}" | python3 -c 'import sys, json; print(json.load(sys.stdin)["data"]["reused"])')
[ "${FIRST_ID}" = "${SECOND_ID}" ] || fail "(b) deploymentId differs: ${FIRST_ID} vs ${SECOND_ID}"
[ "${SECOND_REUSED}" = "True" ] || fail "(b) second call must be reused (got ${SECOND_REUSED})"
ok "(b) idempotent: ${FIRST_ID}"

# ── (c) Cancellation ──────────────────────────────────────────────────────
log "(c) DELETE /deployments/${FIRST_ID}"
CANCEL=$(curl -sSf -X DELETE \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPELINE_ID}/deployments/${FIRST_ID}" \
  -H "${AUTH_H}")
CANCEL_TS=$(echo "${CANCEL}" | python3 -c 'import sys, json; print(json.load(sys.stdin)["data"]["cancellationRequestedAt"])')
[ -n "${CANCEL_TS}" ] || fail "(c) no cancellationRequestedAt in response"
ok "(c) cancel requested at ${CANCEL_TS}"

# ── (d) Dispatcher consumes signal ────────────────────────────────────────
log "(d) waiting up to 15s for dispatcher to consume pipeline_signal row"
DEADLINE=$((SECONDS + 15))
PENDING=""
while [ $SECONDS -lt $DEADLINE ]; do
  PENDING=$(psql_query "SELECT COUNT(*) FROM pipeline_signal WHERE pipeline_id='${PIPELINE_ID}' AND consumed_at IS NULL")
  if [ "${PENDING}" = "0" ]; then
    ok "(d) all signals consumed"
    break
  fi
  sleep 1
done
[ "${PENDING}" = "0" ] || fail "(d) ${PENDING} signal(s) still pending after 15s"

ok "PB-B1 smoke: all acceptance criteria passed"
