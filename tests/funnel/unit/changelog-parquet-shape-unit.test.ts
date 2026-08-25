// ---------------------------------------------------------------------------
// computeChangelog summary shape + backward-compat loaders (Option 2).
//
// Verifies:
//   • computeChangelog commits summary_json with `parquet_ref` (NOT
//     `inline_rows`) and returns {ownedProperties, parquetRef} (NO rows).
//   • loadChangelogRowsFromSnapshot handles legacy `inline_rows` AND the
//     new `parquet_ref` (in-memory round-trip) AND returns [] when neither.
//
// The REAL DuckDB parquet round-trip is verified separately by
// `scripts/verify-funnel-parquet-roundtrip.ts` (vitest cannot load the
// duckdb native binding; tsx can). Here, funnelParquetStore is mocked to
// an in-memory byte store so the by-reference shape + backward-compat
// contracts are exercised without DuckDB.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  // In-memory parquet store: key -> rows[]. writeParquetRef captures;
  // readParquetRows replays.
  const store = new Map<string, unknown[]>();
  const commitCalls: { summary?: Record<string, unknown>; snapshotId?: string }[] = [];
  return { store, commitCalls };
});

// Mock funnelParquetStore with an in-memory round-trip (no DuckDB needed).
// The shape contract under test is what computeChangelog passes to
// commitSnapshot + what the loaders resolve — the parquet encode/decode
// itself is verified by the tsx round-trip script.
vi.mock("../../../src/services/funnel/funnelParquetStore", async (importOriginal) => {
  const real = await importOriginal<
    typeof import("../../../src/services/funnel/funnelParquetStore")
  >();
  return {
    ...real,
    writeParquetRef: vi.fn(async (opts: {
      rows: AsyncIterable<Record<string, unknown>>;
      key: string;
    }) => {
      const rows: unknown[] = [];
      for await (const r of opts.rows) rows.push(r);
      if (rows.length === 0) return null;
      hoisted.store.set(opts.key, rows);
      return {
        refVersion: real.PARQUET_REF_VERSION,
        bucket: "tellus-uploads",
        key: opts.key,
        rowCount: rows.length,
        sizeBytes: rows.length * 100,
      };
    }),
    readParquetRows: vi.fn(async <T,>(
      ref: { key: string },
      mapFn: (row: Record<string, unknown>) => T,
    ): Promise<T[]> => {
      const rows = hoisted.store.get(ref.key) ?? [];
      return rows.map((r) => mapFn(r as Record<string, unknown>));
    }),
    changelogParquetKey: vi.fn(
      (ot: string, snapId: string) => `changelogs/${ot}/${snapId}.parquet`,
    ),
    mergedParquetKey: vi.fn(
      (ot: string, snapId: string) => `merged/${ot}/${snapId}.parquet`,
    ),
    deleteOrphanParquetRef: vi.fn(async () => {}),
    parquetRefToUri: vi.fn(
      (ref: { bucket: string; key: string }) => `s3://${ref.bucket}/${ref.key}`,
    ),
    parseJsonColumn: real.parseJsonColumn,
    parseJsonArrayColumn: real.parseJsonArrayColumn,
    resolveParquetRef: real.resolveParquetRef,
    newSnapshotId: vi.fn(() => "snap-pre-gen-fixed"),
    PARQUET_REF_VERSION: real.PARQUET_REF_VERSION,
    CHANGELOG_PARQUET_COLUMNS: real.CHANGELOG_PARQUET_COLUMNS,
    MERGED_PARQUET_COLUMNS: real.MERGED_PARQUET_COLUMNS,
  };
});

vi.mock("../../../src/services/funnel/icebergCatalog", async (importOriginal) => {
  const real = await importOriginal<
    typeof import("../../../src/services/funnel/icebergCatalog")
  >();
  return {
    ...real,
    commitSnapshot: vi.fn(async (input: {
      summary?: Record<string, unknown>;
      snapshotId?: string;
    }) => {
      hoisted.commitCalls.push({
        summary: input.summary,
        snapshotId: input.snapshotId,
      });
      return { snapshot_id: input.snapshotId ?? "snap-fixed", committed_at: "now" };
    }),
  };
});

let queryImpl: ReturnType<typeof vi.fn>;
vi.mock("../../../src/db", () => {
  queryImpl = vi.fn().mockResolvedValue({ rows: [] });
  return { query: queryImpl, getClient: vi.fn() };
});

beforeEach(() => {
  hoisted.store.clear();
  hoisted.commitCalls.length = 0;
  queryImpl.mockReset();
  queryImpl.mockResolvedValue({ rows: [] });
});

const { computeChangelog } = await import("../../../src/services/funnel/changelogStage");
const { loadChangelogRowsFromSnapshot } = await import("../../../src/services/funnel/mergeStage");
const funnelParquetStore = await import("../../../src/services/funnel/funnelParquetStore");

function arrayReader(
  rows: import("../../../src/services/funnel/changelogStage").SourceChangeRow[],
) {
  return {
    async *read() {
      for (const r of rows) yield r;
    },
  };
}

describe("computeChangelog — summary shape (parquet_ref, NOT inline_rows)", () => {
  it("commits summary_json with parquet_ref and no inline_rows; returns ownedProperties + parquetRef (no rows)", async () => {
    const sourceRows = Array.from({ length: 100 }, (_, i) => ({
      primary_key: `pk-${i}`,
      operation: "INSERT" as const,
      properties: { orderId: i, customerId: `c-${i}` },
      source_transaction_id: "00000000-0000-0000-0000-000000000000",
      source_commit_timestamp: "2026-07-10T00:00:00.000Z",
    }));

    const result = await computeChangelog(
      {
        ontologyId: "ont-1",
        objectTypeApiName: "Order",
        datasourceId: "ds-1",
        sourceTableId: "tbl-1",
        fromSnapshotId: null,
        toSnapshotId: "to-1",
        changelogTableId: "tbl-1",
        outputFileLocation: "s3://_funnel/Order/changelog/default/data/x.parquet",
      },
      arrayReader(sourceRows),
    );

    // No rows in the return (by-reference).
    expect((result as Record<string, unknown>).rows).toBeUndefined();
    expect(result.ownedProperties).toEqual(expect.arrayContaining(["orderId", "customerId"]));
    expect(result.rowsEmitted).toBe(100);
    expect(result.parquetRef).not.toBeNull();
    expect(result.parquetRef!.refVersion).toBe(funnelParquetStore.PARQUET_REF_VERSION);
    expect(result.parquetRef!.rowCount).toBe(100);
    expect(result.parquetRef!.bucket).toBe("tellus-uploads");

    // commitSnapshot received a small summary with parquet_ref, NO inline_rows,
    // and the pre-generated snapshot id (deterministic parquet key).
    expect(hoisted.commitCalls).toHaveLength(1);
    const summary = hoisted.commitCalls[0].summary!;
    expect(summary.parquet_ref).toBeDefined();
    expect(summary.inline_rows).toBeUndefined();
    expect(summary.rows_emitted).toBe(100);
    expect(hoisted.commitCalls[0].snapshotId).toBe("snap-pre-gen-fixed");
    expect(result.parquetRef!.key).toBe("changelogs/Order/snap-pre-gen-fixed.parquet");

    // The parquet object was written (writeParquetRef captured the rows).
    expect(funnelParquetStore.writeParquetRef).toHaveBeenCalledTimes(1);
    expect(hoisted.store.has(result.parquetRef!.key)).toBe(true);
  });
});

describe("loadChangelogRowsFromSnapshot — backward-compat (legacy inline_rows + parquet_ref + empty)", () => {
  it("reads legacy inline_rows snapshots (no parquet_ref) without a migration", async () => {
    const inline = [
      {
        primary_key: "pk-A",
        operation: "INSERT",
        properties: { orderId: 1 },
        source_transaction_id: "00000000-0000-0000-0000-000000000000",
        source_commit_timestamp: "2026-07-10T00:00:00.000Z",
      },
      {
        primary_key: "pk-B",
        operation: "UPDATE",
        properties: { orderId: 2 },
        source_transaction_id: "00000000-0000-0000-0000-000000000000",
        source_commit_timestamp: "2026-07-10T00:00:01.000Z",
      },
    ];
    queryImpl.mockResolvedValueOnce({
      rows: [{ manifest_json: {}, summary_json: { inline_rows: inline } }],
    });
    const out = await loadChangelogRowsFromSnapshot("snap-legacy");
    expect(out).toEqual(inline);
  });

  it("reads a parquet_ref snapshot via the by-reference path", async () => {
    // Commit a changelog snapshot (writes the parquet object via the mock),
    // then load it back via the parquet_ref in the snapshot's summary_json.
    const sourceRows = Array.from({ length: 25 }, (_, i) => ({
      primary_key: `pk-${i}`,
      operation: "INSERT" as const,
      properties: { orderId: i },
      source_transaction_id: "00000000-0000-0000-0000-000000000000",
      source_commit_timestamp: "2026-07-10T00:00:00.000Z",
    }));
    const committed = await computeChangelog(
      {
        ontologyId: "ont-2",
        objectTypeApiName: "Order2",
        datasourceId: "ds-2",
        sourceTableId: "tbl-2",
        fromSnapshotId: null,
        toSnapshotId: "to-2",
        changelogTableId: "tbl-2",
        outputFileLocation: "s3://_funnel/Order2/changelog/default/data/x.parquet",
      },
      arrayReader(sourceRows),
    );
    queryImpl.mockResolvedValueOnce({
      rows: [
        {
          manifest_json: {},
          summary_json: { parquet_ref: committed.parquetRef },
        },
      ],
    });
    const out = await loadChangelogRowsFromSnapshot("snap-parquet");
    expect(out).toHaveLength(25);
    expect(out[0].primary_key).toBe("pk-0");
    expect(out[24].primary_key).toBe("pk-24");
    expect(out[0].properties).toEqual({ orderId: 0 });
  });

  it("returns [] when the snapshot has neither parquet_ref nor inline_rows", async () => {
    queryImpl.mockResolvedValueOnce({
      rows: [{ manifest_json: {}, summary_json: { rows_emitted: 5 } }],
    });
    expect(await loadChangelogRowsFromSnapshot("snap-old")).toEqual([]);
  });

  it("returns [] when the snapshot does not exist", async () => {
    queryImpl.mockResolvedValueOnce({ rows: [] });
    expect(await loadChangelogRowsFromSnapshot("snap-missing")).toEqual([]);
  });
});
