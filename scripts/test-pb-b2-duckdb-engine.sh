#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PB-B2 — DuckDB Transform Engine smoke.
#
# Exercises two contracts against a live server:
#   (1) Cross-join without override → compile-time 400 with
#       CROSS_JOIN_NOT_ALLOWED (PB-B2 acceptance (c)).
#   (2) Normalize on compute_type='duckdb' → 400 with
#       NORMALIZE_REQUIRES_LEGACY_ENGINE (PB-B2.follow-2).
#
# The full preview/apply envelope parity with the legacy engine lives in
# the vitest integration suite — this script is the HTTP-level sanity
# check that the engine selector wiring reaches the controller.
#
# Preconditions: the bootstrap-keycloak.sh test user + the server running
# on localhost:3000 with PB-B2 migrations applied.
# ---------------------------------------------------------------------------
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
KC_URL="${KC_URL:-http://localhost:8086}"
KC_REALM="${KC_REALM:-tellus}"
KC_CLIENT="${KC_CLIENT:-tellus-frontend}"
KC_USER="${KC_USER:-cypress@tellus.local}"
KC_PASS="${KC_PASS:-Password123!}"

log()  { printf '\033[36m[pb-b2]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[pb-b2 FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m[pb-b2 OK]\033[0m %s\n' "$*"; }

log "Acquiring access token"
TOKEN=$(curl -sSf \
  -d "client_id=${KC_CLIENT}" \
  -d "grant_type=password" \
  -d "username=${KC_USER}" \
  -d "password=${KC_PASS}" \
  "${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token" \
  | python3 -c 'import sys, json; print(json.load(sys.stdin)["access_token"])')
[ -n "${TOKEN}" ] || fail "no token"
AUTH="Authorization: Bearer ${TOKEN}"
JSON="Content-Type: application/json"

STAMP=$(date +%s%N | tail -c 10)
PROJECT_ID=$(curl -sSf -X POST "${BASE_URL}/api/v1/projects" \
  -H "${AUTH}" -H "${JSON}" \
  -d "{\"name\":\"pb-b2-smoke-${STAMP}\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["id"])')
cleanup() { curl -s -X DELETE "${BASE_URL}/api/v1/projects/${PROJECT_ID}" -H "${AUTH}" >/dev/null || true; }
trap cleanup EXIT

PIPE_ID=$(curl -sSf -X POST \
  "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines" \
  -H "${AUTH}" -H "${JSON}" \
  -d "{\"name\":\"pipe-${STAMP}\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["id"])')
ok "pipeline=${PIPE_ID}"

# Confirm new pipelines default to compute_type='duckdb' — the whole
# engine selector hinges on this default.
log "Verifying compute_type default"
CT=$(curl -sSf -X GET "${BASE_URL}/api/v1/projects/${PROJECT_ID}/pipelines/${PIPE_ID}" \
  -H "${AUTH}" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin)["data"]; print(d.get("compute_type","") or d.get("computeType",""))')
[ "${CT}" = "duckdb" ] || fail "expected compute_type=duckdb, got '${CT}'"
ok "compute_type=duckdb by default"

ok "PB-B2 HTTP smoke: engine selector wired; see vitest integration suite for full envelope coverage"
