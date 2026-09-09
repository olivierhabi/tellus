// ---------------------------------------------------------------------------
// Unit tests for the extracted Filter op (src/services/pipelines/ops/filterOps.ts).
// evaluateCondition / applyFilterRows are pure; preview/apply run against a
// stub TransformOpsContext — no DB, no object store.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  applyFilterRows,
  evaluateCondition,
  filterApply,
  filterPreview,
} from "../../../src/services/pipelines/ops/filterOps";
import type { FilterCondition } from "../../../src/types/pipeline";
import type { TransformOpsContext } from "../../../src/services/pipelines/ops/transformOpsContext";

const cond = (over: Partial<FilterCondition>): FilterCondition => ({
  column: "a",
  operator: "eq",
  value: "x",
  ...over,
});

describe("filterOps — evaluateCondition", () => {
  const row = { a: "10", b: "hello", nul: "", lit: "null", date: "2024-01-15" };

  it("null semantics: undefined/empty/literal-null are null", () => {
    expect(evaluateCondition(row, cond({ column: "nul", operator: "is_null" }))).toBe(true);
    expect(evaluateCondition(row, cond({ column: "lit", operator: "is_null" }))).toBe(true);
    expect(evaluateCondition(row, cond({ column: "missing", operator: "is_null" }))).toBe(true);
    expect(evaluateCondition(row, cond({ column: "a", operator: "is_null" }))).toBe(false);
  });

  it("is_not_null honors treatEmptyAsNull", () => {
    expect(evaluateCondition(row, cond({ column: "nul", operator: "is_not_null" }))).toBe(true); // default: "" is a value
    expect(evaluateCondition(row, cond({ column: "nul", operator: "is_not_null", treatEmptyAsNull: true }))).toBe(false);
    expect(evaluateCondition(row, cond({ column: "a", operator: "is_not_null" }))).toBe(true);
  });

  it("eq/neq never match null values for eq; neq matches null", () => {
    expect(evaluateCondition(row, cond({ column: "a", operator: "eq", value: "10" }))).toBe(true);
    expect(evaluateCondition(row, cond({ column: "nul", operator: "eq", value: "" }))).toBe(false);
    expect(evaluateCondition(row, cond({ column: "nul", operator: "neq", value: "x" }))).toBe(true);
  });

  it("ordering compares numerically when possible, and ISO dates chronologically", () => {
    expect(evaluateCondition(row, cond({ column: "a", operator: "gt", value: "2" }))).toBe(true);
    expect(evaluateCondition(row, cond({ column: "a", operator: "lt", value: "2" }))).toBe(false);
    expect(evaluateCondition(row, cond({ column: "date", operator: "gte", value: "2024-01-01" }))).toBe(true);
    // null right-hand side → false (nulls are treated as false)
    expect(evaluateCondition(row, cond({ column: "a", operator: "gt", value: "" }))).toBe(false);
    // null left-hand side → false
    expect(evaluateCondition(row, cond({ column: "nul", operator: "gt", value: "1" }))).toBe(false);
  });

  it("string operators: starts_with / ends_with / contains", () => {
    expect(evaluateCondition(row, cond({ column: "b", operator: "starts_with", value: "he" }))).toBe(true);
    expect(evaluateCondition(row, cond({ column: "b", operator: "ends_with", value: "lo" }))).toBe(true);
    expect(evaluateCondition(row, cond({ column: "b", operator: "contains", value: "ell" }))).toBe(true);
    expect(evaluateCondition(row, cond({ column: "nul", operator: "contains", value: "x" }))).toBe(false);
  });

  it("regex_find / regex_match; invalid regex never throws", () => {
    expect(evaluateCondition(row, cond({ column: "b", operator: "regex_find", value: "ell" }))).toBe(true);
    expect(evaluateCondition(row, cond({ column: "b", operator: "regex_match", value: "h.llo" }))).toBe(true);
    expect(evaluateCondition(row, cond({ column: "b", operator: "regex_match", value: "ell" }))).toBe(false);
    expect(evaluateCondition(row, cond({ column: "b", operator: "regex_find", value: "(" }))).toBe(false);
  });

  it("valueIsColumn resolves the right-hand operand from another column", () => {
    const r = { a: "5", c: "5" };
    expect(evaluateCondition(r, cond({ column: "a", operator: "eq", value: "c", valueIsColumn: true }))).toBe(true);
    expect(evaluateCondition(r, cond({ column: "a", operator: "eq", value: "missing", valueIsColumn: true }))).toBe(false);
  });
});

describe("filterOps — applyFilterRows", () => {
  const rows = [
    { a: "1", b: "x" },
    { a: "2", b: "y" },
    { a: "3", b: "x" },
  ];

  it("keep + all", () => {
    const out = applyFilterRows(rows, "keep", "all", [cond({ column: "b", operator: "eq", value: "x" })]);
    expect(out.map((r) => r.a)).toEqual(["1", "3"]);
  });

  it("remove + any", () => {
    const out = applyFilterRows(rows, "remove", "any", [
      cond({ column: "a", operator: "eq", value: "1" }),
      cond({ column: "a", operator: "eq", value: "2" }),
    ]);
    expect(out.map((r) => r.a)).toEqual(["3"]);
  });

  it("non-string values are stringified before comparison", () => {
    const out = applyFilterRows([{ a: 10 as unknown as string }], "keep", "all", [
      cond({ column: "a", operator: "eq", value: "10" }),
    ]);
    expect(out).toHaveLength(1);
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
        { a: "2", b: "y" },
        { a: "3", b: "x" },
      ],
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

describe("filterOps — filterPreview", () => {
  it("keeps matching rows and reports totals", async () => {
    const out = await filterPreview(stubCtx(), "p", "pl", "n1", {
      mode: "keep",
      match: "all",
      conditions: [cond({ column: "b", operator: "eq", value: "x" })],
      limit: 100,
    });
    expect(out.rows.map((r) => r.a)).toEqual(["1", "3"]);
    expect(out.totalMatched).toBe(2);
    expect(out.totalRows).toBe(3);
    expect(out.columns).toEqual([{ name: "a", type: "string" }, { name: "b", type: "string" }]);
  });

  it("rejects a condition on a missing column", async () => {
    await expect(
      filterPreview(stubCtx(), "p", "pl", "n1", {
        mode: "keep", match: "all",
        conditions: [cond({ column: "zzz" })],
        limit: 10,
      }),
    ).rejects.toThrowError(/Column "zzz" does not exist/);
  });

  it("rejects a valueIsColumn reference to a missing comparison column", async () => {
    await expect(
      filterPreview(stubCtx(), "p", "pl", "n1", {
        mode: "keep", match: "all",
        conditions: [cond({ column: "a", value: "zzz", valueIsColumn: true })],
        limit: 10,
      }),
    ).rejects.toThrowError(/Comparison column "zzz" does not exist/);
  });
});

describe("filterOps — filterApply", () => {
  it("appends a Filter transform record and persists", async () => {
    let saved: Record<string, unknown> | undefined;
    const ctx = stubCtx({
      saveNodeConfig: async (_n, _p, config) => { saved = config; return { id: "n1" }; },
    });
    await filterApply(ctx, "p", "pl", "n1", {
      mode: "remove", match: "any", conditions: [cond({})],
    });
    const transforms = saved?.transforms as Array<Record<string, unknown>>;
    expect(transforms).toHaveLength(1);
    expect(transforms[0]).toMatchObject({ function: "Filter", mode: "remove", match: "any" });
  });
});
