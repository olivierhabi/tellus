#!/usr/bin/env python3
"""PyIceberg sidecar for PB-B4 — Iceberg writes via the Lakekeeper REST catalog.

Invoked by Node.js through `child_process.spawn`: one invocation per action,
one JSON document on stdin, one JSON document on stdout, exit code 0 for
success / nonzero for failure. Structured stderr carries diagnostic logs.

This sits where the PB-B2 spec says the "PyIceberg sidecar shared with
Funnel" should live — it is the honest way to commit Iceberg snapshots
(create-table, append data files, rollback_to_snapshot, list snapshots,
time-travel scan) given that DuckDB's Iceberg extension is read-only on
the versions shipped with this repo.

Actions
=======
- create_or_get   — idempotently create `<warehouse>/<namespace>/<table>`
                    with the given schema + partition spec. Returns the
                    current snapshot id (None if newly created).
- append          — register `parquet_files` (absolute s3:// paths or
                    local paths) as a new snapshot. Returns the produced
                    snapshot id + the prior snapshot id.
- rollback        — rollback_to_snapshot(snapshot_id). Prior data files
                    remain accessible for time-travel reads.
- snapshots       — list snapshots for (snapshot_id, parent_id,
                    timestamp_ms, operation, summary).
- scan_as_of      — run a `LIMIT` scan at a specific snapshot_id and
                    return the rows as JSON (honest limits: no row
                    streaming; callers should use DuckDB iceberg_scan for
                    big results and use this only for metadata/preview).
- expire          — expire_snapshots(older_than=now-retention_days,
                    retain_last=keep_last). Used by the compaction worker.
- compact         — rewrite_data_files(). Reduces small-file count.

Stdin shape
===========
{
  "action": "<name>",
  "warehouse": "tellus-funnel",
  "namespace": "_pipeline.proj_abcd.pipe_1234",
  "table": "output",
  "lakekeeper_url": "http://localhost:8181",
  "s3_endpoint": "http://localhost:9000",
  "s3_region": "us-east-1",
  "s3_access_key_id": "...",
  "s3_secret_access_key": "...",
  ... action-specific fields ...
}
"""
from __future__ import annotations

import json
import os
import socket as _socket
import sys
import traceback
from typing import Any, Dict, List, Optional


def _log(msg: str) -> None:
    print(f"[pb-b4-sidecar] {msg}", file=sys.stderr, flush=True)


def _install_dev_dns_override() -> None:
    """Opt-in DNS shim for host-network dev invocations.

    Lakekeeper's warehouse storage profile is registered with the
    docker-internal hostnames (`http://minio:9000`, `http://lakekeeper:8181`).
    When the sidecar runs *outside* the docker network we'd need `minio`
    and `lakekeeper` in /etc/hosts (root required). The production
    sidecar runs inside the cluster, where real DNS resolves these
    names, so this override is off by default.

    Triggered by `PB_B4_LOCAL_DNS_OVERRIDE=1`. Mapping is read from
    comma-separated `PB_B4_LOCAL_DNS_MAP` (default maps `minio` +
    `lakekeeper` to 127.0.0.1).
    """
    if os.environ.get("PB_B4_LOCAL_DNS_OVERRIDE") != "1":
        return
    default_map = "minio=127.0.0.1,lakekeeper=127.0.0.1"
    raw = os.environ.get("PB_B4_LOCAL_DNS_MAP", default_map)
    overrides: Dict[str, str] = {}
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        host, _, ip = entry.partition("=")
        if host and ip:
            overrides[host.strip()] = ip.strip()
    if not overrides:
        return
    original = _socket.getaddrinfo

    def patched(host, *args, **kwargs):  # noqa: ANN001
        if isinstance(host, str) and host in overrides:
            host = overrides[host]
        return original(host, *args, **kwargs)

    _socket.getaddrinfo = patched  # type: ignore[assignment]


_install_dev_dns_override()


def _install_dev_s3_endpoint_override() -> None:
    """Complement to _install_dev_dns_override: libcurl (used by
    pyarrow's native S3 filesystem) bypasses Python's socket layer, so
    DNS shimming alone isn't enough. We also force pyarrow's
    S3FileSystem to use the caller-supplied endpoint by patching its
    constructor to replace the docker-internal MinIO host with the
    external one. Off by default; enable with
    `PB_B4_LOCAL_DNS_OVERRIDE=1` (same switch as the DNS patch).
    """
    if os.environ.get("PB_B4_LOCAL_DNS_OVERRIDE") != "1":
        return
    override_endpoint = os.environ.get(
        "PB_B4_LOCAL_S3_ENDPOINT_OVERRIDE",
        "http://localhost:9000",
    )

    try:
        import pyarrow.fs as _pafs  # type: ignore
    except Exception:
        return

    if getattr(_pafs, "_pb_b4_endpoint_patched", False):
        return

    # PyArrow's S3FileSystem is a C-extension with an immutable __init__.
    # In dev we pivot entirely to the Fsspec FileIO (selected in
    # _load_catalog via properties) which respects Python's socket layer.
    # Here we only tag the module so the other monkey-patches know the
    # override is active.
    _pafs._pb_b4_endpoint_patched = True  # type: ignore[attr-defined]
    _pafs._pb_b4_override_endpoint = override_endpoint  # type: ignore[attr-defined]


_install_dev_s3_endpoint_override()


def _patch_pyiceberg_rest_uri_override(external_uri: str) -> None:
    """Lakekeeper's `/v1/config` response advertises an internal docker
    URL (e.g. http://lakekeeper:8181/catalog) in its `overrides.uri`
    field. PyIceberg's RestCatalog merges those overrides over the
    caller-supplied `uri`, which breaks host-network sidecar invocations
    that cannot resolve the docker-internal hostname.

    We patch `_fetch_config` so the `uri` field in `overrides` is
    rewritten back to the caller-supplied URL on every catalog creation.
    Idempotent: safe to call multiple times; does nothing on pyiceberg
    versions whose shape doesn't match.
    """
    try:
        from pyiceberg.catalog import rest as _rest  # type: ignore
    except Exception:
        return
    if getattr(_rest, "_pb_b4_patched", False):
        return
    original = _rest.RestCatalog._fetch_config  # type: ignore[attr-defined]

    def _patched(self):  # noqa: ANN001
        # PyIceberg mutates self.properties + self.uri inside the call;
        # let it run, then pin both back to the caller-supplied URL.
        result = original(self)
        target = external_uri.rstrip("/") + "/catalog"
        try:
            self.uri = target
        except Exception:  # noqa: BLE001
            pass
        try:
            self.properties["uri"] = target  # type: ignore[index]
        except Exception:  # noqa: BLE001
            pass
        return result

    _rest.RestCatalog._fetch_config = _patched  # type: ignore[attr-defined]
    _rest._pb_b4_patched = True  # type: ignore[attr-defined]


def _load_catalog(cfg: Dict[str, Any]):
    # PyIceberg loads the Iceberg REST catalog via `load_catalog`. The
    # Lakekeeper endpoint accepts the standard REST API at
    # `/catalog/<warehouse-id>/v1/...` — but PyIceberg wants the
    # top-level `uri` and the warehouse name; it resolves internally.
    from pyiceberg.catalog import load_catalog

    lk = cfg["lakekeeper_url"]
    _patch_pyiceberg_rest_uri_override(lk)
    warehouse = cfg["warehouse"]
    properties = {
        "uri": lk.rstrip("/") + "/catalog",
        "warehouse": warehouse,
        "s3.endpoint": cfg.get("s3_endpoint", "http://localhost:9000"),
        "s3.region": cfg.get("s3_region", "us-east-1"),
        "s3.access-key-id": cfg.get("s3_access_key_id", "minioadmin"),
        "s3.secret-access-key": cfg.get("s3_secret_access_key", "minioadmin"),
        "s3.path-style-access": "true",
    }
    # In dev (PB_B4_LOCAL_DNS_OVERRIDE=1) route IO through pyiceberg's
    # Fsspec FileIO (which uses s3fs on top of Python aiohttp) instead of
    # the native PyArrow S3FileSystem. s3fs honours Python's socket.
    # getaddrinfo patch from _install_dev_dns_override so the docker-
    # internal `minio:9000` hostname resolves to 127.0.0.1 automatically.
    # Production sidecars run inside the cluster where DNS works and do
    # not set this override, keeping the faster PyArrow path.
    if os.environ.get("PB_B4_LOCAL_DNS_OVERRIDE") == "1":
        properties["py-io-impl"] = "pyiceberg.io.fsspec.FsspecFileIO"
    return load_catalog("pb_b4", **{"type": "rest", **properties})


# ---------------------------------------------------------------------------
# Schema helpers — map Pipeline Builder logical types → PyIceberg types.
# ---------------------------------------------------------------------------

def _ice_type(t: str):
    from pyiceberg.types import (
        StringType,
        LongType,
        DoubleType,
        BooleanType,
        DateType,
        TimestampType,
    )

    tl = (t or "string").lower()
    return {
        "string": StringType(),
        "text": StringType(),
        "varchar": StringType(),
        "integer": LongType(),
        "int": LongType(),
        "long": LongType(),
        "bigint": LongType(),
        "numeric": DoubleType(),
        "double": DoubleType(),
        "float": DoubleType(),
        "boolean": BooleanType(),
        "bool": BooleanType(),
        "date": DateType(),
        "timestamp": TimestampType(),
    }.get(tl, StringType())


def _schema_from_columns(columns: List[Dict[str, Any]]):
    from pyiceberg.schema import Schema
    from pyiceberg.types import NestedField

    fields = []
    for idx, col in enumerate(columns, start=1):
        fields.append(
            NestedField(
                field_id=idx,
                name=col["name"],
                field_type=_ice_type(col.get("type", "string")),
                required=False,
            ),
        )
    return Schema(*fields)


def _partition_spec(spec: Optional[List[Dict[str, Any]]], schema):
    # Spec shape:
    #   [{"column": "event_date", "transform": "identity"}, ...]
    # Supported transforms for this cut: identity, year, month, day,
    # hour, bucket(n), truncate(n). Anything else is rejected upstream
    # by the Node partition-spec validator so this function trusts its
    # input.
    if not spec:
        from pyiceberg.partitioning import PartitionSpec

        return PartitionSpec()
    from pyiceberg.partitioning import PartitionField, PartitionSpec
    from pyiceberg.transforms import (
        BucketTransform,
        DayTransform,
        HourTransform,
        IdentityTransform,
        MonthTransform,
        TruncateTransform,
        YearTransform,
    )

    fields = []
    for i, entry in enumerate(spec):
        transform_name = (entry.get("transform") or "identity").lower()
        src_field = schema.find_field(entry["column"])
        if transform_name == "identity":
            tx = IdentityTransform()
        elif transform_name == "year":
            tx = YearTransform()
        elif transform_name == "month":
            tx = MonthTransform()
        elif transform_name == "day":
            tx = DayTransform()
        elif transform_name == "hour":
            tx = HourTransform()
        elif transform_name.startswith("bucket"):
            n = int(entry.get("n") or transform_name.replace("bucket", "").strip("()") or 16)
            tx = BucketTransform(n)
        elif transform_name.startswith("truncate"):
            n = int(entry.get("n") or transform_name.replace("truncate", "").strip("()") or 16)
            tx = TruncateTransform(n)
        else:
            raise ValueError(f"unsupported partition transform: {transform_name}")
        fields.append(
            PartitionField(
                source_id=src_field.field_id,
                field_id=1000 + i,
                transform=tx,
                name=entry.get("name", f"{entry['column']}_{transform_name}"),
            ),
        )
    return PartitionSpec(*fields)


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------

def _ensure_namespace(catalog, namespace: str) -> None:
    parts = tuple(namespace.split("."))
    for i in range(1, len(parts) + 1):
        try:
            catalog.create_namespace(parts[:i])
        except Exception as err:
            s = str(err).lower()
            # Lakekeeper and pyiceberg surface "already exist(s)" via a
            # few different strings. AlreadyExistsException, 409, the
            # word "exist" in the body — all indicate idempotent success.
            if (
                "already exist" in s
                or "alreadyexistsexception" in s
                or "409" in s
                or "namespacealreadyexists" in s
            ):
                continue
            raise


def action_create_or_get(cfg: Dict[str, Any]) -> Dict[str, Any]:
    catalog = _load_catalog(cfg)
    namespace = cfg["namespace"]
    table_ident = f"{namespace}.{cfg['table']}"
    _ensure_namespace(catalog, namespace)
    try:
        table = catalog.load_table(table_ident)
        created = False
    except Exception:
        schema = _schema_from_columns(cfg["columns"])
        spec = _partition_spec(cfg.get("partition_spec"), schema)
        table = catalog.create_table(
            identifier=table_ident,
            schema=schema,
            partition_spec=spec,
            properties={
                "format-version": "2",
                "write.parquet.compression-codec": "zstd",
                "write.target-file-size-bytes": "134217728",
            },
        )
        created = True
    current = table.current_snapshot()
    return {
        "created": created,
        "snapshot_id": str(current.snapshot_id) if current else None,
        "location": table.location(),
    }


def action_append(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Append rows from local Parquet file(s) as a new snapshot.

    The sidecar reads each Parquet file with pyarrow, then uses the
    table's `append(pa.Table)` API which stages data files and commits
    a new snapshot atomically against the catalog's OCC semantics.

    Snapshot IDs are returned as strings — Iceberg uses random int64s
    that routinely exceed JavaScript's Number.MAX_SAFE_INTEGER (2^53).
    """
    import pyarrow.parquet as pq

    catalog = _load_catalog(cfg)
    table_ident = f"{cfg['namespace']}.{cfg['table']}"
    table = catalog.load_table(table_ident)
    prior = table.current_snapshot()
    prior_id = str(prior.snapshot_id) if prior else None

    parquet_files: List[str] = cfg["parquet_files"]
    if not parquet_files:
        raise ValueError("append requires at least one parquet_file")

    for path in parquet_files:
        _log(f"append: reading {path}")
        pa_table = pq.read_table(path)
        table.append(pa_table)
        # Refresh the table object so we see the new snapshot without
        # re-loading from the catalog every iteration.
        table = catalog.load_table(table_ident)

    current = table.current_snapshot()
    return {
        "prior_snapshot_id": prior_id,
        "snapshot_id": str(current.snapshot_id) if current else None,
        "location": table.location(),
    }


def action_rollback(cfg: Dict[str, Any]) -> Dict[str, Any]:
    catalog = _load_catalog(cfg)
    table_ident = f"{cfg['namespace']}.{cfg['table']}"
    table = catalog.load_table(table_ident)
    # Accept either stringified or numeric snapshot ids on input.
    target = int(cfg["target_snapshot_id"])
    # PyIceberg 0.11 exposes rollback via the `manage_snapshots` API.
    with table.manage_snapshots() as mgr:
        mgr.rollback_to_snapshot(snapshot_id=target)
    table = catalog.load_table(table_ident)
    current = table.current_snapshot()
    return {
        "snapshot_id": str(current.snapshot_id) if current else None,
    }


def action_snapshots(cfg: Dict[str, Any]) -> Dict[str, Any]:
    catalog = _load_catalog(cfg)
    table_ident = f"{cfg['namespace']}.{cfg['table']}"
    try:
        table = catalog.load_table(table_ident)
    except Exception as err:
        s = str(err).lower()
        etype = err.__class__.__name__.lower()
        if (
            "nosuchtable" in etype
            or "nosuchnamespace" in etype
            or "does not exist" in s
            or "not found" in s
            or "404" in s
        ):
            return {"snapshots": []}
        raise
    out: List[Dict[str, Any]] = []
    for snap in table.snapshots():
        out.append(
            {
                "snapshot_id": str(snap.snapshot_id),
                "parent_id": str(snap.parent_snapshot_id) if snap.parent_snapshot_id else None,
                "timestamp_ms": snap.timestamp_ms,
                "operation": snap.summary.operation.value if snap.summary else None,
                "summary": dict(snap.summary.additional_properties) if snap.summary else {},
            },
        )
    return {"snapshots": out}


def action_scan_as_of(cfg: Dict[str, Any]) -> Dict[str, Any]:
    catalog = _load_catalog(cfg)
    table = catalog.load_table(f"{cfg['namespace']}.{cfg['table']}")
    snapshot_id = cfg.get("snapshot_id")
    limit = int(cfg.get("limit", 1000))
    # PyIceberg 0.11's `Table.scan(snapshot_id=...)` pins the scan to a
    # specific snapshot (time travel per PB-B4 acceptance (a)). Newer
    # versions expose `DataScan.use_ref_or_snapshot`; we avoid it so
    # the sidecar stays compatible with 0.11.
    kwargs: Dict[str, Any] = {"limit": limit}
    if snapshot_id is not None:
        kwargs["snapshot_id"] = int(snapshot_id)
    scan = table.scan(**kwargs)
    arrow_tbl = scan.to_arrow()
    rows = arrow_tbl.to_pylist()
    # Sanitize unsupported JSON types (pyarrow returns Decimal, bytes,
    # datetime; we coerce to JSON-safe strings here so stdout is a clean
    # JSON document).
    for row in rows:
        for k, v in list(row.items()):
            if isinstance(v, (bytes, bytearray)):
                row[k] = v.decode("utf-8", errors="replace")
            elif hasattr(v, "isoformat"):
                row[k] = v.isoformat()
            elif hasattr(v, "__str__") and not isinstance(v, (str, int, float, bool)) and v is not None:
                row[k] = str(v)
    return {
        "columns": [f.name for f in arrow_tbl.schema],
        "rows": rows,
        "row_count": len(rows),
    }


def action_scan_delta(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Manifest-level snapshot-delta read.

    Given `from_snapshot_id` (exclusive; None = first snapshot) and
    `to_snapshot_id` (inclusive), walk the snapshot chain via
    `table.inspect.snapshots()`, collect the data files added in each
    snapshot between those bounds (operation='append' + added_data_files
    from the manifest list), and load them directly with pyarrow. This
    gives the caller only the rows added in that range — the Funnel
    bridge (PB-B4 follow-4.1) uses this to advance
    `pipeline_changelog_watermark` incrementally instead of rereading
    the whole table.

    PyIceberg 0.12's native `incremental_append_scan()` supersedes this
    when we upgrade; for 0.11 we use `table.snapshot_by_id().manifests()`
    → DataFile listing → pyarrow read.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    catalog = _load_catalog(cfg)
    table_ident = f"{cfg['namespace']}.{cfg['table']}"
    table = catalog.load_table(table_ident)

    to_id = int(cfg["to_snapshot_id"])
    from_id = cfg.get("from_snapshot_id")
    from_id = int(from_id) if from_id is not None else None

    # Walk the snapshot chain from `to` backwards (parent by parent) and
    # stop when we reach `from`. Collect the snapshots in chronological
    # order so the per-snapshot files concat reproduces the append order.
    chain: List[Any] = []
    cursor = table.snapshot_by_id(to_id)
    if cursor is None:
        raise ValueError(f"unknown to_snapshot_id: {to_id}")
    while cursor is not None and cursor.snapshot_id != from_id:
        chain.append(cursor)
        if cursor.parent_snapshot_id is None:
            break
        parent_id = cursor.parent_snapshot_id
        cursor = table.snapshot_by_id(parent_id)
    chain.reverse()

    if not chain:
        # Watermark already at to_snapshot_id — no delta.
        return {"columns": [], "rows": [], "row_count": 0, "files": []}

    io = table.io
    data_files: List[str] = []
    for snap in chain:
        op = snap.summary.operation.value if snap.summary else None
        if op not in (None, "append"):
            # Overwrites / deletes can't be honestly expressed as a
            # pure "added rows since N" delta — the consumer must
            # rescan the table to remain consistent. Surface a marker
            # row so the node side can fall back to a full read.
            return {
                "columns": [],
                "rows": [],
                "row_count": 0,
                "files": [],
                "delta_requires_full_scan": True,
                "reason": f"snapshot {snap.snapshot_id} operation={op}",
            }
        # Each snapshot's manifest list contains BOTH newly-written
        # manifests and inherited ones from prior snapshots. We only
        # want files *added by this snapshot*: filter manifests by
        # `added_snapshot_id == snap.snapshot_id`. This is the
        # manifest-level equivalent of the incremental_append_scan API
        # in pyiceberg 0.12+.
        for manifest in snap.manifests(io):
            if getattr(manifest, "added_snapshot_id", None) != snap.snapshot_id:
                continue
            for entry in manifest.fetch_manifest_entry(io, discard_deleted=True):
                # Double-check at the entry level too (status=ADDED).
                if entry.status.value == 1:  # 1 == ADDED per Iceberg spec
                    data_files.append(entry.data_file.file_path)

    if not data_files:
        return {"columns": [], "rows": [], "row_count": 0, "files": []}

    # Read each added file through the s3fs-backed FsspecFileIO that
    # pyiceberg built for this table — it already has the right
    # endpoint + creds and honours the dev DNS override. `get_fs`
    # resolves the fsspec filesystem for an s3:// URI; we strip the
    # scheme for pyarrow's `filesystem=` argument.
    filesystem = None
    try:
        get_fs = getattr(io, "get_fs", None)
        if callable(get_fs):
            filesystem = get_fs("s3")
    except Exception:
        filesystem = None

    tables = []
    for p in data_files:
        rel = p.replace("s3://", "") if p.startswith("s3://") else p
        if filesystem is not None:
            tables.append(pq.read_table(rel, filesystem=filesystem))
        else:
            tables.append(pq.read_table(p))
    combined = pa.concat_tables(tables)
    rows = combined.to_pylist()
    for row in rows:
        for k, v in list(row.items()):
            if isinstance(v, (bytes, bytearray)):
                row[k] = v.decode("utf-8", errors="replace")
            elif hasattr(v, "isoformat"):
                row[k] = v.isoformat()
            elif hasattr(v, "__str__") and not isinstance(v, (str, int, float, bool)) and v is not None:
                row[k] = str(v)
    return {
        "columns": [f.name for f in combined.schema],
        "rows": rows,
        "row_count": len(rows),
        "files": data_files,
    }


def action_update_schema(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Apply a batch of safe schema operations through
    `table.update_schema()`. Supports PB-B10 safe ops:
      * add_column(name, type)
      * rename_column(from, to)
      * update_column_type(name, to)  # widen-only at the caller layer
      * delete_column(name)

    All ops are staged in one transaction and commit atomically; on
    pyiceberg 0.11 the commit returns the table at its new schema_id.
    The caller's deploy workflow keeps the `prior_snapshot_id` so a
    data-write failure downstream can rollback via the existing
    `rollback` action.
    """
    catalog = _load_catalog(cfg)
    table = catalog.load_table(f"{cfg['namespace']}.{cfg['table']}")
    ops: List[Dict[str, Any]] = cfg.get("operations") or []
    if not ops:
        return {
            "applied": 0,
            "schema_id": table.schema().schema_id,
        }

    with table.update_schema() as txn:
        for op in ops:
            kind = op.get("op")
            if kind == "add_column":
                txn.add_column(
                    path=(op["name"],),
                    field_type=_ice_type(op.get("type", "string")),
                    required=False,  # spec: additions always nullable
                )
            elif kind == "delete_column":
                txn.delete_column(path=(op["name"],))
            elif kind == "rename_column":
                txn.rename_column(path_from=(op["from"],), new_name=op["to"])
            elif kind == "update_column_type":
                # Iceberg only allows widen-within-family; the Node side
                # has already classified, so trust the incoming op.
                txn.update_column(
                    path=(op["name"],),
                    field_type=_ice_type(op["to"]),
                )
            else:
                raise ValueError(f"unsupported update_schema op: {kind}")

    table = catalog.load_table(f"{cfg['namespace']}.{cfg['table']}")
    current_snap = table.current_snapshot()
    return {
        "applied": len(ops),
        "schema_id": table.schema().schema_id,
        "snapshot_id": str(current_snap.snapshot_id) if current_snap else None,
    }


def action_expire(cfg: Dict[str, Any]) -> Dict[str, Any]:
    catalog = _load_catalog(cfg)
    table = catalog.load_table(f"{cfg['namespace']}.{cfg['table']}")
    retain_last = int(cfg.get("retain_last", 100))
    older_than_ms = int(cfg.get("older_than_ms", 30 * 24 * 3600 * 1000))
    with table.manage_snapshots() as mgr:
        mgr.expire_snapshots(
            retain_last_n=retain_last,
            older_than_ms=older_than_ms,
        )
    # PyIceberg 0.11 may not report the expired count; surface current
    # snapshot list length as a proxy.
    table = catalog.load_table(f"{cfg['namespace']}.{cfg['table']}")
    return {"snapshot_count_after": len(list(table.snapshots()))}


def action_compact(cfg: Dict[str, Any]) -> Dict[str, Any]:
    catalog = _load_catalog(cfg)
    table = catalog.load_table(f"{cfg['namespace']}.{cfg['table']}")
    # PyIceberg's rewrite_data_files API is 0.12+; on 0.11 we fall back
    # to a full-snapshot overwrite via read-back, which is still
    # correctness-equivalent (one snapshot in → one snapshot out with
    # one data file per partition).
    try:
        table.rewrite_data_files()
    except AttributeError:
        _log("rewrite_data_files unavailable on this pyiceberg; falling back to read-rewrite")
        arrow_tbl = table.scan().to_arrow()
        table.overwrite(arrow_tbl)
    table = catalog.load_table(f"{cfg['namespace']}.{cfg['table']}")
    current = table.current_snapshot()
    return {"snapshot_id": str(current.snapshot_id) if current else None}


DISPATCH = {
    "create_or_get": action_create_or_get,
    "append": action_append,
    "rollback": action_rollback,
    "snapshots": action_snapshots,
    "scan_as_of": action_scan_as_of,
    "scan_delta": action_scan_delta,
    "expire": action_expire,
    "compact": action_compact,
    "update_schema": action_update_schema,
}


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception as err:
        print(
            json.dumps({"ok": False, "error": f"invalid stdin json: {err}"}),
            flush=True,
        )
        return 2
    action = payload.get("action")
    fn = DISPATCH.get(action)
    if fn is None:
        print(
            json.dumps(
                {"ok": False, "error": f"unknown action: {action}", "supported": list(DISPATCH.keys())},
            ),
            flush=True,
        )
        return 2
    try:
        result = fn(payload)
        print(json.dumps({"ok": True, **result}), flush=True)
        return 0
    except Exception as err:  # noqa: BLE001 — surface structured failure
        tb = traceback.format_exc()
        _log(tb)
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": str(err),
                    "error_type": err.__class__.__name__,
                    "traceback": tb,
                },
            ),
            flush=True,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
