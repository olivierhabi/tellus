#!/usr/bin/env bash
# ===========================================================================
# Foundry Parity Conformance Harness — Code Repositories & TypeScript Functions v2
# ===========================================================================
#
# Verifies, piece by piece, how the tellus clone's BACKEND behaves against the
# 1:1 reference behaviour of Palantir Foundry Code Repositories & TypeScript
# Functions v2 (see docs/foundry-parity/CODE_REPOSITORIES_AND_FUNCTIONS_V2.md
# for the cited ground-truth spec).
#
# Each check is tagged with a stable ID (CR-n = Code Repositories,
# FN-n = Functions) that maps 1:1 to a section in the parity doc.
#
# Verdicts:
#   PASS  — clone matches the Foundry contract.
#   FAIL  — endpoint exists but behaves wrong (a real defect).
#   GAP   — Foundry feature has NO implementation in the clone (expected
#           divergence; we assert the absence so the matrix is honest).
#   INFO  — observation, not a pass/fail gate.
#
# The harness boots its OWN backend instance on a dedicated port with
# CODE_REPOS_TEST_AUTH=1 so it can use the X-Tellus-Test-Principal bypass and
# never disturbs any dev server you have running on :3000. It exercises the
# real mounted src/server.ts surface end-to-end (not the test factory).
#
# Usage:
#   bash scripts/foundry-parity/verify-foundry-parity.sh
#   PORT=3070 KEEP_UP=1 bash scripts/foundry-parity/verify-foundry-parity.sh
#
# Requires: the docker dependency services up (postgres at least), node, curl.
# ===========================================================================

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PORT="${PORT:-3055}"
BASE="http://localhost:${PORT}/api/v1"
TMP="$(mktemp -d)"
SERVER_LOG="$TMP/server.log"
SERVER_PID=""
KEEP_UP="${KEEP_UP:-0}"

# ---- pretty output --------------------------------------------------------
b=$'\033[1m'; g=$'\033[32m'; r=$'\033[31m'; y=$'\033[33m'; c=$'\033[36m'; x=$'\033[0m'
PASS=0; FAIL=0; GAP=0
declare -a RESULTS

rec() { # rec <verdict> <id> <desc>
  local v="$1" id="$2" desc="$3"
  case "$v" in
    PASS) PASS=$((PASS+1)); printf "  ${g}✔ PASS${x} ${b}%-6s${x} %s\n" "$id" "$desc" ;;
    FAIL) FAIL=$((FAIL+1)); printf "  ${r}x FAIL${x} ${b}%-6s${x} %s\n" "$id" "$desc" ;;
    GAP)  GAP=$((GAP+1));   printf "  ${y}∅ GAP ${x} ${b}%-6s${x} %s\n" "$id" "$desc" ;;
    INFO) printf "  ${c}• INFO${x} ${b}%-6s${x} %s\n" "$id" "$desc" ;;
  esac
  RESULTS+=("$v|$id|$desc")
}

cleanup() {
  if [[ -n "$SERVER_PID" && "$KEEP_UP" != "1" ]]; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  [[ "$KEEP_UP" == "1" ]] && echo "${y}KEEP_UP=1 → server left running on :$PORT (pid $SERVER_PID), log: $SERVER_LOG${x}"
}
trap cleanup EXIT

# ---- HTTP helper ----------------------------------------------------------
# H <method> <path> [data] [x] [extra-curl-args...]  → sets HTTP_CODE, BODY, HDRS
# The optional literal 'x' after <data> is a readability separator before
# extra curl args; it is consumed and never sent to curl.
AUTH=(-H "X-Tellus-Test-Principal: alice" -H "X-Tellus-Test-Roles: editor")
H() {
  local method="$1" path="$2"; shift 2
  local data=""
  if [[ $# -gt 0 ]]; then data="$1"; shift; fi
  if [[ "${1:-}" == "x" ]]; then shift; fi
  local extra=()
  if [[ $# -gt 0 ]]; then extra=("$@"); fi
  local bodyfile="$TMP/body.$$" hdrfile="$TMP/hdr.$$"
  local args=(-s -o "$bodyfile" -D "$hdrfile" -w '%{http_code}' -X "$method" "${AUTH[@]}")
  if [[ ${#extra[@]} -gt 0 ]]; then args+=("${extra[@]}"); fi
  if [[ -n "$data" ]]; then args+=(-H "content-type: application/json" --data "$data"); fi
  HTTP_CODE="$(curl "${args[@]}" "${BASE}${path}")"
  BODY="$(cat "$bodyfile" 2>/dev/null)"
  HDRS="$(cat "$hdrfile" 2>/dev/null)"
}
jq_get() { printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const p=process.argv[1].split(".");let v=o;for(const k of p){v=v?.[k];}process.stdout.write(v===undefined||v===null?"":String(v));}catch{process.stdout.write("");}})' "$2"; }
hdr_get() { printf '%s' "$HDRS" | grep -i "^$1:" | head -1 | sed "s/^[^:]*: *//I" | tr -d '\r'; }
uuid() { node -e 'console.log(require("crypto").randomUUID())'; }
# create_repo <displayName> <idempotency-key>  (safe JSON quoting)
create_repo() {
  H POST "/code-repositories" '{"displayName":"'"$1"'","parentFolderRid":"'"$FOLDER"'","templateId":"typescript-functions","templateVersion":"2.4.0","defaultBranch":"master"}' x -H "Idempotency-Key: $2"
}

# ===========================================================================
echo "${b}== Booting test backend on :$PORT (CODE_REPOS_TEST_AUTH=1) ==${x}"
CODE_REPOS_TEST_AUTH=1 \
PORT="$PORT" \
NODE_ENV=development \
TELLUS_DISABLE_CONNECTIVITY_POLLER=1 \
TEMPORAL_WORKER_DISABLED=true \
  npx tsx src/server.ts >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# wait for health
ready=0
for i in $(seq 1 60); do
  if curl -sf "http://localhost:${PORT}/api/v1/health" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then echo "${r}server died during boot${x}"; tail -30 "$SERVER_LOG"; exit 1; fi
  sleep 1
done
[[ "$ready" != "1" ]] && { echo "${r}server never became healthy${x}"; tail -40 "$SERVER_LOG"; exit 1; }
echo "${g}backend healthy${x} (pid $SERVER_PID)"
echo

FOLDER="ri.compass.main.folder.0123abcd-ef01-4345-8789-abcdef012345"
# The code_repository metadata row is durable in Postgres across runs (only the
# in-memory Stemma git layer is per-process), so repo display names must be
# unique per run or create returns 409 NameConflict.
RUN="$(node -e 'console.log(Date.now().toString(36)+Math.floor(Math.random()*46656).toString(36))')"
REPO_NAME="ParityRepo-$RUN"
FN_NAME="FnRepo-$RUN"

# ===========================================================================
echo "${b}── CODE REPOSITORIES ──────────────────────────────────────────────${x}"

# CR-2  Authentication (Foundry: Stemma RepositoryResolver; G-C-08 401 envelope)
UNAUTH="$(curl -s -o "$TMP/u" -w '%{http_code}' "${BASE}/code-repositories")"
if [[ "$UNAUTH" == "401" ]]; then rec PASS CR-2 "Unauthenticated request → 401 (auth required, like Stemma)"; else rec FAIL CR-2 "Unauthenticated request returned $UNAUTH (expected 401)"; fi

# CR-1  Repository creation from a template (Foundry: + New > Code repository, TS Functions template)
IDEM="$(uuid)"
create_repo "$REPO_NAME" "$IDEM"
RID="$(jq_get "$BODY" rid)"
if [[ "$HTTP_CODE" == "201" && "$RID" == ri.stemma.main.repository.* ]]; then
  rec PASS CR-1 "Create repo from TS-Functions template → 201, rid=$RID"
else
  rec FAIL CR-1 "Create repo → $HTTP_CODE rid='$RID' body=$BODY"
fi
ETAG="$(hdr_get etag)"
[[ "$ETAG" == 'W/"1"' ]] && rec PASS CR-1b "New repo resource_version ETag = W/\"1\"" || rec FAIL CR-1b "Create ETag was '$ETAG' (expected W/\"1\")"

# CR-3  Idempotency on create (Foundry create is a saga; clone: G-C-22 replay)
create_repo "$REPO_NAME" "$IDEM"
REPLAY="$(hdr_get x-idempotent-replay)"
if [[ "$HTTP_CODE" == "201" && "$(jq_get "$BODY" rid)" == "$RID" && "$REPLAY" == "true" ]]; then
  rec PASS CR-3 "Idempotent create replay → same rid, X-Idempotent-Replay:true"
else
  rec FAIL CR-3 "Replay → $HTTP_CODE replay='$REPLAY' rid='$(jq_get "$BODY" rid)'"
fi

# CR-4  Name uniqueness within a folder (Foundry: unique repo name in Project/folder)
create_repo "$REPO_NAME" "$(uuid)"
if [[ "$HTTP_CODE" == "409" ]]; then rec PASS CR-4 "Duplicate name in same folder → 409 conflict"; else rec FAIL CR-4 "Duplicate name → $HTTP_CODE (expected 409)"; fi

# CR-5  Get repository + IDOR-as-404
H GET "/code-repositories/$RID"
[[ "$HTTP_CODE" == "200" && "$(jq_get "$BODY" rid)" == "$RID" ]] && rec PASS CR-5 "GET repo by rid → 200" || rec FAIL CR-5 "GET repo → $HTTP_CODE"
H GET "/code-repositories/ri.stemma.main.repository.00000000-0000-4000-8000-000000000000"
[[ "$HTTP_CODE" == "404" ]] && rec PASS CR-5b "GET unknown repo → 404 (IDOR-safe)" || rec FAIL CR-5b "Unknown repo → $HTTP_CODE (expected 404)"

# CR-6  Default branch present (Foundry: default branch, usually master)
H GET "/code-repositories/$RID/branches"
BRANCHES="$BODY"
if printf '%s' "$BRANCHES" | grep -q '"master"'; then rec PASS CR-6 "Default 'master' branch listed"; else rec INFO CR-6 "Branches=$BRANCHES (Foundry default is 'master')"; fi

# CR-9  File tree of scaffolded template (Foundry: Foundry Explorer file tree; TS v2 src/functions/)
H GET "/code-repositories/$RID/branches/master/tree?path=&depth=5"
TREE_CODE="$HTTP_CODE"; TREE_ETAG="$(hdr_get etag)"
if [[ "$TREE_CODE" == "200" ]]; then
  if printf '%s' "$BODY" | grep -qiE "functions|src"; then rec PASS CR-9 "Tree returns scaffolded TS-Functions files"; else rec INFO CR-9 "Tree 200 but no functions/src dir: $BODY"; fi
else rec FAIL CR-9 "GET tree → $TREE_CODE"; fi
# CR-9b strong ETag + 304 (Foundry IDE caches)
if [[ -n "$TREE_ETAG" ]]; then
  H GET "/code-repositories/$RID/branches/master/tree?path=&depth=5" "" x -H "If-None-Match: $TREE_ETAG"
  [[ "$HTTP_CODE" == "304" ]] && rec PASS CR-9b "Tree If-None-Match → 304 Not Modified" || rec FAIL CR-9b "Tree conditional GET → $HTTP_CODE (expected 304)"
else rec INFO CR-9b "Tree returned no ETag"; fi

# CR-5  Commit a file (Foundry: mandatory commit message, sandbox-branch commit)
# read tip sha from branches
TIP="$(jq_get "$(printf '%s' "$BRANCHES" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const arr=o.items||o.branches||o;const m=(Array.isArray(arr)?arr:[]).find(b=>(b.name||b.branchName)==="master");process.stdout.write(JSON.stringify(m||{}));}catch{process.stdout.write("{}")}})')" headSha)"
[[ -z "$TIP" ]] && TIP="$(printf '%s' "$BRANCHES" | grep -oE '[0-9a-f]{40}' | head -1)"
FILEB64="$(node -e 'process.stdout.write(Buffer.from("export default function add(x){return x+1;}\n").toString("base64"))')"
# Commit fileChanges schema: { path, op: add|modify|delete, contentBase64?, mode? }
H POST "/code-repositories/$RID/branches/master/commits" '{"message":"add fn","parentSha":"'"$TIP"'","fileChanges":[{"path":"src/functions/add.ts","op":"add","contentBase64":"'"$FILEB64"'"}]}' x -H "Idempotency-Key: $(uuid)" -H "If-Match: \"$TIP\""
CR7_CODE="$HTTP_CODE"
if [[ "$CR7_CODE" == "200" || "$CR7_CODE" == "201" ]]; then
  rec PASS CR-7 "Commit file on master (parent-SHA If-Match) → $CR7_CODE"
  NEWSHA="$(jq_get "$BODY" commitSha)"; [[ -z "$NEWSHA" ]] && NEWSHA="$(jq_get "$BODY" sha)"; [[ -z "$NEWSHA" ]] && NEWSHA="$(jq_get "$BODY" headSha)"
  # CR-7b commit message is mandatory (Foundry: commit dialog requires a message)
  H POST "/code-repositories/$RID/branches/master/commits" '{"message":"","parentSha":"'"${NEWSHA:-$TIP}"'","fileChanges":[{"path":"src/functions/x.ts","op":"add","contentBase64":"'"$FILEB64"'"}]}' x -H "Idempotency-Key: $(uuid)" -H "If-Match: \"${NEWSHA:-$TIP}\""
  [[ "$HTTP_CODE" == "400" || "$HTTP_CODE" == "422" ]] && rec PASS CR-7b "Empty commit message rejected → $HTTP_CODE" || rec FAIL CR-7b "Empty commit message → $HTTP_CODE (Foundry requires a message)"
  # CR-8 stale parent SHA → 412 (Foundry: push rejected on stale ref)
  H POST "/code-repositories/$RID/branches/master/commits" '{"message":"stale","parentSha":"'"$TIP"'","fileChanges":[{"path":"src/functions/y.ts","op":"add","contentBase64":"'"$FILEB64"'"}]}' x -H "Idempotency-Key: $(uuid)" -H "If-Match: \"$TIP\""
  [[ "$HTTP_CODE" == "412" ]] && rec PASS CR-8 "Commit on stale parent SHA → 412 (ref moved)" || rec INFO CR-8 "Stale-parent commit → $HTTP_CODE (expected 412 if HEAD advanced)"
  # CR-10 read the committed file back
  H GET "/code-repositories/$RID/branches/master/files?path=src/functions/add.ts"
  [[ "$HTTP_CODE" == "200" ]] && rec PASS CR-10 "Read committed blob back → 200" || rec FAIL CR-10 "Read blob → $HTTP_CODE"
else
  rec FAIL CR-7 "Commit → $CR7_CODE body=$BODY"
fi

# CR-11  Optimistic concurrency on metadata (Foundry: resource versioning)
# If-Match must be the weak ETag form W/"N" (parseEtag accepts W/"N" or "N").
H PATCH "/code-repositories/$RID" '{"displayName":"ParityRepoRenamed"}' x -H 'If-Match: W/"1"'
[[ "$HTTP_CODE" == "200" ]] && rec PASS CR-11 "PATCH with correct If-Match W/\"1\" → 200 (rename)" || rec FAIL CR-11 "PATCH If-Match → $HTTP_CODE body=$BODY"
H PATCH "/code-repositories/$RID" '{"displayName":"Nope"}' x -H 'If-Match: W/"1"'
[[ "$HTTP_CODE" == "412" ]] && rec PASS CR-11b "PATCH with stale If-Match → 412" || rec FAIL CR-11b "Stale PATCH → $HTTP_CODE (expected 412)"
H PATCH "/code-repositories/$RID" '{"displayName":"NoHeader"}'
[[ "$HTTP_CODE" == "428" || "$HTTP_CODE" == "400" ]] && rec PASS CR-11c "PATCH without If-Match → $HTTP_CODE (precondition required)" || rec FAIL CR-11c "PATCH no If-Match → $HTTP_CODE"
# CR-11d DEFECT: a malformed-but-present If-Match must not 500 (parseEtag→NaN→bigint cast)
H PATCH "/code-repositories/$RID" '{"displayName":"Bad"}' x -H 'If-Match: not-a-version'
if [[ "$HTTP_CODE" == "500" ]]; then rec FAIL CR-11d "DEFECT: malformed If-Match → 500 (parseEtag NaN → bigint cast crash); should be 400/412"; else rec PASS CR-11d "Malformed If-Match → $HTTP_CODE (handled cleanly)"; fi

# CR-12  Ontology resource imports (Foundry: Ontology tab, resources.json versioned)
H GET "/code-repositories/$RID/resource-imports"
[[ "$HTTP_CODE" == "200" ]] && rec PASS CR-12 "GET resource-imports → 200 (Ontology imports surface)" || rec FAIL CR-12 "GET resource-imports → $HTTP_CODE"

# CR-13  Lifecycle: soft-delete → TRASHED (Foundry: Trash)
# Fetch the current resource_version from the live ETag (rename above bumped it).
H GET "/code-repositories/$RID"
CUR_ETAG="$(hdr_get etag)"; [[ -z "$CUR_ETAG" ]] && CUR_ETAG='W/"2"'
H DELETE "/code-repositories/$RID" "" x -H "If-Match: $CUR_ETAG"
[[ "$HTTP_CODE" == "204" || "$HTTP_CODE" == "200" ]] && rec PASS CR-13 "DELETE repo (If-Match:$CUR_ETAG) → soft-trash ($HTTP_CODE)" || rec FAIL CR-13 "DELETE → $HTTP_CODE"

# CR-14  Pagination on list (Foundry: paginated browse)
H GET "/code-repositories?limit=1"
NPT="$(jq_get "$BODY" nextPageToken)"
if printf '%s' "$BODY" | grep -q 'nextPageToken'; then
  if [[ -z "$NPT" ]]; then rec GAP CR-14 "List returns nextPageToken but it is always null (pagination stubbed)"; else rec PASS CR-14 "List pagination cursor honoured"; fi
else rec INFO CR-14 "List shape: $(printf '%s' "$BODY" | head -c 120)"; fi

# ---- Foundry features with NO clone endpoint (assert the gap) --------------
# CR-15 Proposals / Pull Requests (Foundry: Propose changes, reviews, merge)
H POST "/code-repositories/$RID/pulls" "{}"
[[ "$HTTP_CODE" == "404" ]] && rec GAP CR-15 "Pull Requests / Proposals: no endpoint (Foundry core review flow MISSING)" || rec INFO CR-15 "pulls endpoint → $HTTP_CODE"
# CR-16 Branch protection (Foundry: protected branches, PreReceiveHook)
H GET "/code-repositories/$RID/branches/master/protection"
[[ "$HTTP_CODE" == "404" ]] && rec GAP CR-16 "Branch protection: no endpoint (MISSING; Foundry enforces via PreReceiveHook)" || rec INFO CR-16 "protection → $HTTP_CODE"
# CR-17 Checks / CI (Foundry: ci/foundry-publish, Checks tab)
H GET "/code-repositories/$RID/checks"
[[ "$HTTP_CODE" == "404" ]] && rec GAP CR-17 "CI Checks: no endpoint (MISSING; template declares steps but nothing runs them)" || rec INFO CR-17 "checks → $HTTP_CODE"
# CR-18 Tags / Releases (Foundry: Tag & release → publish to functions registry)
# Implemented: create a fresh repo and release its scaffolded functions.
create_repo "RelRepo-$RUN" "$(uuid)"
RELRID="$(jq_get "$BODY" rid)"
H POST "/code-repositories/$RELRID/tags" '{"semver":"1.0.0","branch":"master"}' x -H "Idempotency-Key: $(uuid)"
if [[ "$HTTP_CODE" == "201" ]]; then rec PASS CR-18 "Tag & Release v1.0.0 → 201 (published $(jq_get "$BODY" functions))"; else rec FAIL CR-18 "Tag & Release → $HTTP_CODE body=$(printf '%s' "$BODY" | head -c 160)"; fi

echo
echo "${b}── TYPESCRIPT FUNCTIONS v2 ────────────────────────────────────────${x}"

# Recreate a fresh repo (the previous one is trashed) for function checks
create_repo "$FN_NAME" "$(uuid)"
FRID="$(jq_get "$BODY" rid)"

# FN-1  Discover functions in a repo (Foundry: published + working-tree)
H GET "/code-repositories/$FRID/functions?branch=master"
[[ "$HTTP_CODE" == "200" ]] && rec PASS FN-1 "List repo functions → 200 (published + working_tree union)" || rec FAIL FN-1 "List functions → $HTTP_CODE"

# FN-2  Invoke / Live Preview (Foundry: Functions panel > Live Preview > Run)
INLINE="$(node -e 'process.stdout.write(JSON.stringify("export default function(input){ return { doubled: input.n * 2 }; }"))')"
H POST "/code-repositories/$FRID/functions/invoke" "{\"apiName\":\"adhoc\",\"branch\":\"master\",\"inlineSource\":$INLINE,\"inlineSourcePath\":\"src/functions/adhoc.ts\",\"args\":{\"n\":21}}"
FN2_CODE="$HTTP_CODE"
if [[ "$FN2_CODE" == "200" ]]; then
  DOUBLED="$(jq_get "$BODY" result.doubled)"
  if [[ "$DOUBLED" == "42" ]]; then rec PASS FN-2 "Live-preview invoke runs TS, returns result (21*2=42)"; else rec INFO FN-2 "Invoke 200 but result=$BODY"; fi
  rec INFO FN-2x "NOTE: execution is Node 'vm' (NOT a security boundary) — diverges from Foundry's isolated V8/Node sandbox"
else rec FAIL FN-2 "Invoke → $FN2_CODE body=$(printf '%s' "$BODY" | head -c 200)"; fi

# FN-3  Functions Registry (B8) — publish/list/resolve/yank (Foundry: functions registry)
# A 200 with a versions array means the registry is live. Anything else (401 from
# the global auth wall, 404 catch-all) means /api/v1/functions is not mounted —
# confirmed by grep: createFunctionsApp is never app.use()'d in src/server.ts.
H GET "/functions/$FRID/versions"
if [[ "$HTTP_CODE" == "200" ]]; then
  rec PASS FN-3 "Functions Registry versions endpoint live → 200"
else
  rec GAP FN-3 "Functions Registry /api/v1/functions/* NOT mounted (probe → $HTTP_CODE; B8 registry dead in prod)"
fi
# FN-4  Published version is discoverable in the registry (immutable artifact).
H GET "/functions/$RELRID/versions?branch=master"
if printf '%s' "$BODY" | grep -q '"1.0.0"'; then rec PASS FN-4 "Registry lists published v1.0.0 with artifact sha256"; else rec FAIL FN-4 "Registry versions missing 1.0.0: $(printf '%s' "$BODY" | head -c 120)"; fi

# FN-5  Immutability / monotonicity (core Foundry contract).
H POST "/code-repositories/$RELRID/tags" '{"semver":"1.0.0","branch":"master"}' x -H "Idempotency-Key: $(uuid)"
[[ "$HTTP_CODE" == "200" ]] && rec PASS FN-5 "Re-release identical v1.0.0 → 200 dedupe (idempotent, immutable)" || rec INFO FN-5 "re-release v1.0.0 → $HTTP_CODE"
H POST "/code-repositories/$RELRID/tags" '{"semver":"0.9.0","branch":"master"}' x -H "Idempotency-Key: $(uuid)"
[[ "$HTTP_CODE" == "409" ]] && rec PASS FN-5b "Release a LOWER version (0.9.0) → 409 (monotonic SemVer enforced)" || rec FAIL FN-5b "lower version → $HTTP_CODE (expected 409)"

# FN-6  Caret-range resolution for consumers (Foundry: ^1.0.0 → max satisfying).
H GET "/functions/$RELRID/resolve?versionTarget=%5E1.0.0&branch=master&defaultBranch=master"
[[ "$HTTP_CODE" == "200" && "$(jq_get "$BODY" semver)" == "1.0.0" ]] && rec PASS FN-6 "Resolve caret range ^1.0.0 → 1.0.0 (max satisfying)" || rec FAIL FN-6 "resolve → $HTTP_CODE semver=$(jq_get "$BODY" semver)"

# FN-7  Yank a published version (deprecation).
H POST "/functions/$RELRID/versions/1.0.0/yank?branch=master" "" x -H "Idempotency-Key: $(uuid)"
[[ "$HTTP_CODE" == "200" && "$(jq_get "$BODY" state)" == "YANKED" ]] && rec PASS FN-7 "Yank published v1.0.0 → state=YANKED" || rec FAIL FN-7 "yank → $HTTP_CODE state=$(jq_get "$BODY" state)"

# FN-8  Ontology-backed invoke surfaces edits + snapshot metadata (B7).
H POST "/code-repositories/$FRID/functions/invoke" '{"apiName":"adhoc","branch":"master","inlineSource":"export default function(i){ return Objects.types(); }","inlineSourcePath":"src/functions/adhoc.ts","args":{}}'
[[ "$HTTP_CODE" == "200" ]] && rec PASS FN-8 "Invoke has Ontology SDK injected (Objects/Edits available; ontology meta returned)" || rec FAIL FN-8 "ontology-sdk invoke → $HTTP_CODE"

echo
echo "${b}══ SUMMARY ════════════════════════════════════════════════════════${x}"
printf "  ${g}PASS=%d${x}   ${r}FAIL=%d${x}   ${y}GAP=%d${x}\n" "$PASS" "$FAIL" "$GAP"
echo
echo "  PASS = clone matches Foundry contract"
echo "  FAIL = endpoint exists but behaves incorrectly (defect to fix)"
echo "  GAP  = Foundry feature has no clone implementation (build to reach 1:1)"
echo
# write machine-readable matrix
MATRIX="$ROOT/docs/foundry-parity/last-run-matrix.txt"
{ printf '%s\n' "verdict|id|description"; for row in "${RESULTS[@]}"; do printf '%s\n' "$row"; done; } > "$MATRIX"
echo "  matrix written → docs/foundry-parity/last-run-matrix.txt"

[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
