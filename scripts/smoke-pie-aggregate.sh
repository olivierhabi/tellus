#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# smoke-pie-aggregate.sh — LIVE backend smoke test for the Pie Chart
# aggregation path (the new `terms` group-by + nested per-bucket metric).
#
# Unlike the mocked unit test, this drives the REAL running backend
# (:3000) against REAL indexed OpenSearch data, end-to-end:
#
#   1. health        — backend reports healthy.
#   2. login-bypass  — mint a dev token (NODE_ENV != production).
#   3. discover      — auto-pick an object type with objects + a categorical
#                      (string) property to group by + a numeric property to
#                      aggregate.
#   4. aggregate     — run count / sum / avg / approximate-unique-count, each
#                      grouped by the categorical property.
#   5. assert        — RIGOROUS correctness invariants that can only hold if
#                      the nested metric is computed correctly per bucket:
#                        • count : every bucket.value == bucket.count
#                        • sum   : Σ(bucket.value) == an INDEPENDENT top-level
#                                  sum(field)         (correct + complete)
#                        • avg   : Σ(bucket.value × bucket.count) == top-level
#                                  sum(field)         (per-bucket avg correct)
#                        • approx-unique : every bucket.value ≤ bucket.count
#
# Usage:  bash scripts/smoke-pie-aggregate.sh
# Env:    TELLUS_API (default http://localhost:3000/api/v1)
#         PIE_USER / PIE_PASS (default cypress-admin@tellus.local / Password123!)
# ---------------------------------------------------------------------------

set -u
BASE="${TELLUS_API:-http://localhost:3000/api/v1}"
PIE_USER="${PIE_USER:-cypress-admin@tellus.local}"
PIE_PASS="${PIE_PASS:-Password123!}"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
red() { printf "\033[31m%s\033[0m\n" "$1"; }

bold "════════════════════════════════════════════════════════════"
bold " Pie Chart aggregation — LIVE backend smoke test"
bold "════════════════════════════════════════════════════════════"

# --- 1. health -------------------------------------------------------------
bold "→ [1/5] backend health"
HEALTH="$(curl -s "${BASE}/health" 2>/dev/null)"
if printf "%s" "$HEALTH" | grep -q '"status":"healthy"'; then
  green "   PASS — $(printf "%s" "$HEALTH" | python3 -c "import sys,json;d=json.load(sys.stdin);print('postgres='+d.get('postgres','?'),'opensearch='+d.get('elasticsearch','?'))" 2>/dev/null)"
else
  red "   FAIL — backend not healthy at ${BASE} (is the dev stack up?)"; exit 1
fi

# --- 2. login --------------------------------------------------------------
bold "→ [2/5] login-bypass (dev token)"
TOK="$(curl -s -X POST "${BASE}/auth/_test/login-bypass" \
  -H "Content-Type: application/json" -H "x-tellus-test-hook: 1" \
  -d "{\"username\":\"${PIE_USER}\",\"password\":\"${PIE_PASS}\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('data',{}).get('accessToken',''))" 2>/dev/null)"
if [ -z "$TOK" ]; then
  red "   FAIL — could not mint a token (check PIE_USER/PIE_PASS)"; exit 1
fi
green "   PASS — token acquired"

# --- 3. ontology -----------------------------------------------------------
bold "→ [3/5] active ontology"
ONT="$(curl -s "${BASE}/ontology/default" -H "Authorization: Bearer $TOK" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('ontologyId') or d.get('data',{}).get('ontologyId',''))" 2>/dev/null)"
if [ -z "$ONT" ]; then red "   FAIL — no active ontology"; exit 1; fi
green "   PASS — ontologyId=${ONT}"

# --- 4 + 5. discover + aggregate + assert (Python does the HTTP heavy work) -
bold "→ [4/5] discover a type with objects + string + numeric properties"
bold "→ [5/5] aggregate (count / sum / avg / approx-unique) + assert invariants"

TELLUS_BASE="$BASE" TELLUS_TOK="$TOK" TELLUS_ONT="$ONT" python3 - <<'PY'
import os, json, urllib.request, urllib.error, sys

BASE = os.environ["TELLUS_BASE"]; TOK = os.environ["TELLUS_TOK"]; ONT = os.environ["TELLUS_ONT"]
H = {"Authorization": "Bearer " + TOK, "Content-Type": "application/json"}
NUM = {"integer", "long", "double", "float", "decimal", "byte", "short"}
PREFERRED = ("status", "state", "category", "type", "priority", "assignee", "region", "customerid")

def get(path):
    req = urllib.request.Request(BASE + path, headers=H)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)

def post(path, body):
    req = urllib.request.Request(BASE + path, headers=H, data=json.dumps(body).encode(), method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def unwrap(d):  # tolerate {data:{...}} and bare {...}
    return d.get("data", d) if isinstance(d, dict) and "data" in d else d

# ---- discover ----
ot_resp = get(f"/ontology/{ONT}/objectTypes")
items = ot_resp if isinstance(ot_resp, list) else (ot_resp.get("data") or ot_resp.get("objectTypes") or [])
items = [o for o in items if (o.get("objectCount") or o.get("count") or 0) > 0]
items.sort(key=lambda o: -(o.get("objectCount") or o.get("count") or 0))

chosen = None
for o in items[:20]:
    api = o.get("apiName")
    try:
        det = get(f"/ontology/{ONT}/objectTypes/{api}")
    except Exception:
        continue
    ot = det.get("objectType") or det.get("data", {}).get("objectType") or det
    props = ot.get("properties") or {}
    strs = [k for k, v in props.items() if (v.get("baseType") or "").lower() == "string"]
    nums = [k for k, v in props.items() if (v.get("baseType") or "").lower() in NUM]
    if strs and nums:
        gb = next((s for s in strs if s.lower() in PREFERRED), strs[0])
        chosen = (api, gb, nums[0], o.get("objectCount") or o.get("count"))
        break

if not chosen:
    print("   FAIL — no object type with both a string and a numeric property + data")
    sys.exit(1)

API, GB, MF, CNT = chosen
print(f"   using type='{API}'  groupBy='{GB}'  metricField='{MF}'  (objects={CNT})")
print()

# ---- aggregations ----
def agg(metric=None):
    a = {"name": "g", "type": "terms", "field": GB}
    if metric:
        a["metric"] = metric
    return unwrap(post(f"/objects/{API}/aggregate", {"aggregations": [a]}))["g"]

cnt   = agg(None)
asum  = agg({"type": "sum", "field": MF})
aavg  = agg({"type": "avg", "field": MF})
acard = agg({"type": "cardinality", "field": MF})
top   = unwrap(post(f"/objects/{API}/aggregate", {"aggregations": [{"name": "t", "type": "sum", "field": MF}]}))["t"]

# ---- pretty table ----
print(f"   {'segment':<16}{'count':>8}{'sum':>12}{'avg':>12}{'≈unique':>10}")
sm = {b["key"]: b["value"] for b in asum}
av = {b["key"]: b["value"] for b in aavg}
cd = {b["key"]: b["value"] for b in acard}
for b in cnt:
    k = b["key"]
    print(f"   {str(k)[:15]:<16}{b['count']:>8}{sm.get(k,0):>12.0f}{av.get(k,0):>12.2f}{cd.get(k,0):>10.0f}")
print(f"   {'(top-level sum)':<16}{'':>8}{top:>12.0f}")
print()

# ---- assertions ----
ok = True
def check(label, cond, detail=""):
    global ok
    if cond:
        print(f"   \033[32m✓\033[0m {label} {detail}")
    else:
        print(f"   \033[31m✗\033[0m {label} {detail}")
        ok = False

def approx(a, b, tol=1e-6):
    return abs(a - b) <= tol * max(1.0, abs(a), abs(b))

check("group-by returns ≥1 slice", len(cnt) >= 1, f"({len(cnt)} slices)")
check("count: every bucket.value == bucket.count",
      all(b["value"] == b["count"] for b in cnt))
check("count: Σ(slice counts) ≤ totalCount",
      sum(b["count"] for b in cnt) <= CNT, f"(Σ={sum(b['count'] for b in cnt)} ≤ {CNT})")

sum_of_sums = sum(b["value"] for b in asum)
check("sum: Σ(bucket.value) == independent top-level sum(field)",
      approx(sum_of_sums, top), f"(Σ={sum_of_sums:.0f} vs top={top:.0f})")

cntmap = {b["key"]: b["count"] for b in cnt}
weighted = sum(av[k] * cntmap.get(k, 0) for k in av)
check("avg: Σ(bucket.avg × bucket.count) == top-level sum(field)",
      approx(weighted, top, tol=1e-3), f"(Σ={weighted:.0f} vs top={top:.0f})")

check("approx-unique: every bucket.value ≤ bucket.count",
      all(cd.get(b["key"], 0) <= b["count"] for b in cnt))

print()
if ok:
    print("\033[32m   ALL LIVE INVARIANTS HOLD\033[0m")
    sys.exit(0)
else:
    print("\033[31m   LIVE INVARIANTS FAILED\033[0m")
    sys.exit(1)
PY
RC=$?

bold "════════════════════════════════════════════════════════════"
if [ "$RC" -eq 0 ]; then green "LIVE SMOKE TEST PASSED"; else red "LIVE SMOKE TEST FAILED"; fi
exit "$RC"
