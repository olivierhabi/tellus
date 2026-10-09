// ---------------------------------------------------------------------------
// mergeBuckets — unit tests for bucket planning, predicates, checkpoints.
//
// Pure logic plus SQL shape, with `query` mocked for the checkpoint store.
// What is pinned:
//   * planning: unknown counts plan 1 bucket; target env honored; junk/zero
//     disables bucketing (single bucket);
//   * the bucket predicate normalizes signed hashes into [0, count);
//   * checkpoints are idempotent upserts; resume reads only completed rows;
//   * bucket SQL: self-contained per bucket (contrib_meta rebuilt — cheap),
//     ends with source_state, exports/assembles with explicit columns.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const calls: Array<{ sql: string; params: unknown[] }> = [];
let respond: (sql: string) => { rows: Record<string, unknown>[] } = () => ({
  rows: [],
});

vi.mock("../../../src/db", () => ({
  query: async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    const { rows } = respond(sql);
    return { rowCount: rows.length, rows };
  },
}));

import {
  planBucketCount,
  pendingBuckets,
  mergeBucketKey,
  readCompletedBuckets,
  writeBucketCheckpoint,
  deleteBucketCheckpoint,
} from "../../../src/services/funnel/mergeBuckets";
import {
  bucketPredicate,
  buildNarrowBucketStatements,
  buildBucketAssemblyStatement,
  buildBucketExportStatement,
  buildBucketChecksumStatement,
  isNarrowDedupEnabled,
  mergeBucketTargetRows,
} from "../../../src/services/funnel/mergePrefixSql";
import { setFunnelRuntimeOverridesForTesting } from "../../../src/config/funnelRuntime";

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

beforeEach(() => {
  calls.length = 0;
  respond = () => ({ rows: [] });
});

afterEach(() => {
  setFunnelRuntimeOverridesForTesting(null);
  delete process.env.MERGE_BUCKET_ROWS;
  delete process.env.MERGE_NARROW_DEDUP;
});

describe("versioned merge strategy config", () => {
  it("narrow dedup defaults ON and ignores the retired MERGE_NARROW_DEDUP env knob", () => {
    expect(isNarrowDedupEnabled()).toBe(true);
    process.env.MERGE_NARROW_DEDUP = "0";
    expect(isNarrowDedupEnabled()).toBe(true);
    setFunnelRuntimeOverridesForTesting({ mergeNarrowDedup: false });
    expect(isNarrowDedupEnabled()).toBe(false);
  });

  it("bucket target defaults 1M, ignores MERGE_BUCKET_ROWS; non-positive disables bucketing", () => {
    expect(mergeBucketTargetRows()).toBe(1_000_000);
    process.env.MERGE_BUCKET_ROWS = "500000";
    expect(mergeBucketTargetRows()).toBe(1_000_000);
    setFunnelRuntimeOverridesForTesting({ mergeBucketTargetRows: 500_000 });
    expect(mergeBucketTargetRows()).toBe(500_000);
    for (const v of [0, -3, Number.NaN]) {
      setFunnelRuntimeOverridesForTesting({ mergeBucketTargetRows: v });
      expect(mergeBucketTargetRows()).toBe(0);
    }
  });
});

describe("planBucketCount", () => {
  it("unknown or empty counts plan a single bucket (safe default)", () => {
    expect(planBucketCount([])).toEqual({ bucketCount: 1, totalRows: 0 });
    expect(planBucketCount([undefined])).toEqual({ bucketCount: 1, totalRows: 0 });
    expect(planBucketCount([100, undefined])).toEqual({
      bucketCount: 1,
      totalRows: 100,
    });
  });

  it("splits by target with ceiling", () => {
    setFunnelRuntimeOverridesForTesting({ mergeBucketTargetRows: 1000 });
    expect(planBucketCount([500])).toEqual({ bucketCount: 1, totalRows: 500 });
    expect(planBucketCount([1000])).toEqual({ bucketCount: 1, totalRows: 1000 });
    expect(planBucketCount([1001])).toEqual({ bucketCount: 2, totalRows: 1001 });
    expect(planBucketCount([2500, 1000])).toEqual({
      bucketCount: 4,
      totalRows: 3500,
    });
  });

  it("target <= 0 means one bucket", () => {
    setFunnelRuntimeOverridesForTesting({ mergeBucketTargetRows: 0 });
    expect(planBucketCount([10_000_000]).bucketCount).toBe(1);
  });
});

describe("pendingBuckets / mergeBucketKey", () => {
  it("returns the missing ids in order", () => {
    expect(pendingBuckets(4, [0, 2])).toEqual([1, 3]);
    expect(pendingBuckets(2, [])).toEqual([0, 1]);
    expect(pendingBuckets(2, [0, 1])).toEqual([]);
    // Out-of-range completions are ignored by callers; pending lists all ids.
    expect(pendingBuckets(2, [9])).toEqual([0, 1]);
  });

  it("keys are snapshot-scoped and parallel to merged/ keys", () => {
    expect(mergeBucketKey("Transaction", "snap-1", 3)).toBe(
      "merge-buckets/Transaction/snap-1.b3.parquet",
    );
  });
});

describe("bucketPredicate", () => {
  it("normalizes into [0, count) for signed and unsigned hashes", () => {
    const p = bucketPredicate(3, 7);
    expect(p).toBe("(((hash(primary_key) % 7) + 7) % 7 = 3)");
  });
});

describe("bucket SQL shape", () => {
  const ARGS = {
    contributions: [
      { datasource_id: "ds-1", owned_properties: [], markings: [] },
    ],
    localPaths: ["/tmp/c.parquet"],
    bucket: { id: 2, count: 7 },
    singleContribution: true,
  };

  it("each bucket script is self-contained and ends with source_state", () => {
    const stmts = buildNarrowBucketStatements(ARGS);
    const joined = stmts.join("\n");
    // Self-contained: rebuilds contrib_meta (cheap single-row INSERTs) so a
    // bucket script runs standalone in its own CLI process.
    expect(joined).toContain("CREATE OR REPLACE TEMP TABLE contrib_meta");
    expect(joined).toContain("(((hash(primary_key) % 7) + 7) % 7 = 2)");
    expect(joined).toContain("AS rid");
    expect(joined).toContain("ON ch.rid = c.rid");
    // Builds source_state (then drops intermediates); the caller COPYs it
    // out (no COPY here).
    const at = stmts.findIndex((s) =>
      s.includes("CREATE OR REPLACE TEMP TABLE source_state AS"),
    );
    expect(at).toBeGreaterThan(0);
    expect(stmts.slice(at + 1).join("\n")).toContain("DROP TABLE");
    expect(joined).not.toContain("COPY (");
    // Single-contribution fold (same rule as the unbucketed path).
    expect(joined).not.toContain("per_contrib_props");
  });

  it("assembly selects explicit columns from all bucket files", () => {
    const sql = buildBucketAssemblyStatement(["/tmp/b0.parquet", "/tmp/b1.parquet"]);
    expect(sql).toContain("CREATE OR REPLACE TEMP TABLE source_state AS");
    expect(sql).toContain("CAST(properties AS JSON) AS properties");
    expect(sql).toContain("read_parquet(['/tmp/b0.parquet', '/tmp/b1.parquet'])");
    for (const col of [
      "primary_key",
      "source_datasource_id",
      "source_transaction_id",
      "source_timestamp",
      "tombstoned",
      "markings",
    ]) {
      expect(sql).toContain(col);
    }
  });

  it("export casts properties; checksum is order-independent", () => {
    expect(buildBucketExportStatement("/tmp/b.parquet")).toContain(
      "CAST(properties AS VARCHAR) AS properties",
    );
    const chk = flat(buildBucketChecksumStatement("read_parquet('/tmp/b.parquet')"));
    expect(chk).toContain("bit_xor(hash(primary_key))");
    expect(chk).toContain("FROM read_parquet('/tmp/b.parquet')");
    expect(flat(buildBucketChecksumStatement())).toContain("FROM source_state");
  });
});

describe("checkpoint store", () => {
  it("write is an idempotent upsert keyed by (run_key, bucket_id)", async () => {
    await writeBucketCheckpoint("run-1", 2, 1000, "abc", "k/b2.parquet");
    expect(calls).toHaveLength(1);
    expect(flat(calls[0].sql)).toContain("INSERT INTO funnel_merge_bucket");
    expect(flat(calls[0].sql)).toContain(
      "ON CONFLICT (run_key, bucket_id) DO UPDATE",
    );
    expect(calls[0].params).toEqual(["run-1", 2, 1000, "abc", "k/b2.parquet"]);
  });

  it("read returns completed rows mapped to numbers", async () => {
    respond = () => ({
      rows: [
        { bucket_id: 0, row_count: "100", checksum: "h0", output_key: "k0" },
      ],
    });
    await expect(readCompletedBuckets("run-1")).resolves.toEqual([
      { bucket_id: 0, row_count: 100, checksum: "h0", output_key: "k0" },
    ]);
    expect(flat(calls[0].sql)).toContain("status = 'completed'");
    expect(calls[0].params).toEqual(["run-1"]);
  });

  it("delete is scoped to the bucket", async () => {
    await deleteBucketCheckpoint("run-1", 4);
    expect(flat(calls[0].sql)).toContain(
      "DELETE FROM funnel_merge_bucket WHERE run_key = $1 AND bucket_id = $2",
    );
    expect(calls[0].params).toEqual(["run-1", 4]);
  });
});
