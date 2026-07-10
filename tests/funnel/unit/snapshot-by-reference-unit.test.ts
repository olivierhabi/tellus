// ---------------------------------------------------------------------------
// PASS-BY-REFERENCE — snapshot inline_rows store + re-read path
//
// The fix persists the emitted changelog rows AND the merged rows in-band
// on their committed snapshots' `summary_json.inline_rows` (jsonb in
// Postgres). Downstream stages re-read them by `snapshotId`:
//   - Merge stage: `mergeChangesFromSnapshots` → `loadChangelogRowsFromSnapshot`
//   - Indexing stage: `loadMergedRowsFromSnapshot`
//
// These tests verify the CORE of the by-reference design without standing
// up Postgres:
//   1. `computeChangelog` populates `summary.inline_rows` on the snapshot
//      it commits (so the rows are durably re-readable — this is what
//      makes dropping `rows` from the activity return safe).
//   2. `loadChangelogRowsFromSnapshot` recovers the persisted rows by id.
//   3. `loadMergedRowsFromSnapshot` recovers the persisted merged rows.
//
// Pure-unit: `commitSnapshot` + the raw `query` are stubbed. The
// `computeChangelog` + the re-read functions under test are the REAL
// implementations.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  commitSnapshotMock: vi.fn(),
}));

// Stub the iceberg catalog — only `commitSnapshot` (capture the committed
// summary) + `funnelNamespace` are exercised by the real `computeChangelog`.
// Avoiding `importOriginal` keeps the test free of the real catalog's
// Lakekeeper / AWS-SDK imports. Type-only imports (`ManifestEntry`,
// `SnapshotOperation`) are erased and need no runtime stub.
vi.mock("../../../src/services/funnel/icebergCatalog", () => ({
  commitSnapshot: hoisted.commitSnapshotMock,
  funnelNamespace: (apiName: string, kind: string) =>
    `_funnel.${apiName}.${kind}`,
}));

// Single `query` mock — configured per-test to drive the namespace guard,
// the watermark write, or the snapshot re-read SELECT as needed.
vi.mock("../../../src/db", () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

const { query } = await import("../../../src/db");
const { computeChangelog } = await import(
  "../../../src/services/funnel/changelogStage"
);
const {
  loadChangelogRowsFromSnapshot,
  loadMergedRowsFromSnapshot,
} = await import("../../../src/services/funnel/mergeStage");
import type { ChangelogRow, SourceChangeRow, SnapshotDiffReader } from "../../../src/services/funnel/changelogStage";
import type { MergeResult } from "../../../src/services/funnel/mergeStage";

function arrayReader(rows: SourceChangeRow[]): SnapshotDiffReader {
  return {
    async *read() {
      for (const r of rows) yield r;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PASS-BY-REFERENCE — computeChangelog persists inline_rows", () => {
  const rows: SourceChangeRow[] = [
    {
      primary_key: "pk-A",
      operation: "INSERT",
      properties: { orderId: 1, status: "pending" },
      source_transaction_id: "00000000-0000-0000-0000-000000000000",
      source_commit_timestamp: "2026-07-10T00:00:00.000Z",
    },
    {
      primary_key: "pk-B",
      operation: "INSERT",
      properties: { orderId: 2, status: "shipped" },
      source_transaction_id: "00000000-0000-0000-0000-000000000000",
      source_commit_timestamp: "2026-07-10T00:00:00.000Z",
    },
  ];

  it("writes the emitted rows onto the committed snapshot's summary.inline_rows", async () => {
    // Namespace guard query → no funnel_dataset row → skip (no throw).
    // Watermark write → no-op. Both go through the same `query` mock.
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);
    hoisted.commitSnapshotMock.mockResolvedValue({
      snapshot_id: "snap-cl-1",
      committed_at: "2026-07-10T00:00:00Z",
    } as never);

    const result = await computeChangelog(
      {
        ontologyId: "00000000-0000-0000-0000-000000000001",
        objectTypeApiName: "Order",
        datasourceId: "00000000-0000-0000-0000-000000000000",
        sourceTableId: "src",
        fromSnapshotId: null,
        toSnapshotId: "to",
        changelogTableId: "cl",
        outputFileLocation: "s3://_funnel/Order/changelog/default/data/x.parquet",
      },
      arrayReader(rows)
    );

    // commitSnapshot was called with the rows in summary.inline_rows —
    // this is the durable store that makes re-reading by snapshotId safe.
    expect(hoisted.commitSnapshotMock).toHaveBeenCalledTimes(1);
    const commitArg = hoisted.commitSnapshotMock.mock.calls[0][0] as {
      summary: Record<string, unknown>;
    };
    expect(commitArg.summary.inline_rows).toEqual(rows);
    // computeChangelog still returns rows (additive — the PG dispatcher
    // path that runs in-process, with no Temporal boundary, still gets
    // them by value). The Temporal ACTIVITY layer drops them.
    expect(result.rows).toEqual(rows);
    expect(result.rowsEmitted).toBe(2);
  });
});

describe("PASS-BY-REFERENCE — loadChangelogRowsFromSnapshot re-read", () => {
  const inline: ChangelogRow[] = [
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

  it("recovers the rows persisted on summary_json.inline_rows by snapshotId", async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{ summary_json: { inline_rows: inline } }],
    } as never);

    const out = await loadChangelogRowsFromSnapshot("snap-cl-1");
    expect(out).toEqual(inline);
  });

  it("returns [] when the snapshot has no inline_rows (e.g. pre-fix snapshot)", async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{ summary_json: { rows_emitted: 5 } }],
    } as never);
    expect(await loadChangelogRowsFromSnapshot("snap-old")).toEqual([]);
  });

  it("returns [] when the snapshot does not exist", async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);
    expect(await loadChangelogRowsFromSnapshot("snap-missing")).toEqual([]);
  });
});

describe("PASS-BY-REFERENCE — loadMergedRowsFromSnapshot re-read", () => {
  const inline: MergeResult["mergedRows"] = [
    {
      primary_key: "pk-A",
      properties: { orderId: 1 },
      markings: ["m1"],
      operation: "upsert",
      source_datasource_id: "00000000-0000-0000-0000-000000000000",
      source_transaction_id: "00000000-0000-0000-0000-000000000000",
    },
    {
      primary_key: "pk-B",
      properties: {},
      markings: [],
      operation: "delete",
      source_datasource_id: null,
      source_transaction_id: null,
    },
  ];

  it("recovers the merged rows persisted on the merged snapshot by id", async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{ summary_json: { inline_rows: inline } }],
    } as never);

    const out = await loadMergedRowsFromSnapshot("snap-merged-1");
    expect(out).toEqual(inline);
  });

  it("returns [] when the merged snapshot has no inline_rows", async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{ summary_json: { upserts: 3, deletes: 1 } }],
    } as never);
    expect(await loadMergedRowsFromSnapshot("snap-old")).toEqual([]);
  });
});
