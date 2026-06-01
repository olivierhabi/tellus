#!/usr/bin/env bash
# ===========================================================================
# E2E — Source-Control commit + Tag & Release (production readiness).
#
# Asserts the exact backend paths behind the "Uncommitted changes" panel and
# the TagAndReleaseDialog:
#   A · commit op:"modify" on an existing file, readback, CAS stale→412,
#       mandatory commit message (empty → 400).
#   B · Tag & Release version bumps: publish, dedupe, monotonic (lower→409),
#       backward-incompatibility (drop a function → minor blocked, major ok).
#
# Self-contained: boots its own backend (CODE_REPOS_TEST_AUTH=1) on a port,
# PASS/FAIL summary + exit code. Does not touch :3000.
#   bash scripts/foundry-parity/verify-commit-and-release-e2e.sh
# ===========================================================================
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
PORT="${PORT:-3069}"; BASE="http://localhost:${PORT}/api/v1"; TMP="$(mktemp -d)"
SERVER_PID=""; LOG="$TMP/server.log"
b=$'\033[1m'; g=$'\033[32m'; r=$'\033[31m'; x=$'\033[0m'
PASS=0; FAIL=0
rec(){ if [[ "$1" == ok ]]; then PASS=$((PASS+1)); printf "  ${g}✔${x} %s\n" "$2"; else FAIL=$((FAIL+1)); printf "  ${r}✗ %s${x}\n" "$2"; fi; }
step(){ printf "\n${b}── %s ──${x}\n" "$1"; }
cleanup(){ [[ -n "$SERVER_PID" ]] && { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; }; }
trap cleanup EXIT
AUTH=(-H "X-Tellus-Test-Principal: e2e/editor")
H(){ local m="$1" p="$2"; shift 2; local d=""; if [[ $# -gt 0 && "${1:0:1}" != "-" ]]; then d="$1"; shift; fi
  local e=(); [[ $# -gt 0 ]] && e=("$@"); local a=(-s -o "$TMP/b" -w '%{http_code}' -X "$m" "${AUTH[@]}")
  [[ ${#e[@]} -gt 0 ]] && a+=("${e[@]}"); [[ -n "$d" ]] && a+=(-H 'content-type: application/json' --data "$d")
  HTTP="$(curl "${a[@]}" "${BASE}${p}")"; BODY="$(cat "$TMP/b" 2>/dev/null)"; }
jg(){ printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=(process.argv[1]||"").split(".").reduce((a,k)=>a==null?a:a[k],o);process.stdout.write(v==null?"":typeof v==="object"?JSON.stringify(v):String(v))}catch{process.stdout.write("")}})' "${2:-}"; }
uuid(){ node -e 'console.log(require("crypto").randomUUID())'; }
mkfn(){ printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(Buffer.from(s).toString("base64")))'; }
psql(){ docker compose exec -T postgres psql -U tellus -d tellus_db "$@" 2>/dev/null; }
head_sha(){ psql -c "DELETE FROM code_repository_branch_cache WHERE repository_rid='$1'" >/dev/null 2>&1; H GET "/code-repositories/$1/branches" >/dev/null; printf '%s' "$BODY" | grep -oE '[0-9a-f]{40}' | head -1; }
FN="typescript-functions/src/functions"

step "Boot test backend on :$PORT"
CODE_REPOS_TEST_AUTH=1 PORT="$PORT" NODE_ENV=development TELLUS_DISABLE_CONNECTIVITY_POLLER=1 \
  TEMPORAL_WORKER_DISABLED=true npx tsx src/server.ts >"$LOG" 2>&1 & SERVER_PID=$!
for i in $(seq 1 60); do curl -sf "http://localhost:${PORT}/api/v1/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -20 "$LOG"; echo "server died"; exit 1; }; sleep 1; done
echo "  healthy (pid $SERVER_PID)"

RUN="$(node -e 'console.log(Date.now().toString(36))')"
FOLDER="ri.compass.main.folder.0123abcd-ef01-4345-8789-abcdef012345"
H POST "/code-repositories" '{"displayName":"cr-e2e-'"$RUN"'","parentFolderRid":"'"$FOLDER"'","templateId":"typescript-functions","templateVersion":"2.4.0","defaultBranch":"main"}' -H "Idempotency-Key: $(uuid)"
RID="$(jg "$BODY" rid)"
[[ "$RID" == ri.stemma.main.repository.* ]] && rec ok "repo created" || rec fail "repo create ($BODY)"

# Seed two functions so a release has content + something to drop later.
TIP="$(head_sha "$RID")"
F_A="$(mkfn 'export default function alpha(){ return 1; }')"
F_B="$(mkfn 'export default function beta(){ return 2; }')"
H POST "/code-repositories/$RID/branches/main/commits" '{"message":"seed fns","parentSha":"'"$TIP"'","fileChanges":[{"path":"'"$FN"'/alpha.ts","op":"add","contentBase64":"'"$F_A"'"},{"path":"'"$FN"'/beta.ts","op":"add","contentBase64":"'"$F_B"'"}]}' -H "Idempotency-Key: $(uuid)" -H "If-Match: \"$TIP\""
[[ "$HTTP" == "200" || "$HTTP" == "201" ]] && rec ok "seeded alpha + beta functions" || rec fail "seed → $HTTP"

# ===========================================================================
step "A · Source-Control commit (op:modify) — the 'Uncommitted changes' path"
TIP="$(head_sha "$RID")"
NEW="$(mkfn 'export default function alpha(){ return 42; } // edited via source control')"
H POST "/code-repositories/$RID/branches/main/commits" '{"message":"Edit alpha via source control","fileChanges":[{"path":"'"$FN"'/alpha.ts","op":"modify","contentBase64":"'"$NEW"'"}]}' -H "Idempotency-Key: $(uuid)" -H "If-Match: \"$TIP\""
[[ ( "$HTTP" == "200" || "$HTTP" == "201" ) && "$(jg "$BODY" fileCount)" == "1" ]] && rec ok "commit op:modify → ok (fileCount=1)" || rec fail "modify commit → $HTTP $(printf '%s' "$BODY"|head -c 120)"

H GET "/code-repositories/$RID/branches/main/files?path=$FN/alpha.ts"
printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const c=Buffer.from(o.content,o.encoding==="base64"?"base64":"utf8").toString();process.exit(c.includes("edited via source control")?0:1)}catch{process.exit(1)}})' \
  && rec ok "readback shows the modified content" || rec fail "readback not updated"

# stale parent (CAS) → 412
H POST "/code-repositories/$RID/branches/main/commits" '{"message":"stale","parentSha":"'"$TIP"'","fileChanges":[{"path":"'"$FN"'/beta.ts","op":"modify","contentBase64":"'"$NEW"'"}]}' -H "Idempotency-Key: $(uuid)" -H "If-Match: \"$TIP\""
[[ "$HTTP" == "412" ]] && rec ok "commit on stale parent SHA → 412 (StaleRefHead)" || rec fail "stale commit → $HTTP"

# mandatory commit message — empty → 4xx
TIP="$(head_sha "$RID")"
H POST "/code-repositories/$RID/branches/main/commits" '{"message":"","parentSha":"'"$TIP"'","fileChanges":[{"path":"'"$FN"'/beta.ts","op":"modify","contentBase64":"'"$NEW"'"}]}' -H "Idempotency-Key: $(uuid)" -H "If-Match: \"$TIP\""
[[ "$HTTP" == "400" || "$HTTP" == "422" ]] && rec ok "empty commit message rejected → $HTTP (message mandatory)" || rec fail "empty message → $HTTP"

# ===========================================================================
step "B · Tag & Release version bumps (TagAndReleaseDialog backend path)"
H POST "/code-repositories/$RID/tags" '{"semver":"1.0.0","branch":"main"}' -H "Idempotency-Key: $(uuid)"
NPUB="$(jg "$BODY" functions | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).length))}catch{process.stdout.write("0")}})')"
[[ "$HTTP" == "201" && "$NPUB" -ge 2 ]] && rec ok "patch release v1.0.0 → 201 ($NPUB functions published)" || rec fail "tag 1.0.0 → $HTTP funcs=$NPUB"

H POST "/code-repositories/$RID/tags" '{"semver":"1.0.0","branch":"main"}' -H "Idempotency-Key: $(uuid)"
[[ "$HTTP" == "200" ]] && rec ok "re-release identical v1.0.0 → 200 dedupe (immutable)" || rec fail "re-tag 1.0.0 → $HTTP"

H POST "/code-repositories/$RID/tags" '{"semver":"0.9.0","branch":"main"}' -H "Idempotency-Key: $(uuid)"
[[ "$HTTP" == "409" ]] && rec ok "lower version v0.9.0 → 409 (monotonic SemVer)" || rec fail "lower → $HTTP"

# minor bump with the SAME functions → 201 (backward compatible)
H POST "/code-repositories/$RID/tags" '{"semver":"1.1.0","branch":"main"}' -H "Idempotency-Key: $(uuid)"
[[ "$HTTP" == "201" ]] && rec ok "minor bump v1.1.0 (no fn removed) → 201" || rec fail "minor 1.1.0 → $HTTP"

# drop a function (delete beta), then a minor bump must be BLOCKED, major OK.
TIP="$(head_sha "$RID")"
H POST "/code-repositories/$RID/branches/main/commits" '{"message":"drop beta","parentSha":"'"$TIP"'","fileChanges":[{"path":"'"$FN"'/beta.ts","op":"delete"}]}' -H "Idempotency-Key: $(uuid)" -H "If-Match: \"$TIP\""
[[ "$HTTP" == "200" || "$HTTP" == "201" ]] && rec ok "commit op:delete (drop beta)" || rec fail "delete commit → $HTTP"

H POST "/code-repositories/$RID/tags" '{"semver":"1.2.0","branch":"main"}' -H "Idempotency-Key: $(uuid)"
[[ "$HTTP" == "409" && "$(jg "$BODY" errorName)" == "CodeRepos:BackwardIncompatible" ]] && rec ok "dropping beta + minor bump → 409 BackwardIncompatible" || rec fail "backward-incompat → $HTTP $(jg "$BODY" errorName)"

H POST "/code-repositories/$RID/tags" '{"semver":"2.0.0","branch":"main"}' -H "Idempotency-Key: $(uuid)"
[[ "$HTTP" == "201" ]] && rec ok "same drop + major bump v2.0.0 → 201 (breaking change allowed)" || rec fail "major 2.0.0 → $HTTP"

H GET "/functions/$RID/resolve?versionTarget=%5E1.0.0&branch=main&defaultBranch=main"
[[ "$HTTP" == "200" && "$(jg "$BODY" semver)" == "1.1.0" ]] && rec ok "caret resolve ^1.0.0 → 1.1.0 (max satisfying)" || rec fail "resolve → $HTTP $(jg "$BODY" semver)"

step "SUMMARY"
printf "  ${g}PASS=%d${x}  ${r}FAIL=%d${x}\n" "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
