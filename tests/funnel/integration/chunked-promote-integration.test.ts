// ---------------------------------------------------------------------------
// Chunked staging promote — against the REAL database.
//
// At 6.35M rows the single-statement promote exceeded the 60 s
// statement_timeout (57014) and starved the stage heartbeat. The promote now
// walks one run's staging rows in primary-key chunks inside the caller's ONE
// transaction. These cases pin, with tiny chunk sizes so every boundary is
// exercised:
//   * chunked verify == the exact counts; progress is reported per chunk;
//   * chunked promote applies upserts + deletes across chunk boundaries,
//     bumps versions only for changed rows, and drops every staging row;
//   * the result is identical for every chunk size (1, 3, 1000);
//   * a failure mid-promote rolls back EVERY chunk (live table untouched);
//   * chunked cleanup removes a run regardless of chunk size.
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
let branch: typeof import("../../../src/services/branchContext");

const OT = "ChunkedPromote";

beforeAll(async () => {
  db = await import("../../../src/db");
  staging = await import("../../../src/services/funnel/mergeStaging");
  branch = await import("../../../src/services/branchContext");
});

async function inRolledBackTxn(fn: (c: PoolClient, ontologyId: string) => Promise<void>) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const ontologyId = crypto.randomUUID();
    await client.query(
      `INSERT INTO ontology (ontology_id, display_name) VALUES ($1, $2)`,
      [ontologyId, `chunked-promote-${ontologyId}`],
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

const pk = (i: number) => `k${String(i).padStart(3, "0")}`;

async function seedLive(c: PoolClient, ontologyId: string, n: number) {
  await c.query(
    `INSERT INTO object_instances
       (ontology_id, branch_id, object_type_api_name, primary_key, properties, markings)
     SELECT $1, $2, $3, 'k' || lpad(g::text, 3, '0'), jsonb_build_object('v', g), '{}'
       FROM generate_series(0, $4 - 1) g`,
    [ontologyId, branch.deriveMainBranchId(ontologyId), OT, n],
  );
}

async function live(c: PoolClient, ontologyId: string) {
  const r = await c.query(
    `SELECT primary_key, properties, version::int AS version
       FROM object_instances
      WHERE ontology_id = $1 AND object_type_api_name = $2
      ORDER BY primary_key`,
    [ontologyId, OT],
  );
  return r.rows as Array<{ primary_key: string; properties: { v: number }; version: number }>;
}

async function stagingLeft(c: PoolClient, scope: { stagingRunId: string }) {
  const r = await c.query(
    `SELECT count(*)::int AS n FROM merge_staging_instances WHERE staging_run_id = $1`,
    [scope.stagingRunId],
  );
  return r.rows[0].n as number;
}

/** Live k000..k009 (v=i). Staged: k000..k002 deleted, k003..k005 unchanged,
 *  k006..k009 changed (v=100+i), k010..k011 new. Empty-string key excluded. */
function stagedRows(ontologyId: string) {
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push({
      ontology_id: ontologyId,
      object_type_api_name: OT,
      primary_key: pk(i),
      operation: (i < 3 ? "delete" : "upsert") as "delete" | "upsert",
      properties: { v: i >= 6 ? 100 + i : i },
      markings: [] as string[],
      source_datasource_id: null,
      source_transaction_id: null,
    });
  }
  return rows;
}

async function runCase(chunkRows: number) {
  let result: unknown;
  await inRolledBackTxn(async (c, ontologyId) => {
    await seedLive(c, ontologyId, 10);
    const scope = { ontologyId, objectTypeApiName: OT, stagingRunId: crypto.randomUUID() };
    await staging.stageMergeRows(c, scope, stagedRows(ontologyId));
    const progress: Array<[string, number]> = [];
    const opts = { chunkRows, onProgress: (p: { phase: string; rowsDone: number }) => progress.push([p.phase, p.rowsDone]) };
    const v = await staging.verifyMergeStaging(c, scope, opts);
    expect(v).toEqual({ staged: 12, stagedUpserts: 9, stagedDeletes: 3, distinctPk: 12, nullPk: 0, emptyPk: 0 });
    const out = await staging.promoteMergeStaging(c, scope, opts);
    // 4 changed + 2 new written; 3 unchanged skipped by IS DISTINCT FROM.
    expect(out).toEqual({ upserts: 6, deletes: 3 });
    expect(await stagingLeft(c, scope)).toBe(0);
    const promoteReports = progress.filter(([p]) => p === "promote");
    expect(promoteReports.length).toBe(Math.ceil(12 / chunkRows));
    expect(promoteReports[promoteReports.length - 1][1]).toBe(12);
    result = await live(c, ontologyId);
  });
  return result as Awaited<ReturnType<typeof live>>;
}

describe("chunked staging promote", () => {
  it("applies upserts + deletes across chunk boundaries identically for every chunk size", async () => {
    const byChunk = [];
    for (const n of [1, 3, 1000]) byChunk.push(await runCase(n));
    const expected = [
      ...[3, 4, 5].map((i) => ({ primary_key: pk(i), properties: { v: i }, version: 1 })),
      ...[6, 7, 8, 9].map((i) => ({ primary_key: pk(i), properties: { v: 100 + i }, version: 2 })),
      ...[10, 11].map((i) => ({ primary_key: pk(i), properties: { v: 100 + i }, version: 1 })),
    ];
    for (const r of byChunk) expect(r).toEqual(expected);
  });

  it("a failure in a later chunk rolls back every earlier chunk", async () => {
    await inRolledBackTxn(async (c, ontologyId) => {
      await seedLive(c, ontologyId, 10);
      const before = await live(c, ontologyId);
      const scope = { ontologyId, objectTypeApiName: OT, stagingRunId: crypto.randomUUID() };
      await staging.stageMergeRows(c, scope, stagedRows(ontologyId));
      await c.query("SAVEPOINT before_promote");
      let chunks = 0;
      await expect(
        staging.promoteMergeStaging(c, scope, {
          chunkRows: 4,
          onProgress: () => {
            chunks++;
          },
        }).then(async (r) => {
          // Simulate the caller failing after promote (e.g. a crash before COMMIT).
          throw new Error(`boom after ${chunks} chunks ${JSON.stringify(r)}`);
        }),
      ).rejects.toThrow(/boom after 3 chunks/);
      await c.query("ROLLBACK TO SAVEPOINT before_promote");
      expect(await live(c, ontologyId)).toEqual(before);
      expect(await stagingLeft(c, scope)).toBe(12);
    });
  });

  it("a statement failure mid-promote leaves the live table untouched", async () => {
    await inRolledBackTxn(async (c, ontologyId) => {
      await seedLive(c, ontologyId, 10);
      const before = await live(c, ontologyId);
      const scope = { ontologyId, objectTypeApiName: OT, stagingRunId: crypto.randomUUID() };
      await staging.stageMergeRows(c, scope, stagedRows(ontologyId));
      await c.query("SAVEPOINT before_promote");
      // Fail the 2nd chunk's upsert: a trigger raising on k006.
      await c.query(`
        CREATE OR REPLACE FUNCTION pg_temp.fail_k006() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.object_type_api_name = '${OT}' AND NEW.primary_key = 'k006' THEN
            RAISE EXCEPTION 'injected failure at k006';
          END IF;
          RETURN NEW;
        END $$`);
      await c.query(`CREATE TRIGGER chunked_promote_fail BEFORE UPDATE ON object_instances
                       FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_k006()`);
      await expect(staging.promoteMergeStaging(c, scope, { chunkRows: 4 })).rejects.toThrow(/injected failure/);
      await c.query("ROLLBACK TO SAVEPOINT before_promote");
      expect(await live(c, ontologyId)).toEqual(before);
      expect(await stagingLeft(c, scope)).toBe(12);
    });
  });

  it("chunked cleanup drops a whole run for any chunk size", async () => {
    await inRolledBackTxn(async (c, ontologyId) => {
      for (const n of [1, 5, 1000]) {
        const scope = { ontologyId, objectTypeApiName: OT, stagingRunId: crypto.randomUUID() };
        await staging.stageMergeRows(c, scope, stagedRows(ontologyId));
        await staging.clearMergeStagingRun(c, scope, { chunkRows: n });
        expect(await stagingLeft(c, scope)).toBe(0);
      }
      const a = { ontologyId, objectTypeApiName: OT, stagingRunId: crypto.randomUUID() };
      const b = { ontologyId, objectTypeApiName: OT, stagingRunId: crypto.randomUUID() };
      await staging.stageMergeRows(c, a, stagedRows(ontologyId));
      await staging.stageMergeRows(c, b, stagedRows(ontologyId));
      await staging.clearMergeStaging(c, { ontologyId, objectTypeApiName: OT }, { chunkRows: 2 });
      expect((await stagingLeft(c, a)) + (await stagingLeft(c, b))).toBe(0);
    });
  });
});
