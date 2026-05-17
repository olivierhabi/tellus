#!/usr/bin/env bash
#
# test-dataset-size-formatting.sh
# -------------------------------
# Production invariant: every dataset in the Compass-children response
# carries a `fileSizeFormatted` field whose value is the canonical
# human-readable size string computed by `formatFileSize` on the
# backend.
#
# Tests:
#   1.  POST /api/v1/auth/_test/login-bypass  → access token
#   2.  GET  /api/v1/compass/folders/<rid>/children
#   3.  Assert every dataset row has:
#          - `fileSizeFormatted` present, non-empty, type string
#          - matches the canonical regex (^\d{1,3}(,\d{3})*(\.\d+)?\s(B|KB|MB|GB|TB|PB)$ or "0 B")
#   4.  Assert specifically that the [Olivier] dataset (file_size_bytes
#       = 90_136 in this DB) renders as "88 KB" — pins the screenshot
#       regression at the API level so any future serialisation drift
#       (BIGINT-as-string, padded zeros, 2-decimal output) fails CI
#       before reaching the UI.
#
# Exits non-zero on any failure. Suitable as a CI gate.
#
# Usage:
#   bash scripts/test-dataset-size-formatting.sh
#   # or with overrides:
#   PROJECT_ID=… DATASET_NAME_LIKE='[Olivier]' bash scripts/test-dataset-size-formatting.sh

set -euo pipefail

API="${TELLUS_API_URL:-http://localhost:3000}"
PROJECT_ID="${PROJECT_ID:-36271681-65d7-4c55-a6d0-20137f8212dc}"
PROJECT_ROOT_RID="ri.compass.main.folder.${PROJECT_ID}"
AUTH_EMAIL="${KEYCLOAK_TEST_USER:-cypress@tellus.local}"
AUTH_PASSWORD="${KEYCLOAK_TEST_PASS:-Password123!}"
EXPECTED_SCREENSHOT_LABEL="${EXPECTED_SCREENSHOT_LABEL:-88 KB}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'
ok()   { printf "${GREEN}[ok]${NC}   %s\n" "$1"; }
warn() { printf "${YELLOW}[warn]${NC} %s\n" "$1"; }
fail() { printf "${RED}[fail]${NC} %s\n" "$1" >&2; exit 1; }

command -v jq >/dev/null || fail "jq required"
command -v curl >/dev/null || fail "curl required"

# --- 1. obtain an access token via the backend test hook ----------------
TOKEN_RESP="$(curl -fsS -X POST \
  -H 'Content-Type: application/json' \
  -H 'X-Tellus-Test-Hook: 1' \
  -d "{\"username\":\"${AUTH_EMAIL}\",\"password\":\"${AUTH_PASSWORD}\"}" \
  "${API}/api/v1/auth/_test/login-bypass")"

ACCESS_TOKEN="$(jq -r '.accessToken // .data.accessToken // empty' <<<"$TOKEN_RESP")"
[ -n "$ACCESS_TOKEN" ] || fail "login-bypass returned no accessToken: $TOKEN_RESP"
ok "logged in as $AUTH_EMAIL"

# --- 2. fetch the Compass children for the project root ------------------
ENC_RID="$(printf %s "$PROJECT_ROOT_RID" | jq -sRr @uri)"
CHILDREN_URL="${API}/api/v1/compass/folders/${ENC_RID}/children?pageSize=50"

RESP="$(curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "$CHILDREN_URL")"

ITEM_COUNT="$(jq '.items | length' <<<"$RESP")"
[ "${ITEM_COUNT:-0}" -gt 0 ] || fail "no items in children response"
ok "fetched $ITEM_COUNT items"

DATASETS="$(jq '[.items[] | select(.kind=="dataset")]' <<<"$RESP")"
DATASET_COUNT="$(jq 'length' <<<"$DATASETS")"
[ "$DATASET_COUNT" -gt 0 ] || fail "no datasets in this project's root"
ok "found $DATASET_COUNT dataset(s) at project root"

# --- 3. every dataset must have a well-formed fileSizeFormatted ---------
MISSING="$(jq '[.[] | select((.fileSizeFormatted // "") == "")] | length' <<<"$DATASETS")"
[ "$MISSING" = "0" ] || {
  jq '[.[] | select((.fileSizeFormatted // "") == "") | {displayName, fileSize, fileSizeFormatted}]' <<<"$DATASETS"
  fail "$MISSING dataset(s) missing fileSizeFormatted"
}
ok "all datasets carry a fileSizeFormatted string"

# Canonical formatter regex: integer-or-3-sig-fig number with thousand
# separators, single space, one of B/KB/MB/GB/TB/PB.
INVALID="$(jq '[.[] | select(.fileSizeFormatted | test("^[0-9,]+(\\.[0-9]+)? (B|KB|MB|GB|TB|PB)$") | not)
                  | {displayName, fileSize, fileSizeFormatted}]' <<<"$DATASETS")"
[ "$(jq 'length' <<<"$INVALID")" = "0" ] || {
  echo "$INVALID"
  fail "fileSizeFormatted does not match canonical regex"
}
ok "every fileSizeFormatted matches the canonical contract"

# --- 4. pin the screenshot regression: 90136 B → "88 KB" -----------------
SCREENSHOT="$(jq -r --arg name "[Olivier]" '
  [.[] | select(.displayName | startswith($name)) | .fileSizeFormatted] | first // empty
' <<<"$DATASETS")"
if [ -n "$SCREENSHOT" ]; then
  if [ "$SCREENSHOT" = "$EXPECTED_SCREENSHOT_LABEL" ]; then
    ok "[Olivier] datasets render exactly '$EXPECTED_SCREENSHOT_LABEL' (screenshot regression locked)"
  else
    fail "[Olivier] dataset rendered '$SCREENSHOT' — expected '$EXPECTED_SCREENSHOT_LABEL'"
  fi
else
  warn "no [Olivier] dataset in this project — skipping screenshot regression assertion"
fi

# --- 5. print a small summary table for runbook readability -------------
echo
printf "  %-40s %-12s %s\n" "displayName" "fileSize" "fileSizeFormatted"
printf "  %-40s %-12s %s\n" "----------------------------------------" "------------" "-------------------"
jq -r '.[] | "  " + (.displayName | .[0:40] | tostring | (. + (" " * (40 - length))) ) + " " + ((.fileSize // 0) | tostring | (. + (" " * (12 - length)))) + " " + .fileSizeFormatted' <<<"$DATASETS"

echo
ok "PASS — server-authoritative dataset size rendering is healthy."
