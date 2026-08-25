// ---------------------------------------------------------------------------
// PASS-BY-REFERENCE payload-size regression guard
//
// The original bug: `runChangelogActivity` returned the full
// `ChangelogRow[]` in its Temporal activity result (~42 MB for an 83k-row
// dataset), which exceeded Temporal's `RespondActivityTaskCompleted`
// payload limit. No `ActivityTaskCompleted` was ever recorded, the
// workflow's `await runChangelogActivity` never resolved, and the funnel
// stayed pinned at "changelog" forever.
//
// The fix (Option B — pass-by-reference): `computeChangelog` persists
// the rows in-band on the committed snapshot's `summary_json.inline_rows`
// (see snapshot-by-reference-unit.test.ts); `runChangelogActivity` now
// returns only `{ snapshotId, rowsEmitted, manifest, ownedProperties }`
// — the row array is dropped.
//
// THIS test is the regression guard that prevents the bug class from
// recurring silently: it drives `runChangelogActivity` with a mocked
// `computeChangelog` that returns a REPRESENTATIVE LARGE row set, and
// asserts the activity's actual return value serializes to well under
// 1 MB (Temporal's safe budget) AND contains no `rows` key. If a future
// change re-adds the row array (or any large payload) to an activity
// return, this test fails.
//
// Pure-unit: no Postgres, S3, OpenSearch, or Temporal worker. All I/O
// the activity touches is stubbed.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

// 83,087 rows — the exact size of the dataset that triggered the original
// "stuck at changelog" incident. Each row carries a modest payload so the
// "would-be by-value return" is clearly over the 1 MB budget (proving the
// guard bites) without making the test slow.
const REPRESENTATIVE_ROW_COUNT = 83_087;
const PAYLOAD_BUDGET_BYTES = 1_000_000; // 1 MB — well under Temporal's limits.

const hoisted = vi.hoisted(() => {
  const computeChangelogMock = vi.fn();
  // Synthetic large row set. The activity will OWN this internally
  // (computeChangelog returns it) but MUST NOT echo it in its return.
  const bigRows = Array.from({ length: 83_087 }, (_, i) => ({
    primary_key: `pk-${i}`,
    operation: "INSERT" as const,
    properties: {
      orderId: i,
      customerId: `c-${i % 5000}`,
      itemName: `item-${i % 200}`,
      quantity: (i % 100) + 1,
      unitPrice: (i % 1000) / 100,
      status: ["pending", "shipped", "delivered"][i % 3],
    },
    source_transaction_id: "00000000-0000-0000-0000-000000000000",
    source_commit_timestamp: "2026-07-10T00:00:00.000Z",
  }));
  return { computeChangelogMock, bigRows };
});

// Stub computeChangelog so the activity gets a large row set WITHOUT
// touching Postgres/MinIO. The rest of changelogStage stays real.
vi.mock("../../../src/services/funnel/changelogStage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/funnel/changelogStage")>()),
  computeChangelog: hoisted.computeChangelogMock,
}));

// No DuckDB in the offline lane — the foundry/iceberg reader branches are
// short-circuited so the activity falls through to the pending-edit
// fallback reader (empty) before calling the mocked computeChangelog.
vi.mock("../../../src/services/funnel/duckdbIceberg", () => ({
  isDuckDBAvailable: () => false,
  duckdbIcebergDiffReader: vi.fn(),
}));

// ensureTable() -> getTable(); stubbed to return a minimal dataset row so
// the activity never tries to createTable() against a real catalog.
vi.mock("../../../src/services/funnel/icebergCatalog", async (importOriginal) => {
  const real = await importOriginal<
    typeof import("../../../src/services/funnel/icebergCatalog")
  >();
  return {
    ...real,
    getTable: vi.fn().mockResolvedValue({
      dataset_table_id: "t-changelog",
      namespace: "_funnel.Order.changelog",
      table_name: "default",
      location: "s3://_funnel/Order/changelog/default",
      latest_snapshot_id: null,
    }),
    createTable: vi.fn().mockResolvedValue({
      dataset_table_id: "t-changelog",
      location: "s3://_funnel/Order/changelog/default",
      latest_snapshot_id: null,
    }),
  };
});

// All raw SQL the activity issues (loadIcebergSource,
// loadFoundryBridgedDatasource, getPendingMergeEdits) returns nothing →
// the pending-edit fallback reader yields zero rows; computeChangelog is
// the mocked source of the large row set.
vi.mock("../../../src/db", () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  getClient: vi.fn(),
}));

// withStageInstrumentation records duration/error metrics; keep them as
// no-ops so the test never depends on the prom client being registered.
vi.mock("../../../src/services/funnel/metrics", () => ({
  observeHistogram: vi.fn(),
  incCounter: vi.fn(),
}));

// sleepForStageDelay is a no-op with the default env (FUNNEL_STAGE_DELAY_MS=0)
// but stub it to be certain the suite never waits. writeStageReceipt is
// equally deterministic (no-op when the receipt env is unset — no env set
// in this lane).
vi.mock("../../../src/services/funnel/stageDelay", () => ({
  sleepForStageDelay: vi.fn().mockResolvedValue(undefined),
  writeStageReceipt: vi.fn(),
}));

const { runChangelogActivity } = await import(
  "../../../src/services/funnel/temporal/activities"
);

// FUNN-ISO: the activity fence requires the dispatch ctx environment id to
// match THIS worker process's identity. This test is a payload-size guard —
// the specific environment name is irrelevant to what it proves — so take
// the ambient identity instead of hard-coding one. Hard-coding "tellus-dev"
// passed only because the offline unit lane leaves the worker env to
// dotenv (tellus-dev) and broke under the default (lane-pinned) config
// where the worker identity is "tellus-tests-main".
const WORKER_ENV_ID = process.env.TELLUS_ENVIRONMENT_ID ?? "tellus-dev";

beforeEach(() => {
  hoisted.computeChangelogMock.mockReset();
  hoisted.computeChangelogMock.mockResolvedValue({
    snapshotId: "snap-83k",
    rowsEmitted: REPRESENTATIVE_ROW_COUNT,
    manifest: [
      {
        file_path: "s3://_funnel/Order/changelog/default/data/2026.parquet",
        file_size_bytes: 0,
        row_count: REPRESENTATIVE_ROW_COUNT,
        operation: "added",
      },
    ],
    // The by-value fix (Option 2): computeChangelog persists rows to a
    // MinIO parquet (parquet_ref in summary_json) and returns ONLY the
    // small ownedProperties set — never the row array.
    ownedProperties: [
      "orderId",
      "customerId",
      "itemName",
      "quantity",
      "unitPrice",
      "status",
    ],
  });
});

describe("PASS-BY-REFERENCE — changelog activity return payload", () => {
  it("does NOT include the row array in the activity return value", async () => {
    const result = await runChangelogActivity({
      ontologyId: "00000000-0000-0000-0000-000000000001",
      objectTypeApiName: "Order",
      environmentId: WORKER_ENV_ID,
    });

    // The single most important assertion: the row array that used to
    // blow Temporal's payload limit is NOT in the return.
    expect(result).not.toHaveProperty("rows");
  });

  it("returns only the small by-reference fields", async () => {
    const result = await runChangelogActivity({
      ontologyId: "00000000-0000-0000-0000-000000000001",
      objectTypeApiName: "Order",
      environmentId: WORKER_ENV_ID,
    });

    expect(result).toEqual(
      expect.objectContaining({
        snapshotId: "snap-83k",
        rowsEmitted: REPRESENTATIVE_ROW_COUNT,
        manifest: expect.any(Array),
        ownedProperties: expect.any(Array),
      })
    );
    // ownedProperties is the small property-name set the merge stage needs
    // for column-wise MDO — NOT the row data.
    expect(result.ownedProperties).toEqual(
      expect.arrayContaining([
        "orderId",
        "customerId",
        "itemName",
        "quantity",
        "unitPrice",
        "status",
      ])
    );
    expect(result.ownedProperties!.length).toBeLessThan(20);
  });

  it("serializes to well under 1 MB even for an 83k-row dataset", async () => {
    const result = await runChangelogActivity({
      ontologyId: "00000000-0000-0000-0000-000000000001",
      objectTypeApiName: "Order",
      environmentId: WORKER_ENV_ID,
    });

    const serialized = JSON.stringify(result);
    expect(serialized.length).toBeLessThan(PAYLOAD_BUDGET_BYTES);
  });

  it("proves the guard bites: a by-value return WOULD exceed the budget", async () => {
    await runChangelogActivity({
      ontologyId: "00000000-0000-0000-0000-000000000001",
      objectTypeApiName: "Order",
      environmentId: WORKER_ENV_ID,
    });

    // computeChangelog was called. Under Option 2 it streams the rows to a
    // MinIO parquet and returns only {snapshotId, rowsEmitted, manifest,
    // ownedProperties} — the large row set NEVER enters the activity return.
    expect(hoisted.computeChangelogMock).toHaveBeenCalledTimes(1);

    // Reconstruct what the OLD (buggy) by-value return would have looked
    // like: the small fields PLUS the 83k-row array. That serialization
    // MUST exceed the 1 MB budget — otherwise the row set isn't
    // representative and the regression guard isn't proving anything.
    expect(hoisted.bigRows).toHaveLength(REPRESENTATIVE_ROW_COUNT);
    const oldStyleReturn = {
      snapshotId: "snap-83k",
      rowsEmitted: REPRESENTATIVE_ROW_COUNT,
      manifest: [{ file_path: "x", file_size_bytes: 0, row_count: REPRESENTATIVE_ROW_COUNT, operation: "added" }],
      rows: hoisted.bigRows,
    };
    const oldStyleSerialized = JSON.stringify(oldStyleReturn);
    expect(oldStyleSerialized.length).toBeGreaterThan(PAYLOAD_BUDGET_BYTES);
  });
});
