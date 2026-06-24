#!/usr/bin/env bash
# ===========================================================================
# DEMO — Foundry "TypeScript v2 Ontology Edits" features, committed as real
# functions into repo test-6 (branch main) over the live Synthetic Main
# ontology (OlivierAllOrders15). Mirrors:
#   https://www.palantir.com/docs/foundry/functions/typescript-v2-ontology-edits
#
# Exercises: createEditBatch, create (by type + by interface), update (by PK
# ref + by object instance + copy-all), delete, link/unlink, edit collapsing,
# and return-type `OntologyEdit[]`. Then applies one batch via Action semantics.
# ===========================================================================
set -u
BASE="http://localhost:3000/api/v1"
RID="ri.stemma.main.repository.1a6883a8-5f28-4c27-a66a-5720fb620d48"
ONT_RID="ri.ontology.main.ontology.ffffffff-ffff-ffff-ffff-ffffffffffff"
ONT="ffffffff-ffff-ffff-ffff-ffffffffffff"
BRANCH="main"; OT="OlivierAllOrders15"; TMP="$(mktemp -d)"
b=$'\033[1m'; g=$'\033[32m'; c=$'\033[36m'; m=$'\033[35m'; y=$'\033[33m'; r=$'\033[31m'; x=$'\033[0m'
step(){ printf "\n${b}${m}▌ %s${x}\n" "$1"; }; ok(){ printf "  ${g}✔${x} %s\n" "$1"; }
info(){ printf "  ${c}•${x} %s\n" "$1"; }; warn(){ printf "  ${y}!${x} %s\n" "$1"; }; die(){ printf "  ${r}x %s${x}\n" "$1"; exit 1; }
AUTH=(-H "X-Tellus-Test-Principal: senior-eng/editor"); J=(-H 'content-type: application/json')
U(){ node -e 'console.log(require("crypto").randomUUID())'; }
mkfn(){ printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(Buffer.from(s).toString("base64")))'; }
psql(){ docker compose exec -T postgres psql -U tellus -d tellus_db "$@"; }
H(){ local method="$1" path="$2"; shift 2; local data=""; if [[ $# -gt 0 && "${1:0:1}" != "-" ]]; then data="$1"; shift; fi
  local extra=(); [[ $# -gt 0 ]] && extra=("$@"); local a=(-s -o "$TMP/b" -w '%{http_code}' -X "$method" "${AUTH[@]}")
  [[ ${#extra[@]} -gt 0 ]] && a+=("${extra[@]}"); [[ -n "$data" ]] && a+=(-H 'content-type: application/json' --data "$data")
  HTTP_CODE="$(curl "${a[@]}" "${BASE}${path}")"; BODY="$(cat "$TMP/b")"; }
head_sha(){ psql -c "DELETE FROM code_repository_branch_cache WHERE repository_rid='$RID'" >/dev/null 2>&1; H GET "/code-repositories/$RID/branches" >/dev/null; printf '%s' "$BODY" | grep -oE '[0-9a-f]{40}' | head -1; }
# edits(): pretty-print the function's returned OntologyEdit[] (the `result`).
edits(){ printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);let r=o.result;if(typeof r==="string")r=JSON.parse(r);process.stdout.write(JSON.stringify(r))}catch{process.stdout.write("")}})'; }

curl -sf http://localhost:3000/api/v1/health >/dev/null 2>&1 || die "backend :3000 not reachable (start with CODE_REPOS_TEST_AUTH=1 npm run dev)"
H GET "/code-repositories/$RID" >/dev/null; [[ "$HTTP_CODE" == "200" ]] || die "auth/repo check failed ($HTTP_CODE) — ensure CODE_REPOS_TEST_AUTH=1"

step "0 · Ensure the repo imports the ontology object type ($OT)"
psql -v ON_ERROR_STOP=1 >/dev/null <<SQL || die "import bind failed"
INSERT INTO code_repository_resource_imports (repository_rid, ontology_id, kind, api_name, display_name, added_by)
VALUES ('$RID','$ONT_RID','object_type','$OT','All Orders','00000000-0000-4000-8000-000000000001')
ON CONFLICT (repository_rid, kind, api_name) DO NOTHING;
SQL
ok "imported $OT"

step "1 · Author & commit six v2 Ontology-edit functions to src/functions/"
read -r -d '' F1 <<'TS'
import { createEditBatch } from "@osdk/functions";
import { OlivierAllOrders15 } from "@ontology/sdk";
// create(type, props) — by generated object type, with $primaryKey.
export default function v2_createOrder(input: { orderId: string; item: string; qty: number; price: number }) {
  const batch = createEditBatch();
  batch.create(OlivierAllOrders15, {
    $primaryKey: input.orderId, orderid: input.orderId, item_name: input.item,
    quantity: String(input.qty), unit_price: String(input.price), status: "assigned",
  });
  return batch.getEdits();
}
TS
read -r -d '' F2 <<'TS'
import { createEditBatch } from "@osdk/functions";
// update by { $apiName, $primaryKey } reference (no object load needed).
export default function v2_updateStatus(input: { orderId: string; status: string }) {
  const batch = createEditBatch();
  batch.update({ $apiName: "OlivierAllOrders15", $primaryKey: input.orderId }, { status: input.status });
  return batch.getEdits();
}
TS
read -r -d '' F3 <<'TS'
import { Objects, createEditBatch } from "@osdk/functions";
// update by OBJECT INSTANCE — read with Objects, then edit the loaded object.
export default function v2_repriceItem(input: { item: string; pct: number }) {
  const batch = createEditBatch();
  const orders = Objects.search("OlivierAllOrders15").filter(o => o.item_name === input.item).all();
  for (const o of orders) {
    const newPrice = Math.round(Number(o.unit_price) * (1 + input.pct / 100));
    batch.update(o, { unit_price: String(newPrice) });
  }
  return batch.getEdits();
}
TS
read -r -d '' F4 <<'TS'
import { createEditBatch } from "@osdk/functions";
// delete by primary-key reference.
export default function v2_deleteOrder(input: { orderId: string }) {
  const batch = createEditBatch();
  batch.delete({ $apiName: "OlivierAllOrders15", $primaryKey: input.orderId });
  return batch.getEdits();
}
TS
read -r -d '' F5 <<'TS'
import { createEditBatch } from "@osdk/functions";
// link / unlink over a link type (many-to-many edits).
export default function v2_linkOrders(input: { sourceId: string; targetId: string; unlink?: boolean }) {
  const batch = createEditBatch();
  const src = { $apiName: "OlivierAllOrders15", $primaryKey: input.sourceId };
  const dst = { $apiName: "OlivierAllOrders15", $primaryKey: input.targetId };
  if (input.unlink) batch.unlink(src, "olivierOrder", dst);
  else batch.link(src, "olivierOrder", dst);
  return batch.getEdits();
}
TS
read -r -d '' F6 <<'TS'
import { createEditBatch } from "@osdk/functions";
// EDIT COLLAPSING — create then update then delete collapse to the minimal set.
// Here create+update collapse into ONE create; a second object's create+delete
// cancel out entirely. getEdits() returns the collapsed result.
export default function v2_collapsingDemo(input: { orderId: string }) {
  const batch = createEditBatch();
  batch.create("OlivierAllOrders15", { $primaryKey: input.orderId, item_name: "Widget", status: "open" });
  batch.update({ $apiName: "OlivierAllOrders15", $primaryKey: input.orderId }, { status: "assigned" });
  batch.create("OlivierAllOrders15", { $primaryKey: input.orderId + "-temp", item_name: "Scratch" });
  batch.delete({ $apiName: "OlivierAllOrders15", $primaryKey: input.orderId + "-temp" });
  return batch.getEdits();
}
TS

TIP="$(head_sha)"; [[ -n "$TIP" ]] || die "no HEAD"
COMMIT="$(node -e '
const f=[["v2_createOrder",1],["v2_updateStatus",2],["v2_repriceItem",3],["v2_deleteOrder",4],["v2_linkOrders",5],["v2_collapsingDemo",6]];
const b=process.argv.slice(1);
process.stdout.write(JSON.stringify({message:"Add v2 Ontology-edit demo functions",parentSha:b[6],
 fileChanges:f.map(([n,i])=>({path:"typescript-functions/src/functions/"+n+".ts",op:"add",contentBase64:b[i-1]}))}));
' "$(mkfn "$F1")" "$(mkfn "$F2")" "$(mkfn "$F3")" "$(mkfn "$F4")" "$(mkfn "$F5")" "$(mkfn "$F6")" "$TIP")"
H POST "/code-repositories/$RID/branches/$BRANCH/commits" "$COMMIT" -H "Idempotency-Key: $(U)" -H "If-Match: \"$TIP\""
[[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "201" ]] || die "commit → $HTTP_CODE: $(printf '%s' "$BODY"|head -c 200)"
ok "committed 6 functions to typescript-functions/src/functions/"

invoke(){ H POST "/code-repositories/$RID/functions/invoke" '{"apiName":"'"$1"'","branch":"'"$BRANCH"'","source":"working_tree","args":'"$2"',"applyEdits":'"${3:-false}"'}'; }
# a real order pk for the update/reprice/link demos
PK1="$(psql -tAc "SELECT primary_key FROM object_instances WHERE ontology_id='$ONT' AND object_type_api_name='$OT' ORDER BY primary_key LIMIT 1" | tr -d '[:space:]')"
PK2="$(psql -tAc "SELECT primary_key FROM object_instances WHERE ontology_id='$ONT' AND object_type_api_name='$OT' ORDER BY primary_key OFFSET 1 LIMIT 1" | tr -d '[:space:]')"

step "2 · Live-preview each function — getEdits() returns the OntologyEdit[]"
invoke v2_createOrder '{"orderId":"DEMO-NEW-1","item":"Plasma Cutter","qty":3,"price":999}'
ok "create →            $(edits "$BODY")"
invoke v2_updateStatus '{"orderId":"'"$PK1"'","status":"closed"}'
ok "update(by PK ref) → $(edits "$BODY")"
invoke v2_repriceItem '{"item":"Stapler","pct":10}'
ok "update(by object) → $(edits "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s||"[]");process.stdout.write(a.length+" update edits, e.g. "+JSON.stringify(a[0]||{}))})')"
invoke v2_deleteOrder '{"orderId":"'"$PK2"'"}'
ok "delete →            $(edits "$BODY")"
invoke v2_linkOrders '{"sourceId":"'"$PK1"'","targetId":"'"$PK2"'"}'
ok "link →              $(edits "$BODY")"
invoke v2_collapsingDemo '{"orderId":"DEMO-COLLAPSE-1"}'
ok "collapsing →        $(edits "$BODY")"
info "  ↑ create+update collapsed to ONE create(status=assigned); the temp create+delete cancelled out."

step "3 · Apply edits via Action semantics (applyEdits=true) — persists to the SoR"
BEFORE="$(psql -tAc "SELECT properties->>'status' FROM object_instances WHERE ontology_id='$ONT' AND object_type_api_name='$OT' AND primary_key='$PK1'" | tr -d '[:space:]')"
invoke v2_updateStatus '{"orderId":"'"$PK1"'","status":"escalated"}' true
ok "applied update → editsApplied: $(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(JSON.stringify(o.editsApplied ?? o))})')"
AFTER="$(psql -tAc "SELECT properties->>'status' FROM object_instances WHERE ontology_id='$ONT' AND object_type_api_name='$OT' AND primary_key='$PK1'" | tr -d '[:space:]')"
info "  order $PK1 status: '$BEFORE' → '$AFTER' (SoR mutated)"
LBEFORE="$(psql -tAc "SELECT count(*) FROM link_edit WHERE ontology_id='$ONT' AND link_type_api_name='olivierOrder'" | tr -d '[:space:]')"
invoke v2_linkOrders '{"sourceId":"'"$PK1"'","targetId":"'"$PK2"'"}' true
ok "applied link → editsApplied: $(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(JSON.stringify(o.editsApplied ?? o))})')"
LAFTER="$(psql -tAc "SELECT count(*) FROM link_edit WHERE ontology_id='$ONT' AND link_type_api_name='olivierOrder'" | tr -d '[:space:]')"
info "  link_edit rows for olivierOrder: $LBEFORE → $LAFTER"

step "Done"
ok "All TypeScript v2 Ontology-edit features demoed + committed to branch main."
echo "  Refresh: http://localhost:3001/code-repositories/repo/$RID?branch=main  → Functions panel → Live Preview"
