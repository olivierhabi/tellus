#!/usr/bin/env bash
# ===========================================================================
# E2E — Branch lifecycle + TypeScript v2 Ontology Edits (production readiness).
#
# Self-contained: boots its OWN backend (CODE_REPOS_TEST_AUTH=1) on a dedicated
# port, seeds a tiny ontology, and ASSERTS every behaviour with a PASS/FAIL
# summary + exit code (0 = all pass). Does not touch any dev server on :3000.
#
#   bash scripts/foundry-parity/verify-branches-and-edits-e2e.sh
# ===========================================================================
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
PORT="${PORT:-3066}"; BASE="http://localhost:${PORT}/api/v1"; TMP="$(mktemp -d)"
SERVER_PID=""; LOG="$TMP/server.log"
b=$'\033[1m'; g=$'\033[32m'; r=$'\033[31m'; c=$'\033[36m'; y=$'\033[33m'; x=$'\033[0m'
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
rg(){ printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);let v=o.result;if(typeof v==="string")v=JSON.parse(v);process.stdout.write(JSON.stringify(v))}catch{process.stdout.write("")}})'; }
uuid(){ node -e 'console.log(require("crypto").randomUUID())'; }
mkfn(){ printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(Buffer.from(s).toString("base64")))'; }
psql(){ docker compose exec -T postgres psql -U tellus -d tellus_db "$@" 2>/dev/null; }

step "Boot test backend on :$PORT"
CODE_REPOS_TEST_AUTH=1 PORT="$PORT" NODE_ENV=development TELLUS_DISABLE_CONNECTIVITY_POLLER=1 \
  TEMPORAL_WORKER_DISABLED=true npx tsx src/server.ts >"$LOG" 2>&1 & SERVER_PID=$!
for i in $(seq 1 60); do curl -sf "http://localhost:${PORT}/api/v1/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -20 "$LOG"; echo "server died"; exit 1; }; sleep 1; done
echo "  healthy (pid $SERVER_PID)"

RUN="$(node -e 'console.log(Date.now().toString(36))')"
FOLDER="ri.compass.main.folder.0123abcd-ef01-4345-8789-abcdef012345"
mkrepo(){ H POST "/code-repositories" '{"displayName":"'"$1"'","parentFolderRid":"'"$FOLDER"'","templateId":"typescript-functions","templateVersion":"2.4.0","defaultBranch":"main"}' -H "Idempotency-Key: $(uuid)"; jg "$BODY" rid; }
head_sha(){ psql -c "DELETE FROM code_repository_branch_cache WHERE repository_rid='$1'" >/dev/null 2>&1; H GET "/code-repositories/$1/branches" >/dev/null; printf '%s' "$BODY" | grep -oE '[0-9a-f]{40}' | head -1; }

# ===========================================================================
step "A · Branch lifecycle"
RID="$(mkrepo "be2e-$RUN")"
[[ "$RID" == ri.stemma.main.repository.* ]] && rec ok "repo created" || rec fail "repo create ($BODY)"

H POST "/code-repositories/$RID/branches" '{"name":"feat/e2e","fromBranch":"main"}' -H "Idempotency-Key: $(uuid)"
[[ "$HTTP" == "201" && "$(jg "$BODY" name)" == "feat/e2e" ]] && rec ok "POST create branch (fork main) → 201" || rec fail "create branch → $HTTP $BODY"

H GET "/code-repositories/$RID/branches"
printf '%s' "$BODY" | grep -q '"feat/e2e"' && printf '%s' "$BODY" | grep -q '"main"' && rec ok "GET branches lists main + feat/e2e" || rec fail "branch list"

H GET "/code-repositories/$RID/branches/feat%2Fe2e/tree?path=typescript-functions/src/functions&depth=2"
printf '%s' "$BODY" | grep -q "helloWorld.ts" && rec ok "forked branch has the scaffold content (helloWorld.ts)" || rec fail "fork content"

# commit to feat/e2e only; main must be unaffected
TIP="$(head_sha "$RID")"
FB="$(mkfn "export default ()=>1;")"
H POST "/code-repositories/$RID/branches/feat%2Fe2e/commits" '{"message":"branch-only","parentSha":"'"$TIP"'","fileChanges":[{"path":"typescript-functions/src/functions/branchOnly.ts","op":"add","contentBase64":"'"$FB"'"}]}' -H "Idempotency-Key: $(uuid)" -H "If-Match: \"$TIP\""
COMMIT_OK="$HTTP"
H GET "/code-repositories/$RID/branches/feat%2Fe2e/tree?path=typescript-functions/src/functions&depth=2"; HAS_FEAT=$(printf '%s' "$BODY" | grep -c "branchOnly.ts")
H GET "/code-repositories/$RID/branches/main/tree?path=typescript-functions/src/functions&depth=2"; HAS_MAIN=$(printf '%s' "$BODY" | grep -c "branchOnly.ts")
[[ ( "$COMMIT_OK" == "200" || "$COMMIT_OK" == "201" ) && "$HAS_FEAT" -ge 1 && "$HAS_MAIN" -eq 0 ]] && rec ok "commit on feat/e2e is isolated (present on branch, absent on main)" || rec fail "branch isolation (commit=$COMMIT_OK feat=$HAS_FEAT main=$HAS_MAIN)"

H POST "/code-repositories/$RID/branches" '{"name":"feat/e2e"}' -H "Idempotency-Key: $(uuid)"
[[ "$HTTP" == "409" && "$(jg "$BODY" errorName)" == "CodeRepos:BranchExists" ]] && rec ok "duplicate branch → 409 BranchExists" || rec fail "duplicate → $HTTP"

H POST "/code-repositories/$RID/branches" '{"name":"feat/x","fromBranch":"ghost"}' -H "Idempotency-Key: $(uuid)"
[[ "$HTTP" == "404" ]] && rec ok "unknown source branch → 404" || rec fail "bad source → $HTTP"

H POST "/code-repositories/$RID/branches" '{"name":"../evil"}' -H "Idempotency-Key: $(uuid)"
[[ "$HTTP" == "400" ]] && rec ok "invalid branch name → 400" || rec fail "invalid name → $HTTP"

H DELETE "/code-repositories/$RID/branches/main"
[[ "$HTTP" == "412" && "$(jg "$BODY" errorName)" == "CodeRepos:CannotModifyDefaultBranch" ]] && rec ok "DELETE default branch → 412" || rec fail "delete default → $HTTP"

H DELETE "/code-repositories/$RID/branches/feat%2Fe2e"
[[ "$HTTP" == "204" ]] && rec ok "DELETE feat/e2e → 204" || rec fail "delete → $HTTP"
H DELETE "/code-repositories/$RID/branches/feat%2Fe2e"
[[ "$HTTP" == "404" ]] && rec ok "DELETE again → 404" || rec fail "re-delete → $HTTP"

# ===========================================================================
step "B · TypeScript v2 Ontology Edits"
ONT="$(uuid)"   # a valid v4 UUID for the seeded e2e ontology
# seed a tiny ontology with 3 Widget instances
psql -v ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO ontology (ontology_id, display_name, description) VALUES ('$ONT','E2E Edits $RUN','e2e') ON CONFLICT (ontology_id) DO NOTHING;
INSERT INTO ontology_branch (branch_id, ontology_id, name) VALUES ('$ONT','$ONT','main') ON CONFLICT (branch_id) DO NOTHING;
DELETE FROM object_instances WHERE ontology_id='$ONT';
INSERT INTO object_instances (ontology_id, branch_id, object_type_api_name, primary_key, properties) VALUES
('$ONT','$ONT','Widget','W1','{"name":"Alpha","status":"open","price":"100"}'),
('$ONT','$ONT','Widget','W2','{"name":"Beta","status":"open","price":"200"}'),
('$ONT','$ONT','Widget','W3','{"name":"Alpha","status":"open","price":"50"}');
SQL
REPO2="$(mkrepo "be2e-edits-$RUN")"
psql >/dev/null <<SQL
INSERT INTO code_repository_resource_imports (repository_rid, ontology_id, kind, api_name, display_name, added_by)
VALUES ('$REPO2','ri.ontology.main.ontology.$ONT','object_type','Widget','Widget','00000000-0000-4000-8000-000000000001')
ON CONFLICT (repository_rid, kind, api_name) DO NOTHING;
SQL
WC="$(psql -tAc "SELECT count(*) FROM object_instances WHERE ontology_id='$ONT' AND object_type_api_name='Widget'" | tr -d '[:space:]')"
[[ "$WC" == "3" ]] && rec ok "seeded ontology (3 Widgets) + repo bound to it" || rec fail "ontology seed (widgets=$WC, ONT=$ONT)"

read -r -d '' E1 <<'TS'
import { Objects, createEditBatch } from "@osdk/functions";
export default function e2eCreate(i:{id:string}){const b=createEditBatch();b.create("Widget",{$primaryKey:i.id,name:"New",status:"open"});return b.getEdits();}
TS
read -r -d '' E2 <<'TS'
import { Objects, createEditBatch } from "@osdk/functions";
export default function e2eRepriceByObject(i:{name:string}){const b=createEditBatch();for(const o of Objects.search("Widget").filter(w=>w.name===i.name).all())b.update(o,{price:String(Number(o.price)+1)});return b.getEdits();}
TS
read -r -d '' E3 <<'TS'
import { createEditBatch } from "@osdk/functions";
export default function e2eCollapse(i:{id:string}){const b=createEditBatch();b.create("Widget",{$primaryKey:i.id,status:"open"});b.update({$apiName:"Widget",$primaryKey:i.id},{status:"closed"});b.create("Widget",{$primaryKey:i.id+"-t"});b.delete({$apiName:"Widget",$primaryKey:i.id+"-t"});return b.getEdits();}
TS
read -r -d '' E4 <<'TS'
import { createEditBatch } from "@osdk/functions";
export default function e2eUpdate(i:{id:string;status:string}){const b=createEditBatch();b.update({$apiName:"Widget",$primaryKey:i.id},{status:i.status});return b.getEdits();}
TS
read -r -d '' E5 <<'TS'
import { createEditBatch } from "@osdk/functions";
export default function e2eLink(i:{a:string;c:string}){const b=createEditBatch();b.link({$apiName:"Widget",$primaryKey:i.a},"related",{$apiName:"Widget",$primaryKey:i.c});return b.getEdits();}
TS
TIP2="$(head_sha "$REPO2")"
CB="$(node -e 'const f=[["e2eCreate",1],["e2eRepriceByObject",2],["e2eCollapse",3],["e2eUpdate",4],["e2eLink",5]];const a=process.argv.slice(1);process.stdout.write(JSON.stringify({message:"e2e edit fns",parentSha:a[5],fileChanges:f.map(([n,i])=>({path:"typescript-functions/src/functions/"+n+".ts",op:"add",contentBase64:a[i-1]}))}))' "$(mkfn "$E1")" "$(mkfn "$E2")" "$(mkfn "$E3")" "$(mkfn "$E4")" "$(mkfn "$E5")" "$TIP2")"
H POST "/code-repositories/$REPO2/branches/main/commits" "$CB" -H "Idempotency-Key: $(uuid)" -H "If-Match: \"$TIP2\""
[[ "$HTTP" == "200" || "$HTTP" == "201" ]] && rec ok "committed 5 v2 edit functions" || rec fail "commit edit fns → $HTTP $(printf '%s' "$BODY"|head -c 120)"

inv(){ H POST "/code-repositories/$REPO2/functions/invoke" '{"apiName":"'"$1"'","branch":"main","source":"working_tree","args":'"$2"',"applyEdits":'"${3:-false}"'}'; }

inv e2eCreate '{"id":"NEW1"}'
[[ "$(rg "$BODY")" == '[{"op":"create","objectType":"Widget","primaryKey":"NEW1","properties":{"name":"New","status":"open"}}]' ]] && rec ok "create → correct OntologyEdit[]" || rec fail "create edit: $(rg "$BODY")"

inv e2eRepriceByObject '{"name":"Alpha"}'
N=$(rg "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);process.stdout.write(String(a.length))}catch{process.stdout.write("0")}})')
[[ "$N" == "2" ]] && rec ok "update by OBJECT instance → 2 edits (the two Alpha widgets)" || rec fail "reprice-by-object N=$N"

inv e2eCollapse '{"id":"COL1"}'
[[ "$(rg "$BODY")" == '[{"op":"create","objectType":"Widget","primaryKey":"COL1","properties":{"status":"closed"}}]' ]] && rec ok "edit collapsing → create+update merged to ONE create; temp create+delete cancelled" || rec fail "collapse: $(rg "$BODY")"

# apply update via Action semantics
BEFORE="$(psql -tAc "SELECT properties->>'status' FROM object_instances WHERE ontology_id='$ONT' AND primary_key='W1'" | tr -d '[:space:]')"
inv e2eUpdate '{"id":"W1","status":"closed"}' true
AFTER="$(psql -tAc "SELECT properties->>'status' FROM object_instances WHERE ontology_id='$ONT' AND primary_key='W1'" | tr -d '[:space:]')"
[[ "$(jg "$BODY" editsApplied.updated)" == "1" && "$BEFORE" == "open" && "$AFTER" == "closed" ]] && rec ok "applyEdits=true persists update (W1 open→closed)" || rec fail "apply update (before=$BEFORE after=$AFTER applied=$(jg "$BODY" editsApplied))"

# apply link → link_edit row
LINK_BEFORE="$(psql -tAc "SELECT count(*) FROM link_edit WHERE ontology_id='$ONT' AND link_type_api_name='related'" | tr -d '[:space:]')"
inv e2eLink '{"a":"W1","c":"W2"}' true
LINK_AFTER="$(psql -tAc "SELECT count(*) FROM link_edit WHERE ontology_id='$ONT' AND link_type_api_name='related'" | tr -d '[:space:]')"
if [[ "$(jg "$BODY" editsApplied.linked)" == "1" && "$LINK_AFTER" -gt "$LINK_BEFORE" ]]; then
  rec ok "applyEdits=true persists link (link_edit $LINK_BEFORE -> $LINK_AFTER)"
else
  rec fail "apply link ($LINK_BEFORE -> $LINK_AFTER, applied=$(jg "$BODY" editsApplied))"
fi

# cleanup seeded ontology
psql >/dev/null <<SQL
DELETE FROM link_edit WHERE ontology_id='$ONT'; DELETE FROM object_instances WHERE ontology_id='$ONT';
DELETE FROM ontology_branch WHERE branch_id='$ONT'; DELETE FROM ontology WHERE ontology_id='$ONT';
SQL

# ===========================================================================
step "SUMMARY"
printf "  ${g}PASS=%d${x}  ${r}FAIL=%d${x}\n" "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
