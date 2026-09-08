// ---------------------------------------------------------------------------
// Unit tests for the extracted Join op (src/services/pipelines/ops/joinOps.ts).
// executeJoin is pure; preview/apply run against a stub TransformOpsContext.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  executeJoin,
  joinApply,
  joinPreview,
} from "../../../src/services/pipelines/ops/joinOps";
import type { TransformOpsContext } from "../../../src/services/pipelines/ops/transformOpsContext";

const LEFT = [
  { id: "1", name: "Ada" },
  { id: "2", name: "Bob" },
  { id: "3", name: "Cid" },
];
const RIGHT = [
  { id: "1", dept: "eng" },
  { id: "2", dept: "ops" },
  { id: "4", dept: "hr" },
];
const LCOLS = [{ name: "id", type: "string" }, { name: "name", type: "string" }];
const RCOLS = [{ name: "id", type: "string" }, { name: "dept", type: "string" }];
const CONDS = [{ leftColumn: "id", rightColumn: "id" }];

describe("joinOps — executeJoin", () => {
  it("inner: only matches, right columns prefixed on collision", () => {
    const out = executeJoin(LEFT, RIGHT, "inner", CONDS, LCOLS, RCOLS);
    expect(out).toEqual([
      { id: "1", name: "Ada", right_id: "1", dept: "eng" },
      { id: "2", name: "Bob", right_id: "2", dept: "ops" },
    ]);
  });

  it("left: unmatched left rows get null right columns", () => {
    const out = executeJoin(LEFT, RIGHT, "left", CONDS, LCOLS, RCOLS);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ id: "3", name: "Cid", right_id: null, dept: null });
  });

  it("right: unmatched right rows get null left columns", () => {
    const out = executeJoin(LEFT, RIGHT, "right", CONDS, LCOLS, RCOLS);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ id: null, name: null, right_id: "4", dept: "hr" });
  });

  it("full_outer: both unmatched sides appear", () => {
    const out = executeJoin(LEFT, RIGHT, "full_outer", CONDS, LCOLS, RCOLS);
    expect(out).toHaveLength(4);
  });

  it("cross: cartesian product, no conditions", () => {
    const out = executeJoin(LEFT.slice(0, 2), RIGHT.slice(0, 2), "cross", [], LCOLS, RCOLS);
    expect(out).toHaveLength(4);
  });

  it("semi: left rows with a match, no right columns", () => {
    const out = executeJoin(LEFT, RIGHT, "semi", CONDS, LCOLS, RCOLS);
    expect(out).toEqual([
      { id: "1", name: "Ada", right_id: null, dept: null },
      { id: "2", name: "Bob", right_id: null, dept: null },
    ]);
  });

  it("anti: left rows without a match", () => {
    const out = executeJoin(LEFT, RIGHT, "anti", CONDS, LCOLS, RCOLS);
    expect(out).toEqual([{ id: "3", name: "Cid", right_id: null, dept: null }]);
  });

  it("null ≠ null: null keys never match", () => {
    const out = executeJoin([{ id: "" }], [{ id: "" }], "inner", CONDS, LCOLS, RCOLS);
    expect(out).toEqual([]);
  });

  it("coalesceJoinKeys folds same-named equality keys into one column", () => {
    const out = executeJoin(LEFT.slice(0, 1), RIGHT.slice(0, 1), "left", CONDS, LCOLS, RCOLS, "right_", true);
    expect(out).toEqual([{ id: "1", name: "Ada", dept: "eng" }]);
  });
});

// ---------------------------------------------------------------------------

function stubCtx(overrides: Partial<TransformOpsContext> = {}): TransformOpsContext {
  return {
    resolvePreviewInput: async () => ({
      dataset: null, sourceColumns: [], existingTransforms: [], baseRows: [],
    }),
    applyExistingTransforms: (rows) => rows,
    applyExistingTransformColumns: (cols) => cols,
    fetchNodeConfig: async (_p, _pl, nodeId) => ({ id: nodeId, config: {} }),
    saveNodeConfig: async (_n, _p, config) => ({ id: "n1", config }),
    assertColumnsExist: () => {},
    resolveNodeData: async (_p, _pl, nodeId) => nodeId === "right-node"
      ? { columns: RCOLS, rows: RIGHT }
      : { columns: LCOLS, rows: LEFT },
    persistExecutionSnapshot: async () => {},
    walkTransitiveInputs: async () => [],
    unionPreview: async () => ({ columns: [], rows: [] }),
    ...overrides,
  };
}

describe("joinOps — joinPreview", () => {
  it("joins and reports counts and column provenance", async () => {
    const out = await joinPreview(stubCtx(), "p", "pl", "join-node", {
      rightNodeId: "right-node",
      joinType: "left",
      conditions: CONDS,
      limit: 100,
    });
    expect(out.rows).toHaveLength(3);
    expect(out.totalJoined).toBe(3);
    expect(out.leftRowCount).toBe(3);
    expect(out.rightRowCount).toBe(3);
    expect(out.columns.map((c) => `${c.source}:${c.name}`))
      .toEqual(["left:id", "left:name", "right:right_id", "right:dept"]);
  });

  it("rejects a self join", async () => {
    await expect(
      joinPreview(stubCtx(), "p", "pl", "join-node", {
        rightNodeId: "join-node", joinType: "left", conditions: CONDS, limit: 10,
      }),
    ).rejects.toThrowError(/Cannot join a node with itself/);
  });

  it("requires conditions for non-cross joins", async () => {
    await expect(
      joinPreview(stubCtx(), "p", "pl", "join-node", {
        rightNodeId: "right-node", joinType: "inner", conditions: [], limit: 10,
      }),
    ).rejects.toThrowError(/At least one join condition/);
  });

  it("rejects unknown join columns on either side", async () => {
    await expect(
      joinPreview(stubCtx(), "p", "pl", "join-node", {
        rightNodeId: "right-node", joinType: "inner",
        conditions: [{ leftColumn: "zzz", rightColumn: "id" }], limit: 10,
      }),
    ).rejects.toThrowError(/Left column "zzz" not found/);
    await expect(
      joinPreview(stubCtx(), "p", "pl", "join-node", {
        rightNodeId: "right-node", joinType: "inner",
        conditions: [{ leftColumn: "id", rightColumn: "zzz" }], limit: 10,
      }),
    ).rejects.toThrowError(/Right column "zzz" not found/);
  });

  it("warns ZERO_MATCHES for an inner join with no overlap", async () => {
    const ctx = stubCtx({
      resolveNodeData: async (_p, _pl, nodeId) => nodeId === "right-node"
        ? { columns: RCOLS, rows: [{ id: "99", dept: "x" }] }
        : { columns: LCOLS, rows: LEFT },
    });
    const out = await joinPreview(ctx, "p", "pl", "join-node", {
      rightNodeId: "right-node", joinType: "inner", conditions: CONDS, limit: 10,
    });
    expect(out.rows).toEqual([]);
    expect(out.warnings.map((w) => w.code)).toContain("ZERO_MATCHES");
  });

  it("persist=true writes the snapshot through the context", async () => {
    let persisted: unknown[] | undefined;
    const ctx = stubCtx({
      persistExecutionSnapshot: async (...a: unknown[]) => { persisted = a; },
    });
    await joinPreview(ctx, "p", "pl", "join-node", {
      rightNodeId: "right-node", joinType: "left", conditions: CONDS, limit: 10, persist: true,
    });
    expect(persisted).toBeDefined();
    expect((persisted as unknown[])[2]).toBe("join-node");
  });
});

describe("joinOps — joinApply", () => {
  it("persists the join spec including non-default prefix and coalesce flag", async () => {
    let saved: Record<string, unknown> | undefined;
    const ctx = stubCtx({ saveNodeConfig: async (_n, _p, c) => { saved = c; return {}; } });
    await joinApply(ctx, "p", "pl", "n1", {
      rightNodeId: "r", joinType: "left", conditions: CONDS,
      rightPrefix: "r_", coalesceJoinKeys: true,
    });
    const transforms = saved?.transforms as Array<Record<string, unknown>>;
    expect(transforms[0]).toMatchObject({
      function: "Join", rightNodeId: "r", joinType: "left",
      rightPrefix: "r_", coalesceJoinKeys: true,
    });
  });

  it("omits optional keys when defaults are used", async () => {
    let saved: Record<string, unknown> | undefined;
    const ctx = stubCtx({ saveNodeConfig: async (_n, _p, c) => { saved = c; return {}; } });
    await joinApply(ctx, "p", "pl", "n1", { rightNodeId: "r", joinType: "inner", conditions: CONDS });
    const transforms = saved?.transforms as Array<Record<string, unknown>>;
    expect(transforms[0]).not.toHaveProperty("rightPrefix");
    expect(transforms[0]).not.toHaveProperty("coalesceJoinKeys");
  });
});
