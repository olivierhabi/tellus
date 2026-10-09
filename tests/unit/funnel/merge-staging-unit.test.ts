// ---------------------------------------------------------------------------
// Merge staging + promote — unit tests (Blocker 3).
//
// The PG client is faked, so these pin the SQL contract, not Postgres:
//   * staging loads target merge_staging_instances (never object_instances);
//   * staging PK includes the run id (a duplicate inside one run fails);
//   * verify reads count/distinct/null/empty scoped to the run, in
//     pk-keyset chunks;
//   * promote writes the LIVE table inside the caller's transaction in
//     bounded pk-ordered chunks (each under statement_timeout, progress
//     reported between them) and drops each chunk's staging rows;
//   * resolveStagingRunId prefers a uuid run key, else the snapshot id.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  clearMergeStaging,
  clearMergeStagingRun,
  stageMergeRows,
  verifyMergeStaging,
  promoteMergeStaging,
  resolveStagingRunId,
} from "../../../src/services/funnel/mergeStaging";

interface Call {
  sql: string;
  params: unknown[];
}

function fakeClient(respond: (sql: string) => { rows: Record<string, unknown>[]; rowCount: number }) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return respond(sql);
      },
    } as never,
  };
}

const SCOPE = {
  ontologyId: "00000000-0000-0000-0000-000000000001",
  objectTypeApiName: "Account",
  stagingRunId: "11111111-1111-1111-1111-111111111111",
};

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("resolveStagingRunId", () => {
  it("prefers a uuid run key, else the snapshot id", () => {
    expect(
      resolveStagingRunId("22222222-2222-2222-2222-222222222222", "snap"),
    ).toBe("22222222-2222-2222-2222-222222222222");
    expect(resolveStagingRunId("not-a-uuid", "snap")).toBe("snap");
    expect(resolveStagingRunId(undefined, "snap")).toBe("snap");
  });
});

describe("staging loads", () => {
  it("targets merge_staging_instances with the run id, never the live table", async () => {
    const { calls, client } = fakeClient(() => ({ rows: [], rowCount: 1 }));
    const n = await stageMergeRows(client, SCOPE, [
      {
        ontology_id: SCOPE.ontologyId,
        object_type_api_name: SCOPE.objectTypeApiName,
        primary_key: "A",
        operation: "upsert",
        properties: { x: 1 },
        markings: [],
        source_datasource_id: null,
        source_transaction_id: null,
      },
    ]);
    expect(n).toBe(1);
    expect(calls).toHaveLength(1);
    const sql = flat(calls[0].sql);
    expect(sql).toContain("INSERT INTO merge_staging_instances");
    expect(sql).not.toContain("INSERT INTO object_instances");
    expect(calls[0].params[0]).toBe(SCOPE.stagingRunId);
  });

  it("clear scopes to the owner (ontology, object type) and deletes per run in pk ranges", async () => {
    const { calls, client } = fakeClient((sql) =>
      sql.includes("SELECT DISTINCT")
        ? { rows: [{ staging_run_id: SCOPE.stagingRunId, branch_id: "b" }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    await clearMergeStaging(client, SCOPE);
    const sqls = calls.map((c) => flat(c.sql));
    expect(sqls[0]).toContain("ontology_id = $1 AND object_type_api_name = $2");
    expect(calls[0].params).toEqual([SCOPE.ontologyId, SCOPE.objectTypeApiName]);
    const del = sqls.findIndex((q) => q.startsWith("DELETE FROM merge_staging_instances"));
    expect(del).toBeGreaterThan(0);
    expect(sqls[del]).toContain("staging_run_id = $1");
    expect(calls[del].params.slice(0, 4)).toEqual([SCOPE.stagingRunId, SCOPE.ontologyId, "b", SCOPE.objectTypeApiName]);
  });

  it("clear run scopes to the run id and walks bounded pk ranges", async () => {
    let bounds = 0;
    const { calls, client } = fakeClient((sql) => {
      if (sql.includes("SELECT DISTINCT")) return { rows: [{ staging_run_id: SCOPE.stagingRunId, branch_id: "b" }], rowCount: 1 };
      if (sql.includes("OFFSET")) return bounds++ === 0 ? { rows: [{ primary_key: "K2" }], rowCount: 1 } : { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 2 };
    });
    const phases: string[] = [];
    await clearMergeStagingRun(client, SCOPE, { chunkRows: 2, onProgress: (p) => phases.push(p.phase) });
    expect(flat(calls[0].sql)).toContain("staging_run_id = $1");
    const dels = calls.filter((c) => flat(c.sql).startsWith("DELETE FROM merge_staging_instances"));
    expect(dels).toHaveLength(2);
    expect(flat(dels[0].sql)).toContain("primary_key <= $5");
    expect(dels[0].params[4]).toBe("K2");
    expect(flat(dels[1].sql)).toContain("primary_key > $5");
    expect(dels[1].params[4]).toBe("K2");
    expect(phases).toEqual(["cleanup", "cleanup"]);
  });
});

describe("verify + promote", () => {
  it("verify sums staged/distinct/null/empty over pk-keyset chunks scoped to the run", async () => {
    const chunks = [
      { staged: "2", upserts: "2", deletes: "0", distinct_pk: "2", null_pk: "0", empty_pk: "1", last_pk: "B" },
      { staged: "1", upserts: "0", deletes: "1", distinct_pk: "1", null_pk: "0", empty_pk: "0", last_pk: "C" },
    ];
    let i = 0;
    const { calls, client } = fakeClient(() => ({ rows: [chunks[i++]], rowCount: 1 }));
    const progress: number[] = [];
    const v = await verifyMergeStaging(client, SCOPE, { chunkRows: 2, onProgress: (p) => progress.push(p.rowsDone) });
    expect(v).toEqual({
      staged: 3,
      stagedUpserts: 2,
      stagedDeletes: 1,
      distinctPk: 3,
      nullPk: 0,
      emptyPk: 1,
    });
    expect(calls).toHaveLength(2);
    expect(flat(calls[0].sql)).toContain("FROM merge_staging_instances");
    expect(flat(calls[0].sql)).toContain("staging_run_id = $1");
    expect(flat(calls[0].sql)).toContain("LIMIT 2");
    // first chunk is unbounded below (so an empty-string key is still counted)
    expect(flat(calls[0].sql)).not.toContain("primary_key > $5");
    expect(flat(calls[1].sql)).toContain("primary_key > $5");
    expect(calls[1].params[4]).toBe("B");
    expect(progress).toEqual([2, 3]);
  });

  it("promote walks staging in chunks: upsert, index-keyed live delete, staging range drop, progress", async () => {
    const chunks = [
      { scanned: "2", last_pk: "B", upserted: "1", delete_keys: ["A"] },
      { scanned: "1", last_pk: "C", upserted: "1", delete_keys: [] },
    ];
    let i = 0;
    const { calls, client } = fakeClient((sql) =>
      sql.includes("INSERT INTO object_instances")
        ? { rows: [chunks[i++]], rowCount: 1 }
        : { rows: [], rowCount: 1 },
    );
    const progress: Array<[string, number]> = [];
    const out = await promoteMergeStaging(client, SCOPE, {
      chunkRows: 2,
      onProgress: (p) => progress.push([p.phase, p.rowsDone]),
    });
    expect(out).toEqual({ upserts: 2, deletes: 1 });
    const sqls = calls.map((c) => flat(c.sql));
    // chunk 1: upsert → live delete by key array → staging range drop
    expect(sqls[0]).toContain("INSERT INTO object_instances");
    expect(sqls[0]).toContain("FROM merge_staging_instances");
    expect(sqls[0]).toContain("ORDER BY primary_key LIMIT 2");
    expect(sqls[1]).toMatch(/^DELETE FROM object_instances .*primary_key = ANY\(\$4::text\[\]\)/);
    expect(calls[1].params[3]).toEqual(["A"]);
    expect(sqls[2]).toMatch(/^DELETE FROM merge_staging_instances .*primary_key <= \$5/);
    expect(calls[2].params[4]).toBe("B");
    // chunk 2: keyset continues after "B"; no live delete (no delete keys)
    expect(sqls[3]).toContain("primary_key > $5");
    expect(calls[3].params[4]).toBe("B");
    expect(sqls[4]).toMatch(/^DELETE FROM merge_staging_instances .*primary_key > \$5 .*primary_key <= \$6/);
    expect(calls).toHaveLength(5);
    // never a join-shaped live delete, never a planner override
    expect(sqls.some((q) => q.includes("USING merge_staging_instances"))).toBe(false);
    expect(sqls.some((q) => q.includes("enable_nestloop"))).toBe(false);
    expect(progress).toEqual([["promote", 2], ["promote", 3]]);
  });

  it("skips the live DELETE entirely when nothing is staged for deletion (first loads)", async () => {
    const { calls, client } = fakeClient((sql) =>
      sql.includes("INSERT INTO object_instances")
        ? { rows: [{ scanned: "7", last_pk: "G", upserted: "7", delete_keys: [] }], rowCount: 1 }
        : { rows: [], rowCount: 7 },
    );
    const out = await promoteMergeStaging(client, SCOPE);
    expect(out).toEqual({ upserts: 7, deletes: 0 });
    expect(calls.some((c) => flat(c.sql).startsWith("DELETE FROM object_instances"))).toBe(false);
    expect(flat(calls[calls.length - 1].sql)).toContain("DELETE FROM merge_staging_instances");
  });

  it("an empty staging run promotes nothing", async () => {
    const { calls, client } = fakeClient(() => ({ rows: [{ scanned: "0", last_pk: null, upserted: "0", delete_keys: [] }], rowCount: 1 }));
    expect(await promoteMergeStaging(client, SCOPE)).toEqual({ upserts: 0, deletes: 0 });
    expect(calls).toHaveLength(1);
  });

  it("rejects a non-positive chunk size", async () => {
    const { client } = fakeClient(() => ({ rows: [], rowCount: 0 }));
    await expect(promoteMergeStaging(client, SCOPE, { chunkRows: 0 })).rejects.toThrow(/chunkRows/);
  });
});
