#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# demo-code-repository-commit.sh
#
# Production-grade demo of the B2-C-12 commit slice — F4's deferred
# `console.log("commit", ...)` stub is now wired to a real backend route
# at `POST /api/v1/code-repositories/:rid/branches/:branch/commits`.
#
# This script exercises the full commit lifecycle against a running
# tellus backend using only curl + jq, no test runner, no fixtures
# beyond what we synthesize inline. It is the "smoke" any operator
# should run after deploying the backend before they trust the IDE
# Source Control panel against a fresh stack:
#
#   1. POST /v1/code-repositories               → scaffold a repo
#   2. GET  /v1/code-repositories/:rid/branches → capture initial tip SHA
#   3. POST .../branches/main/commits           → add a file
#   4. GET  .../branches/main/files?path=...    → read it back
#   5. GET  .../branches                        → confirm tip advanced
#   6. POST .../branches/main/commits (replay)  → idempotency-key reuse
#                                                 returns the original SHA
#   7. POST .../branches/main/commits (stale)   → wrong If-Match → 412
#                                                 CodeRepos:StaleRefHead
#   8. POST .../branches/main/commits (empty)   → re-modify same content
#                                                 → 422 CodeRepos:EmptyChangeSet
#   9. DELETE /v1/code-repositories/:rid        → tear down (If-Match)
#
# All assertions exit non-zero immediately if a step fails, so this is
# safe to wire into a deployment smoke check (`./demo-code-repository-commit.sh`
# in a post-deploy hook returns 0 iff the commit path is operational).
#
# Required env (or defaults shown):
#   TELLUS_BASE       http://localhost:3000        (no trailing slash)
#   TELLUS_PRINCIPAL  cypress/editor               (test-mode bypass header)
#                                                  — needs CODE_REPOS_TEST_AUTH=1
#                                                  on the backend
#   TELLUS_FOLDER_RID ri.compass.main.folder.0123abcd-ef01-4345-8789-abcdef012345
#                     (any compass folder rid the backend will accept)
# ----------------------------------------------------------------------------
set -euo pipefail

BASE="${TELLUS_BASE:-http://localhost:3000}"
PRINCIPAL="${TELLUS_PRINCIPAL:-cypress/editor}"
FOLDER_RID="${TELLUS_FOLDER_RID:-ri.compass.main.folder.0123abcd-ef01-4345-8789-abcdef012345}"

# UUID v4 generator — works on macOS (uuidgen) and Linux. Falls back to
# /proc/sys/kernel/random/uuid (linux-only) and finally a python one-liner.
gen_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr 'A-Z' 'a-z'
  elif [[ -r /proc/sys/kernel/random/uuid ]]; then
    cat /proc/sys/kernel/random/uuid
  else
    python3 -c "import uuid;print(uuid.uuid4())"
  fi
}

# Curl wrapper — always sends the test principal header, captures both
# body and status code, and pretty-prints failures so the operator can
# see the error envelope without re-running with -v.
api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  shift 3 || true

  local args=(
    -sS
    -X "$method"
    -H "Content-Type: application/json"
    -H "X-Tellus-Test-Principal: $PRINCIPAL"
    -o /tmp/_demo_body.json
    -D /tmp/_demo_headers.txt
    -w "%{http_code}"
  )
  for h in "$@"; do args+=("-H" "$h"); done
  if [[ -n "$body" ]]; then args+=(-d "$body"); fi

  local code
  code=$(curl "${args[@]}" "${BASE}${path}")
  echo "$code"
}

# Read the body from the last api call.
last_body() {
  cat /tmp/_demo_body.json
}

# Read a header value from the last api call (case-insensitive).
last_header() {
  local h="$1"
  awk -v h="$h" 'BEGIN{IGNORECASE=1} tolower($1) ~ "^"tolower(h)":" { sub(/^[^:]+:[ \t]*/,""); sub(/\r$/,""); print; exit }' /tmp/_demo_headers.txt
}

require() {
  local got="$1" want="$2" label="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL: $label — wanted $want, got $got" >&2
    echo "  body:    $(last_body)" >&2
    echo "  headers: $(cat /tmp/_demo_headers.txt | tr '\n' ' ')" >&2
    exit 1
  fi
  echo "  ok  $label  ($got)"
}

# Base64 a string (works on macOS + linux; macOS base64 has no -w).
b64() {
  if base64 --help 2>&1 | grep -q -- '-w'; then
    printf '%s' "$1" | base64 -w0
  else
    printf '%s' "$1" | base64 | tr -d '\n'
  fi
}

# JSON value extractor — jq is required because the responses are
# nested envelopes and we need exact-string assertions.
if ! command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq is required (brew install jq)" >&2
  exit 2
fi

# --- 0. Health probe -------------------------------------------------------
echo "[0/9] health check  ($BASE/health)"
status=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/health" || echo "000")
case "$status" in
  200|401|503) echo "  ok  health responded ($status)";;
  *) echo "FAIL: $BASE/health returned $status — is the backend up?" >&2; exit 1;;
esac

# --- 1. Create the repo ----------------------------------------------------
TS=$(date +%s)
DISPLAY_NAME="demo-commit-$TS"
echo "[1/9] POST /v1/code-repositories  (scaffolds $DISPLAY_NAME)"
CREATE_BODY=$(cat <<JSON
{ "displayName": "$DISPLAY_NAME",
  "parentFolderRid": "$FOLDER_RID",
  "templateId": "typescript-functions",
  "templateVersion": "2.4.0",
  "defaultBranch": "main" }
JSON
)
status=$(api POST /api/v1/code-repositories "$CREATE_BODY" "Idempotency-Key: $(gen_uuid)")
require "$status" "201" "create repo"
RID=$(last_body | jq -r '.rid')
echo "  rid = $RID"

# --- 2. Capture the initial tip SHA ---------------------------------------
echo "[2/9] GET /branches  (initial tip)"
status=$(api GET "/api/v1/code-repositories/$RID/branches")
require "$status" "200" "list branches"
INITIAL_TIP=$(last_body | jq -r '.branches[] | select(.branchName=="main") | .tipCommitSha')
if [[ -z "$INITIAL_TIP" ]] || ! [[ "$INITIAL_TIP" =~ ^[0-9a-f]{40}$ ]]; then
  echo "FAIL: tipCommitSha not a 40-char hex string: $INITIAL_TIP" >&2
  exit 1
fi
echo "  initial tip = $INITIAL_TIP"

# --- 3. Happy-path commit --------------------------------------------------
ADDED_PATH="demo/added-$TS.txt"
ADDED_CONTENT="hello from demo-code-repository-commit.sh @ $TS
"
ADDED_B64=$(b64 "$ADDED_CONTENT")
echo "[3/9] POST /commits  (add $ADDED_PATH)"
COMMIT_BODY=$(cat <<JSON
{ "message": "demo: add $ADDED_PATH",
  "fileChanges": [
    { "path": "$ADDED_PATH", "op": "add", "contentBase64": "$ADDED_B64" }
  ] }
JSON
)
status=$(api POST "/api/v1/code-repositories/$RID/branches/main/commits" "$COMMIT_BODY" \
  "Idempotency-Key: $(gen_uuid)" \
  "If-Match: \"$INITIAL_TIP\"")
require "$status" "201" "happy-path commit"
NEW_SHA=$(last_body | jq -r '.commitSha')
echo "  new commit sha = $NEW_SHA"
[[ "$NEW_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "FAIL: bad sha: $NEW_SHA" >&2; exit 1; }
[[ "$NEW_SHA" != "$INITIAL_TIP" ]] || { echo "FAIL: sha didn't advance" >&2; exit 1; }
ETAG=$(last_header etag)
[[ "$ETAG" == "\"$NEW_SHA\"" ]] || { echo "FAIL: ETag mismatch — got $ETAG, want \"$NEW_SHA\"" >&2; exit 1; }

# --- 4. Read the file back -------------------------------------------------
echo "[4/9] GET /files?path=$ADDED_PATH"
status=$(api GET "/api/v1/code-repositories/$RID/branches/main/files?path=$ADDED_PATH")
require "$status" "200" "read file back"
ENC=$(last_body | jq -r '.encoding')
RAW=$(last_body | jq -r '.content')
if [[ "$ENC" == "utf-8" ]]; then
  GOT="$RAW"
else
  # macOS base64 -d works on stdin without flags.
  GOT=$(printf '%s' "$RAW" | base64 -d 2>/dev/null || printf '%s' "$RAW" | base64 --decode)
fi
if [[ "$GOT" != "$ADDED_CONTENT" ]]; then
  echo "FAIL: content round-trip mismatch" >&2
  echo "  wanted: $(printf '%s' "$ADDED_CONTENT" | xxd | head -3)" >&2
  echo "  got:    $(printf '%s' "$GOT" | xxd | head -3)" >&2
  exit 1
fi
echo "  ok  content round-trip ($(printf '%s' "$GOT" | wc -c | tr -d ' ') bytes)"

# --- 5. Confirm tip advanced ----------------------------------------------
echo "[5/9] GET /branches  (tip advanced)"
status=$(api GET "/api/v1/code-repositories/$RID/branches")
require "$status" "200" "list branches (post-commit)"
NEW_TIP=$(last_body | jq -r '.branches[] | select(.branchName=="main") | .tipCommitSha')
[[ "$NEW_TIP" == "$NEW_SHA" ]] || { echo "FAIL: tip didn't advance ($NEW_TIP != $NEW_SHA)" >&2; exit 1; }
echo "  ok  tip = $NEW_TIP"

# --- 6. Idempotency replay -------------------------------------------------
echo "[6/9] POST /commits  (idempotency replay; same key + body → same sha)"
REPLAY_KEY=$(gen_uuid)
REPLAY_PATH="demo/replay-$TS.txt"
REPLAY_BODY=$(cat <<JSON
{ "message": "demo: replay",
  "fileChanges": [
    { "path": "$REPLAY_PATH", "op": "add", "contentBase64": "$(b64 "replay payload")" }
  ] }
JSON
)
status=$(api POST "/api/v1/code-repositories/$RID/branches/main/commits" "$REPLAY_BODY" \
  "Idempotency-Key: $REPLAY_KEY" \
  "If-Match: \"$NEW_SHA\"")
require "$status" "201" "replay first call"
REPLAY_SHA1=$(last_body | jq -r '.commitSha')

# Same If-Match (the original parent — cached row replays verbatim).
status=$(api POST "/api/v1/code-repositories/$RID/branches/main/commits" "$REPLAY_BODY" \
  "Idempotency-Key: $REPLAY_KEY" \
  "If-Match: \"$NEW_SHA\"")
require "$status" "201" "replay second call"
REPLAY_SHA2=$(last_body | jq -r '.commitSha')
[[ "$REPLAY_SHA1" == "$REPLAY_SHA2" ]] || { echo "FAIL: replay sha mismatch ($REPLAY_SHA1 != $REPLAY_SHA2)" >&2; exit 1; }
REPLAY_FLAG=$(last_header x-idempotent-replay)
[[ "$REPLAY_FLAG" == "true" ]] || { echo "FAIL: X-Idempotent-Replay header missing" >&2; exit 1; }
echo "  ok  replay returned same sha ($REPLAY_SHA1) with x-idempotent-replay=true"

# --- 7. StaleRefHead -------------------------------------------------------
echo "[7/9] POST /commits  (wrong parent → 412 StaleRefHead)"
WRONG_SHA="0000000000000000000000000000000000000000"
status=$(api POST "/api/v1/code-repositories/$RID/branches/main/commits" "$COMMIT_BODY" \
  "Idempotency-Key: $(gen_uuid)" \
  "If-Match: \"$WRONG_SHA\"")
require "$status" "412" "StaleRefHead"
ERR=$(last_body | jq -r '.errorName')
[[ "$ERR" == "CodeRepos:StaleRefHead" ]] || { echo "FAIL: wrong errorName: $ERR" >&2; exit 1; }
echo "  ok  errorName = $ERR"

# --- 8. EmptyChangeSet -----------------------------------------------------
echo "[8/9] POST /commits  (re-modify same content → 422 EmptyChangeSet)"
# Refresh tip after the replay step.
status=$(api GET "/api/v1/code-repositories/$RID/branches")
TIP_NOW=$(last_body | jq -r '.branches[] | select(.branchName=="main") | .tipCommitSha')
EMPTY_BODY=$(cat <<JSON
{ "message": "demo: should be empty",
  "fileChanges": [
    { "path": "$ADDED_PATH", "op": "modify", "contentBase64": "$ADDED_B64" }
  ] }
JSON
)
status=$(api POST "/api/v1/code-repositories/$RID/branches/main/commits" "$EMPTY_BODY" \
  "Idempotency-Key: $(gen_uuid)" \
  "If-Match: \"$TIP_NOW\"")
require "$status" "422" "EmptyChangeSet"
ERR=$(last_body | jq -r '.errorName')
[[ "$ERR" == "CodeRepos:EmptyChangeSet" ]] || { echo "FAIL: wrong errorName: $ERR" >&2; exit 1; }
echo "  ok  errorName = $ERR"

# --- 9. Tear down ----------------------------------------------------------
echo "[9/9] DELETE /v1/code-repositories/$RID"
status=$(api GET "/api/v1/code-repositories/$RID")
ETAG=$(last_header etag)
status=$(api DELETE "/api/v1/code-repositories/$RID" "" "If-Match: $ETAG")
case "$status" in
  200|204) echo "  ok  deleted ($status)";;
  *) echo "  warn  delete returned $status (not fatal): $(last_body)" >&2;;
esac

echo
echo "PASS — commit slice operational on $BASE"
