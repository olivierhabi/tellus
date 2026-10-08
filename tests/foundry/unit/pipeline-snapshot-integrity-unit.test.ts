// ---------------------------------------------------------------------------
// Preview-snapshot integrity — the "0 columns" regression guards.
//
// A pipeline node's saved schema (config.previewSnapshot) must be
// impossible to lose through the normal edit flow. The failure that these
// tests pin:
//
//   1. `PUT /nodes/:id` REPLACES the entire config column. A client
//      echoing its working copy without the snapshot wiped it — every
//      failed re-apply permanently blanked the node's schema ("0 columns"
//      on the canvas, SNAPSHOT_REQUIRED for every downstream node).
//      updateNode now strips previewSnapshot from accepted input: the key
//      is owned exclusively by the snapshot endpoints / atomic applies.
//
//   2. Union apply used to be client-orchestrated in two writes (config,
//      then snapshots) so a skipped/failed preview left a union node
//      wired-but-schemaless. unionApply now recomputes the union and
//      persists wiring + snapshot in ONE update — or nothing at all.
//
//   3. executeChain ("Apply All") used to leave snapshot persistence to a
//      second client request. It now persists the resulting snapshot
//      itself before returning.
//
// Knex and the private I/O seams are stubbed — the assertions are about
// what gets written (a single, complete config payload), not about the
// database.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { Knex } from "knex";
import { PipelineService } from "../../../src/services/pipelineService";
import { TransformService } from "../../../src/services/transformService";
import { AppError } from "../../../src/utils/foundryAppError";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PIPELINE_ID = "22222222-2222-4222-8222-222222222222";
const NODE_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_ID = "44444444-4444-4444-8444-444444444444";
const RIGHT_ID = "55555555-5555-4555-8555-555555555555";
const FILTER_STEP = {
  function: "Filter",
  mode: "keep",
  match: "all",
  conditions: [{ column: "a", operator: "isNotNull" }],
};

/**
 * Minimal knex stand-in: a function returning per-table chains that capture
 * UPDATE payloads and answer the reads each code path makes. Returns are
 * fixed; this suite asserts on the captured payloads, not the reads.
 */
function fakeKnex(opts: {
  nodeConfig?: Record<string, unknown>;
  nodeRow?: Record<string, unknown> | null;
}) {
  const captured: { table: string; payload: Record<string, unknown> }[] = [];

  const nodeRow = opts.nodeRow ?? {
    id: NODE_ID,
    config: JSON.stringify(opts.nodeConfig ?? {}),
  };

  const knex = ((table: string) => {
    if (table === "pipelines") {
      // ensurePipelineExists
      return {
        where: () => ({ whereNotExists: () => ({ first: async () => ({ id: PIPELINE_ID }) }) }),
      };
    }
    if (table === "pipeline_nodes as pn") {
      return {
        join: () => ({
          where: () => ({
            select: () => ({ first: async () => nodeRow }),
          }),
        }),
      };
    }
    if (table === "pipeline_nodes") {
      return {
        where: () => ({
          // updateNode re-reads the persisted config so a client config
          // replace can never wipe the snapshot owned by the snapshot
          // endpoints — the stub answers that read with the fixed nodeRow.
          first: async () => ({ config: nodeRow.config }),
          update: (payload: Record<string, unknown>) => {
            captured.push({ table, payload });
            return { returning: async () => [{ id: NODE_ID }] };
          },
        }),
      };
    }
    throw new Error(`unexpected table: ${table}`);
  }) as unknown as Knex;

  return { knex, captured };
}

describe("updateNode — previewSnapshot is write-protected", () => {
  it("strips previewSnapshot from an incoming config replace", async () => {
    const { knex, captured } = fakeKnex({
      nodeConfig: { previewSnapshot: { columns: [{ name: "a", type: "text" }] } },
    });
    const svc = new PipelineService(knex);

    // The client echoes a config that (legitimately) does not include the
    // snapshot — e.g. re-applying a transform chain.
    await svc.updateNode(PROJECT_ID, PIPELINE_ID, NODE_ID, {
      // A well-formed Filter: updateNode refuses structurally incomplete
      // steps (transformStepIntegrity), so the echo must carry conditions.
      config: { transforms: [FILTER_STEP], sourceNodeId: SOURCE_ID },
    });

    expect(captured).toHaveLength(1);
    const written = JSON.parse(String(captured[0].payload.config));
    // The incoming replace carries no snapshot; the PERSISTED one is
    // re-attached from the current row so it can never be wiped.
    expect(written.previewSnapshot).toEqual({ columns: [{ name: "a", type: "text" }] });
    expect(written.transforms).toEqual([FILTER_STEP]);
    expect(written.sourceNodeId).toBe(SOURCE_ID);
  });

  it("also strips a forged previewSnapshot, not just an absent one", async () => {
    const { knex, captured } = fakeKnex({});
    const svc = new PipelineService(knex);

    await svc.updateNode(PROJECT_ID, PIPELINE_ID, NODE_ID, {
      config: { previewSnapshot: { columns: [{ name: "fake", type: "text" }] } },
    });

    const written = JSON.parse(String(captured[0].payload.config));
    expect(written.previewSnapshot).toBeUndefined();
  });
});

describe("unionApply — atomic config + snapshot persistence", () => {
  function svcWithUnionResult(result: unknown, walkResult: unknown[] = []) {
    const { knex, captured } = fakeKnex({
      nodeConfig: { sourceNodeId: SOURCE_ID },
    });
    const svc = new TransformService(knex);
    const priv = svc as unknown as {
      unionPreview: (
        projectId: string, pipelineId: string, nodeId: string, input: unknown,
      ) => Promise<unknown>;
      walkTransitiveInputs: () => Promise<unknown[]>;
    };
    priv.unionPreview = async (_p, _pl, nodeId, _input) => {
      // The union's first input is the node's persisted source, not the
      // union node itself.
      expect(nodeId).toBe(SOURCE_ID);
      if (result instanceof Error) throw result;
      return result;
    };
    priv.walkTransitiveInputs = async () => walkResult;
    return { svc, captured };
  }

  it("persists wiring AND the computed schema in a single update", async () => {
    const unionResult = {
      columns: [{ name: "id", type: "string" }, { name: "qty", type: "string" }],
      rows: [{ id: "1", qty: "2" }],
      rowCount: 1,
    };
    const { svc, captured } = svcWithUnionResult(unionResult);

    await svc.unionApply(PROJECT_ID, PIPELINE_ID, NODE_ID, {
      rightNodeIds: [RIGHT_ID],
      mode: "wide",
    });

    expect(captured).toHaveLength(1);
    const written = JSON.parse(String(captured[0].payload.config));
    expect(written.sourceNodeId).toBe(SOURCE_ID);
    expect(written.rightNodeIds).toEqual([RIGHT_ID]);
    expect(written.rightNodeId).toBe(RIGHT_ID);
    expect(written.mode).toBe("wide");
    expect(written.previewSnapshot.columns).toEqual(unionResult.columns);
    expect(written.previewSnapshot.rows).toEqual(unionResult.rows);
    expect(written.previewSnapshot.nodeId).toBe(NODE_ID);
    expect(typeof written.previewSnapshot.chainHash).toBe("string");
    expect(typeof written.previewSnapshot.schemaFingerprint).toBe("string");
    expect(typeof written.previewSnapshot.savedAt).toBe("string");
  });

  it("writes NOTHING when the union cannot be computed", async () => {
    const { svc, captured } = svcWithUnionResult(
      new AppError("Join/union input has no saved preview snapshot. Run Apply on it first.", 400, "SNAPSHOT_REQUIRED"),
    );

    await expect(
      svc.unionApply(PROJECT_ID, PIPELINE_ID, NODE_ID, { rightNodeIds: [RIGHT_ID] }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_REQUIRED" });

    // The wiring must NOT be persisted without its schema — that split
    // state is exactly the "0 columns" bug.
    expect(captured).toHaveLength(0);
  });

  it("rejects an unwired union node instead of persisting a schemaless one", async () => {
    const { knex, captured } = fakeKnex({ nodeConfig: {} });
    const svc = new TransformService(knex);

    await expect(
      svc.unionApply(PROJECT_ID, PIPELINE_ID, NODE_ID, { rightNodeIds: [RIGHT_ID] }),
    ).rejects.toMatchObject({ code: "UNION_NO_SOURCE" });

    expect(captured).toHaveLength(0);
  });
});

describe("executeChain — persists the snapshot itself", () => {
  it("writes a 500-row-bounded snapshot derived from the execution result", async () => {
    const bigRows = Array.from({ length: 600 }, (_v, i) => ({ id: String(i) }));
    const nodeConfig = {
      sourceNodeId: SOURCE_ID,
      transforms: [{ function: "Filter", mode: "keep", match: "all", conditions: [] }],
    };
    const { knex, captured } = fakeKnex({ nodeConfig });
    const svc = new TransformService(knex);
    const priv = svc as unknown as {
      executeChainInternal: () => Promise<unknown>;
      walkTransitiveInputs: () => Promise<unknown[]>;
    };
    priv.executeChainInternal = async () => ({
      columns: [{ name: "id", type: "string" }],
      rows: bigRows,
      rowCount: bigRows.length,
    });
    priv.walkTransitiveInputs = async () => [];

    const out = (await svc.executeChain(PROJECT_ID, PIPELINE_ID, NODE_ID)) as { rowCount: number };
    // The caller still receives the FULL execution result.
    expect(out.rowCount).toBe(600);

    expect(captured).toHaveLength(1);
    const written = JSON.parse(String(captured[0].payload.config));
    const snap = written.previewSnapshot;
    expect(snap.columns).toEqual([{ name: "id", type: "string" }]);
    expect(snap.rows).toHaveLength(500);
    expect(snap.rowCount).toBe(500);
    // Chain hash is computed from the node's OWN persisted transforms so the
    // deploy stale-check compares like with like.
    expect(snap.transforms).toEqual(nodeConfig.transforms);
    // Unrelated config keys survive the merge.
    expect(written.sourceNodeId).toBe(SOURCE_ID);
    expect(written.transforms).toEqual(nodeConfig.transforms);
  });
});

describe("joinPreview — persist flag saves the preview atomically", () => {
  it("persists exactly the columns/rows the preview computed, in the same call", async () => {
    // knex surface joinPreview needs: right-node lookup, right dataset row,
    // right dataset columns.
    const knex = ((table: string) => {
      if (table === "pipeline_nodes as pn") {
        return {
          join: () => ({
            where: () => ({
              select: () => ({
                first: async () => ({ id: RIGHT_ID, dataset_id: "right-d", config: null }),
              }),
            }),
          }),
        };
      }
      if (table === "foundry_datasets") {
        return {
          where: () => ({
            select: () => ({
              first: async () => ({ id: "right-d", file_path: "right.csv", status: "ready" }),
            }),
          }),
        };
      }
      if (table === "dataset_columns") {
        return {
          where: () => ({
            select: () => ({
              orderBy: async () => [{ column_name: "rid", column_type: "string" }],
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    }) as unknown as Knex;

    const svc = new TransformService(knex);
    const persisted: { columns: unknown; rows: unknown }[] = [];
    const priv = svc as unknown as Record<string, unknown>;
    // Current seams: joinOps resolves both arms through fetchNodeConfig +
    // resolveNodeData (the same resolver output previews use) instead of the
    // old resolveNodeDataset/readCsvRows pair.
    priv.fetchNodeConfig = async (_p: string, _pl: string, id: string) => ({ id, config: {} });
    priv.resolveNodeData = async (_p: string, _pl: string, id: string) =>
      id === RIGHT_ID
        ? { columns: [{ name: "rid", type: "string" }], rows: [{ rid: "9" }] }
        : { columns: [{ name: "id", type: "string" }], rows: [{ id: "1" }] };
    priv.persistExecutionSnapshot = async (
      _p: string, _pl: string, nodeId: string,
      columns: unknown, rows: unknown,
    ) => {
      expect(nodeId).toBe(NODE_ID);
      persisted.push({ columns, rows });
    };

    const out = await svc.joinPreview(PROJECT_ID, PIPELINE_ID, NODE_ID, {
      rightNodeId: RIGHT_ID,
      joinType: "cross",
      conditions: [],
      limit: 500,
      rightPrefix: "right_",
      persist: true,
    });

    expect(persisted).toHaveLength(1);
    expect(persisted[0].columns).toEqual(out.columns);
    expect(persisted[0].rows).toEqual(out.rows);
  });

  it("does NOT persist when the flag is absent", async () => {
    const knex = ((table: string) => {
      if (table === "pipeline_nodes as pn") {
        return {
          join: () => ({
            where: () => ({
              select: () => ({
                first: async () => ({ id: RIGHT_ID, dataset_id: "right-d", config: null }),
              }),
            }),
          }),
        };
      }
      if (table === "foundry_datasets") {
        return {
          where: () => ({
            select: () => ({
              first: async () => ({ id: "right-d", file_path: "right.csv", status: "ready" }),
            }),
          }),
        };
      }
      if (table === "dataset_columns") {
        return {
          where: () => ({
            select: () => ({
              orderBy: async () => [{ column_name: "rid", column_type: "string" }],
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    }) as unknown as Knex;

    const svc = new TransformService(knex);
    const persisted: unknown[] = [];
    const priv = svc as unknown as Record<string, unknown>;
    priv.fetchNodeConfig = async (_p: string, _pl: string, id: string) => ({ id, config: {} });
    priv.resolveNodeData = async () => ({
      columns: [{ name: "id", type: "string" }],
      rows: [{ id: "1" }],
    });
    priv.persistExecutionSnapshot = async (...a: unknown[]) => { persisted.push(a); };

    await svc.joinPreview(PROJECT_ID, PIPELINE_ID, NODE_ID, {
      rightNodeId: RIGHT_ID,
      joinType: "cross",
      conditions: [],
      limit: 500,
      rightPrefix: "right_",
    });

    expect(persisted).toHaveLength(0);
  });
});
