// ---------------------------------------------------------------------------
// streamFullIndexBatches — pure unit tests (offline; `../../db` is mocked so
// the object_instances repair read is injected).
//
// This generator is what lets Object Types above TELLUS_PARQUET_READ_MAX_ROWS
// (2M) reach the Quickwit serving index at all: the previous caller
// materialised every merged row, so the BIGGEST types were exactly the ones
// that could never be indexed. The properties worth pinning are therefore the
// ones a future refactor could quietly break without failing typecheck:
//
//   • batch boundaries honour `batchSize` (peak heap is the batch, not the
//     snapshot),
//   • `version` is monotonic ACROSS batches and continues into repair rows —
//     replay/rebuild must converge on the same state as the array variant,
//   • `editIds` ride on the FIRST yielded batch only and are never stranded,
//   • coverage is answered against the pending PK set, so a streamed base row
//     suppresses the repair read for its PK,
//   • an uncovered pending PK becomes an UPDATE when the instance still exists
//     and a DELETE tombstone when it does not, or when the latest edit deletes.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
vi.mock("../../../src/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import {
  streamFullIndexBatches,
  type PendingIndexEdit,
} from "../../../src/services/funnel/indexingStage";

const ONTOLOGY = "ont-1";
const OBJECT_TYPE = "OlivierOrder";

type BaseRow = {
  primary_key: string;
  properties: Record<string, unknown>;
  operation: "upsert" | "delete";
  source_transaction_id?: string | null;
};

/** Async source mimicking streamMergedRowsFromSnapshot. */
async function* source(rows: BaseRow[]): AsyncGenerator<BaseRow> {
  for (const r of rows) yield r;
}

function baseRows(count: number, prefix = "pk"): BaseRow[] {
  return Array.from({ length: count }, (_, i) => ({
    primary_key: `${prefix}-${i}`,
    properties: { i },
    operation: "upsert" as const,
  }));
}

function edit(pk: string, operation = "update", executedAt = "2026-08-16T00:00:00Z"): PendingIndexEdit {
  return { edit_id: `e-${pk}-${operation}`, primary_key: pk, operation, executed_at: executedAt };
}

/** Prime the object_instances repair read: only these PKs still exist. */
function primeInstances(present: Record<string, Record<string, unknown>>): void {
  mockQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
    const asked = (params[2] as string[]) ?? [];
    return {
      rows: asked
        .filter((pk) => pk in present)
        .map((pk) => ({ primary_key: pk, properties: present[pk] })),
    };
  });
}

async function collect(
  gen: AsyncGenerator<{ rows: unknown[]; editIds: string[] }>,
): Promise<{ rows: any[]; editIds: string[] }[]> {
  const out: { rows: any[]; editIds: string[] }[] = [];
  for await (const b of gen) out.push({ rows: b.rows as any[], editIds: b.editIds });
  return out;
}

beforeEach(() => {
  mockQuery.mockReset();
  primeInstances({});
});

describe("streamFullIndexBatches — batching", () => {
  it("splits base rows at batchSize and keeps every row exactly once", async () => {
    const rows = baseRows(25);
    const batches = await collect(
      streamFullIndexBatches({
        ontologyId: ONTOLOGY,
        objectTypeApiName: OBJECT_TYPE,
        baseRows: source(rows),
        pending: [],
        batchSize: 10,
      }),
    );

    expect(batches.map((b) => b.rows.length)).toEqual([10, 10, 5]);
    expect(batches.flatMap((b) => b.rows.map((r) => r.primary_key))).toEqual(
      rows.map((r) => r.primary_key),
    );
  });

  it("emits a single batch when the row count is under the default batch size", async () => {
    const batches = await collect(
      streamFullIndexBatches({
        ontologyId: ONTOLOGY,
        objectTypeApiName: OBJECT_TYPE,
        baseRows: source(baseRows(700)),
        pending: [],
      }),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0].rows).toHaveLength(700);
  });

  it("yields nothing at all when there are no base rows and no pending edits", async () => {
    const batches = await collect(
      streamFullIndexBatches({
        ontologyId: ONTOLOGY,
        objectTypeApiName: OBJECT_TYPE,
        baseRows: source([]),
        pending: [],
      }),
    );
    expect(batches).toEqual([]);
    // No PKs to repair ⇒ no object_instances read at all.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("does not exceed batchSize even when repair rows follow a full base batch", async () => {
    primeInstances({ "orphan-0": { v: 1 }, "orphan-1": { v: 2 }, "orphan-2": { v: 3 } });
    const batches = await collect(
      streamFullIndexBatches({
        ontologyId: ONTOLOGY,
        objectTypeApiName: OBJECT_TYPE,
        baseRows: source(baseRows(4)),
        pending: [edit("orphan-0"), edit("orphan-1"), edit("orphan-2")],
        batchSize: 2,
      }),
    );
    for (const b of batches) expect(b.rows.length).toBeLessThanOrEqual(2);
    expect(batches.flatMap((b) => b.rows).length).toBe(7);
  });
});

describe("streamFullIndexBatches — version numbering", () => {
  it("numbers rows 1..N monotonically across batch boundaries", async () => {
    const batches = await collect(
      streamFullIndexBatches({
        ontologyId: ONTOLOGY,
        objectTypeApiName: OBJECT_TYPE,
        baseRows: source(baseRows(7)),
        pending: [],
        batchSize: 3,
      }),
    );
    expect(batches.flatMap((b) => b.rows.map((r) => r.version))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("continues the version sequence into repair rows rather than restarting", async () => {
    primeInstances({ "orphan-a": { keep: true } });
    const batches = await collect(
      streamFullIndexBatches({
        ontologyId: ONTOLOGY,
        objectTypeApiName: OBJECT_TYPE,
        baseRows: source(baseRows(3)),
        pending: [edit("orphan-a")],
        batchSize: 3,
      }),
    );
    const versions = batches.flatMap((b) => b.rows.map((r) => r.version));
    expect(versions).toEqual([1, 2, 3, 4]);
  });
});

describe("streamFullIndexBatches — edit acknowledgement ids", () => {
  it("puts every pending edit id on the first batch and leaves the rest empty", async () => {
    const pending = [edit("pk-0"), edit("pk-1"), edit("pk-2")];
    const batches = await collect(
      streamFullIndexBatches({
        ontologyId: ONTOLOGY,
        objectTypeApiName: OBJECT_TYPE,
        baseRows: source(baseRows(6)),
        pending,
        batchSize: 2,
      }),
    );
    expect(batches[0].editIds).toEqual(pending.map((p) => p.edit_id));
    for (const b of batches.slice(1)) expect(b.editIds).toEqual([]);
  });

  it("never strands edit ids when the ONLY batch is the repair batch", async () => {
    // mergedRowCount === 0 path: activities.ts feeds an empty source, so every
    // pending edit must still be acknowledged via the repair batch.
    primeInstances({ "orphan-a": { keep: true } });
    const pending = [edit("orphan-a")];
    const batches = await collect(
      streamFullIndexBatches({
        ontologyId: ONTOLOGY,
        objectTypeApiName: OBJECT_TYPE,
        baseRows: source([]),
        pending,
      }),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0].editIds).toEqual(["e-orphan-a-update"]);
  });
});

describe("streamFullIndexBatches — coverage and repair", () => {
  it("suppresses the repair read for a pending PK carried by a streamed base row", async () => {
    const batches = await collect(
      streamFullIndexBatches({
        ontologyId: ONTOLOGY,
        objectTypeApiName: OBJECT_TYPE,
        baseRows: source(baseRows(3)),
        pending: [edit("pk-1")],
      }),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0].rows).toHaveLength(3);
    // Covered ⇒ no object_instances lookup is issued.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("emits an UPDATE carrying committed state for an uncovered PK that still exists", async () => {
    primeInstances({ "orphan-a": { name: "committed" } });
    const batches = await collect(
      streamFullIndexBatches({
        ontologyId: ONTOLOGY,
        objectTypeApiName: OBJECT_TYPE,
        baseRows: source([]),
        pending: [edit("orphan-a")],
      }),
    );
    expect(batches[0].rows[0]).toMatchObject({
      primary_key: "orphan-a",
      operation: "UPDATE",
      properties: { name: "committed" },
    });
  });

  it("emits a DELETE tombstone when the instance is already gone", async () => {
    primeInstances({});
    const batches = await collect(
      streamFullIndexBatches({
        ontologyId: ONTOLOGY,
        objectTypeApiName: OBJECT_TYPE,
        baseRows: source([]),
        pending: [edit("orphan-gone")],
      }),
    );
    expect(batches[0].rows[0]).toMatchObject({
      primary_key: "orphan-gone",
      operation: "DELETE",
      properties: {},
    });
  });

  it("emits a DELETE tombstone when the latest edit deletes, even if the row lingers", async () => {
    primeInstances({ "orphan-d": { stale: true } });
    const batches = await collect(
      streamFullIndexBatches({
        ontologyId: ONTOLOGY,
        objectTypeApiName: OBJECT_TYPE,
        baseRows: source([]),
        pending: [
          edit("orphan-d", "update", "2026-08-16T00:00:00Z"),
          edit("orphan-d", "delete", "2026-08-16T01:00:00Z"),
        ],
      }),
    );
    expect(batches[0].rows).toHaveLength(1);
    expect(batches[0].rows[0]).toMatchObject({ operation: "DELETE", properties: {} });
  });

  it("lets a later update win over an earlier delete for the same PK", async () => {
    primeInstances({ "orphan-u": { revived: true } });
    const batches = await collect(
      streamFullIndexBatches({
        ontologyId: ONTOLOGY,
        objectTypeApiName: OBJECT_TYPE,
        baseRows: source([]),
        pending: [
          edit("orphan-u", "delete", "2026-08-16T00:00:00Z"),
          edit("orphan-u", "update", "2026-08-16T02:00:00Z"),
        ],
      }),
    );
    expect(batches[0].rows[0]).toMatchObject({
      operation: "UPDATE",
      properties: { revived: true },
    });
  });

  it("maps a base-row delete operation to a DELETE index operation", async () => {
    const batches = await collect(
      streamFullIndexBatches({
        ontologyId: ONTOLOGY,
        objectTypeApiName: OBJECT_TYPE,
        baseRows: source([
          { primary_key: "pk-x", properties: { a: 1 }, operation: "delete" },
          { primary_key: "pk-y", properties: { a: 2 }, operation: "upsert" },
        ]),
        pending: [],
      }),
    );
    expect(batches[0].rows.map((r) => r.operation)).toEqual(["DELETE", "UPDATE"]);
  });

  it("carries source_transaction_id through and normalises null to undefined", async () => {
    const batches = await collect(
      streamFullIndexBatches({
        ontologyId: ONTOLOGY,
        objectTypeApiName: OBJECT_TYPE,
        baseRows: source([
          { primary_key: "pk-a", properties: {}, operation: "upsert", source_transaction_id: "tx-1" },
          { primary_key: "pk-b", properties: {}, operation: "upsert", source_transaction_id: null },
        ]),
        pending: [],
      }),
    );
    expect(batches[0].rows[0].source_transaction_id).toBe("tx-1");
    expect(batches[0].rows[1].source_transaction_id).toBeUndefined();
  });
});
