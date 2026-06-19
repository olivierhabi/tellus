#!/usr/bin/env bash
# ===========================================================================
# DEMO — Palantir Foundry "TypeScript Functions v2" clone, end-to-end.
# ===========================================================================
#
# Drives the full vertical slice with REAL TypeScript Functions v2 operating on
# a REAL Ontology:
#
#   1. Seed an Ontology (Flight + Airport object instances) into object_instances.
#   2. Create a Functions repository (TypeScript Functions template).
#   3. Import the Ontology object types into the repo (resource imports).
#   4. Commit four real-world TS v2 functions (query / aggregation / per-object /
#      Ontology-edit) into src/functions/.
#   5. Live-Preview invoke each over the Ontology snapshot (Foundry's snapshot
#      isolation), including an EDIT function applied via Action semantics.
#   6. Tag & Release v1.0.0 → publish all functions (immutable, SemVer) to the
#      functions registry.
#   7. Registry ops: list / resolve (caret range) / invoke published / yank.
#   8. Guardrails: immutability conflict + backward-incompatibility check.
#
# Self-contained: boots its own backend (CODE_REPOS_TEST_AUTH=1) on PORT and
# tears it down (unless KEEP_UP=1). Requires docker postgres up, node, curl.
#
#   bash scripts/foundry-parity/demo-typescript-functions-v2.sh
#   PORT=3061 KEEP_UP=1 bash scripts/foundry-parity/demo-typescript-functions-v2.sh
# ===========================================================================

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
PORT="${PORT:-3061}"
BASE="http://localhost:${PORT}/api/v1"
TMP="$(mktemp -d)"
SERVER_PID=""
KEEP_UP="${KEEP_UP:-0}"
SERVER_LOG="$TMP/server.log"

b=$'\033[1m'; g=$'\033[32m'; r=$'\033[31m'; y=$'\033[33m'; c=$'\033[36m'; m=$'\033[35m'; x=$'\033[0m'
step() { printf "\n${b}${m}▌ %s${x}\n" "$1"; }
ok()   { printf "  ${g}✔${x} %s\n" "$1"; }
info() { printf "  ${c}•${x} %s\n" "$1"; }
warn() { printf "  ${y}!${x} %s\n" "$1"; }
die()  { printf "  ${r}x %s${x}\n" "$1"; exit 1; }

cleanup() {
  if [[ -n "$SERVER_PID" && "$KEEP_UP" != "1" ]]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
  [[ "$KEEP_UP" == "1" ]] && echo "${y}KEEP_UP=1 → backend left on :$PORT (pid $SERVER_PID)${x}"
}
trap cleanup EXIT

AUTH=(-H "X-Tellus-Test-Principal: demo" -H "X-Tellus-Test-Roles: editor")
# H <METHOD> <path> [jsonData] [extra curl args...]
H() {
  local method="$1" path="$2"; shift 2
  local data=""; if [[ $# -gt 0 && "${1:0:1}" != "-" ]]; then data="$1"; shift; fi
  local extra=(); [[ $# -gt 0 ]] && extra=("$@")
  local bf="$TMP/b" hf="$TMP/h"
  local args=(-s -o "$bf" -D "$hf" -w '%{http_code}' -X "$method" "${AUTH[@]}")
  [[ ${#extra[@]} -gt 0 ]] && args+=("${extra[@]}")
  [[ -n "$data" ]] && args+=(-H "content-type: application/json" --data "$data")
  HTTP_CODE="$(curl "${args[@]}" "${BASE}${path}")"
  BODY="$(cat "$bf" 2>/dev/null)"; HDRS="$(cat "$hf" 2>/dev/null)"
}
jget() { printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);process.stdout.write(v==null?"":typeof v==="object"?JSON.stringify(v):String(v))}catch{process.stdout.write("")}})' "${2:-}"; }
# rget <body> [dotpath-into-result]: parse body.result (a JSON string) then navigate.
rget() { printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);let r=o.result;if(typeof r==="string"){try{r=JSON.parse(r)}catch{}}const p=process.argv[1]||"";const v=p?p.split(".").reduce((a,k)=>a==null?a:a[k],r):r;process.stdout.write(v==null?"":typeof v==="object"?JSON.stringify(v,null,2):String(v))}catch{process.stdout.write("")}})' "${2:-}"; }
jpretty() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.stringify(JSON.parse(s),null,2))}catch{process.stdout.write(s)}})'; }
uuid() { node -e 'console.log(require("crypto").randomUUID())'; }
psql() { docker compose exec -T postgres psql -U tellus -d tellus_db "$@"; }

ONT="a1b2c3d4-0000-4000-8000-0000000fa11a"   # demo ontology id (uuid)
BRANCH_ID="b1b2c3d4-0000-4000-8000-0000000b1a0c"
RUN="$(node -e 'console.log(Date.now().toString(36))')"
FOLDER="ri.compass.main.folder.0123abcd-ef01-4345-8789-abcdef012345"

# ---------------------------------------------------------------------------
step "Booting backend on :$PORT (CODE_REPOS_TEST_AUTH=1)"
CODE_REPOS_TEST_AUTH=1 PORT="$PORT" NODE_ENV=development \
  TELLUS_DISABLE_CONNECTIVITY_POLLER=1 TEMPORAL_WORKER_DISABLED=true \
  npx tsx src/server.ts >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 60); do
  curl -sf "http://localhost:${PORT}/api/v1/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -25 "$SERVER_LOG"; die "server died"; }
  sleep 1
done
ok "backend healthy (pid $SERVER_PID)"

# ---------------------------------------------------------------------------
step "1 · Seed the Ontology (Flight + Airport object instances)"
psql -v ON_ERROR_STOP=1 >/dev/null <<SQL || die "ontology seed failed"
INSERT INTO ontology (ontology_id, display_name, description)
  VALUES ('$ONT', 'Flight Ops Demo', 'Foundry Functions v2 demo ontology')
  ON CONFLICT (ontology_id) DO NOTHING;
INSERT INTO ontology_branch (branch_id, ontology_id, name)
  VALUES ('$BRANCH_ID', '$ONT', 'main')
  ON CONFLICT (branch_id) DO NOTHING;
DELETE FROM object_instances WHERE ontology_id = '$ONT';
INSERT INTO object_instances (ontology_id, branch_id, object_type_api_name, primary_key, properties) VALUES
('$ONT','$BRANCH_ID','Airport','JFK','{"code":"JFK","name":"New York JFK","city":"New York"}'),
('$ONT','$BRANCH_ID','Airport','SFO','{"code":"SFO","name":"San Francisco Intl","city":"San Francisco"}'),
('$ONT','$BRANCH_ID','Airport','ORD','{"code":"ORD","name":"Chicago O''Hare","city":"Chicago"}'),
('$ONT','$BRANCH_ID','Flight','DL101','{"flightNumber":"DL101","carrier":"DL","origin":"JFK","destination":"SFO","capacity":180,"booked":172,"delayMinutes":0,"status":"SCHEDULED"}'),
('$ONT','$BRANCH_ID','Flight','DL220','{"flightNumber":"DL220","carrier":"DL","origin":"SFO","destination":"ORD","capacity":180,"booked":90,"delayMinutes":35,"status":"SCHEDULED"}'),
('$ONT','$BRANCH_ID','Flight','DL330','{"flightNumber":"DL330","carrier":"DL","origin":"ORD","destination":"JFK","capacity":200,"booked":200,"delayMinutes":140,"status":"SCHEDULED"}'),
('$ONT','$BRANCH_ID','Flight','AA400','{"flightNumber":"AA400","carrier":"AA","origin":"JFK","destination":"ORD","capacity":160,"booked":120,"delayMinutes":15,"status":"SCHEDULED"}'),
('$ONT','$BRANCH_ID','Flight','AA512','{"flightNumber":"AA512","carrier":"AA","origin":"ORD","destination":"SFO","capacity":160,"booked":158,"delayMinutes":210,"status":"SCHEDULED"}'),
('$ONT','$BRANCH_ID','Flight','UA600','{"flightNumber":"UA600","carrier":"UA","origin":"SFO","destination":"JFK","capacity":220,"booked":140,"delayMinutes":0,"status":"SCHEDULED"}'),
('$ONT','$BRANCH_ID','Flight','UA715','{"flightNumber":"UA715","carrier":"UA","origin":"JFK","destination":"SFO","capacity":220,"booked":205,"delayMinutes":45,"status":"SCHEDULED"}'),
('$ONT','$BRANCH_ID','Flight','UA822','{"flightNumber":"UA822","carrier":"UA","origin":"ORD","destination":"SFO","capacity":150,"booked":150,"delayMinutes":190,"status":"SCHEDULED"}'),
('$ONT','$BRANCH_ID','Flight','DL905','{"flightNumber":"DL905","carrier":"DL","origin":"SFO","destination":"ORD","capacity":180,"booked":60,"delayMinutes":20,"status":"SCHEDULED"}');
SQL
FLIGHTS="$(psql -tAc "SELECT count(*) FROM object_instances WHERE ontology_id='$ONT' AND object_type_api_name='Flight'")"
ok "seeded $(echo "$FLIGHTS" | tr -d '[:space:]') Flight + 3 Airport instances under ontology $ONT"

# ---------------------------------------------------------------------------
step "2 · Create a Functions repository (TypeScript Functions template)"
H POST "/code-repositories" '{"displayName":"flight-ops-functions-'"$RUN"'","parentFolderRid":"'"$FOLDER"'","templateId":"typescript-functions","templateVersion":"2.4.0","defaultBranch":"master"}' -H "Idempotency-Key: $(uuid)"
[[ "$HTTP_CODE" == "201" ]] || die "create repo → $HTTP_CODE: $BODY"
RID="$(jget "$BODY" rid)"
ok "repo created: $RID"

# ---------------------------------------------------------------------------
step "3 · Import the Ontology object types into the repo"
# (PUT resource-imports binds the repo to the ontology; the function runtime
#  reads these to scope the snapshot — exactly like Foundry's Ontology tab.)
psql -v ON_ERROR_STOP=1 >/dev/null <<SQL || die "resource-imports seed failed"
DELETE FROM code_repository_resource_imports WHERE repository_rid = '$RID';
INSERT INTO code_repository_resource_imports (repository_rid, ontology_id, kind, api_name, display_name, added_by) VALUES
('$RID','$ONT','object_type','Flight','Flight','00000000-0000-4000-8000-000000000001'),
('$RID','$ONT','object_type','Airport','Airport','00000000-0000-4000-8000-000000000001');
SQL
ok "imported object types: Flight, Airport (ontology $ONT)"

# ---------------------------------------------------------------------------
step "4 · Author & commit four real TypeScript Functions v2"
mkfn() { printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(Buffer.from(s).toString("base64")))'; }

read -r -d '' F_FLEET <<'TS'
import { Objects } from "@foundry/functions";
// Query + aggregation across the fleet.
export default function fleetSummary() {
  const flights = Objects.search("Flight");
  return {
    totalFlights: flights.count(),
    totalSeats: flights.sum("capacity"),
    totalBooked: flights.sum("booked"),
    avgDelayMinutes: Math.round(flights.avg("delayMinutes")),
    flightsByCarrier: flights.groupByCount(f => f.carrier),
  };
}
TS

read -r -d '' F_DELAY <<'TS'
import { Objects } from "@foundry/functions";
// Parametrised aggregation: carriers ranked by delayed-flight count.
export default function topDelayedCarriers(input: { minDelayMinutes?: number }) {
  const threshold = input.minDelayMinutes ?? 30;
  const delayed = Objects.search("Flight").filter(f => Number(f.delayMinutes) >= threshold);
  const byCarrier = delayed.groupByCount(f => f.carrier);
  const ranked = Object.entries(byCarrier)
    .map(([carrier, count]) => ({ carrier, delayed: count }))
    .sort((a, b) => b.delayed - a.delayed);
  return { thresholdMinutes: threshold, delayedFlights: delayed.count(), ranking: ranked };
}
TS

read -r -d '' F_LOAD <<'TS'
import { Objects } from "@foundry/functions";
// Per-object lookup + computed property (load factor).
export default function flightLoadFactor(input: { flightNumber: string }) {
  const f = Objects.search("Flight").filter(x => x.flightNumber === input.flightNumber).first();
  if (!f) return { error: "flight not found: " + input.flightNumber };
  const load = Number(f.booked) / Number(f.capacity);
  return {
    flightNumber: f.flightNumber, carrier: f.carrier,
    route: f.origin + "→" + f.destination,
    loadFactorPct: Math.round(load * 1000) / 10,
    overbooked: Number(f.booked) > Number(f.capacity),
  };
}
TS

read -r -d '' F_CANCEL <<'TS'
import { Objects, Edits } from "@foundry/functions";
// Ontology EDIT function: cancel flights delayed beyond a threshold.
// Edits only persist when invoked through an Action (applyEdits=true).
export default function cancelSeverelyDelayedFlights(input: { maxDelayMinutes?: number }) {
  const limit = input.maxDelayMinutes ?? 120;
  const toCancel = Objects.search("Flight")
    .filter(f => Number(f.delayMinutes) >= limit && f.status !== "CANCELLED")
    .all();
  for (const f of toCancel) {
    Edits.update("Flight", f.$primaryKey, { status: "CANCELLED" });
  }
  return { thresholdMinutes: limit, cancelledFlights: toCancel.map(f => f.flightNumber) };
}
TS

TIP="$(H GET "/code-repositories/$RID/branches" >/dev/null; printf '%s' "$BODY" | grep -oE '[0-9a-f]{40}' | head -1)"
[[ -n "$TIP" ]] || die "could not resolve branch HEAD sha"
COMMIT_BODY="$(node -e '
const fs=require("fs");
const files=[
 ["src/functions/fleetSummary.ts", process.argv[1]],
 ["src/functions/topDelayedCarriers.ts", process.argv[2]],
 ["src/functions/flightLoadFactor.ts", process.argv[3]],
 ["src/functions/cancelSeverelyDelayedFlights.ts", process.argv[4]],
];
process.stdout.write(JSON.stringify({
  message:"Add flight-ops functions",
  parentSha: process.argv[5],
  fileChanges: files.map(([path,b64])=>({path, op:"add", contentBase64:b64}))
}));
' "$(mkfn "$F_FLEET")" "$(mkfn "$F_DELAY")" "$(mkfn "$F_LOAD")" "$(mkfn "$F_CANCEL")" "$TIP")"
H POST "/code-repositories/$RID/branches/master/commits" "$COMMIT_BODY" -H "Idempotency-Key: $(uuid)" -H "If-Match: \"$TIP\""
[[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "201" ]] || die "commit → $HTTP_CODE: $BODY"
ok "committed 4 functions to src/functions/ (HEAD $(jget "$BODY" commitSha | head -c 12)…)"

# ---------------------------------------------------------------------------
step "5 · Live-Preview invoke over the Ontology snapshot"
invoke() { # invoke <apiName> <argsJson> [applyEdits]
  local apiName="$1" argsJson="$2" apply="${3:-false}"
  H POST "/code-repositories/$RID/functions/invoke" \
    '{"apiName":"'"$apiName"'","branch":"master","source":"working_tree","args":'"$argsJson"',"applyEdits":'"$apply"'}'
}

invoke fleetSummary '{}'
[[ "$HTTP_CODE" == "200" ]] || die "fleetSummary → $HTTP_CODE: $BODY"
info "fleetSummary() → loaded $(jget "$BODY" ontology.objectsLoaded) objects from the Ontology"
rget "$BODY" | sed 's/^/      /'

invoke topDelayedCarriers '{"minDelayMinutes":30}'
ok "topDelayedCarriers({minDelayMinutes:30}) →"
rget "$BODY" | sed 's/^/      /'

invoke flightLoadFactor '{"flightNumber":"UA715"}'
ok "flightLoadFactor({flightNumber:'UA715'}) → $(rget "$BODY")"

step "5b · Ontology EDIT function — preview (no persistence) then apply (Action)"
invoke cancelSeverelyDelayedFlights '{"maxDelayMinutes":120}' false
ok "preview: would cancel $(rget "$BODY" cancelledFlights) — edits collected: $(jget "$BODY" edits | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).length))}catch{process.stdout.write("0")}})')"
BEFORE="$(psql -tAc "SELECT count(*) FROM object_instances WHERE ontology_id='$ONT' AND object_type_api_name='Flight' AND properties->>'status'='CANCELLED'" | tr -d '[:space:]')"
info "CANCELLED flights in Ontology BEFORE apply: $BEFORE"
invoke cancelSeverelyDelayedFlights '{"maxDelayMinutes":120}' true
ok "applied as Action → editsApplied: $(jget "$BODY" editsApplied)"
AFTER="$(psql -tAc "SELECT count(*) FROM object_instances WHERE ontology_id='$ONT' AND object_type_api_name='Flight' AND properties->>'status'='CANCELLED'" | tr -d '[:space:]')"
info "CANCELLED flights in Ontology AFTER apply:  $AFTER"
[[ "$AFTER" -gt "$BEFORE" ]] && ok "Ontology system-of-record mutated by the function-backed Action" || warn "no rows changed"

# ---------------------------------------------------------------------------
step "6 · Tag & Release v1.0.0 → publish all functions to the registry"
H POST "/code-repositories/$RID/tags" '{"semver":"1.0.0","branch":"master","message":"Initial flight-ops release"}' -H "Idempotency-Key: $(uuid)"
[[ "$HTTP_CODE" == "201" ]] || die "tag&release → $HTTP_CODE: $BODY"
ok "published version $(jget "$BODY" version.semver) (rid $(jget "$BODY" version.rid | head -c 36)…)"
info "functions in release: $(jget "$BODY" functions)"
info "artifact sha256: $(jget "$BODY" version.artifactSha256 | head -c 24)…  preview=$(jget "$BODY" version.isPreview)"

# ---------------------------------------------------------------------------
step "7 · Functions registry — list / resolve / invoke published / yank"
H GET "/functions/$RID/versions?branch=master"
ok "registry list → $(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(o.versions.map(v=>v.semver+(v.isPreview?"(preview)":"")).join(", "))})')"

H GET "/functions/$RID/resolve?versionTarget=%5E1.0.0&branch=master&defaultBranch=master"
ok "resolve caret range ^1.0.0 → $(jget "$BODY" semver)"

info "invoke the PUBLISHED artifact (not the working tree):"
H POST "/code-repositories/$RID/functions/invoke" '{"apiName":"fleetSummary","branch":"master","source":"published","args":{}}'
[[ "$HTTP_CODE" == "200" ]] && ok "published fleetSummary() → totalFlights=$(rget "$BODY" totalFlights), avgDelayMinutes=$(rget "$BODY" avgDelayMinutes)" || warn "published invoke → $HTTP_CODE"

# ---------------------------------------------------------------------------
step "8 · Guardrails — immutability & backward-compatibility"
H POST "/code-repositories/$RID/tags" '{"semver":"1.0.0","branch":"master"}' -H "Idempotency-Key: $(uuid)"
if [[ "$HTTP_CODE" == "200" ]]; then ok "re-release identical v1.0.0 → dedup (idempotent)"; else info "re-release v1.0.0 → $HTTP_CODE ($(jget "$BODY" errorName))"; fi

# Drop a function (remove a file) and try a minor bump → must be blocked.
TIP2="$(H GET "/code-repositories/$RID/branches" >/dev/null; printf '%s' "$BODY" | grep -oE '[0-9a-f]{40}' | head -1)"
H POST "/code-repositories/$RID/branches/master/commits" '{"message":"drop fleetSummary","parentSha":"'"$TIP2"'","fileChanges":[{"path":"src/functions/fleetSummary.ts","op":"delete"}]}' -H "Idempotency-Key: $(uuid)" -H "If-Match: \"$TIP2\""
if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "201" ]]; then
  H POST "/code-repositories/$RID/tags" '{"semver":"1.1.0","branch":"master"}' -H "Idempotency-Key: $(uuid)"
  if [[ "$HTTP_CODE" == "409" ]]; then
    ok "backward-incompat blocked: dropping fleetSummary needs a MAJOR bump ($(jget "$BODY" errorName); removed=$(jget "$BODY" parameters.removedFunctions))"
  else warn "expected 409 backward-incompat, got $HTTP_CODE: $(jget "$BODY" errorName)"; fi
  H POST "/code-repositories/$RID/tags" '{"semver":"2.0.0","branch":"master"}' -H "Idempotency-Key: $(uuid)"
  [[ "$HTTP_CODE" == "201" ]] && ok "same drop with MAJOR bump v2.0.0 → published ($(jget "$BODY" functions))" || warn "v2.0.0 → $HTTP_CODE"
else warn "delete-commit → $HTTP_CODE"; fi

H POST "/functions/$RID/versions/2.0.0/yank?branch=master" '' -H "Idempotency-Key: $(uuid)"
[[ "$HTTP_CODE" == "200" ]] && ok "yanked v2.0.0 → state=$(jget "$BODY" state)" || warn "yank → $HTTP_CODE"

step "Demo complete"
ok "TypeScript Functions v2 — fullstack flow verified: author → ontology query/edit → tag&release → registry → invoke published → guardrails."
printf "  Ontology demo data left under ontology %s (Flight/Airport).\n" "$ONT"
