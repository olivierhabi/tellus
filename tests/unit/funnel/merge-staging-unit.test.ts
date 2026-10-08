// ---------------------------------------------------------------------------
// Merge staging + promote — unit tests (Blocker 3).
//
// The PG client is faked, so these pin the SQL contract, not Postgres:
//   * staging loads target merge_staging_instances (never object_instances);
//   * staging PK includes the run id (a duplicate inside one run fails);
//   * verify reads count/distinct/null/empty scoped to the run;
//   * promote writes the LIVE table inside the caller's transaction and
//     drops the run's staging rows afterwards;
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

  it("clear scopes to the owner (ontology, object type)", async () => {
    const { calls, client } = fakeClient(() => ({ rows: [], rowCount: 0 }));
    await clearMergeStaging(client, SCOPE);
    const sql = flat(calls[0].sql);
    expect(sql).toContain("DELETE FROM merge_staging_instances");
    expect(sql).toContain("ontology_id = $1 AND object_type_api_name = $2");
    expect(calls[0].params).toEqual([SCOPE.ontologyId, SCOPE.objectTypeApiName]);
  });

  it("clear run scopes to the run id", async () => {
    const { calls, client } = fakeClient(() => ({ rows: [], rowCount: 0 }));
    await clearMergeStagingRun(client, SCOPE);
    expect(flat(calls[0].sql)).toContain("staging_run_id = $1");
  });
});

describe("verify + promote", () => {
  it("verify returns staged/distinct/null/empty scoped to the run", async () => {
    const { calls, client } = fakeClient(() => ({
      rows: [
        {
          staged: "5",
          upserts: "4",
          deletes: "1",
          distinct_pk: "5",
          null_pk: "0",
          empty_pk: "0",
        },
      ],
      rowCount: 1,
    }));
    const v = await verifyMergeStaging(client, SCOPE);
    expect(v).toEqual({
      staged: 5,
      stagedUpserts: 4,
      stagedDeletes: 1,
      distinctPk: 5,
      nullPk: 0,
      emptyPk: 0,
    });
    expect(flat(calls[0].sql)).toContain("FROM merge_staging_instances");
    expect(flat(calls[0].sql)).toContain("staging_run_id = $1");
  });

  it("promote upserts + deletes live, then drops the run staging", async () => {
    const { calls, client } = fakeClient(() => ({ rows: [], rowCount: 3 }));
    const out = await promoteMergeStaging(client, SCOPE);
    expect(out).toEqual({ upserts: 3, deletes: 3 });
    expect(calls).toHaveLength(3);
    expect(flat(calls[0].sql)).toContain("INSERT INTO object_instances");
    expect(flat(calls[0].sql)).toContain("FROM merge_staging_instances");
    expect(flat(calls[1].sql)).toContain("DELETE FROM object_instances");
    expect(flat(calls[1].sql)).toContain("USING merge_staging_instances");
    expect(flat(calls[2].sql)).toContain("DELETE FROM merge_staging_instances");
  });
});
