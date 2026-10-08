/**
 * Engine build on a LOCAL synthetic graph — proves staging + reclamation.
 *
 * The PaySim deploy failed with `No space left on device` because every
 * materialised stage stayed on disk until the build ended. This exercises the
 * same buildWithEngine code path against a tiny local Parquet source, and
 * asserts that stages are unlinked as soon as their last consumer has read
 * them — i.e. peak disk is bounded by the graph WIDTH, not its node count.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The shared DuckDB pool demands S3 creds at acquireConnection; this test
// never touches S3 (the source is a local file), so stub placeholders.
vi.stubEnv("S3_ACCESS_KEY_ID", "unit-test-placeholder");
vi.stubEnv("S3_SECRET_ACCESS_KEY", "unit-test-placeholder");

import { buildWithEngine } from "../../../src/services/pipelines/engineBuild";
import type { PipelineNodeInfo } from "../../../src/services/pipelines/engineBuild";
import { acquireConnection, releaseConnection } from "../../../src/services/duckdb/pool";

describe("engineBuild staging + reclamation", () => {
  let dir: string;
  let sourcePath: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "engine-build-test-"));
    sourcePath = join(dir, "source.parquet");
    const conn = await acquireConnection();
    // A tiny stand-in for the PaySim source: same shape, 20 rows.
    await conn.run(`COPY (
      SELECT 'tx' || i AS id, (i % 5) AS step, i * 1.5 AS amount
      FROM range(0, 20) t(i)
    ) TO '${sourcePath}' (FORMAT PARQUET)`);
    releaseConnection(conn);
  });

  afterAll(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const node = (
    nodeId: string,
    nodeType: string,
    config: Record<string, unknown>,
    extra: Partial<PipelineNodeInfo> = {},
  ): [string, PipelineNodeInfo] => [
    nodeId,
    { nodeId, nodeType, config, sourceNodeId: null, datasetPath: null, ...extra },
  ];

  it("builds a linear chain and reclaims every consumed stage", async () => {
    const nodes = new Map<string, PipelineNodeInfo>([
      node("ds", "dataset", {}, { datasetPath: sourcePath }),
      node("a", "transform", { transforms: [{ function: "Drop", columns: ["amount"] }] }, { sourceNodeId: "ds" }),
      node("b", "transform", { transforms: [{ function: "Drop", columns: ["step"] }] }, { sourceNodeId: "a" }),
      node("out", "output", {}, { sourceNodeId: "b" }),
    ]);

    const res = await buildWithEngine("out", {
      nodes,
      sinkFormat: "csv",
      stagingPrefix: `${dir}/`,
    });

    // ds(id, step, amount) -> `a` drops amount -> `b` drops step => id only.
    expect(res.rowCount).toBe(20);
    expect(res.columns.map((c) => c.name)).toEqual(["id"]);
    expect(res.exportFormat).toBe("csv");

    // The CSV is real and carries a header.
    const csv = readFileSync(res.exportPath, "utf8");
    expect(csv.split("\n")[0]).toBe("id");
    expect(csv.trim().split("\n")).toHaveLength(21);

    // `a` is consumed by `b`, `b` is the chain root (kept for export). So at
    // minimum `a` must have been reclaimed — this is the assertion that the
    // PaySim disk failure is addressed.
    expect(res.reclaimedStages).toBeGreaterThanOrEqual(1);
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".parquet"));
    // Only the source + the retained final stage may remain on disk.
    expect(leftovers.filter((f) => f !== "source.parquet")).toHaveLength(1);
  });

  it("keeps both branches until the union has read both, then reclaims them", async () => {
    const nodes = new Map<string, PipelineNodeInfo>([
      node("ds", "dataset", {}, { datasetPath: sourcePath }),
      node("left", "transform", { transforms: [{ function: "Drop", columns: ["amount"] }] }, { sourceNodeId: "ds" }),
      node("right", "transform", { transforms: [{ function: "Drop", columns: ["step"] }] }, { sourceNodeId: "ds" }),
      // Union consumes BOTH branches — neither may be deleted before this reads them.
      node("u", "union", { rightNodeId: "right", mode: "wide", transforms: [] }, { sourceNodeId: "left" }),
      node("out", "output", {}, { sourceNodeId: "u" }),
    ]);

    const res = await buildWithEngine("out", {
      nodes,
      sinkFormat: "csv",
      stagingPrefix: `${dir}/union-`,
    });

    // 20 + 20 rows after a UNION ALL of the two branches.
    expect(res.rowCount).toBe(40);
    // Both branches were consumed exactly once, so both are reclaimable.
    expect(res.reclaimedStages).toBeGreaterThanOrEqual(2);
  });

  // ── Union ordering (Palantir parity) ──────────────────────────────────
  // The union COMBINES the inputs; the union node's own transforms then run
  // over the combined table. Appending the Union step last instead made a
  // dedup on the union node apply to the LEFT branch only, so the union
  // reintroduced the duplicates the node was meant to remove.

  it("runs the union node's own transforms AFTER the union, not before", async () => {
    // Each branch is already unique on `id`, but they OVERLAP (both derive
    // from the same 20-row source), so the union is not unique on `id`.
    // A dedup placed after the union must therefore collapse to 20 rows; the
    // old ordering (dedup on the left branch only) produced 40.
    const nodes = new Map<string, PipelineNodeInfo>([
      node("ds", "dataset", {}, { datasetPath: sourcePath }),
      node("left", "transform", { transforms: [] }, { sourceNodeId: "ds" }),
      node("right", "transform", { transforms: [] }, { sourceNodeId: "ds" }),
      node("u", "union", {
        rightNodeId: "right",
        mode: "wide",
        transforms: [{ function: "DropDuplicates", columns: ["id"] }],
      }, { sourceNodeId: "left" }),
      node("out", "output", {}, { sourceNodeId: "u" }),
    ]);

    const res = await buildWithEngine("out", {
      nodes,
      sinkFormat: "csv",
      stagingPrefix: `${dir}/union-dedup-`,
    });

    // 20 + 20 stacked = 40 rows, deduplicated on `id` back down to 20.
    expect(res.rowCount).toBe(20);
  });

  it("leaves a union node with no transforms as a plain union", async () => {
    const nodes = new Map<string, PipelineNodeInfo>([
      node("ds", "dataset", {}, { datasetPath: sourcePath }),
      node("left", "transform", { transforms: [] }, { sourceNodeId: "ds" }),
      node("right", "transform", { transforms: [] }, { sourceNodeId: "ds" }),
      node("u", "union", { rightNodeId: "right", mode: "wide", transforms: [] }, { sourceNodeId: "left" }),
      node("out", "output", {}, { sourceNodeId: "u" }),
    ]);

    const res = await buildWithEngine("out", {
      nodes,
      sinkFormat: "csv",
      stagingPrefix: `${dir}/union-plain-`,
    });

    expect(res.rowCount).toBe(40);
  });

  it("computes a window aggregate on the engine and preserves row count", async () => {
    // windowV1: aggregation over a partition, row count preserved. The
    // per-partition count must be attached to every row of that partition.
    const nodes = new Map<string, PipelineNodeInfo>([
      node("ds", "dataset", {}, { datasetPath: sourcePath }),
      node("w", "transform", {
        transforms: [
          { function: "Window", partitionBy: ["step"], aggregations: [{ function: "count", outputColumn: "n_in_step" }] },
        ],
      }, { sourceNodeId: "ds" }),
      node("out", "output", {}, { sourceNodeId: "w" }),
    ]);

    const res = await buildWithEngine("out", {
      nodes,
      sinkFormat: "csv",
      stagingPrefix: `${dir}/window-`,
    });

    expect(res.rowCount).toBe(20);
    const csv = readFileSync(res.exportPath, "utf8");
    expect(csv.split("\n")[0]).toContain("n_in_step");
    // step = i % 5 over 20 rows => 4 rows per partition.
    const counts = csv.trim().split("\n").slice(1).map((l) => l.split(",").pop());
    expect(new Set(counts)).toEqual(new Set(["4"]));
  });

  it("hashes a column with sha256 on the engine", async () => {
    const nodes = new Map<string, PipelineNodeInfo>([
      node("ds", "dataset", {}, { datasetPath: sourcePath }),
      node("h", "transform", {
        transforms: [{ function: "HashSha256", expression: "id", outputColumn: "id_hash" }],
      }, { sourceNodeId: "ds" }),
      node("out", "output", {}, { sourceNodeId: "h" }),
    ]);

    const res = await buildWithEngine("out", {
      nodes,
      sinkFormat: "csv",
      stagingPrefix: `${dir}/hash-`,
    });

    expect(res.rowCount).toBe(20);
    const csv = readFileSync(res.exportPath, "utf8");
    expect(csv.split("\n")[0]).toContain("id_hash");
    const first = csv.trim().split("\n")[1].split(",");
    // 64 hex chars, and equal to Node's sha256 of the source id `tx0`.
    expect(first[first.length - 1]).toBe(
      createHash("sha256").update("tx0", "utf8").digest("hex"),
    );
  });

  it("refuses a graph that is not topological rather than building it wrong", async () => {
    const nodes = new Map<string, PipelineNodeInfo>([
      node("ds", "dataset", {}, { datasetPath: sourcePath }),
      // `j` references a node that does not exist — a dangling edge.
      node("j", "join", {
        transforms: [
          { function: "Join", rightNodeId: "ghost", conditions: [{ leftColumn: "id", rightColumn: "id" }] },
        ],
      }, { sourceNodeId: "ds" }),
      node("out", "output", {}, { sourceNodeId: "j" }),
    ]);

    await expect(
      buildWithEngine("out", { nodes, sinkFormat: "csv", stagingPrefix: `${dir}/bad-` }),
    ).rejects.toThrow(/not found|topological|consumed before/i);
  });

  it("refuses a transform the SQL compiler cannot express", async () => {
    const nodes = new Map<string, PipelineNodeInfo>([
      node("ds", "dataset", {}, { datasetPath: sourcePath }),
      node("t", "transform", { transforms: [{ function: "UppercaseColumnNames" }] }, { sourceNodeId: "ds" }),
      node("out", "output", {}, { sourceNodeId: "t" }),
    ]);

    await expect(
      buildWithEngine("out", { nodes, sinkFormat: "csv", stagingPrefix: `${dir}/inel-` }),
    ).rejects.toThrow(/SQL equivalent|legacy_nodejs/i);
  });

  it("cleans up its own scratch files for a failing graph", async () => {
    const scratch = join(dir, "cleanup-check");
    const nodes = new Map<string, PipelineNodeInfo>([
      node("ds", "dataset", {}, { datasetPath: sourcePath }),
      node("t", "transform", { transforms: [{ function: "UppercaseColumnNames" }] }, { sourceNodeId: "ds" }),
      node("out", "output", {}, { sourceNodeId: "t" }),
    ]);
    await expect(
      buildWithEngine("out", { nodes, sinkFormat: "csv", stagingPrefix: `${scratch}/` }),
    ).rejects.toThrow();
    // The caller's `finally` owns the directory; buildWithEngine must not
    // leave a half-written result behind for the next deploy to trip over.
    const residue = existsSync(scratch) ? readdirSync(scratch) : [];
    expect(residue.filter((f) => f.endsWith(".parquet") && f.startsWith("result-"))).toHaveLength(0);
  });
});