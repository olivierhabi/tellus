// ---------------------------------------------------------------------------
// PB-B4 — PyIceberg sidecar end-to-end (integration).
//
// Exercises the full sidecar lifecycle against a live Lakekeeper +
// MinIO: namespace creation, table create, append (with row commit),
// snapshot list, time-travel scan, and rollback. These cover the PB-B4
// acceptance surface we can honestly verify in this sandbox:
//
//   (a) time-travel: SELECT * FROM table FOR VERSION AS OF <snap> →
//       sidecar's scan_as_of returns rows at that snapshot.
//   (b) cancellation rollback: rollback_to_snapshot(prior) leaves the
//       table at the prior state; the orphan snapshot is still in the
//       history but the current ref points back.
//   (f) _pipeline.* namespace: table created under _pipeline.<proj>.<pipe>.
//
// Skips gracefully when Lakekeeper / MinIO / pyiceberg are not available.
// Uses the dev DNS override so host-network tests work without /etc/hosts.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { spawnSync } from "child_process";
import {
  icebergCreateOrGet,
  icebergAppend,
  icebergRollback,
  icebergSnapshots,
  icebergScanAsOf,
  icebergScanDelta,
  icebergSidecarAvailable,
} from "../../../src/services/pipelines/icebergSidecar";
import {
  pipelineNamespace,
  slugForNamespace,
} from "../../../src/services/pipelines/icebergNamespace";

// Force the sidecar dev-mode DNS + endpoint override for every spawn so
// the host-network test environment can talk to docker-internal minio.
// Production runs with these unset and takes the native pyarrow path.
process.env.PB_B4_LOCAL_DNS_OVERRIDE = "1";
process.env.LAKEKEEPER_URL ??= "http://localhost:8181";
process.env.LAKEKEEPER_PIPELINE_WAREHOUSE ??= "tellus-pipeline";
process.env.S3_ENDPOINT ??= "http://minio:9000";

const STAMP = Date.now().toString();
const SUITE_TAG = `pb_b4_${STAMP.slice(-8)}`;
const projectSlug = slugForNamespace(`test_${SUITE_TAG}`);
const pipelineSlug = slugForNamespace(`pipe_${SUITE_TAG}`);
const namespace = pipelineNamespace(projectSlug, pipelineSlug);
const table = "output";
let sidecarUp = false;
let lakekeeperUp = false;
let warehouseUp = false;
let minioUp = false;

async function lakekeeperReachable(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:8181/management/v1/info", {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Lakekeeper's /management/v1/info answers 2xx even when no warehouse is
// provisioned. The operation that actually fails is the REST catalog's
// config fetch: GET /catalog/v1/config?warehouse=<wh> returns 404 →
// pyiceberg raises NoSuchWarehouseException. Probing this endpoint is the
// only way to tell "warehouse usable" from "server answers pings".
async function warehouseReachable(): Promise<boolean> {
  try {
    const base = process.env.LAKEKEEPER_URL ?? "http://localhost:8181";
    const warehouse =
      process.env.LAKEKEEPER_PIPELINE_WAREHOUSE ??
      process.env.LAKEKEEPER_WAREHOUSE ??
      "tellus-pipeline";
    const url = `${base}/catalog/v1/config?warehouse=${encodeURIComponent(warehouse)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return r.ok; // 200 = warehouse provisioned; 404 = NoSuchWarehouse
  } catch {
    return false;
  }
}

// MinIO/S3 is the warehouse's backing object store. A warehouse can be
// registered with the catalog while its object store is unreachable, in
// which case commits fail with an S3-unreachable error.
async function minioReachable(): Promise<boolean> {
  try {
    const endpoint =
      process.env.S3_ENDPOINT ?? process.env.ICEBERG_S3_ENDPOINT ?? "http://localhost:9000";
    const url = new URL("/minio/health/live", endpoint).toString();
    const r = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return r.ok;
  } catch {
    return false;
  }
}

function writeFixtureParquet(rows: Array<{ id: number; status: string }>): string {
  // Use Python to write a Parquet fixture so the schema + encoding
  // match what the sidecar expects from production deploys.
  const p = path.join(require("os").tmpdir(), `pb-b4-${randomUUID()}.parquet`);
  const escaped = JSON.stringify(rows);
  const script = `
import sys, json
import pyarrow as pa
import pyarrow.parquet as pq
rows = json.loads(sys.argv[1])
t = pa.table({"id":[r["id"] for r in rows], "status":[r["status"] for r in rows]})
pq.write_table(t, sys.argv[2], compression="zstd")
`;
  const res = spawnSync("python3", ["-c", script, escaped, p], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`parquet fixture failed: ${res.stderr}`);
  }
  return p;
}

beforeAll(async () => {
  sidecarUp = await icebergSidecarAvailable();
  lakekeeperUp = await lakekeeperReachable();
  warehouseUp = await warehouseReachable();
  minioUp = await minioReachable();
  if (!sidecarUp || !lakekeeperUp || !warehouseUp || !minioUp) {
    console.warn(
      `[pb-b4] skipping — sidecar=${sidecarUp} lakekeeper=${lakekeeperUp} warehouse=${warehouseUp} minio=${minioUp}`,
    );
  }
});

afterAll(() => {
  // Best-effort cleanup: drop the test table if the sidecar is alive.
  // PyIceberg 0.11 doesn't expose `drop_table` over the thin action
  // layer we built; leaving the test tables around in a tagged
  // namespace is acceptable — they're slug-prefixed with the suite ID.
});

function guard(): boolean {
  return sidecarUp && lakekeeperUp && warehouseUp && minioUp;
}

describe("PB-B4 Iceberg sidecar", () => {
  it("(f) creates the _pipeline namespace + table idempotently", async () => {
    if (!guard()) return;
    const first = await icebergCreateOrGet({
      namespace,
      table,
      columns: [
        { name: "id", type: "integer" },
        { name: "status", type: "string" },
      ],
    });
    expect(first.created).toBe(true);
    expect(first.location.startsWith("s3://")).toBe(true);
    // Second call is idempotent.
    const second = await icebergCreateOrGet({
      namespace,
      table,
      columns: [
        { name: "id", type: "integer" },
        { name: "status", type: "string" },
      ],
    });
    expect(second.created).toBe(false);
  });

  it("appends Parquet data as a new snapshot, list reflects history", async () => {
    if (!guard()) return;
    const pf = writeFixtureParquet([
      { id: 1, status: "open" },
      { id: 2, status: "closed" },
    ]);
    try {
      const app = await icebergAppend({
        namespace,
        table,
        parquetFiles: [pf],
      });
      expect(app.snapshotId).not.toBeNull();
      const list = await icebergSnapshots({ namespace, table });
      expect(list.snapshots.length).toBeGreaterThanOrEqual(1);
    } finally {
      try { fs.unlinkSync(pf); } catch { /* ignore */ }
    }
  });

  it("(a) time-travel scan returns rows at the latest snapshot", async () => {
    if (!guard()) return;
    const { snapshots } = await icebergSnapshots({ namespace, table });
    const latest = snapshots[snapshots.length - 1];
    const scan = await icebergScanAsOf({
      namespace,
      table,
      snapshotId: latest.snapshot_id,
      limit: 100,
    });
    expect(scan.columns).toEqual(["id", "status"]);
    expect(scan.rows.length).toBeGreaterThan(0);
  });

  it("(d) scan_delta returns only rows added between snapshots (PB-B4 follow-4.1)", async () => {
    if (!guard()) return;
    // Self-contained against a dedicated namespace so the test runs
    // identically in isolation or as part of the suite. Every run gets
    // a fresh pair of snapshots we can reason about deterministically.
    const deltaNs = pipelineNamespace(
      projectSlug,
      slugForNamespace(`delta_${randomUUID().slice(0, 8)}`),
    );
    await icebergCreateOrGet({
      namespace: deltaNs,
      table,
      columns: [
        { name: "id", type: "integer" },
        { name: "status", type: "string" },
      ],
    });
    const firstPf = writeFixtureParquet([
      { id: 1, status: "open" },
      { id: 2, status: "closed" },
    ]);
    const markerPf = writeFixtureParquet([{ id: 7777, status: "delta_marker" }]);
    try {
      const first = await icebergAppend({ namespace: deltaNs, table, parquetFiles: [firstPf] });
      const second = await icebergAppend({ namespace: deltaNs, table, parquetFiles: [markerPf] });
      expect(second.snapshotId).not.toEqual(first.snapshotId);
      expect(first.snapshotId).toBeTruthy();

      // Delta (first-exclusive, second-inclusive] = only the marker row.
      const delta = await icebergScanDelta({
        namespace: deltaNs,
        table,
        fromSnapshotId: first.snapshotId,
        toSnapshotId: second.snapshotId as string,
      });
      expect(delta.delta_requires_full_scan).not.toBe(true);
      expect(delta.row_count).toBe(1);
      expect(delta.rows[0]).toMatchObject({ id: 7777, status: "delta_marker" });

      // Delta from null walks the whole chain → 3 rows total (2+1).
      const fromBeginning = await icebergScanDelta({
        namespace: deltaNs,
        table,
        fromSnapshotId: null,
        toSnapshotId: second.snapshotId as string,
      });
      expect(fromBeginning.row_count).toBe(3);
    } finally {
      try { fs.unlinkSync(firstPf); } catch { /* ignore */ }
      try { fs.unlinkSync(markerPf); } catch { /* ignore */ }
    }
  });

  it("(b) rollback_to_snapshot restores the prior state", async () => {
    if (!guard()) return;
    const before = await icebergSnapshots({ namespace, table });
    expect(before.snapshots.length).toBeGreaterThanOrEqual(1);
    // The rollback target must be reachable from the current head, so
    // we grab the LATEST snapshot (not the oldest — older ones may have
    // been trimmed in prior runs).
    const priorSnap = before.snapshots[before.snapshots.length - 1];

    const pf = writeFixtureParquet([{ id: 99, status: "new" }]);
    try {
      const appendRes = await icebergAppend({ namespace, table, parquetFiles: [pf] });
      expect(appendRes.snapshotId).not.toBe(Number(priorSnap.snapshot_id));

      await icebergRollback({
        namespace,
        table,
        targetSnapshotId: priorSnap.snapshot_id,
      });
      // After rollback the current scan should NOT include id=99.
      const scan = await icebergScanAsOf({ namespace, table, limit: 100 });
      const ids = scan.rows.map((r) => Number(r.id));
      expect(ids).not.toContain(99);
    } finally {
      try { fs.unlinkSync(pf); } catch { /* ignore */ }
    }
  });
});
