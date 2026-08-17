// ---------------------------------------------------------------------------
// streamMergedRowsFromSnapshot — pure unit tests.
//
// This is the read half of the fix that let Object Types above
// TELLUS_PARQUET_READ_MAX_ROWS (2M) reach the Quickwit serving index. The
// array variant (loadMergedRowsFromSnapshot) goes through readParquetRows,
// which THROWS above the cap, so before this generator existed the largest
// Object Types — OO7 at 4.65M rows — could never be indexed at all.
//
// What has to hold, and what a refactor could break without failing tsc:
//
//   • a parquet_ref snapshot streams through streamParquetRows and NEVER
//     touches the materialising reader (that would restore the 2M wall),
//   • a legacy snapshot with no ref still yields its inline_rows, so
//     pre-fix snapshots keep replaying,
//   • an unknown refVersion degrades to the inline fallback rather than
//     mis-parsing (resolveParquetRef returns null by design),
//   • a missing snapshot row yields nothing instead of throwing — the
//     caller treats "no rows" as an empty merge, not as a stage failure,
//   • the row mapper normalises the wire shape: delete/upsert operation,
//     JSON columns parsed, and empty-string source ids become null (an
//     empty string would otherwise be indexed as a real provenance id).
//
// `../../db` and the parquet reader are mocked, so nothing here contacts
// Postgres, MinIO or DuckDB.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
vi.mock("../../../src/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  pool: {},
  getClient: vi.fn(),
  withTransaction: vi.fn(),
  queryWithRetry: (...args: unknown[]) => mockQuery(...args),
}));

/** Rows the mocked parquet reader will stream, and the refs it was asked for. */
let parquetRows: Record<string, unknown>[] = [];
const streamCalls: unknown[] = [];
const readCalls: unknown[] = [];

vi.mock("../../../src/services/funnel/funnelParquetStore", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../src/services/funnel/funnelParquetStore")
  >();
  return {
    ...actual,
    // Keep the REAL resolveParquetRef: its version gating is part of what we
    // are pinning here, so stubbing it would test the stub.
    streamParquetRows: async function* (
      ref: unknown,
      map: (r: Record<string, unknown>) => unknown,
    ) {
      streamCalls.push(ref);
      for (const r of parquetRows) yield map(r);
    },
    readParquetRows: async (ref: unknown) => {
      // Reaching this in the streaming path is the regression we care about:
      // it is the reader with the 2M throw.
      readCalls.push(ref);
      return parquetRows;
    },
  };
});

import { streamMergedRowsFromSnapshot } from "../../../src/services/funnel/mergeStage";

const PARQUET_REF = {
  // Numeric, matching PARQUET_REF_VERSION — resolveParquetRef compares with
  // !==, so a stringly-typed "v1" resolves to null and silently degrades to
  // the inline fallback.
  refVersion: 1,
  bucket: "tellus-funnel",
  key: "merged/snap-1.parquet",
  rowCount: 4_657_493,
  sizeBytes: 1234,
};

/** Programme the funnel_snapshot read with one summary_json payload. */
function primeSnapshot(summary: Record<string, unknown> | null): void {
  mockQuery.mockImplementation(async () => ({
    rows: summary === null ? [] : [{ summary_json: summary }],
  }));
}

async function collect(snapshotId = "snap-1"): Promise<any[]> {
  const out: any[] = [];
  for await (const r of streamMergedRowsFromSnapshot(snapshotId)) out.push(r);
  return out;
}

/** A parquet row as DuckDB hands it back (JSON columns as strings). */
function wireRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    primary_key: "pk-1",
    properties: JSON.stringify({ name: "a" }),
    markings: JSON.stringify(["m1"]),
    operation: "upsert",
    source_datasource_id: "ds-1",
    source_transaction_id: "tx-1",
    ...over,
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  parquetRows = [];
  streamCalls.length = 0;
  readCalls.length = 0;
});

describe("streamMergedRowsFromSnapshot — parquet_ref path", () => {
  it("streams the ref and never calls the materialising reader", async () => {
    primeSnapshot({ parquet_ref: PARQUET_REF });
    parquetRows = [wireRow({ primary_key: "a" }), wireRow({ primary_key: "b" })];

    const rows = await collect();

    expect(rows.map((r) => r.primary_key)).toEqual(["a", "b"]);
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]).toMatchObject({ key: PARQUET_REF.key, bucket: PARQUET_REF.bucket });
    // readParquetRows is the one that throws above 2M rows.
    expect(readCalls).toEqual([]);
  });

  it("does not fall through to inline_rows once a ref has streamed", async () => {
    // A snapshot can legitimately carry both (the ref is authoritative);
    // yielding both would double-index every row.
    primeSnapshot({
      parquet_ref: PARQUET_REF,
      inline_rows: [{ primary_key: "legacy", properties: {}, operation: "upsert" }],
    });
    parquetRows = [wireRow({ primary_key: "fresh" })];

    const rows = await collect();
    expect(rows.map((r) => r.primary_key)).toEqual(["fresh"]);
  });

  it("looks the snapshot up by id", async () => {
    primeSnapshot({ parquet_ref: PARQUET_REF });
    await collect("snap-xyz");
    expect(mockQuery.mock.calls[0][1]).toEqual(["snap-xyz"]);
  });
});

describe("streamMergedRowsFromSnapshot — row mapping", () => {
  it("parses JSON columns and maps the operation", async () => {
    primeSnapshot({ parquet_ref: PARQUET_REF });
    parquetRows = [
      wireRow({ operation: "delete" }),
      wireRow({ primary_key: "pk-2", operation: "upsert" }),
      // Anything unrecognised must NOT become a delete.
      wireRow({ primary_key: "pk-3", operation: "weird" }),
    ];

    const rows = await collect();

    expect(rows.map((r) => r.operation)).toEqual(["delete", "upsert", "upsert"]);
    expect(rows[0].properties).toEqual({ name: "a" });
    expect(rows[0].markings).toEqual(["m1"]);
  });

  it("normalises missing and empty-string source ids to null", async () => {
    primeSnapshot({ parquet_ref: PARQUET_REF });
    parquetRows = [
      wireRow({ source_datasource_id: "", source_transaction_id: "" }),
      wireRow({ primary_key: "pk-2", source_datasource_id: null, source_transaction_id: null }),
    ];

    const rows = await collect();

    for (const r of rows) {
      expect(r.source_datasource_id).toBeNull();
      expect(r.source_transaction_id).toBeNull();
    }
  });

  it("coerces a missing primary key to an empty string rather than undefined", async () => {
    primeSnapshot({ parquet_ref: PARQUET_REF });
    parquetRows = [wireRow({ primary_key: undefined })];
    const rows = await collect();
    expect(rows[0].primary_key).toBe("");
  });
});

describe("streamMergedRowsFromSnapshot — legacy and empty snapshots", () => {
  it("yields inline_rows when the snapshot predates parquet refs", async () => {
    const inline = [
      { primary_key: "l-1", properties: { a: 1 }, operation: "upsert" },
      { primary_key: "l-2", properties: {}, operation: "delete" },
    ];
    primeSnapshot({ inline_rows: inline });

    const rows = await collect();

    expect(rows).toEqual(inline);
    expect(streamCalls).toEqual([]);
  });

  it("falls back to inline_rows when the ref version is not understood", async () => {
    // Degrade, never mis-parse: resolveParquetRef returns null for a future
    // refVersion so a stale reader replays the legacy payload instead.
    primeSnapshot({
      parquet_ref: { ...PARQUET_REF, refVersion: 99 },
      inline_rows: [{ primary_key: "legacy", properties: {}, operation: "upsert" }],
    });

    const rows = await collect();

    expect(rows.map((r) => r.primary_key)).toEqual(["legacy"]);
    expect(streamCalls).toEqual([]);
  });

  it("falls back to inline_rows when the ref is missing bucket or key", async () => {
    primeSnapshot({
      parquet_ref: { refVersion: 1, rowCount: 10 },
      inline_rows: [{ primary_key: "legacy", properties: {}, operation: "upsert" }],
    });
    const rows = await collect();
    expect(rows.map((r) => r.primary_key)).toEqual(["legacy"]);
  });

  it("yields nothing when the snapshot row does not exist", async () => {
    primeSnapshot(null);
    await expect(collect()).resolves.toEqual([]);
    expect(streamCalls).toEqual([]);
  });

  it("yields nothing for a snapshot with neither a ref nor inline rows", async () => {
    primeSnapshot({});
    await expect(collect()).resolves.toEqual([]);
  });

  it("yields nothing when inline_rows is present but not an array", async () => {
    primeSnapshot({ inline_rows: { not: "an array" } });
    await expect(collect()).resolves.toEqual([]);
  });
});
