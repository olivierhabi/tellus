// ---------------------------------------------------------------------------
// Indexing close-out — live-table writer contract against the REAL database.
//
//   * Provenance never regresses to NULL: a staged NULL or non-uuid
//     source id (asUuidOrNull downgrade) keeps the live breadcrumb, through
//     BOTH promoteMergeStaging (SQL/merge path) and bulkUpsertInstances
//     (reindex path). A valid new uuid still replaces the old one.
//   * Single writer (1.5): the pure-TS merge commits through
//     commitMergedRowsViaStaging → stage → assertStagedTail → promote, and
//     produces exactly the same live rows as the staging/promote contract
//     used by the SQL path. Duplicate staged PKs fail the gate with the
//     live table untouched.
//
// Every case runs on ONE dedicated client inside BEGIN … ROLLBACK with a
// throwaway ontology, so the shared database is never altered.
// ---------------------------------------------------------------------------

import { LANE } from "../../laneEnv";
import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

void LANE;

type PoolClient = import("pg").PoolClient;

let db: typeof import("../../../src/db");
let staging: typeof import("../../../src/services/funnel/mergeStaging");
let merge: typeof import("../../../src/services/funnel/mergeStage");
let objectInstance: typeof import("../../../src/models/objectInstance");
let branch: typeof import("../../../src/services/branchContext");

const OT = "CloseoutProvenance";
const DS_OLD = "11111111-1111-4111-8111-111111111111";
const TX_OLD = "22222222-2222-4222-8222-222222222222";
const DS_NEW = "33333333-3333-4333-8333-333333333333";

beforeAll(async () => {
  db = await import("../../../src/db");
  staging = await import("../../../src/services/funnel/mergeStaging");
  merge = await import("../../../src/services/funnel/mergeStage");
  objectInstance = await import("../../../src/models/objectInstance");
  branch = await import("../../../src/services/branchContext");
});

async function inRolledBackTxn(fn: (c: PoolClient, ontologyId: string) => Promise<void>) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const ontologyId = crypto.randomUUID();
    await client.query(
      `INSERT INTO ontology (ontology_id, display_name) VALUES ($1, $2)`,
      [ontologyId, `closeout-provenance-${ontologyId}`],
    );
    await client.query(
      `INSERT INTO ontology_branch (branch_id, ontology_id, name) VALUES ($1, $2, 'main')`,
      [branch.deriveMainBranchId(ontologyId), ontologyId],
    );
    await fn(client, ontologyId);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

async function seedLive(c: PoolClient, ontologyId: string, pk: string) {
  await c.query(
    `INSERT INTO object_instances
       (ontology_id, branch_id, object_type_api_name, primary_key, properties,
        markings, source_datasource_id, source_transaction_id)
     VALUES ($1, $2, $3, $4, '{"v":1}'::jsonb, '{}', $5, $6)`,
    [ontologyId, branch.deriveMainBranchId(ontologyId), OT, pk, DS_OLD, TX_OLD],
  );
}

async function live(c: PoolClient, ontologyId: string) {
  const r = await c.query(
    `SELECT primary_key, properties, markings,
            source_datasource_id::text AS ds, source_transaction_id::text AS tx
       FROM object_instances
      WHERE ontology_id = $1 AND object_type_api_name = $2
      ORDER BY primary_key`,
    [ontologyId, OT],
  );
  return r.rows as Array<{ primary_key: string; properties: unknown; markings: string[]; ds: string | null; tx: string | null }>;
}

function row(ontologyId: string, pk: string, ds: string | null, tx: string | null, v = 2) {
  return {
    ontology_id: ontologyId,
    object_type_api_name: OT,
    primary_key: pk,
    operation: "upsert" as const,
    properties: { v },
    markings: [] as string[],
    source_datasource_id: ds,
    source_transaction_id: tx,
  };
}

describe("live provenance never regresses to NULL", () => {
  it("promoteMergeStaging keeps live provenance for NULL / non-uuid staged ids", async () => {
    await inRolledBackTxn(async (c, ontologyId) => {
      await seedLive(c, ontologyId, "a");
      await seedLive(c, ontologyId, "b");
      await seedLive(c, ontologyId, "c");
      const scope = { ontologyId, objectTypeApiName: OT, stagingRunId: crypto.randomUUID() };
      await staging.stageMergeRows(c, scope, [
        row(ontologyId, "a", null, null),
        row(ontologyId, "b", "csv:not-a-uuid", "edit_42"),
        row(ontologyId, "c", DS_NEW, null),
      ]);
      await staging.promoteMergeStaging(c, scope);
      const rows = await live(c, ontologyId);
      expect(rows.map((r) => [r.primary_key, r.ds, r.tx])).toEqual([
        ["a", DS_OLD, TX_OLD],
        ["b", DS_OLD, TX_OLD],
        ["c", DS_NEW, TX_OLD],
      ]);
      expect(rows.every((r) => (r.properties as { v: number }).v === 2)).toBe(true);
    });
  });

  it("bulkUpsertInstances (reindex path) keeps live provenance for NULL / non-uuid ids", async () => {
    await inRolledBackTxn(async (c, ontologyId) => {
      await seedLive(c, ontologyId, "a");
      await seedLive(c, ontologyId, "b");
      await objectInstance.bulkUpsertInstances(
        [row(ontologyId, "a", null, null), row(ontologyId, "b", "not-a-uuid", DS_NEW)],
        c,
      );
      const rows = await live(c, ontologyId);
      expect(rows.map((r) => [r.primary_key, r.ds, r.tx])).toEqual([
        ["a", DS_OLD, TX_OLD],
        ["b", DS_OLD, DS_NEW],
      ]);
    });
  });

  it("a NULL-provenance re-merge of unchanged content is a no-op (no version bump)", async () => {
    await inRolledBackTxn(async (c, ontologyId) => {
      await seedLive(c, ontologyId, "a");
      const scope = { ontologyId, objectTypeApiName: OT, stagingRunId: crypto.randomUUID() };
      await staging.stageMergeRows(c, scope, [row(ontologyId, "a", null, null, 1)]);
      const res = await staging.promoteMergeStaging(c, scope);
      expect(res.upserts).toBe(0);
      const v = await c.query(
        `SELECT version FROM object_instances WHERE ontology_id = $1 AND primary_key = 'a'`,
        [ontologyId],
      );
      expect(Number(v.rows[0].version)).toBe(1);
    });
  });
});

describe("pure-TS merge commits through the single staging/promote writer", () => {
  it("upserts + deletes land exactly as the staging contract dictates; staging is emptied", async () => {
    await inRolledBackTxn(async (c, ontologyId) => {
      await seedLive(c, ontologyId, "keep");
      await seedLive(c, ontologyId, "gone");
      const res = await merge.commitMergedRowsViaStaging(c, { ontologyId, objectTypeApiName: OT }, [
        { primary_key: "keep", properties: { v: 9 }, markings: ["m1"], operation: "upsert", source_datasource_id: null, source_transaction_id: null },
        { primary_key: "gone", properties: {}, markings: [], operation: "delete", source_datasource_id: null, source_transaction_id: null },
        { primary_key: "new", properties: { v: 3 }, markings: [], operation: "upsert", source_datasource_id: DS_NEW, source_transaction_id: null },
      ]);
      expect(res).toEqual({ upserts: 2, deletes: 1 });
      const rows = await live(c, ontologyId);
      expect(rows.map((r) => [r.primary_key, r.properties, r.markings, r.ds, r.tx])).toEqual([
        ["keep", { v: 9 }, ["m1"], DS_OLD, TX_OLD],
        ["new", { v: 3 }, [], DS_NEW, null],
      ]);
      const left = await c.query(
        `SELECT count(*)::int AS n FROM merge_staging_instances WHERE ontology_id = $1`,
        [ontologyId],
      );
      expect(left.rows[0].n).toBe(0);
    });
  });

  it("matches the SQL path's stage → verify → promote result row-for-row", async () => {
    const merged = [
      { primary_key: "p1", properties: { a: 1, b: "x" }, markings: ["m"], operation: "upsert" as const, source_datasource_id: DS_NEW, source_transaction_id: TX_OLD },
      { primary_key: "p2", properties: {}, markings: [], operation: "delete" as const, source_datasource_id: null, source_transaction_id: null },
      { primary_key: "p3", properties: { z: [1, 2] }, markings: [], operation: "upsert" as const, source_datasource_id: null, source_transaction_id: null },
    ];
    let viaPureTs: unknown;
    let viaSqlContract: unknown;
    await inRolledBackTxn(async (c, ontologyId) => {
      await seedLive(c, ontologyId, "p2");
      await merge.commitMergedRowsViaStaging(c, { ontologyId, objectTypeApiName: OT }, merged);
      viaPureTs = (await live(c, ontologyId)).map(({ primary_key, properties, markings, ds, tx }) => ({ primary_key, properties, markings, ds, tx }));
    });
    await inRolledBackTxn(async (c, ontologyId) => {
      await seedLive(c, ontologyId, "p2");
      const scope = { ontologyId, objectTypeApiName: OT, stagingRunId: crypto.randomUUID() };
      await staging.stageMergeRows(c, scope, merged.map((m) => ({ ...m, ontology_id: ontologyId, object_type_api_name: OT })));
      const staged = await staging.verifyMergeStaging(c, scope);
      merge.assertStagedTail(staged, merged.length, OT);
      await staging.promoteMergeStaging(c, scope);
      viaSqlContract = (await live(c, ontologyId)).map(({ primary_key, properties, markings, ds, tx }) => ({ primary_key, properties, markings, ds, tx }));
    });
    expect(viaPureTs).toEqual(viaSqlContract);
    expect((viaPureTs as unknown[]).length).toBe(2);
  });

  it("duplicate PKs fail the staging gate before the live table is touched", async () => {
    await inRolledBackTxn(async (c, ontologyId) => {
      await seedLive(c, ontologyId, "dup");
      await c.query("SAVEPOINT before_merge");
      await expect(
        merge.commitMergedRowsViaStaging(c, { ontologyId, objectTypeApiName: OT }, [
          { primary_key: "dup", properties: { v: 7 }, markings: [], operation: "upsert", source_datasource_id: null, source_transaction_id: null },
          { primary_key: "dup", properties: { v: 8 }, markings: [], operation: "upsert", source_datasource_id: null, source_transaction_id: null },
        ]),
      ).rejects.toThrow();
      await c.query("ROLLBACK TO SAVEPOINT before_merge");
      const rows = await live(c, ontologyId);
      expect(rows.map((r) => [r.primary_key, r.properties])).toEqual([["dup", { v: 1 }]]);
    });
  });
});
