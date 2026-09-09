// ---------------------------------------------------------------------------
// Unit tests for the extracted Sort / TopRows ops
// (src/services/pipelines/ops/sortOps.ts).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  applySort,
  computeTopRows,
  sortApply,
  sortPreview,
  topRowsApply,
  topRowsPreview,
} from "../../../src/services/pipelines/ops/sortOps";
import type { TransformOpsContext } from "../../../src/services/pipelines/ops/transformOpsContext";

describe("sortOps — applySort", () => {
  it("sorts numerically when values coerce, and is stable on ties", () => {
    const rows = [
      { a: "10", id: "first" },
      { a: "2", id: "second" },
      { a: "10", id: "third" },
    ];
    const out = applySort(rows, [{ column: "a", direction: "asc" }]);
    expect(out.map((r) => r.id)).toEqual(["second", "first", "third"]);
  });

  it("desc reverses comparison; nulls default first on desc, last on asc", () => {
    const rows = [{ a: "1" }, { a: "" }, { a: "3" }];
    expect(applySort(rows, [{ column: "a", direction: "asc" }]).map((r) => r.a)).toEqual(["1", "3", ""]);
    expect(applySort(rows, [{ column: "a", direction: "desc" }]).map((r) => r.a)).toEqual(["", "3", "1"]);
  });

  it("explicit nulls first/last overrides the direction default", () => {
    const rows = [{ a: "1" }, { a: "" }, { a: "3" }];
    expect(applySort(rows, [{ column: "a", direction: "asc", nulls: "first" }]).map((r) => r.a))
      .toEqual(["", "1", "3"]);
    expect(applySort(rows, [{ column: "a", direction: "desc", nulls: "last" }]).map((r) => r.a))
      .toEqual(["3", "1", ""]);
  });

  it("falls back to string order for non-numeric values", () => {
    const rows = [{ a: "banana" }, { a: "apple" }];
    expect(applySort(rows, [{ column: "a", direction: "asc" }]).map((r) => r.a))
      .toEqual(["apple", "banana"]);
  });

  it("multi-key: later keys break ties", () => {
    const rows = [
      { a: "1", b: "y" },
      { a: "1", b: "x" },
      { a: "0", b: "z" },
    ];
    const out = applySort(rows, [
      { column: "a", direction: "asc" },
      { column: "b", direction: "asc" },
    ]);
    expect(out.map((r) => `${r.a}${r.b}`)).toEqual(["0z", "1x", "1y"]);
  });
});

describe("sortOps — computeTopRows", () => {
  const rows = [
    { g: "US", v: "1" },
    { g: "US", v: "9" },
    { g: "US", v: "5" },
    { g: "CA", v: "2" },
    { g: "CA", v: "8" },
  ];

  it("no partition: global top-N after sort", () => {
    const out = computeTopRows(rows, [], [{ column: "v", direction: "desc" }], 2);
    expect(out.map((r) => r.v)).toEqual(["9", "8"]);
  });

  it("partitioned: top-N per partition in first-appearance order", () => {
    const out = computeTopRows(rows, ["g"], [{ column: "v", direction: "desc" }], 1);
    expect(out).toEqual([{ g: "US", v: "9" }, { g: "CA", v: "8" }]);
  });
});

// ---------------------------------------------------------------------------

function stubCtx(overrides: Partial<TransformOpsContext> = {}): TransformOpsContext {
  return {
    resolvePreviewInput: async () => ({
      dataset: { id: "d1", file_path: "k.csv", status: "ready" },
      sourceColumns: [{ name: "a", type: "string" }, { name: "g", type: "string" }],
      existingTransforms: [],
      baseRows: [{ a: "3", g: "x" }, { a: "1", g: "x" }, { a: "2", g: "y" }],
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

describe("sortOps — sortPreview / sortApply", () => {
  it("sortPreview orders rows and validates the sort columns", async () => {
    const out = await sortPreview(stubCtx(), "p", "pl", "n1", {
      sorts: [{ column: "a", direction: "asc" }],
      limit: 100,
    });
    expect(out.rows.map((r) => r.a)).toEqual(["1", "2", "3"]);
    expect(out.totalRows).toBe(3);

    await expect(
      sortPreview(stubCtx(), "p", "pl", "n1", { sorts: [{ column: "zzz", direction: "asc" }], limit: 10 }),
    ).rejects.toThrowError(/Sort column "zzz" does not exist/);
  });

  it("sortApply persists a Sort transform record", async () => {
    let saved: Record<string, unknown> | undefined;
    const ctx = stubCtx({ saveNodeConfig: async (_n, _p, c) => { saved = c; return {}; } });
    await sortApply(ctx, "p", "pl", "n1", { sorts: [{ column: "a", direction: "desc" }] });
    const transforms = saved?.transforms as Array<Record<string, unknown>>;
    expect(transforms[0]).toMatchObject({ function: "Sort" });
    expect(transforms[0].sorts).toEqual([{ column: "a", direction: "desc" }]);
  });
});

describe("sortOps — topRowsPreview / topRowsApply", () => {
  it("requires at least one sort column", async () => {
    await expect(
      topRowsPreview(stubCtx(), "p", "pl", "n1", { partitionBy: [], sorts: [], topN: 1, limit: 10 }),
    ).rejects.toThrowError(/at least one sort column/);
  });

  it("returns the top-N rows per partition", async () => {
    const out = await topRowsPreview(stubCtx(), "p", "pl", "n1", {
      partitionBy: ["g"],
      sorts: [{ column: "a", direction: "asc" }],
      topN: 1,
      limit: 10,
    });
    expect(out.rows).toEqual([{ a: "1", g: "x" }, { a: "2", g: "y" }]);
  });

  it("topRowsApply persists a TopRows transform record", async () => {
    let saved: Record<string, unknown> | undefined;
    const ctx = stubCtx({ saveNodeConfig: async (_n, _p, c) => { saved = c; return {}; } });
    await topRowsApply(ctx, "p", "pl", "n1", {
      partitionBy: ["g"],
      sorts: [{ column: "a", direction: "asc" }],
      topN: 3,
    });
    const transforms = saved?.transforms as Array<Record<string, unknown>>;
    expect(transforms[0]).toMatchObject({ function: "TopRows", partitionBy: ["g"], topN: 3 });
  });
});
