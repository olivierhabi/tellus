// ---------------------------------------------------------------------------
// Truthful indexing acknowledgement (OSv2 serving-index parity).
//
// An edit may receive applied_to_index_at ONLY after the serving index has
// confirmed the corrosponding batch; Quickwit outages, indexing failures and
// publish-wait timeouts must leave edits PENDING so the Redis overlay is
// retained and the next funnel run retries with full coverage.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runIndexingActivity, QuickwitPublishTimeoutError } from "../../../src/services/quickwit/indexingActivity";
import { QuickwitClient } from "../../../src/services/quickwit/client";
import { runIndexingActivityProxy } from "../../../src/services/funnel/temporal/activities";
import { buildFullIndexBatch } from "../../../src/services/funnel/indexingStage";

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });

function clientWithoutSplits(): QuickwitClient {
  return new QuickwitClient({
    baseUrl: "http://qw",
    fetchImpl: (async () => json({ splits: [] })) as never,
  });
}

describe("truthful indexing acknowledgement", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("publish timeout rejects with QuickwitPublishTimeoutError and stamps NOTHING (object_edits)", async () => {
    const updates: string[] = [];
    const dbMod = await import("../../../src/db");
    vi.spyOn(dbMod, "query").mockImplementation(async (sql: string) => {
      if (/UPDATE object_edits/i.test(sql)) updates.push(sql);
      return { rows: [], rowCount: 0 } as never;
    });
    // Publish returns strictly increasing offsets — the wait then polls
    // listSplits (empty) until the tiny timeout expires.
    let offset = 0;
    await expect(
      runIndexingActivity({
        ontologyId: "o",
        objectTypeApiName: "Orders",
        primaryKeyApiName: "id",
        reader: async function* () {
          yield {
            rows: [{ primary_key: "A", properties: {}, operation: "INSERT", version: 1 }],
            editIds: ["edit-1"],
          } as never;
        },
        publishDoc: async () => ++offset,
        publishTimeoutMs: 30,
        publishPollMs: 5,
        client: clientWithoutSplits(),
      }),
    ).rejects.toBeInstanceOf(QuickwitPublishTimeoutError);
    expect(updates).toEqual([]);
  });

  it("confirmed split publish stamps object_edits.applied_to_index_at", async () => {
    const updates: string[] = [];
    const dbMod = await import("../../../src/db");
    vi.spyOn(dbMod, "query").mockImplementation(async (sql: string) => {
      if (/UPDATE object_edits/i.test(sql)) updates.push(sql);
      return { rows: [], rowCount: 0 } as never;
    });
    let offset = 0;
    const client = new QuickwitClient({
      baseUrl: "http://qw",
      fetchImpl: (async () =>
        json({
          splits: [
            {
              split_id: "s-1",
              split_state: "Published",
              publish_timestamp: 1,
              tags: ["kafka-offset:0:2147483647"],
            },
          ],
        })) as never,
    });
    const out = await runIndexingActivity({
      ontologyId: "o",
      objectTypeApiName: "Orders",
      primaryKeyApiName: "id",
      reader: async function* () {
        yield {
          rows: [{ primary_key: "A", properties: {}, operation: "INSERT", version: 1 }],
          editIds: ["edit-1"],
        } as never;
      },
      publishDoc: async () => ++offset,
      publishTimeoutMs: 2_000,
      publishPollMs: 5,
      client,
    });
    expect(out.publishedSplitIds).toEqual(["s-1"]);
    expect(updates.some((u) => /applied_to_index_at = NOW\(\)/i.test(u))).toBe(true);
  });

  it("temporal indexing activity: Quickwit unreachable ⇒ edits stay pending, nothing stamped", async () => {
    process.env.TELLUS_ENVIRONMENT_ID = "truthful-test";
    const stamped: string[] = [];
    const dbMod = await import("../../../src/db");
    vi.spyOn(dbMod, "query").mockImplementation(async (sql: string) => {
      if (/UPDATE ontology_edit\s+SET\s+applied_to_index_at/i.test(sql)) {
        stamped.push(sql);
        return { rows: [], rowCount: 1 } as never;
      }
      if (/FROM ontology_edit/i.test(sql)) {
        return {
          rows: [
            {
              edit_id: "00000000-0000-0000-0000-000000000001",
              primary_key: "O-1",
              operation: "create",
              executed_at: new Date().toISOString(),
            },
          ],
          rowCount: 1,
        } as never;
      }
      // Environment seal: unsealed → sealed.
      return { rows: [], rowCount: 0 } as never;
    });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));

    const out = await runIndexingActivityProxy({
      ontologyId: "o",
      objectTypeApiName: "Orders",
      environmentId: "truthful-test",
      mergedSnapshotId: "snap-x",
      mergedRowCount: 1,
    } as never);
    expect(out.quickwit).toBe(false);
    expect(out.editsIndexed).toBe(0);
    expect(stamped).toEqual([]);
  });
});

describe("buildFullIndexBatch repair pass", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  const pending = (id: string, pk: string, op: string, at: string) => ({
    edit_id: id,
    primary_key: pk,
    operation: op,
    executed_at: at,
  });

  it("covers pending edits from earlier runs via object_instances; absent instance ⇒ DELETE tombstone", async () => {
    const dbMod = await import("../../../src/db");
    vi.spyOn(dbMod, "query").mockImplementation(async (sql: string) => {
      if (/FROM object_instances/i.test(sql)) {
        return {
          rows: [{ primary_key: "PK-old", properties: { status: "closed" } }],
          rowCount: 1,
        } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    });
    const batch = await buildFullIndexBatch({
      ontologyId: "ont-1",
      objectTypeApiName: "Orders",
      baseRows: [
        { primary_key: "PK-new", properties: { status: "open" }, operation: "UPDATE", version: 1 },
      ],
      pending: [
        pending("e1", "PK-new", "update", "2026-08-01T10:00:00Z"),
        pending("e2", "PK-old", "update", "2026-08-01T09:00:00Z"),
        pending("e3", "PK-gone", "delete", "2026-08-01T11:00:00Z"),
      ],
    });
    expect(batch.editIds).toEqual(["e1", "e2", "e3"]);
    const byPk = new Map(batch.rows.map((r) => [r.primary_key, r]));
    expect(byPk.get("PK-old")?.operation).toBe("UPDATE");
    expect(byPk.get("PK-old")?.properties).toEqual({ status: "closed" });
    expect(byPk.get("PK-gone")?.operation).toBe("DELETE");
    expect(byPk.get("PK-gone")?.properties).toEqual({});
  });

  it("newer delete wins over older creates on the same uncovered PK (no resurrection)", async () => {
    const dbMod = await import("../../../src/db");
    vi.spyOn(dbMod, "query").mockImplementation(async (sql: string) => {
      if (/FROM object_instances/i.test(sql)) {
        // instance still present (merge crashed between instance delete and stamp)
        return { rows: [{ primary_key: "PK-x", properties: { a: 1 } }], rowCount: 1 } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    });
    const batch = await buildFullIndexBatch({
      ontologyId: "ont-1",
      objectTypeApiName: "Orders",
      baseRows: [],
      pending: [
        pending("e-old", "PK-x", "create", "2026-08-01T08:00:00Z"),
        pending("e-new", "PK-x", "delete", "2026-08-01T12:00:00Z"),
      ],
    });
    expect(batch.rows).toHaveLength(1);
    expect(batch.rows[0].operation).toBe("DELETE");
  });

  it("stamps version counter monotonically after the base rows", async () => {
    const dbMod = await import("../../../src/db");
    vi.spyOn(dbMod, "query").mockImplementation(async () => ({ rows: [], rowCount: 0 }) as never);
    const batch = await buildFullIndexBatch({
      ontologyId: "ont-1",
      objectTypeApiName: "Orders",
      baseRows: [
        { primary_key: "A", properties: {}, operation: "UPDATE", version: 41 },
      ],
      pending: [pending("e1", "B", "create", "2026-08-01T08:00:00Z")],
    });
    expect(Math.max(...batch.rows.map((r) => r.version))).toBe(42);
  });
});
