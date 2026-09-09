// ---------------------------------------------------------------------------
// Unit tests for the extracted Cast op (src/services/pipelines/ops/castOps.ts).
// The pure row-level pieces are exercised directly; preview/apply are driven
// through a stub TransformOpsContext — no DB, no object store.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  applyCastToRows,
  buildOutputColumns,
  castApply,
  castOptionsForColumn,
  castPreview,
  castRows,
} from "../../../src/services/pipelines/ops/castOps";
import type { TransformOpsContext } from "../../../src/services/pipelines/ops/transformOpsContext";

describe("castOps — castOptionsForColumn", () => {
  it("is plain coerce for non-date targets", () => {
    expect(castOptionsForColumn([], "c", "string")).toEqual({ coerce: true });
    expect(castOptionsForColumn([], "c", "integer")).toEqual({ coerce: true });
  });

  it("sniffs mdy from a decisive value for date targets", () => {
    const rows = [{ d: "7/30/23" }]; // only readable month-first
    expect(castOptionsForColumn(rows, "d", "date")).toEqual({ coerce: true, dateFormat: "mdy" });
  });

  it("falls back to the dmy default when nothing decisive is sampled", () => {
    const rows = [{ d: "2024-01-15" }];
    expect(castOptionsForColumn(rows, "d", "date")).toEqual({ coerce: true });
  });
});

describe("castOps — castRows", () => {
  it("casts values leniently and counts failures with reason + sample", () => {
    const { rows, castErrors, castErrorReason, castErrorSample } = castRows(
      [{ a: "10" }, { a: "not-a-number" }, { a: "7" }],
      "a",
      "a",
      "integer",
      { coerce: true },
    );
    expect(rows[0].a).toBe(10);
    expect(rows[1].a).toBeNull();
    expect(rows[2].a).toBe(7);
    expect(castErrors).toBe(1);
    expect(castErrorReason).toBeTruthy();
    expect(castErrorSample).toBe("not-a-number");
  });

  it("appends a new column when outputCol differs from sourceCol", () => {
    const { rows } = castRows([{ a: "1", b: "keep" }], "a", "a_int", "integer", { coerce: true });
    expect(rows[0]).toEqual({ a: "1", b: "keep", a_int: 1 });
  });
});

describe("castOps — applyCastToRows (chain replay variant)", () => {
  it("applies the lenient cast without telemetry", () => {
    const out = applyCastToRows([{ a: "3" }, { a: "xx" }], "a", "a", "integer");
    expect(out.map((r) => r.a)).toEqual([3, null]);
  });
});

describe("castOps — buildOutputColumns", () => {
  const cols = [
    { name: "a", type: "string" },
    { name: "b", type: "string" },
  ];

  it("retypes an existing column in place", () => {
    expect(buildOutputColumns(cols, "a", "integer")).toEqual([
      { name: "a", type: "integer", isNew: false },
      { name: "b", type: "string", isNew: false },
    ]);
  });

  it("appends a new column flagged isNew", () => {
    const out = buildOutputColumns(cols, "c", "date");
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ name: "c", type: "date", isNew: true });
  });
});

// ---------------------------------------------------------------------------
// Preview/apply via a stubbed context.
// ---------------------------------------------------------------------------

function stubCtx(overrides: Partial<TransformOpsContext> = {}): TransformOpsContext {
  return {
    resolvePreviewInput: async () => ({
      dataset: { id: "d1", file_path: "k.csv", status: "ready" },
      sourceColumns: [{ name: "a", type: "string" }],
      existingTransforms: [],
      baseRows: [{ a: "1" }, { a: "2" }, { a: "bad" }],
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

describe("castOps — castPreview", () => {
  it("casts the expression column and reports sample info + cast telemetry", async () => {
    const out = await castPreview(stubCtx(), "p", "pl", "n1", {
      expression: "a",
      targetType: "integer",
      limit: 100,
    });
    expect(out.rows.map((r) => r.a)).toEqual([1, 2, null]);
    expect(out.castErrors).toBe(1);
    expect(out.castExpression).toBe('CAST("a" AS INTEGER)');
    expect(out.columns).toEqual([{ name: "a", type: "integer", isNew: false }]);
    expect(out.sampledSourceRows).toBe(3);
    expect(out.truncated).toBe(false);
  });

  it("rejects a missing column with the available list", async () => {
    await expect(
      castPreview(stubCtx(), "p", "pl", "n1", { expression: "zzz", targetType: "integer", limit: 10 }),
    ).rejects.toThrowError(/"zzz" does not exist\. Available: a/);
  });

  it("respects the row limit", async () => {
    const out = await castPreview(stubCtx(), "p", "pl", "n1", {
      expression: "a",
      targetType: "integer",
      limit: 2,
    });
    expect(out.rows).toHaveLength(2);
  });
});

describe("castOps — castApply", () => {
  it("appends a Cast transform record and persists via saveNodeConfig", async () => {
    let saved: Record<string, unknown> | undefined;
    const ctx = stubCtx({
      fetchNodeConfig: async () => ({ id: "n1", config: { transforms: [{ function: "Filter" }] } }),
      saveNodeConfig: async (_n, _p, config) => { saved = config; return { id: "n1" }; },
    });
    await castApply(ctx, "p", "pl", "n1", { expression: "a", targetType: "date" });
    const transforms = saved?.transforms as Array<Record<string, unknown>>;
    expect(transforms).toHaveLength(2);
    expect(transforms[0]).toEqual({ function: "Filter" });
    expect(transforms[1].function).toBe("Cast");
    expect(transforms[1].expression).toBe("a");
    expect(transforms[1].targetType).toBe("date");
    expect(transforms[1].outputColumn).toBe("a"); // defaults to expression
    expect(typeof transforms[1].createdAt).toBe("string");
  });

  it("propagates the 404 from fetchNodeConfig when the node is gone", async () => {
    const ctx = stubCtx({
      fetchNodeConfig: async () => {
        const { AppError } = await import("../../../src/utils/foundryAppError");
        throw new AppError("Pipeline node not found", 404, "NOT_FOUND");
      },
    });
    await expect(castApply(ctx, "p", "pl", "n1", { expression: "a", targetType: "date" }))
      .rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  });
});
