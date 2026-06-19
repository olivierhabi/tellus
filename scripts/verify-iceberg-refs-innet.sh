#!/usr/bin/env bash
# FOUNDRY-GAPS §6 — LIVE in-network verification of Iceberg branches & tags.
#
# Runs the REAL production sidecar (scripts/iceberg_sidecar/pb_b4_sidecar.py)
# inside the tellus Docker network, so `minio:9000` / `lakekeeper:8181`
# resolve natively (the production topology — no host DNS override, native
# PyArrow S3 IO). Drives the full ref lifecycle against the live catalog and
# asserts the catalog persisted each ref.
set -euo pipefail
cd "$(dirname "$0")/.."

WAREHOUSE="${WAREHOUSE:-refs-test}"
NET="${NET:-tellus_default}"
NS="_refs_innet.t_$(date +%s)"
TABLE="refs_demo"
AK="${S3_ACCESS_KEY_ID:-tellus-s3-49f524d9}"
SK="${S3_SECRET_ACCESS_KEY:-kYJtYYunruhlPtOow9PD5FyRa36BXPM}"

docker run --rm --network "$NET" \
  -v "$PWD/scripts/iceberg_sidecar:/sc:ro" \
  -e WAREHOUSE -e NS="$NS" -e TABLE -e AK -e SK \
  python:3.12-slim bash -c '
set -e
pip install --quiet --disable-pip-version-check "pyiceberg[s3fs]==0.11.1" pyarrow >/dev/null 2>&1
python3 - <<PY
import json, subprocess, sys
import pyarrow as pa, pyarrow.parquet as pq

WH="'"$WAREHOUSE"'"; NS="'"$NS"'"; TABLE="'"$TABLE"'"
COMMON=dict(warehouse=WH, namespace=NS, table=TABLE,
            lakekeeper_url="http://lakekeeper:8181",
            s3_endpoint="http://minio:9000", s3_region="us-east-1",
            s3_access_key_id="'"$AK"'", s3_secret_access_key="'"$SK"'")

def call(action, **extra):
    payload=json.dumps({"action":action, **COMMON, **extra})
    p=subprocess.run(["python3","/sc/pb_b4_sidecar.py"], input=payload,
                     capture_output=True, text=True)
    if p.returncode!=0:
        print(f"  \033[31m✘ {action} exit={p.returncode}\033[0m\n{p.stderr[-800:]}"); sys.exit(1)
    return json.loads(p.stdout)

P=[0]; F=[0]
def check(label, cond, detail=""):
    if cond: P[0]+=1; print(f"  \033[32m✔\033[0m {label}" + (f" — {detail}" if detail else ""))
    else: F[0]+=1; print(f"  \033[31m✘ {label}" + (f" — {detail}" if detail else "") + "\033[0m")

print(f"\n── §6 refs LIVE in-network (warehouse={WH}, ns={NS}) ──\n")

# fixture parquet
pq.write_table(pa.table({"id":[1,2],"status":["a","b"]}), "/tmp/f1.parquet", compression="zstd")
pq.write_table(pa.table({"id":[3],"status":["c"]}), "/tmp/f2.parquet", compression="zstd")

call("create_or_get", columns=[{"name":"id","type":"integer"},{"name":"status","type":"string"}])
a=call("append", parquet_files=["/tmp/f1.parquet"]); snapA=str(a.get("snapshot_id") or a.get("snapshotId"))
check("table created + first append committed a snapshot", snapA not in ("None",""), f"snapshot={snapA}")

br=call("create_branch", branch_name="dev"); check("create_branch dev @ A", br.get("type")=="branch" and str(br.get("snapshot_id") or br.get("snapshotId"))==snapA, f"{br.get(chr(39)+chr(39))}{br}")
tg=call("create_tag", tag_name="v1"); check("create_tag v1 @ A", tg.get("type")=="tag")

refs=call("list_refs")["refs"]; names=sorted(r["name"] for r in refs)
check("list_refs shows main+dev+v1 (catalog persisted)", all(n in names for n in ["dev","main","v1"]), ",".join(names))
byname={r["name"]:r for r in refs}
check("dev=branch, v1=tag in catalog metadata", byname.get("dev",{}).get("type")=="branch" and byname.get("v1",{}).get("type")=="tag")

b=call("append", parquet_files=["/tmp/f2.parquet"]); snapB=str(b.get("snapshot_id") or b.get("snapshotId"))
check("second append advances main to snapshot B", snapB not in ("None","") and snapB!=snapA, f"B={snapB}")

ff=call("fast_forward", branch_name="dev", to_ref="main")
check("fast_forward dev → main", bool(ff.get("fast_forwarded") or ff.get("fastForwarded")) and str(ff.get("snapshot_id") or ff.get("snapshotId"))==snapB, f"dev@{ff.get(\"snapshot_id\") or ff.get(\"snapshotId\")}")

refs2={r["name"]:r for r in call("list_refs")["refs"]}
check("dev advanced to B; v1 tag still pinned at A", str(refs2["dev"]["snapshot_id"])==snapB and str(refs2["v1"]["snapshot_id"])==snapA)

dr=call("drop_ref", ref_name="v1"); check("drop_ref v1 (type=tag)", dr.get("dropped")=="v1" and dr.get("type")=="tag")
check("list_refs no longer has v1 (catalog mutated)", "v1" not in [r["name"] for r in call("list_refs")["refs"]])

print(f"\n{(chr(27)+chr(91)+chr(51)+chr(50)+chr(109)+chr(10004)+chr(32)+chr(65)+chr(76)+chr(76)+chr(32)+chr(80)+chr(65)+chr(83)+chr(83)) if F[0]==0 else (chr(27)+chr(91)+chr(51)+chr(49)+chr(109)+chr(10008)+chr(32)+chr(70)+chr(65)+chr(73)+chr(76))} — {P[0]} passed, {F[0]} failed\033[0m\n")
sys.exit(0 if F[0]==0 else 1)
PY
'
