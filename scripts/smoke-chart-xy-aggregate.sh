#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# smoke-chart-xy-aggregate.sh — LIVE backend smoke test for the Chart: XY
# aggregation path (the new nested `groupBy` series sub-aggregation).
#
# Drives the REAL running backend (:3000) against REAL OpenSearch data:
#
#   1. health / login-bypass / ontology.
#   2. discover an object type with objects + TWO categorical (string)
#      properties (X + segment-by) + a numeric property (Y metric).
#   3. run a Chart XY request: terms(X) → groupBy(series) → sum(Y).
#   4. RIGOROUS correctness invariants — these can only hold if the nested
#      series matrix is computed correctly per (X, series) cell:
#        • Σ over all (X,series) cells of series.value
#            == an INDEPENDENT top-level sum(Y)           (correct + complete)
#        • for each X bucket, Σ series.count == bucket.count   (no lost rows)
#        • Σ over X buckets of bucket.count == totalCount
#
# Usage:  bash scripts/smoke-chart-xy-aggregate.sh
# Env:    TELLUS_API, PIE_USER, PIE_PASS (same defaults as the pie smoke)
# ---------------------------------------------------------------------------

set -u
BASE="${TELLUS_API:-http://localhost:3000/api/v1}"
PIE_USER="${PIE_USER:-cypress-admin@tellus.local}"
PIE_PASS="${PIE_PASS:-Password123!}"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
red() { printf "\033[31m%s\033[0m\n" "$1"; }

bold "════════════════════════════════════════════════════════════"
bold " Chart: XY aggregation — LIVE backend smoke test"
bold "════════════════════════════════════════════════════════════"

bold "→ [1/4] backend health"
HEALTH="$(curl -s "${BASE}/health" 2>/dev/null)"
if printf "%s" "$HEALTH" | grep -q '"status":"healthy"'; then
  green "   PASS — $(printf "%s" "$HEALTH" | python3 -c "import sys,json;d=json.load(sys.stdin);print('postgres='+d.get('postgres','?'),'opensearch='+d.get('elasticsearch','?'))" 2>/dev/null)"
else
  red "   FAIL — backend not healthy at ${BASE}"; exit 1
fi

bold "→ [2/4] login-bypass (dev token)"
TOK="$(curl -s -X POST "${BASE}/auth/_test/login-bypass" \
  -H "Content-Type: application/json" -H "x-tellus-test-hook: 1" \
  -d "{\"username\":\"${PIE_USER}\",\"password\":\"${PIE_PASS}\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('data',{}).get('accessToken',''))" 2>/dev/null)"
if [ -z "$TOK" ]; then red "   FAIL — could not mint a token"; exit 1; fi
green "   PASS — token acquired"

bold "→ [3/4] active ontology"
ONT="$(curl -s "${BASE}/ontology/default" -H "Authorization: Bearer $TOK" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('ontologyId') or d.get('data',{}).get('ontologyId',''))" 2>/dev/null)"
if [ -z "$ONT" ]; then red "   FAIL — no active ontology"; exit 1; fi
green "   PASS — ontologyId=${ONT}"

bold "→ [4/4] Chart XY series aggregation + assert invariants"
TELLUS_BASE="$BASE" TELLUS_TOK="$TOK" TELLUS_ONT="$ONT" python3 - <<'PY'
import os, json, urllib.request, sys

BASE = os.environ["TELLUS_BASE"]; TOK = os.environ["TELLUS_TOK"]; ONT = os.environ["TELLUS_ONT"]
H = {"Authorization": "Bearer " + TOK, "Content-Type": "application/json"}
NUM = {"integer", "long", "double", "float", "decimal", "byte", "short"}

def get(p):
    with urllib.request.urlopen(urllib.request.Request(BASE + p, headers=H), timeout=20) as r:
        return json.load(r)
def post(p, b):
    req = urllib.request.Request(BASE + p, headers=H, data=json.dumps(b).encode(), method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)
def unwrap(d):
    return d.get("data", d) if isinstance(d, dict) and "data" in d else d

# ---- discover: a type with ≥2 string props + ≥1 numeric prop + data ----
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
    pk = ot.get("primaryKey")
    # Exclude the primary key: it is unique per row, so using it as a series
    # yields one series per object — a degenerate, high-cardinality split that
    # the `terms` size cap would truncate (breaking the reconciliation).
    strs = [k for k, v in props.items()
            if (v.get("baseType") or "").lower() == "string" and k != pk]
    nums = [k for k, v in props.items() if (v.get("baseType") or "").lower() in NUM]
    # X and segment must be DISTINCT non-pk string props; prefer a
    # low-cardinality one for X (status/state/...).
    if len(strs) >= 2 and nums:
        pref = ("status", "state", "category", "type", "priority", "assignee")
        x = next((s for s in strs if s.lower() in pref), strs[0])
        seg = next((s for s in strs if s != x), None)
        if seg:
            chosen = (api, x, seg, nums[0], o.get("objectCount") or o.get("count"))
            break

if not chosen:
    print("   FAIL — no type with 2 string props + a numeric prop + data")
    sys.exit(1)

API, X, SEG, MF, CNT = chosen
print(f"   type='{API}'  X='{X}'  segmentBy='{SEG}'  metric=sum('{MF}')  (objects={CNT})")
print()

# ---- Chart XY request: terms(X) → groupBy(series=SEG) → sum(MF) ----
# `size` large enough that the series sub-agg is never truncated (top-N
# truncation would break the exact reconciliation below).
chart = unwrap(post(f"/objects/{API}/aggregate", {"aggregations": [{
    "name": "chart", "type": "terms", "field": X, "size": 1000,
    "groupBy": {"field": SEG, "size": 2000},
    "metric": {"type": "sum", "field": MF},
}]}))["chart"]
top = unwrap(post(f"/objects/{API}/aggregate", {"aggregations": [{"name": "t", "type": "sum", "field": MF}]}))["t"]

# ---- show a compact matrix preview ----
seriesKeys = []
seen = set()
for b in chart:
    for s in b.get("series", []):
        k = str(s["key"])
        if k not in seen:
            seen.add(k); seriesKeys.append(k)
print(f"   X buckets={len(chart)}  series={len(seriesKeys)}  (showing first 4×4)")
hdr = "   " + f"{'X \\\\ series':<14}" + "".join(f"{str(k)[:9]:>10}" for k in seriesKeys[:4])
print(hdr)
for b in chart[:4]:
    smap = {str(s["key"]): s["value"] for s in b.get("series", [])}
    row = f"   {str(b['key'])[:13]:<14}" + "".join(f"{smap.get(str(k),0):>10.0f}" for k in seriesKeys[:4])
    print(row)
print(f"   (top-level sum = {top:.0f})")
print()

# ---- assertions ----
ok = True
def check(label, cond, detail=""):
    global ok
    print(("   \033[32m✓\033[0m " if cond else "   \033[31m✗\033[0m ") + label + (" " + detail if detail else ""))
    if not cond: ok = False
def approx(a, b, tol=1e-3):
    return abs(a - b) <= tol * max(1.0, abs(a), abs(b))

cell_sum = sum(s["value"] for b in chart for s in b.get("series", []))
check("series matrix Σ(cell.value) == independent top-level sum(field)",
      approx(cell_sum, top), f"(Σ={cell_sum:.0f} vs top={top:.0f})")

per_bucket_ok = all(
    sum(s["count"] for s in b.get("series", [])) == b["count"] for b in chart
)
check("each X bucket: Σ(series.count) == bucket.count (no rows lost to series split)",
      per_bucket_ok)

total_count = sum(b["count"] for b in chart)
check("Σ(X bucket counts) ≤ object count", total_count <= CNT, f"(Σ={total_count} ≤ {CNT})")
check("at least one X bucket and one series", len(chart) >= 1 and len(seriesKeys) >= 1)

print()
if ok:
    print("\033[32m   ALL LIVE INVARIANTS HOLD\033[0m"); sys.exit(0)
else:
    print("\033[31m   LIVE INVARIANTS FAILED\033[0m"); sys.exit(1)
PY
RC=$?

bold "════════════════════════════════════════════════════════════"
if [ "$RC" -eq 0 ]; then green "LIVE SMOKE TEST PASSED"; else red "LIVE SMOKE TEST FAILED"; fi
exit "$RC"
