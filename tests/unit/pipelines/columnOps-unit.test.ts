// ---------------------------------------------------------------------------
// Unit tests for the extracted column ops
// (src/services/pipelines/ops/columnOps.ts): drop / rename / normalize /
// select / uppercase / rowSize row transforms + preview/apply entry points.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  applyDropColumnsRows,
  applyRowSizeRows,
  applySelectRows,
  dropApply,
  dropPreview,
  rowSizeApply,
  rowSizePreview,
  selectApply,
  selectPreview,
} from "../../../src/services/pipelines/ops/columnOps";
import {
  applyNormalizeRows,
  applyRenameRows,
  applyUppercaseRows,
  buildNormalizeMap,
  normalizeApply,
  normalizePreview,
  renameApply,
  renamePreview,
  uppercaseColumnNamesApply,
  uppercaseColumnNamesPreview,
} from "../../../src/services/pipelines/ops/columnNameOps";
import type { TransformOpsContext } from "../../../src/services/pipelines/ops/transformOpsContext";

describe("columnOps — pure row transforms", () => {
  it("applyDropColumnsRows removes columns and refuses to drop everything", () => {
    expect(applyDropColumnsRows([{ a: 1, b: 2 }], ["b"])).toEqual([{ a: 1 }]);
    expect(() => applyDropColumnsRows([{ a: 1 }], ["a"])).toThrowError(/Drop removed every column/);
  });

  it("applyRenameRows renames BOM-insensitively", () => {
    expect(applyRenameRows([{ a: 1, b: 2 }], [{ from: "a", to: "A2" }])).toEqual([{ A2: 1, b: 2 }]);
  });

  it("buildNormalizeMap dedupes collisions with _1 suffixes", () => {
    const map = buildNormalizeMap(["First Name", "first  name", "other"], false);
    expect(map.get("First Name")).toBe("first_name");
    expect(map.get("first  name")).toBe("first_name_1");
    expect(map.get("other")).toBe("other");
  });

  it("applyNormalizeRows derives its map from the row keys", () => {
    expect(applyNormalizeRows([{ "First Name": "x" }], false)).toEqual([{ first_name: "x" }]);
    expect(applyNormalizeRows([], false)).toEqual([]);
  });

  it("applySelectRows keeps the user's order, fills missing with null, refuses zero columns", () => {
    expect(applySelectRows([{ a: 1, b: 2, c: 3 }], ["c", "a"])).toEqual([{ c: 3, a: 1 }]);
    expect(applySelectRows([{ a: 1 }], ["zzz"])).toEqual([{ zzz: null }]);
    expect(() => applySelectRows([{ a: 1 }], [])).toThrowError(/Select kept zero columns/);
  });

  it("applyUppercaseRows uppercases keys only", () => {
    expect(applyUppercaseRows([{ a: "x" }])).toEqual([{ A: "x" }]);
  });

  it("applyRowSizeRows appends a byte-size column", () => {
    const out = applyRowSizeRows([{ a: "x" }], "row_size");
    expect(out[0].a).toBe("x");
    expect(typeof out[0].row_size).toBe("number");
    expect(out[0].row_size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

function stubCtx(overrides: Partial<TransformOpsContext> = {}): TransformOpsContext {
  return {
    resolvePreviewInput: async () => ({
      dataset: { id: "d1", file_path: "k.csv", status: "ready" },
      sourceColumns: [{ name: "First Name", type: "string" }, { name: "b", type: "string" }],
      existingTransforms: [],
      baseRows: [{ "First Name": "Ada", b: "2" }],
    }),
    applyExistingTransforms: (rows) => rows,
    applyExistingTransformColumns: (cols) => cols,
    fetchNodeConfig: async () => ({ id: "n1", config: {} }),
    saveNodeConfig: async (_n, _p, config) => ({ id: "n1", config }),
    assertColumnsExist: () => {},
    resolveNodeData: async () => ({ columns: [], rows: [] }),
    persistExecutionSnapshot: async () => {},
    walkTransitiveInputs: async () => [],
    unionPreview: async () => ({ columns: [], rows: [] }),
    ...overrides,
  };
}

describe("columnOps — previews", () => {
  it("dropPreview removes columns and rejects dropping everything", async () => {
    const out = await dropPreview(stubCtx(), "p", "pl", "n1", { columns: ["b"], limit: 10 });
    expect(out.rows).toEqual([{ "First Name": "Ada" }]);
    expect(out.droppedColumns).toEqual(["b"]);
    await expect(
      dropPreview(stubCtx(), "p", "pl", "n1", { columns: ["First Name", "b"], limit: 10 }),
    ).rejects.toThrowError(/Drop removed every column/);
    await expect(
      dropPreview(stubCtx(), "p", "pl", "n1", { columns: ["zzz"], limit: 10 }),
    ).rejects.toThrowError(/Column "zzz" does not exist/);
  });

  it("renamePreview renames rows and marks renamed output columns", async () => {
    const out = await renamePreview(stubCtx(), "p", "pl", "n1", {
      renames: [{ from: "First Name", to: "first_name" }],
      limit: 10,
    });
    expect(out.rows).toEqual([{ first_name: "Ada", b: "2" }]);
    expect(out.columns[0]).toMatchObject({ name: "first_name", renamed: true, originalName: "First Name" });
    await expect(
      renamePreview(stubCtx(), "p", "pl", "n1", { renames: [{ from: "zzz", to: "x" }], limit: 10 }),
    ).rejects.toThrowError(/Column "zzz" does not exist/);
  });

  it("normalizePreview lower_snake_cases the columns", async () => {
    const out = await normalizePreview(stubCtx(), "p", "pl", "n1", { removeSpecialCharacters: false, limit: 10 });
    expect(out.rows).toEqual([{ first_name: "Ada", b: "2" }]);
    expect(out.columns[0]).toMatchObject({ name: "first_name", normalized: true, originalName: "First Name" });
  });

  it("selectPreview projects in the requested order and rejects unknown columns", async () => {
    const out = await selectPreview(stubCtx(), "p", "pl", "n1", { columns: ["b", "First Name"], limit: 10 });
    expect(out.rows).toEqual([{ b: "2", "First Name": "Ada" }]);
    expect(out.columns.map((c) => c.name)).toEqual(["b", "First Name"]);
    await expect(
      selectPreview(stubCtx(), "p", "pl", "n1", { columns: ["zzz"], limit: 10 }),
    ).rejects.toThrowError(/Columns not found: zzz/);
  });

  it("uppercaseColumnNamesPreview uppercases row keys and column names", async () => {
    const out = await uppercaseColumnNamesPreview(stubCtx(), "p", "pl", "n1", { limit: 10 });
    expect(out.rows).toEqual([{ "FIRST NAME": "Ada", B: "2" }]);
    expect(out.columns.map((c) => c.name)).toEqual(["FIRST NAME", "B"]);
  });

  it("rowSizePreview appends a row-size column", async () => {
    const out = await rowSizePreview(stubCtx(), "p", "pl", "n1", { limit: 10 });
    expect(out.rows[0]).toHaveProperty("row_size");
    expect(out.columns.map((c) => c.name)).toContain("row_size");
  });
});

describe("columnOps — applies persist the right transform records", () => {
  async function captured(fn: (ctx: TransformOpsContext) => Promise<unknown>) {
    let saved: Record<string, unknown> | undefined;
    const ctx = stubCtx({ saveNodeConfig: async (_n, _p, c) => { saved = c; return {}; } });
    await fn(ctx);
    return (saved?.transforms as Array<Record<string, unknown>>)[0];
  }

  it("dropApply", async () => {
    expect(await captured((ctx) => dropApply(ctx, "p", "pl", "n1", { columns: ["b"] })))
      .toMatchObject({ function: "Drop", columns: ["b"] });
  });

  it("renameApply strips BOM from the from-names", async () => {
    expect(await captured((ctx) => renameApply(ctx, "p", "pl", "n1", { renames: [{ from: "a", to: "b" }] })))
      .toMatchObject({ function: "Rename", renames: [{ from: "a", to: "b" }] });
  });

  it("normalizeApply", async () => {
    expect(await captured((ctx) => normalizeApply(ctx, "p", "pl", "n1", { removeSpecialCharacters: true })))
      .toMatchObject({ function: "Normalize", removeSpecialCharacters: true });
  });

  it("selectApply", async () => {
    expect(await captured((ctx) => selectApply(ctx, "p", "pl", "n1", { columns: ["a"] })))
      .toMatchObject({ function: "Select", columns: ["a"] });
  });

  it("uppercaseColumnNamesApply", async () => {
    expect(await captured((ctx) => uppercaseColumnNamesApply(ctx, "p", "pl", "n1", {})))
      .toMatchObject({ function: "UppercaseColumnNames" });
  });

  it("rowSizeApply defaults the output column", async () => {
    expect(await captured((ctx) => rowSizeApply(ctx, "p", "pl", "n1", {})))
      .toMatchObject({ function: "RowSize", outputColumn: "row_size" });
  });
});
