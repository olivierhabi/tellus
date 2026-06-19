# ---------------------------------------------------------------------------
# FOUNDRY-GAPS §6 — LIVE proof: atomic multi-table (cross-dataset) commit.
#
# Proves the NEW capability behind the sidecar's `action_multi_table_commit`
# (scripts/iceberg_sidecar/pb_b4_sidecar.py) + `icebergMultiTableCommit`
# (src/services/pipelines/icebergSidecar.ts): committing changes to MULTIPLE
# Iceberg tables ATOMICALLY through one Iceberg REST `transactions/commit`
# call, which Lakekeeper implements. Either every table advances or none do.
#
# It exercises the EXACT request-assembly the sidecar action uses — one
# CommitTableRequest per table (requirements incl. AssertTableUUID + updates),
# wrapped as {"table-changes":[...]} and POSTed to `transactions/commit` — and
# asserts:
#   1. happy path  → both tables advance in ONE transaction (HTTP 200).
#   2. all-or-nothing → a failing per-table requirement rejects the WHOLE
#      transaction (HTTP 409); the other table does NOT change.
#
# The updates here are metadata (SetProperties) rather than data appends, so
# the proof needs NO client→S3 write: Iceberg REST metadata commits are applied
# server-side by the catalog. The production action appends data files via the
# same assembly; that data-write leg is identical to the single-table `append`
# (its client→S3 path is environment-dependent — Trino / the in-process writer
# are the data-plane writers in the local dev stack).
#
# Run inside the docker network (production topology) via:
#   bash scripts/verify-multi-table-commit.sh
# ---------------------------------------------------------------------------
import json
import os
import sys
import urllib.request
from uuid import uuid4

from pyiceberg.catalog import load_catalog
from pyiceberg.table import CommitTableRequest, TableIdentifier
from pyiceberg.table.update import AssertTableUUID, SetPropertiesUpdate
from pyiceberg.schema import Schema
from pyiceberg.types import NestedField, LongType

GREEN, RED, CYAN, RESET = "\033[32m", "\033[31m", "\033[1;36m", "\033[0m"
def step(m): print(f"\n{CYAN}── {m} ──{RESET}", flush=True)
def ok(m): print(f"{GREEN}✔ {m}{RESET}", flush=True)
def fail(m): print(f"{RED}✘ {m}{RESET}", flush=True); sys.exit(1)

WH = os.environ.get("MTC_WAREHOUSE", "mtc-mn")
LK = os.environ.get("LAKEKEEPER_URL", "http://lakekeeper:8181")
S3_ENDPOINT = os.environ.get("MTC_S3_ENDPOINT", "http://minio:9000")
S3_KEY = os.environ.get("S3_ACCESS_KEY_ID", "")
S3_SECRET = os.environ.get("S3_SECRET_ACCESS_KEY", "")


def ensure_warehouse():
    listing = json.load(urllib.request.urlopen(f"{LK}/management/v1/warehouse"))
    names = [w["name"] for w in listing.get("warehouses", [])]
    if WH in names:
        return
    body = json.dumps({
        "warehouse-name": WH,
        "project-id": "00000000-0000-0000-0000-000000000000",
        "storage-profile": {
            "type": "s3", "bucket": "iceberg-warehouse", "key-prefix": "_mtc_mn",
            "endpoint": "http://minio:9000", "region": "us-east-1",
            "path-style-access": True, "flavor": "minio", "sts-enabled": False,
        },
        "storage-credential": {
            "type": "s3", "credential-type": "access-key",
            "aws-access-key-id": S3_KEY, "aws-secret-access-key": S3_SECRET,
        },
    }).encode()
    urllib.request.urlopen(urllib.request.Request(
        f"{LK}/management/v1/warehouse", data=body,
        headers={"Content-Type": "application/json"}, method="POST"))


def catalog():
    return load_catalog("mtc", **{
        "type": "rest", "uri": f"{LK}/catalog", "warehouse": WH,
        "s3.endpoint": S3_ENDPOINT, "s3.region": os.environ.get("S3_REGION", "us-east-1"),
        "s3.path-style-access": "true",
        "s3.access-key-id": S3_KEY, "s3.secret-access-key": S3_SECRET,
        "py-io-impl": "pyiceberg.io.fsspec.FsspecFileIO",
    })


def multi_commit(cat, table_props, requirements_override=None):
    """Assemble + POST a multi-table transactions/commit — the same wire format
    action_multi_table_commit builds."""
    reqs = []
    for tbl, props in table_props:
        name = tbl.name()
        requirements = requirements_override(tbl) if requirements_override else (
            AssertTableUUID(uuid=tbl.metadata.table_uuid),
        )
        reqs.append(CommitTableRequest(
            identifier=TableIdentifier(namespace=name[:-1], name=name[-1]),
            requirements=requirements,
            updates=(SetPropertiesUpdate(updates=props),),
        ))
    body = {"table-changes": [json.loads(r.model_dump_json()) for r in reqs]}
    resp = cat._session.post(cat.url("transactions/commit", prefixed=True),
                             data=json.dumps(body).encode(), headers=cat._session.headers)
    return resp.status_code, resp.text[:200]


def main():
    if not S3_KEY or not S3_SECRET:
        fail("S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY must be set")

    step(f"0. ensure test warehouse '{WH}'")
    ensure_warehouse(); ok(f"warehouse '{WH}' ready")

    cat = catalog()
    ns = "mtc_" + uuid4().hex[:8]
    sch = Schema(NestedField(1, "id", LongType(), required=False))
    step(f"1. create two datasets (namespace {ns})")
    try: cat.create_namespace(ns)
    except Exception: pass
    ta = cat.create_table(f"{ns}.orders", schema=sch)
    tb = cat.create_table(f"{ns}.audit", schema=sch)
    ok("orders + audit created")

    step("2. ATOMIC commit: advance BOTH tables in ONE transaction")
    code, txt = multi_commit(cat, [(ta, {"mtc.batch": "1"}), (tb, {"mtc.batch": "1"})])
    if code not in (200, 204):
        fail(f"atomic commit rejected: HTTP {code} {txt}")
    ra, rb = cat.load_table(f"{ns}.orders"), cat.load_table(f"{ns}.audit")
    if ra.properties.get("mtc.batch") != "1" or rb.properties.get("mtc.batch") != "1":
        fail(f"both tables should carry mtc.batch=1: orders={ra.properties} audit={rb.properties}")
    ok(f"BOTH datasets advanced atomically in one transactions/commit (HTTP {code})")

    step("3. ALL-OR-NOTHING: a failing per-table requirement rejects the WHOLE txn")
    def reqs_for(tbl):
        if tbl.name()[-1] == "audit":
            return (AssertTableUUID(uuid=uuid4()),)  # stale uuid → must fail
        return (AssertTableUUID(uuid=tbl.metadata.table_uuid),)
    before = cat.load_table(f"{ns}.orders").properties.get("mtc.batch")
    code2, _ = multi_commit(
        cat,
        [(cat.load_table(f"{ns}.orders"), {"mtc.batch": "2"}),
         (cat.load_table(f"{ns}.audit"), {"mtc.batch": "2"})],
        requirements_override=reqs_for,
    )
    if code2 in (200, 204):
        fail(f"expected the transaction to be REJECTED, got HTTP {code2}")
    after = cat.load_table(f"{ns}.orders").properties.get("mtc.batch")
    if not (before == after == "1"):
        fail(f"PARTIAL COMMIT: orders changed {before}->{after} despite the audit requirement failing")
    ok(f"whole transaction rejected (HTTP {code2}); orders UNCHANGED (mtc.batch={after}) — no partial cross-dataset write")

    print(f"\n{GREEN}✔ §6 atomic multi-table transactions verified on real Lakekeeper{RESET}", flush=True)
    print(f"  (test namespace {ns} in warehouse {WH} left for inspection)")


if __name__ == "__main__":
    main()
