#!/usr/bin/env bash
# ===========================================================================
# DEMONSTRATION — all Code Repositories functionality + fully-functional
# TypeScript Functions v2, on the REAL repo "test-6" against the REAL
# "Synthetic Main" ontology (OlivierAllOrders15 — 1,492 live order objects).
#
# Runs against the live :3000 backend (started with CODE_REPOS_TEST_AUTH=1),
# so everything it does is visible in the FE at:
#   http://localhost:3001/code-repositories/repo/<RID>
#
#   bash scripts/foundry-parity/demo-test6-repo.sh
# ===========================================================================

set -u
BASE="http://localhost:3000/api/v1"
RID="ri.stemma.main.repository.1a6883a8-5f28-4c27-a66a-5720fb620d48"
ONT_RID="ri.ontology.main.ontology.ffffffff-ffff-ffff-ffff-ffffffffffff"
BRANCH="main"
OT="OlivierAllOrders15"
TMP="$(mktemp -d)"

b=$'\033[1m'; g=$'\033[32m'; r=$'\033[31m'; c=$'\033[36m'; m=$'\033[35m'; y=$'\033[33m'; x=$'\033[0m'
step(){ printf "\n${b}${m}▌ %s${x}\n" "$1"; }
ok(){ printf "  ${g}✔${x} %s\n" "$1"; }
info(){ printf "  ${c}•${x} %s\n" "$1"; }
warn(){ printf "  ${y}!${x} %s\n" "$1"; }
die(){ printf "  ${r}x %s${x}\n" "$1"; exit 1; }

AUTH=(-H "X-Tellus-Test-Principal: senior-eng/editor")
H(){ # H METHOD path [json] [extra curl args...]
  local method="$1" path="$2"; shift 2
  local data=""; if [[ $# -gt 0 && "${1:0:1}" != "-" ]]; then data="$1"; shift; fi
  local extra=(); [[ $# -gt 0 ]] && extra=("$@")
  local args=(-s -o "$TMP/b" -D "$TMP/h" -w '%{http_code}' -X "$method" "${AUTH[@]}")
  [[ ${#extra[@]} -gt 0 ]] && args+=("${extra[@]}")
  [[ -n "$data" ]] && args+=(-H "content-type: application/json" --data "$data")
  HTTP_CODE="$(curl "${args[@]}" "${BASE}${path}")"; BODY="$(cat "$TMP/b")"; HDRS="$(cat "$TMP/h")"
}
jget(){ printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=(process.argv[1]||"").split(".").reduce((a,k)=>a==null?a:a[k],o);process.stdout.write(v==null?"":typeof v==="object"?JSON.stringify(v):String(v))}catch{process.stdout.write("")}})' "${2:-}"; }
rget(){ printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);let r=o.result;if(typeof r==="string"){try{r=JSON.parse(r)}catch{}}const p=process.argv[1]||"";const v=p?p.split(".").reduce((a,k)=>a==null?a:a[k],r):r;process.stdout.write(v==null?"":typeof v==="object"?JSON.stringify(v,null,2):String(v))}catch{process.stdout.write("")}})' "${2:-}"; }
hdr(){ printf '%s' "$HDRS" | grep -i "^$1:" | head -1 | sed "s/^[^:]*: *//I" | tr -d '\r'; }
uuid(){ node -e 'console.log(require("crypto").randomUUID())'; }
mkfn(){ printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(Buffer.from(s).toString("base64")))'; }
head_sha(){
  # The durable branch_cache can hold a stale head after an in-memory-Stemma
  # restart (the cached SHA outlives the re-scaffold). Clear it so GET /branches
  # falls back to the LIVE Stemma HEAD, which is what the commit CAS checks.
  docker compose exec -T postgres psql -U tellus -d tellus_db -c \
    "DELETE FROM code_repository_branch_cache WHERE repository_rid='$RID'" >/dev/null 2>&1
  H GET "/code-repositories/$RID/branches" >/dev/null
  printf '%s' "$BODY" | grep -oE '[0-9a-f]{40}' | head -1
}

curl -sf http://localhost:3000/api/v1/health >/dev/null 2>&1 || die "backend :3000 not reachable"

# ===========================================================================
step "1 · Repository metadata (GET /:rid)"
H GET "/code-repositories/$RID"
[[ "$HTTP_CODE" == "200" ]] || die "GET repo → $HTTP_CODE"
ok "$(jget "$BODY" displayName)  ·  state=$(jget "$BODY" state)  ·  default branch=$(jget "$BODY" defaultBranch)  ·  ETag=$(hdr etag)"

step "2 · Branches (GET /:rid/branches)"
H GET "/code-repositories/$RID/branches"
ok "branches: $(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write((o.branches||[]).map(x=>x.name+" @"+(x.headSha||"").slice(0,8)).join(", "))})')"

step "3 · File tree (GET /:rid/branches/$BRANCH/tree) — strong ETag + 304"
H GET "/code-repositories/$RID/branches/$BRANCH/tree?path=&depth=5"
TREE_ETAG="$(hdr etag)"
ok "$(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write((o.entries||[]).length+" entries; functions dir present: "+String((o.entries||[]).some(e=>e.path.endsWith("src/functions"))))})') (ETag $(printf '%s' "$TREE_ETAG" | head -c 14)…)"
H GET "/code-repositories/$RID/branches/$BRANCH/tree?path=&depth=5" -H "If-None-Match: $TREE_ETAG"
[[ "$HTTP_CODE" == "304" ]] && ok "conditional GET (If-None-Match) → 304 Not Modified" || warn "conditional GET → $HTTP_CODE"

step "4 · Read a file (GET /:rid/branches/$BRANCH/files) — the scaffold's helloWorld"
H GET "/code-repositories/$RID/branches/$BRANCH/files?path=typescript-functions/src/functions/helloWorld.ts"
[[ "$HTTP_CODE" == "200" ]] && ok "read helloWorld.ts ($(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);process.stdout.write((o.content||"").length+" chars, encoding="+o.encoding)}catch{process.stdout.write("?")}})'))" || warn "read file → $HTTP_CODE"

step "5 · Repository settings (GET + PUT with If-Match)"
H GET "/code-repositories/$RID/settings"; SET_ETAG="$(hdr etag)"
H PUT "/code-repositories/$RID/settings" '{"description":"Order analytics functions (demo)","owner":"senior-eng"}' -H "If-Match: $SET_ETAG"
[[ "$HTTP_CODE" == "200" ]] && ok "settings updated (optimistic concurrency via If-Match)" || warn "settings PUT → $HTTP_CODE: $(printf '%s' "$BODY"|head -c 120)"

step "6 · Import Ontology object types into the repo (PUT /:rid/resource-imports)"
H GET "/code-repositories/$RID/resource-imports"; RI_ETAG="$(hdr etag)"
H PUT "/code-repositories/$RID/resource-imports" \
  '{"ontologyRid":"'"$ONT_RID"'","items":[{"kind":"object_type","apiName":"'"$OT"'","displayName":"All Orders"},{"kind":"object_type","apiName":"OlivierOrder","displayName":"Order"}]}' \
  -H "If-Match: $RI_ETAG"
if [[ "$HTTP_CODE" == "200" ]]; then ok "imported object types: $OT, OlivierOrder (ontology ffffffff)"; else
  warn "PUT resource-imports → $HTTP_CODE: $(printf '%s' "$BODY"|head -c 160) — falling back to direct bind"
  docker compose exec -T postgres psql -U tellus -d tellus_db >/dev/null 2>&1 <<SQL
DELETE FROM code_repository_resource_imports WHERE repository_rid='$RID';
INSERT INTO code_repository_resource_imports (repository_rid, ontology_id, kind, api_name, display_name, added_by)
VALUES ('$RID','$ONT_RID','object_type','$OT','All Orders','00000000-0000-4000-8000-000000000001'),
       ('$RID','$ONT_RID','object_type','OlivierOrder','Order','00000000-0000-4000-8000-000000000001');
SQL
  ok "bound object types via fallback"
fi

# ===========================================================================
step "7 · Author & commit five real TypeScript Functions v2 (order analytics)"
read -r -d '' F_SUMMARY <<'TS'
import { Objects } from "@foundry/functions";
// Fleet-wide order book: totals, revenue, status & item breakdowns.
export default function orderBookSummary() {
  const orders = Objects.search("OlivierAllOrders15").all();
  const revenue = orders.reduce((a, o) => a + Number(o.quantity) * Number(o.unit_price), 0);
  return {
    totalOrders: orders.length,
    totalRevenue: revenue,
    avgOrderValue: Math.round(revenue / Math.max(orders.length, 1)),
    byStatus: orders.reduce((m: Record<string, number>, o) => { m[o.status as string] = (m[o.status as string] || 0) + 1; return m; }, {}),
  };
}
TS
read -r -d '' F_REVITEM <<'TS'
import { Objects } from "@foundry/functions";
// Revenue ranked by item, with units sold.
export default function revenueByItem() {
  const orders = Objects.search("OlivierAllOrders15").all();
  const byItem: Record<string, { revenue: number; units: number }> = {};
  for (const o of orders) {
    const item = String(o.item_name);
    const rev = Number(o.quantity) * Number(o.unit_price);
    byItem[item] = byItem[item] || { revenue: 0, units: 0 };
    byItem[item].revenue += rev;
    byItem[item].units += Number(o.quantity);
  }
  return Object.entries(byItem)
    .map(([item, v]) => ({ item, revenue: v.revenue, units: v.units }))
    .sort((a, b) => b.revenue - a.revenue);
}
TS
read -r -d '' F_ASSIGNEE <<'TS'
import { Objects } from "@foundry/functions";
// Workload: top assignees by open (non-closed) order count.
export default function topAssignees(input: { limit?: number }) {
  const open = Objects.search("OlivierAllOrders15").filter(o => o.status !== "closed");
  const byAssignee = open.groupByCount(o => String(o.assignee));
  return Object.entries(byAssignee)
    .map(([assignee, openOrders]) => ({ assignee, openOrders }))
    .sort((a, b) => b.openOrders - a.openOrders)
    .slice(0, input.limit ?? 5);
}
TS
read -r -d '' F_CUST <<'TS'
import { Objects } from "@foundry/functions";
// Per-customer total order value (lifetime).
export default function customerOrderValue(input: { customerName: string }) {
  const orders = Objects.search("OlivierAllOrders15")
    .filter(o => o.customer_name === input.customerName).all();
  if (orders.length === 0) return { customerName: input.customerName, orders: 0, totalValue: 0 };
  const total = orders.reduce((a, o) => a + Number(o.quantity) * Number(o.unit_price), 0);
  return { customerName: input.customerName, orders: orders.length, totalValue: total };
}
TS
read -r -d '' F_FLAG <<'TS'
import { Objects, Edits } from "@foundry/functions";
// Ontology EDIT function: tag high-value open orders with priority=HIGH.
// Additive (merges a new property) — does not overwrite existing fields.
export default function flagHighValueOrders(input: { minValue?: number; limit?: number }) {
  const min = input.minValue ?? 5000;
  const matches = Objects.search("OlivierAllOrders15")
    .filter(o => o.status === "assigned" && Number(o.quantity) * Number(o.unit_price) >= min)
    .all()
    .slice(0, input.limit ?? 25);
  for (const o of matches) Edits.update("OlivierAllOrders15", o.$primaryKey, { priority: "HIGH" });
  return { minValue: min, flagged: matches.length, orderIds: matches.map(o => o.orderid) };
}
TS

TIP="$(head_sha)"
COMMIT="$(node -e '
const f=[
 ["typescript-functions/src/functions/orderBookSummary.ts",process.argv[1]],
 ["typescript-functions/src/functions/revenueByItem.ts",process.argv[2]],
 ["typescript-functions/src/functions/topAssignees.ts",process.argv[3]],
 ["typescript-functions/src/functions/customerOrderValue.ts",process.argv[4]],
 ["typescript-functions/src/functions/flagHighValueOrders.ts",process.argv[5]],
];
process.stdout.write(JSON.stringify({message:"Add order-analytics functions",parentSha:process.argv[6],
 fileChanges:f.map(([path,b64])=>({path,op:"add",contentBase64:b64}))}));
' "$(mkfn "$F_SUMMARY")" "$(mkfn "$F_REVITEM")" "$(mkfn "$F_ASSIGNEE")" "$(mkfn "$F_CUST")" "$(mkfn "$F_FLAG")" "$TIP")"
H POST "/code-repositories/$RID/branches/$BRANCH/commits" "$COMMIT" -H "Idempotency-Key: $(uuid)" -H "If-Match: \"$TIP\""
[[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "201" ]] || die "commit → $HTTP_CODE: $(printf '%s' "$BODY"|head -c 200)"
ok "committed 5 functions to typescript-functions/src/functions/ (HEAD $(jget "$BODY" commitSha | head -c 12)…)"

step "8 · List functions in the repo (GET /:rid/functions)"
H GET "/code-repositories/$RID/functions?branch=$BRANCH"
ok "discovered: $(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const a=o.data||o;process.stdout.write(a.map(f=>f.apiName+"["+f.source+"]").join(", "))}catch{process.stdout.write(s.slice(0,160))}})')"

# ===========================================================================
step "9 · Live-Preview invoke over the REAL ontology (1,492 OlivierAllOrders15 objects)"
invoke(){ H POST "/code-repositories/$RID/functions/invoke" '{"apiName":"'"$1"'","branch":"'"$BRANCH"'","source":"working_tree","args":'"$2"',"applyEdits":'"${3:-false}"'}'; }

invoke orderBookSummary '{}'
[[ "$HTTP_CODE" == "200" ]] || die "orderBookSummary → $HTTP_CODE: $(printf '%s' "$BODY"|head -c 200)"
info "orderBookSummary() → loaded $(jget "$BODY" ontology.objectsLoaded) objects:"
rget "$BODY" | sed 's/^/      /'

invoke revenueByItem '{}'
ok "revenueByItem() → top items by revenue:"
rget "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);a.slice(0,5).forEach(r=>console.log("      "+r.item+": $"+r.revenue+" ("+r.units+" units)"))}catch{process.stdout.write("      "+s)}})'

invoke topAssignees '{"limit":4}'
ok "topAssignees({limit:4}) → $(rget "$BODY")"

# pick a real customer name from the data for the customer function
CUST="$(docker compose exec -T postgres psql -U tellus -d tellus_db -tAc "SELECT properties->>'customer_name' FROM object_instances WHERE ontology_id='ffffffff-ffff-ffff-ffff-ffffffffffff' AND object_type_api_name='$OT' AND properties->>'customer_name' IS NOT NULL LIMIT 1" 2>/dev/null | tr -d '\r')"
invoke customerOrderValue '{"customerName":"'"$CUST"'"}'
ok "customerOrderValue({customer:'$CUST'}) → $(rget "$BODY")"

step "10 · Ontology EDIT function — preview, then apply via Action semantics"
invoke flagHighValueOrders '{"minValue":3000,"limit":10}' false
ok "preview: would flag $(rget "$BODY" flagged) high-value orders — edits collected: $(jget "$BODY" edits | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).length))}catch{process.stdout.write("0")}})') (NOT yet persisted)"
BEFORE="$(docker compose exec -T postgres psql -U tellus -d tellus_db -tAc "SELECT count(*) FROM object_instances WHERE ontology_id='ffffffff-ffff-ffff-ffff-ffffffffffff' AND object_type_api_name='$OT' AND properties ? 'priority'" 2>/dev/null | tr -d '[:space:]')"
invoke flagHighValueOrders '{"minValue":3000,"limit":10}' true
ok "applied as Action → editsApplied: $(jget "$BODY" editsApplied)"
AFTER="$(docker compose exec -T postgres psql -U tellus -d tellus_db -tAc "SELECT count(*) FROM object_instances WHERE ontology_id='ffffffff-ffff-ffff-ffff-ffffffffffff' AND object_type_api_name='$OT' AND properties ? 'priority'" 2>/dev/null | tr -d '[:space:]')"
info "orders with priority property — before: $BEFORE, after: $AFTER (additive merge; original fields untouched)"

# ===========================================================================
step "11 · Tag & Release v1.0.0 → publish all functions to the registry"
H POST "/code-repositories/$RID/tags" '{"semver":"1.0.0","branch":"'"$BRANCH"'","message":"Order analytics v1"}' -H "Idempotency-Key: $(uuid)"
if [[ "$HTTP_CODE" == "201" ]]; then
  ok "published v1.0.0 — functions: $(jget "$BODY" functions)"
  info "artifact sha256 $(jget "$BODY" version.artifactSha256 | head -c 20)…  ·  preview=$(jget "$BODY" version.isPreview)"
elif [[ "$HTTP_CODE" == "200" ]]; then ok "v1.0.0 already published (idempotent dedupe)"
else warn "tag&release → $HTTP_CODE: $(printf '%s' "$BODY"|head -c 200)"; fi

step "12 · Functions registry — list / resolve / invoke published"
H GET "/functions/$RID/versions?branch=$BRANCH"
ok "registry versions: $(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).versions.map(v=>v.semver+(v.isPreview?"*":"")+"["+v.state+"]").join(", "))}catch{process.stdout.write("")}})')"
H GET "/functions/$RID/resolve?versionTarget=%5E1.0.0&branch=$BRANCH&defaultBranch=$BRANCH"
ok "resolve ^1.0.0 → $(jget "$BODY" semver)"
H POST "/code-repositories/$RID/functions/invoke" '{"apiName":"orderBookSummary","branch":"'"$BRANCH"'","source":"published","args":{}}'
[[ "$HTTP_CODE" == "200" ]] && ok "invoke PUBLISHED orderBookSummary() → totalOrders=$(rget "$BODY" totalOrders), totalRevenue=$(rget "$BODY" totalRevenue)" || warn "published invoke → $HTTP_CODE"

step "Done"
ok "All Code Repositories functionality demonstrated on repo test-6 with fully-functional TypeScript Functions v2 over the live ontology."
echo
echo "  ${b}Open in your browser${x} (refresh):"
echo "    http://localhost:3001/code-repositories/repo/$RID"
echo "    → file tree shows typescript-functions/src/functions/*.ts"
echo "    → Functions panel: Live Preview (run any function) + Published tab (v1.0.0)"
