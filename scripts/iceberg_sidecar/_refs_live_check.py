#!/usr/bin/env python3
"""FOUNDRY-GAPS §6 — drive the REAL pb_b4_sidecar.py through the full
branch/tag/ref lifecycle against the live Lakekeeper + MinIO catalog.

Runs INSIDE the tellus Docker network (minio:9000 / lakekeeper:8181 resolve
natively — the production topology). Env: WAREHOUSE, NS, TABLE, AK, SK.
"""
import json
import os
import subprocess
import sys

import pyarrow as pa
import pyarrow.parquet as pq

WH = os.environ["WAREHOUSE"]
NS = os.environ["NS"]
TABLE = os.environ["TABLE"]
COMMON = dict(
    warehouse=WH, namespace=NS, table=TABLE,
    lakekeeper_url="http://lakekeeper:8181",
    s3_endpoint="http://minio:9000", s3_region="us-east-1",
    s3_access_key_id=os.environ["AK"], s3_secret_access_key=os.environ["SK"],
)
SIDE = "/sc/pb_b4_sidecar.py"
GREEN, RED, RST = "\033[32m", "\033[31m", "\033[0m"


def call(action, **extra):
    payload = json.dumps({"action": action, **COMMON, **extra})
    p = subprocess.run(["python3", SIDE], input=payload, capture_output=True, text=True)
    if p.returncode != 0:
        print(f"  {RED}✘ {action} exit={p.returncode}{RST}\n{p.stderr[-900:]}")
        sys.exit(1)
    return json.loads(p.stdout)


P = [0]
F = [0]


def snap(d):
    return str(d.get("snapshot_id", d.get("snapshotId")))


def check(label, cond, detail=""):
    if cond:
        P[0] += 1
        print(f"  {GREEN}✔{RST} {label}" + (f" — {detail}" if detail else ""))
    else:
        F[0] += 1
        print(f"  {RED}✘ {label}" + (f" — {detail}" if detail else "") + RST)


def main():
    print(f"\n── §6 refs LIVE in-network (warehouse={WH}, ns={NS}) ──\n")
    pq.write_table(pa.table({"id": [1, 2], "status": ["a", "b"]}), "/tmp/f1.parquet", compression="zstd")
    pq.write_table(pa.table({"id": [3], "status": ["c"]}), "/tmp/f2.parquet", compression="zstd")

    call("create_or_get", columns=[{"name": "id", "type": "integer"}, {"name": "status", "type": "string"}])
    a = call("append", parquet_files=["/tmp/f1.parquet"])
    snapA = snap(a)
    check("table created + first append committed a snapshot", snapA not in ("None", ""), f"snapshot={snapA}")

    br = call("create_branch", branch_name="dev")
    check("create_branch dev @ A", br.get("type") == "branch" and snap(br) == snapA, f"{br.get('type')}@{snap(br)}")
    tg = call("create_tag", tag_name="v1")
    check("create_tag v1 @ A", tg.get("type") == "tag" and snap(tg) == snapA, f"{tg.get('type')}@{snap(tg)}")

    refs = call("list_refs")["refs"]
    names = sorted(r["name"] for r in refs)
    check("list_refs shows main+dev+v1 (catalog persisted)", all(n in names for n in ["dev", "main", "v1"]), ",".join(names))
    byname = {r["name"]: r for r in refs}
    check("dev=branch, v1=tag in catalog metadata", byname.get("dev", {}).get("type") == "branch" and byname.get("v1", {}).get("type") == "tag")

    b = call("append", parquet_files=["/tmp/f2.parquet"])
    snapB = snap(b)
    check("second append advances main to snapshot B", snapB not in ("None", "") and snapB != snapA, f"B={snapB}")

    ff = call("fast_forward", branch_name="dev", to_ref="main")
    fwd = bool(ff.get("fast_forwarded", ff.get("fastForwarded")))
    check("fast_forward dev → main", fwd and snap(ff) == snapB, f"dev@{snap(ff)}")

    refs2 = {r["name"]: r for r in call("list_refs")["refs"]}
    check("dev advanced to B; v1 tag still pinned at A", str(refs2["dev"]["snapshot_id"]) == snapB and str(refs2["v1"]["snapshot_id"]) == snapA)

    dr = call("drop_ref", ref_name="v1")
    check("drop_ref v1 (type=tag)", dr.get("dropped") == "v1" and dr.get("type") == "tag")
    check("list_refs no longer has v1 (catalog mutated)", "v1" not in [r["name"] for r in call("list_refs")["refs"]])

    if F[0] == 0:
        print(f"\n{GREEN}✔ ALL LIVE §6 CHECKS PASSED{RST} — {P[0]} passed, {F[0]} failed\n")
    else:
        print(f"\n{RED}✘ SOME CHECKS FAILED{RST} — {P[0]} passed, {F[0]} failed\n")
    sys.exit(0 if F[0] == 0 else 1)


main()
