// ---------------------------------------------------------------------------
// Unit tests for the extracted Union ops (src/services/pipelines/ops/unionOps.ts).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { unionApply, unionPreview } from "../../../src/services/pipelines/ops/unionOps";
import type { TransformOpsContext } from "../../../src/services/pipelines/ops/transformOpsContext";

const BRANCHES: Record<string, { columns: Array<{ name: string; type: string }>; rows: Array<Record<string, unknown>> }> = {
  left: {
    columns: [{ name: "id", type: "string" }, { name: "a", type: "string" }],
    rows: [{ id: "1", a: "x" }],
  },
  right: {
    columns: [{ name: "id", type: "string" }, { name: "b", type: "integer" }],
    rows: [{ id: "2", b: 5 }],
  },
};

function stubCtx(overrides: Partial<TransformOpsContext> = {}): TransformOpsContext {
  return {
    resolvePreviewInput: async () => ({
      dataset: null, sourceColumns: [], existingTransforms: [], baseRows: [],
    }),
    applyExistingTransforms: (rows) => rows,
    applyExistingTransformColumns: (cols) => cols,
    fetchNodeConfig: async (_p, _pl, nodeId) => ({ id: nodeId, config: { sourceNodeId: "left" } }),
    saveNodeConfig: async (_n, _p, config) => ({ id: "n1", config }),
    assertColumnsExist: () => {},
    resolveNodeData: async (_p, _pl, nodeId) => BRANCHES[nodeId] ?? { columns: [], rows: [] },
    persistExecutionSnapshot: async () => {},
    walkTransitiveInputs: async () => [],
    unionPreview: async () => ({ columns: [], rows: [] }),
    ...overrides,
  };
}

describe("unionOps — unionPreview", () => {
  it("wide (default): superset of columns, input-ordered, null-filled rows", async () => {
    const out = await unionPreview(stubCtx(), "p", "pl", "left", {
      rightNodeIds: ["right"],
      limit: 100,
    });
    expect(out.columns.map((c) => c.name)).toEqual(["id", "a", "b"]);
    expect(out.rows).toEqual([
      { id: "1", a: "x", b: null },
      { id: "2", a: null, b: 5 },
    ]);
    expect(out.totalUnioned).toBe(2);
    expect(out.inputCount).toBe(2);
    expect(out.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(["LEFT_ONLY_COLUMNS", "RIGHT_ONLY_COLUMNS"]),
    );
  });

  it("first: keeps only the first input's schema and warns about dropped columns", async () => {
    const out = await unionPreview(stubCtx(), "p", "pl", "left", {
      rightNodeIds: ["right"], mode: "first", limit: 100,
    });
    expect(out.columns.map((c) => c.name)).toEqual(["id", "a"]);
    expect(out.rows).toEqual([{ id: "1", a: "x" }, { id: "2", a: null }]);
    expect(out.warnings.map((w) => w.code)).toContain("RIGHT_ONLY_COLUMNS_DROPPED");
  });

  it("narrow: keeps only columns present in every input", async () => {
    const out = await unionPreview(stubCtx(), "p", "pl", "left", {
      rightNodeIds: ["right"], mode: "narrow", limit: 100,
    });
    expect(out.columns.map((c) => c.name)).toEqual(["id"]);
    expect(out.rows).toEqual([{ id: "1" }, { id: "2" }]);
  });

  it("strict: schema divergence fails with UNION_SCHEMA_MISMATCH", async () => {
    await expect(
      unionPreview(stubCtx(), "p", "pl", "left", {
        rightNodeIds: ["right"], mode: "strict", limit: 100,
      }),
    ).rejects.toMatchObject({ code: "UNION_SCHEMA_MISMATCH" });
  });

  it("both-empty inputs are a 400", async () => {
    const ctx = stubCtx({
      resolveNodeData: async () => ({ columns: [{ name: "id", type: "string" }], rows: [] }),
    });
    await expect(
      unionPreview(ctx, "p", "pl", "left", { rightNodeIds: ["right"], limit: 10 }),
    ).rejects.toMatchObject({ code: "BOTH_EMPTY" });
  });
});

describe("unionOps — unionApply", () => {
  it("persists wiring + recomputed snapshot atomically", async () => {
    let saved: Record<string, unknown> | undefined;
    const ctx = stubCtx({
      saveNodeConfig: async (_n, _p, c) => { saved = c; return { id: "u1" }; },
      walkTransitiveInputs: async () => [{ nodeId: "left", datasetId: "d1", filePath: "f", format: "csv" }],
    });
    const result = await unionApply(ctx, "p", "pl", "u1", { rightNodeIds: ["right"] });
    expect(result).toEqual({ id: "u1" });
    expect(saved?.rightNodeIds).toEqual(["right"]);
    expect(saved?.rightNodeId).toBe("right");
    const snap = saved?.previewSnapshot as Record<string, unknown>;
    expect(snap).toBeDefined();
    expect(snap.columns).toBeDefined();
    expect(snap.nodeId).toBe("u1");
    expect(snap.transitiveInputSnapshots).toHaveLength(1);
  });

  it("rejects when the union node has no sourceNodeId", async () => {
    const ctx = stubCtx({
      fetchNodeConfig: async (_p, _pl, nodeId) => ({ id: nodeId, config: {} }),
    });
    await expect(
      unionApply(ctx, "p", "pl", "u1", { rightNodeIds: ["right"] }),
    ).rejects.toMatchObject({ code: "UNION_NO_SOURCE" });
  });
});
