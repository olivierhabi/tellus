// ---------------------------------------------------------------------------
// Unit tests for the extracted dedupe ops
// (src/services/pipelines/ops/dedupeOps.ts).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  applyDropDuplicates,
  computeKeepDuplicates,
  dropDuplicatesApply,
  dropDuplicatesPreview,
  keepDuplicatesApply,
  keepDuplicatesPreview,
} from "../../../src/services/pipelines/ops/dedupeOps";
import type { TransformOpsContext } from "../../../src/services/pipelines/ops/transformOpsContext";

describe("dedupeOps — applyDropDuplicates", () => {
  const rows = [
    { a: "1", b: "x" },
    { a: "1", b: "x" },
    { a: "1", b: "y" },
    { a: "2", b: "x" },
  ];

  it("keyed: keeps the first row per key", () => {
    const out = applyDropDuplicates(rows, ["a", "b"]);
    expect(out).toEqual([rows[0], rows[2], rows[3]]);
  });

  it("unkeyed: dedupes on the entire row", () => {
    const out = applyDropDuplicates(rows, null);
    expect(out).toEqual([rows[0], rows[2], rows[3]]);
  });

  it("keyed on a subset collapses rows differing elsewhere", () => {
    const out = applyDropDuplicates(rows, ["a"]);
    expect(out).toEqual([rows[0], rows[3]]);
  });
});

describe("dedupeOps — computeKeepDuplicates", () => {
  const rows = [
    { a: "1", b: "x" },
    { a: "1", b: "x" },
    { a: "2", b: "y" },
  ];

  it("keeps ALL rows whose key appears more than once", () => {
    expect(computeKeepDuplicates(rows, ["a", "b"], ["a", "b"])).toEqual([rows[0], rows[1]]);
    expect(computeKeepDuplicates(rows, ["a"], ["a", "b"])).toEqual([rows[0], rows[1]]);
    expect(computeKeepDuplicates(rows, [], ["a", "b"])).toEqual([rows[0], rows[1]]);
  });

  it("returns empty when nothing repeats", () => {
    expect(computeKeepDuplicates([{ a: "1" }, { a: "2" }], ["a"], ["a"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

function stubCtx(overrides: Partial<TransformOpsContext> = {}): TransformOpsContext {
  return {
    resolvePreviewInput: async () => ({
      dataset: { id: "d1", file_path: "k.csv", status: "ready" },
      sourceColumns: [{ name: "a", type: "string" }, { name: "b", type: "string" }],
      existingTransforms: [],
      baseRows: [
        { a: "1", b: "x" },
        { a: "1", b: "x" },
        { a: "2", b: "y" },
      ],
    }),
    applyExistingTransforms: (rows) => rows,
    applyExistingTransformColumns: (cols) => cols,
    fetchNodeConfig: async () => ({ id: "n1", config: {} }),
    saveNodeConfig: async (_n, _p, config) => ({ id: "n1", config }),
    assertColumnsExist: (names, needed, fnName) => {
      for (const c of needed) {
        if (!names.has(c)) throw new Error(`${fnName} column "${c}" does not exist`);
      }
    },
    resolveNodeData: async () => ({ columns: [], rows: [] }),
    persistExecutionSnapshot: async () => {},
    walkTransitiveInputs: async () => [],
    unionPreview: async () => ({ columns: [], rows: [] }),
    ...overrides,
  };
}

describe("dedupeOps — dropDuplicatesPreview / Apply", () => {
  it("dedupes and reports duplicatesRemoved", async () => {
    const out = await dropDuplicatesPreview(stubCtx(), "p", "pl", "n1", { limit: 100 });
    expect(out.rows).toHaveLength(2);
    expect(out.duplicatesRemoved).toBe(1);
    expect(out.dedupeSummary).toBe("By all columns");
  });

  it("rejects an unknown key column", async () => {
    await expect(
      dropDuplicatesPreview(stubCtx(), "p", "pl", "n1", { columns: ["zzz"], limit: 10 }),
    ).rejects.toThrowError(/Deduplicate key column "zzz" does not exist/);
  });

  it("apply persists a DropDuplicates record", async () => {
    let saved: Record<string, unknown> | undefined;
    const ctx = stubCtx({ saveNodeConfig: async (_n, _p, c) => { saved = c; return {}; } });
    await dropDuplicatesApply(ctx, "p", "pl", "n1", { columns: ["a"] });
    const transforms = saved?.transforms as Array<Record<string, unknown>>;
    expect(transforms[0]).toMatchObject({ function: "DropDuplicates", columns: ["a"] });
  });
});

describe("dedupeOps — keepDuplicatesPreview / Apply", () => {
  it("keeps only repeated rows", async () => {
    const out = await keepDuplicatesPreview(stubCtx(), "p", "pl", "n1", { limit: 100 });
    expect(out.rows).toEqual([{ a: "1", b: "x" }, { a: "1", b: "x" }]);
  });

  it("apply persists a KeepDuplicates record", async () => {
    let saved: Record<string, unknown> | undefined;
    const ctx = stubCtx({ saveNodeConfig: async (_n, _p, c) => { saved = c; return {}; } });
    await keepDuplicatesApply(ctx, "p", "pl", "n1", { columns: ["a"] });
    const transforms = saved?.transforms as Array<Record<string, unknown>>;
    expect(transforms[0]).toMatchObject({ function: "KeepDuplicates", columns: ["a"] });
  });
});
