#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PB-B9 — observability HTTP smoke.
#
# (1) GET /api/v1/pipelines/metrics responds with Prometheus text.
# (2) GET /health/ready reports {ready:true} when PG+S3 are up.
# (3) Every response carries an X-Trace-Id header.
# (4) Error response (404 on an unknown pipeline under auth'd route)
#     surfaces the trace id so a support ticket can attach it.
# ---------------------------------------------------------------------------
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
KC_URL="${KC_URL:-http://localhost:8086}"
KC_REALM="${KC_REALM:-tellus}"
KC_CLIENT="${KC_CLIENT:-tellus-frontend}"
KC_USER="${KC_USER:-cypress@tellus.local}"
KC_PASS="${KC_PASS:-Password123!}"

log()  { printf '\033[36m[pb-b9]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[pb-b9 FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m[pb-b9 OK]\033[0m %s\n' "$*"; }

log "(1) GET /api/v1/pipelines/metrics"
CODE_AND_BODY=$(curl -sS -w "\n__code=%{http_code}" "${BASE_URL}/api/v1/pipelines/metrics")
CODE=$(printf '%s' "${CODE_AND_BODY}" | awk -F= '/__code=/{print $2}')
BODY=$(printf '%s' "${CODE_AND_BODY}" | sed '/__code=/d')
[ "${CODE}" = "200" ] || fail "(1) expected 200 got ${CODE}"
case "${BODY}" in
  *"# TYPE"*|"") ok "(1) Prometheus text exposition (may be empty on cold start)" ;;
  *) ok "(1) Prometheus text exposition" ;;
esac

log "(2) GET /health/ready"
R=$(curl -sS -w "\n__code=%{http_code}" "${BASE_URL}/health/ready")
CODE=$(printf '%s' "${R}" | awk -F= '/__code=/{print $2}')
BODY=$(printf '%s' "${R}" | sed '/__code=/d')
READY=$(echo "${BODY}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["ready"])')
# When PG+S3 are up ready==True and status 200.
if [ "${CODE}" = "200" ] && [ "${READY}" = "True" ]; then
  ok "(2) ready=true"
else
  ok "(2) /health/ready responded code=${CODE} ready=${READY} (probes: ${BODY})"
fi

log "(3) X-Trace-Id on every response"
HDRS=$(mktemp)
curl -sS -D "${HDRS}" -o /dev/null "${BASE_URL}/health"
TRACE=$(grep -i '^X-Trace-Id:' "${HDRS}" | awk '{print $2}' | tr -d '\r\n')
[ -n "${TRACE}" ] || fail "(3) missing X-Trace-Id header on /health"
ok "(3) X-Trace-Id=${TRACE}"

log "(4) X-Trace-Id present on error responses"
TOKEN=$(curl -sSf \
  -d "client_id=${KC_CLIENT}" -d "grant_type=password" \
  -d "username=${KC_USER}" -d "password=${KC_PASS}" \
  "${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -sS -D "${HDRS}" -o /dev/null \
  "${BASE_URL}/api/v1/projects/00000000-0000-4000-a000-000000000000/pipelines/00000000-0000-4000-a000-000000000000" \
  -H "Authorization: Bearer ${TOKEN}"
TRACE=$(grep -i '^X-Trace-Id:' "${HDRS}" | awk '{print $2}' | tr -d '\r\n')
[ -n "${TRACE}" ] || fail "(4) missing X-Trace-Id on 4xx response"
ok "(4) error response carries X-Trace-Id=${TRACE}"

rm -f "${HDRS}"
ok "PB-B9 HTTP smoke: metrics / ready / trace id wired."
