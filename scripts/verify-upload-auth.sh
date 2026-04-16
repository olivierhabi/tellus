#!/usr/bin/env bash
#
# verify-upload-auth.sh
# ---------------------
# Reproduces the fix for the "not a member of this project" FORBIDDEN that
# the frontend was hitting on POST /api/v1/projects/:projectId/upload after the
# Keycloak auth revamp.
#
# What it checks:
#   1. Obtain a Keycloak access token via direct grant for the seeded
#      cypress@tellus.local user.
#   2. Hit POST /api/v1/auth/token-info and assert 200 — confirms the local
#      user row was auto-provisioned by requireTellusAuth (ensureLocalUserForClaims).
#   3. Create a fresh project owned by that user via POST /api/v1/projects.
#   4. Upload a tiny CSV to POST /api/v1/projects/:id/upload and assert HTTP 2xx
#      AND that the response body has `success: true`. A FORBIDDEN here means
#      the membership fix regressed.
#   5. Clean up the project.
#
# Requires: curl, jq. The tellus backend must be running at API_URL with the
# bootstrap-keycloak.sh realm loaded and the DB migrated.
#
# Env overrides: KC_URL, KC_REALM, KC_CLIENT, TELLUS_USER, TELLUS_PASS, API_URL.
# Exit 0 on success, 1 on any failure.

set -o pipefail

KC="${KC_URL:-http://localhost:8086}"
REALM="${KC_REALM:-tellus}"
CLIENT="${KC_CLIENT:-tellus-frontend}"
USER="${TELLUS_USER:-cypress@tellus.local}"
PASS="${TELLUS_PASS:-Password123!}"
API="${API_URL:-http://localhost:3000/api}"

GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m'
ok()  { printf "${GREEN}✓${NC} %s\n" "$1"; }
die() { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }
note(){ printf "${DIM}  %s${NC}\n" "$1"; }

command -v jq   >/dev/null || die "jq is required"
command -v curl >/dev/null || die "curl is required"

# ---- 1. Get Keycloak access token --------------------------------------------
note "POST $KC/realms/$REALM/protocol/openid-connect/token"
TOKEN_RESPONSE=$(curl -sf -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=$USER" \
  -d "password=$PASS" \
  -d "grant_type=password" \
  -d "client_id=$CLIENT" \
  -d "scope=openid profile email" \
  "$KC/realms/$REALM/protocol/openid-connect/token") \
  || die "Keycloak direct grant failed — is $KC reachable and the realm bootstrapped?"

ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token')
[ -n "$ACCESS_TOKEN" ] && [ "$ACCESS_TOKEN" != "null" ] \
  || die "No access_token in Keycloak response: $TOKEN_RESPONSE"
ok "Obtained Keycloak access token for $USER"

AUTH_HEADER="Authorization: Bearer $ACCESS_TOKEN"

# ---- 2. Verify token resolves to a local users.id ----------------------------
note "GET  $API/v1/auth/token-info"
TOKEN_INFO_HTTP=$(curl -s -o /tmp/tellus_token_info.json -w "%{http_code}" \
  -H "$AUTH_HEADER" "$API/v1/auth/token-info")
[ "$TOKEN_INFO_HTTP" = "200" ] \
  || die "token-info returned $TOKEN_INFO_HTTP: $(cat /tmp/tellus_token_info.json)"
ok "token-info OK — backend accepts the Keycloak JWT"

# ---- 3. Create a fresh project so the caller is guaranteed to be owner -------
note "POST $API/projects"
PROJECT_BODY=$(printf '{"name":"upload-auth-check-%s","description":"temp"}' "$(date +%s)")
PROJECT_RESPONSE=$(curl -sf -X POST \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d "$PROJECT_BODY" \
  "$API/projects") || die "Project creation failed — did the fix regress at /projects?"

PROJECT_ID=$(echo "$PROJECT_RESPONSE" | jq -r '.data.id // .id // .project.id')
[ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "null" ] \
  || die "No project id in response: $PROJECT_RESPONSE"
ok "Created project $PROJECT_ID"

cleanup() {
  curl -s -o /dev/null -X DELETE -H "$AUTH_HEADER" "$API/projects/$PROJECT_ID" || true
}
trap cleanup EXIT

# ---- 4. Upload a file to the project -----------------------------------------
TMP_CSV="/tmp/tellus_upload_${PROJECT_ID}.csv"
printf "id,name\n1,alpha\n2,bravo\n" > "$TMP_CSV"

note "POST $API/projects/$PROJECT_ID/upload"
UPLOAD_BODY=$(curl -s -o /tmp/tellus_upload_response.json -w "%{http_code}" \
  -X POST \
  -H "$AUTH_HEADER" \
  -F "files=@$TMP_CSV" \
  "$API/projects/$PROJECT_ID/upload")

if [ "$UPLOAD_BODY" != "200" ] && [ "$UPLOAD_BODY" != "201" ]; then
  printf "${RED}UPLOAD FAILED:${NC} HTTP %s\n" "$UPLOAD_BODY" >&2
  cat /tmp/tellus_upload_response.json >&2
  printf "\n" >&2
  die "This is the bug being fixed. The project owner should always pass authorizeRoles('owner')."
fi

SUCCESS=$(jq -r '.success // empty' /tmp/tellus_upload_response.json)
[ "$SUCCESS" = "true" ] \
  || die "Upload returned HTTP $UPLOAD_BODY but body.success != true: $(cat /tmp/tellus_upload_response.json)"
ok "Upload succeeded (HTTP $UPLOAD_BODY)"

rm -f "$TMP_CSV"
ok "All checks passed"
