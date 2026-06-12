#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# scripts/test-create-dataset.sh
# -----------------------------------------------------------------------------
# Integration check for the Foundry-parity "Create Dataset" API:
#   POST /api/v1/datasets   { parentFolderRid, name }  ->  { rid, name, parentFolderRid }
#
# A 1:1 imitation of Foundry v2 POST /v2/datasets, served under v1.
#
# What it does (against a RUNNING backend + Keycloak):
#   0. Type-checks the touched backend files (tsc --noEmit, filtered).
#   1. Obtains an access token via Keycloak ROPC.
#   2. Resolves a parent folder (creates the default output folder, idempotent).
#   3. Happy path: creates a dataset; asserts 200 + Foundry response shape
#      (rid has the ri.foundry.main.dataset.* prefix; name/parentFolderRid echo).
#   4. Negative cases (Foundry error parity, Conjure envelope):
#        - missing `name`         -> 400 Default:InvalidArgument
#        - unknown parent folder  -> 404 Datasets:FolderNotFound
#        - duplicate name         -> 409 Datasets:ResourceNameAlreadyExists
#
# Exit codes: 0 ok · 1 tsc · 2 prerequisites (token/folder) · 3 assertion failed
#
# Env overrides (defaults match cypress.config.ts / bootstrap-keycloak.sh):
#   BACKEND_URL  (http://localhost:3000)
#   KC_URL       (http://localhost:8086)   KC_REALM (tellus)   KC_CLIENT (tellus-frontend)
#   DS_USER      (cypress@tellus.local)    DS_PASS  (Password123!)
#
# Usage:  ./scripts/test-create-dataset.sh [--skip-tsc]
# -----------------------------------------------------------------------------

set -uo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "${REPO_ROOT}"

BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"
KC_URL="${KC_URL:-http://localhost:8086}"
KC_REALM="${KC_REALM:-tellus}"
KC_CLIENT="${KC_CLIENT:-tellus-frontend}"
DS_USER="${DS_USER:-cypress@tellus.local}"
DS_PASS="${DS_PASS:-Password123!}"

SKIP_TSC=0
[[ "${1:-}" == "--skip-tsc" ]] && SKIP_TSC=1

if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_RESET=$'\033[0m'
else C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_RESET=""; fi
step() { echo "${C_BLUE}==>${C_RESET} $*"; }
ok()   { echo "${C_GREEN}OK${C_RESET}  $*"; }
fail() { echo "${C_RED}FAIL${C_RESET} $*"; }
warn() { echo "${C_YELLOW}WARN${C_RESET} $*"; }

PASS_N=0; FAIL_N=0
assert_eq() { # label expected actual
  if [[ "$2" == "$3" ]]; then ok "$1 (= $3)"; PASS_N=$((PASS_N+1));
  else fail "$1: expected [$2] got [$3]"; FAIL_N=$((FAIL_N+1)); fi
}
assert_match() { # label regex actual
  if [[ "$3" =~ $2 ]]; then ok "$1 (~ $3)"; PASS_N=$((PASS_N+1));
  else fail "$1: [$3] !~ /$2/"; FAIL_N=$((FAIL_N+1)); fi
}

# --- Step 0: typecheck touched backend files --------------------------------
if [[ "${SKIP_TSC}" -eq 0 ]]; then
  step "Type-checking backend (tsc --noEmit, filtered to touched files)"
  TSC_OUT="$(mktemp)"; trap 'rm -f "${TSC_OUT}"' EXIT
  npx tsc --noEmit -p tsconfig.json >"${TSC_OUT}" 2>&1 || true
  if grep -E "foundryDatasetCreate|foundry-dataset\.repo" "${TSC_OUT}" >/dev/null; then
    fail "TypeScript errors in touched files:"; grep -E "foundryDatasetCreate|foundry-dataset\.repo" "${TSC_OUT}"; exit 1
  fi
  ok "touched backend files tsc clean"
else
  warn "Skipping tsc (--skip-tsc)"
fi

# --- JSON field extractor ----------------------------------------------------
jget() { python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
k=sys.argv[1].split(".")
for p in k:
    if isinstance(d,dict): d=d.get(p)
    else: d=None; break
print("" if d is None else d)' "$1"; }

# POST helper: $1 url, $2 json body, $3 auth(0/1). Sets HTTP_CODE + BODY.
api_post() {
  local url="$1" body="$2" auth="${3:-1}" hdr=(-H "Content-Type: application/json")
  [[ "$auth" == "1" ]] && hdr+=(-H "Authorization: Bearer ${TOKEN}")
  local raw; raw="$(curl -s -w $'\n%{http_code}' --max-time 20 -X POST "$url" "${hdr[@]}" -d "$body")"
  HTTP_CODE="$(printf '%s' "$raw" | tail -n1)"
  BODY="$(printf '%s' "$raw" | sed '$d')"
}

# GET helper: $1 url. Sets HTTP_CODE + BODY.
api_get() {
  local raw; raw="$(curl -s -w $'\n%{http_code}' --max-time 20 "$1" -H "Authorization: Bearer ${TOKEN}")"
  HTTP_CODE="$(printf '%s' "$raw" | tail -n1)"
  BODY="$(printf '%s' "$raw" | sed '$d')"
}

# --- Step 1: token -----------------------------------------------------------
step "Requesting Keycloak token (${DS_USER} @ ${KC_REALM})"
TOKEN="$(curl -s --max-time 20 -X POST \
  "${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token" \
  -d grant_type=password -d "client_id=${KC_CLIENT}" \
  -d "username=${DS_USER}" -d "password=${DS_PASS}" -d scope=openid \
  | jget access_token)"
if [[ -z "${TOKEN}" ]]; then
  fail "Could not obtain a token from ${KC_URL} (realm ${KC_REALM}, user ${DS_USER})."
  warn "Ensure Keycloak is up and the user is bootstrapped (npm run auth:bootstrap)."
  exit 2
fi
ok "got access token"

# --- Step 2: resolve a parent folder ----------------------------------------
step "Resolving a parent folder (POST /connectivity/folders, idempotent default)"
api_post "${BACKEND_URL}/api/v1/connectivity/folders" '{"name":"raw"}' 1
PARENT_RID="$(printf '%s' "$BODY" | jget rid)"
if [[ -z "${PARENT_RID}" ]]; then
  warn "create-folder returned HTTP ${HTTP_CODE}; falling back to GET /connectivity/folders"
  LIST="$(curl -s --max-time 20 "${BACKEND_URL}/api/v1/connectivity/folders" -H "Authorization: Bearer ${TOKEN}")"
  PARENT_RID="$(printf '%s' "$LIST" | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: d={}
items=d.get("items") or []
print(items[0]["rid"] if items else "")')"
fi
if [[ -z "${PARENT_RID}" ]]; then
  fail "Could not resolve a parent folder to create the dataset under."; exit 2
fi
ok "parent folder: ${PARENT_RID}"

# --- Step 3: happy path ------------------------------------------------------
DS_NAME="preview_dataset_$(date +%s)_$$"
step "Create dataset '${DS_NAME}'"
api_post "${BACKEND_URL}/api/v1/datasets" \
  "$(printf '{"parentFolderRid":"%s","name":"%s"}' "${PARENT_RID}" "${DS_NAME}")" 1
assert_eq "create -> HTTP 200" "200" "${HTTP_CODE}"
DS_RID="$(printf '%s' "$BODY" | jget rid)"
assert_match "rid is a Foundry dataset RID" '^ri\.foundry\.main\.dataset\.' "${DS_RID}"
assert_eq "name echoes" "${DS_NAME}" "$(printf '%s' "$BODY" | jget name)"
assert_eq "parentFolderRid echoes" "${PARENT_RID}" "$(printf '%s' "$BODY" | jget parentFolderRid)"

# --- Step 3b: Get Dataset (RID-keyed, app-agnostic) -------------------------
step "Get dataset by RID"
api_get "${BACKEND_URL}/api/v1/datasets/${DS_RID}"
assert_eq "get -> HTTP 200" "200" "${HTTP_CODE}"
assert_eq "get rid echoes" "${DS_RID}" "$(printf '%s' "$BODY" | jget rid)"
assert_eq "get name echoes" "${DS_NAME}" "$(printf '%s' "$BODY" | jget name)"
assert_eq "get parentFolderRid echoes" "${PARENT_RID}" "$(printf '%s' "$BODY" | jget parentFolderRid)"

# --- Step 3c: Dataset Preview (RID-keyed) — empty for a just-created dataset -
step "Preview dataset by RID (no data yet → empty preview)"
api_get "${BACKEND_URL}/api/v1/datasets/${DS_RID}/preview"
assert_eq "preview -> HTTP 200" "200" "${HTTP_CODE}"
assert_eq "preview rid echoes" "${DS_RID}" "$(printf '%s' "$BODY" | jget rid)"
assert_eq "preview totalRows is 0" "0" "$(printf '%s' "$BODY" | jget totalRows)"

# --- Step 3d: Get unknown dataset -> 404 Datasets:DatasetNotFound -----------
step "Get unknown dataset RID"
api_get "${BACKEND_URL}/api/v1/datasets/ri.foundry.main.dataset.00000000-0000-0000-0000-000000000000"
assert_eq "unknown dataset -> HTTP 404" "404" "${HTTP_CODE}"
assert_eq "errorName Datasets:DatasetNotFound" "Datasets:DatasetNotFound" "$(printf '%s' "$BODY" | jget errorName)"

# --- Step 4a: missing name -> 400 Default:InvalidArgument --------------------
step "Negative: missing name"
api_post "${BACKEND_URL}/api/v1/datasets" \
  "$(printf '{"parentFolderRid":"%s"}' "${PARENT_RID}")" 1
assert_eq "missing name -> HTTP 400" "400" "${HTTP_CODE}"
assert_eq "errorName Default:InvalidArgument" "Default:InvalidArgument" "$(printf '%s' "$BODY" | jget errorName)"

# --- Step 4b: unknown folder -> 404 Datasets:FolderNotFound -----------------
step "Negative: unknown parent folder"
api_post "${BACKEND_URL}/api/v1/datasets" \
  '{"parentFolderRid":"ri.compass.main.folder.00000000-0000-0000-0000-000000000000","name":"orphan_ds"}' 1
assert_eq "unknown folder -> HTTP 404" "404" "${HTTP_CODE}"
assert_eq "errorName Datasets:FolderNotFound" "Datasets:FolderNotFound" "$(printf '%s' "$BODY" | jget errorName)"

# --- Step 4c: duplicate name -> 409 Datasets:ResourceNameAlreadyExists -------
step "Negative: duplicate name in the same folder"
api_post "${BACKEND_URL}/api/v1/datasets" \
  "$(printf '{"parentFolderRid":"%s","name":"%s"}' "${PARENT_RID}" "${DS_NAME}")" 1
assert_eq "duplicate -> HTTP 409" "409" "${HTTP_CODE}"
assert_eq "errorName Datasets:ResourceNameAlreadyExists" "Datasets:ResourceNameAlreadyExists" "$(printf '%s' "$BODY" | jget errorName)"

echo
if [[ "${FAIL_N}" -eq 0 ]]; then
  ok "All ${PASS_N} assertions passed."
else
  fail "${FAIL_N} assertion(s) failed (${PASS_N} passed)."; exit 3
fi
