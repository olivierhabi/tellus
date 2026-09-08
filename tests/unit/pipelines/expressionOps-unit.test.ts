// ---------------------------------------------------------------------------
// Unit tests for the extracted expression-family ops
// (src/services/pipelines/ops/expressionOps.ts).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  applyCaseExpressionToRows,
  applyComputeIfAbsentRows,
  applyExpressionApply,
  applyExpressionPreview,
  applyExpressionToRows,
  applyToMultipleColumnsPreview,
  caseExpressionApply,
  computeIfExpressionAbsentApply,
  concatenateStringsApply,
  concatenateStringsPreview,
  formatStringApply,
  formatStringPreview,
  isValueAbsent,
  textBlockApply,
  textBlockPreview,
} from "../../../src/services/pipelines/ops/expressionOps";
import type { ExpressionItem } from "../../../src/types/pipeline";
import type { TransformOpsContext } from "../../../src/services/pipelines/ops/transformOpsContext";

const expr = (over: Partial<ExpressionItem>): ExpressionItem => ({
  left: { kind: "column", value: "a" },
  operator: "+",
  right: { kind: "literal", value: "1", literalType: "integer" },
  outputColumn: "out",
  ...over,
});

describe("expressionOps — pure row transforms", () => {
  it("applyExpressionToRows evaluates and optionally casts", () => {
    const out = applyExpressionToRows([{ a: "1" }], expr({ outputType: "integer" }));
    expect(out).toEqual([{ a: "1", out: 2 }]);
    const noCast = applyExpressionToRows([{ a: "1" }], expr({}));
    expect(noCast[0].out).toBe(2); // arithmetic returns a number pre-cast
  });

  it("applyCaseExpressionToRows picks the first matching branch, else default", () => {
    const out = applyCaseExpressionToRows(
      [{ a: "1" }, { a: "9" }],
      {
        outputColumn: "label",
        branches: [
          {
            condition: expr({ operator: ">", right: { kind: "literal", value: "5", literalType: "integer" } }),
            value: { kind: "literal", value: "big" },
          },
        ],
        defaultValue: { kind: "literal", value: "small" },
      },
    );
    expect(out.map((r) => r.label)).toEqual(["small", "big"]);
  });

  it("applyCaseExpressionToRows resolves typed literals via parseLiteral", () => {
    const out = applyCaseExpressionToRows(
      [{ a: "1" }],
      {
        outputColumn: "n",
        branches: [],
        defaultValue: { kind: "literal", value: "42", literalType: "integer" },
      },
    );
    expect(out[0].n).toBe(42);
  });

  it("isValueAbsent: undefined/null/''/literal 'null'", () => {
    expect(isValueAbsent(undefined)).toBe(true);
    expect(isValueAbsent(null)).toBe(true);
    expect(isValueAbsent("")).toBe(true);
    expect(isValueAbsent("NULL")).toBe(true);
    expect(isValueAbsent("0")).toBe(false);
    expect(isValueAbsent(0)).toBe(false);
  });

  it("applyComputeIfAbsentRows only fills absent targets", () => {
    const out = applyComputeIfAbsentRows(
      [{ out: "keep", a: "1" }, { out: "", a: "1" }, { out: null, a: "1" }, { other: true, a: "1" }],
      "out",
      expr({ right: { kind: "literal", value: "10", literalType: "integer" } }),
    );
    expect(out[0].out).toBe("keep"); // present → untouched
    expect(out[1].out).toBe(11); // 1 + 10
    expect(out[2].out).toBe(11);
    expect(out[3].out).toBe(11); // missing key counts as absent
  });
});

// ---------------------------------------------------------------------------

function stubCtx(overrides: Partial<TransformOpsContext> = {}): TransformOpsContext {
  return {
    resolvePreviewInput: async () => ({
      dataset: { id: "d1", file_path: "k.csv", status: "ready" },
      sourceColumns: [{ name: "a", type: "string" }, { name: "b", type: "string" }],
      existingTransforms: [],
      baseRows: [{ a: "1", b: "x" }, { a: "2", b: "y" }],
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

describe("expressionOps — previews", () => {
  it("applyExpressionPreview computes the expression column and flags it new", async () => {
    const out = await applyExpressionPreview(stubCtx(), "p", "pl", "n1", {
      expression: expr({ outputColumn: "a_plus_1", outputType: "integer" }),
      limit: 10,
    });
    expect(out.rows.map((r) => r.a_plus_1)).toEqual([2, 3]);
    expect(out.columns.find((c) => c.name === "a_plus_1")).toMatchObject({ type: "integer", isNew: true });
  });

  it("applyExpressionPreview rejects unknown referenced columns", async () => {
    await expect(
      applyExpressionPreview(stubCtx(), "p", "pl", "n1", {
        expression: expr({ left: { kind: "column", value: "zzz" } }),
        limit: 10,
      }),
    ).rejects.toThrowError(/"zzz" which does not exist/);
  });

  it("concatenateStringsPreview joins operands with the separator", async () => {
    const out = await concatenateStringsPreview(stubCtx(), "p", "pl", "n1", {
      expressions: [
        { kind: "column", value: "a" },
        { kind: "literal", value: "-" },
        { kind: "column", value: "b" },
      ],
      separator: "",
      outputColumn: "joined",
      nullOutputIfAnyInputIsNull: false,
      limit: 10,
    });
    expect(out.rows.map((r) => r.joined)).toEqual(["1-x", "2-y"]);
  });

  it("formatStringPreview renders the template per row", async () => {
    const out = await formatStringPreview(stubCtx(), "p", "pl", "n1", {
      format: "val=%s",
      arguments: [{ kind: "column", value: "a" }],
      outputColumn: "f",
      limit: 10,
    });
    expect(out.rows.map((r) => r.f)).toEqual(["val=1", "val=2"]);
  });

  it("applyToMultipleColumnsPreview expands one expression per input column", async () => {
    const out = await applyToMultipleColumnsPreview(stubCtx(), "p", "pl", "n1", {
      columns: ["a", "b"],
      operator: "||",
      right: { kind: "literal", value: "!" },
      limit: 10,
    });
    expect(out.rows[0]).toMatchObject({ a_calc: "1!", b_calc: "x!" });
    expect(out.columns.filter((c) => c.isNew).map((c) => c.name)).toEqual(["a_calc", "b_calc"]);
  });

  it("textBlockPreview passes rows through untouched", async () => {
    const out = await textBlockPreview(stubCtx(), "p", "pl", "n1", { text: "note", title: "T", limit: 10 });
    expect(out.rows).toEqual([{ a: "1", b: "x" }, { a: "2", b: "y" }]);
    expect(out.textBlockSummary).toBe("Annotation: T");
  });
});

describe("expressionOps — applies persist the right transform records", () => {
  async function captured(fn: (ctx: TransformOpsContext) => Promise<unknown>) {
    let saved: Record<string, unknown> | undefined;
    const ctx = stubCtx({ saveNodeConfig: async (_n, _p, c) => { saved = c; return {}; } });
    await fn(ctx);
    return (saved?.transforms as Array<Record<string, unknown>>)[0];
  }

  it("applyExpressionApply", async () => {
    const e = expr({});
    expect(await captured((ctx) => applyExpressionApply(ctx, "p", "pl", "n1", { expression: e })))
      .toMatchObject({ function: "ApplyExpression", expression: e });
  });

  it("caseExpressionApply", async () => {
    const input = { outputColumn: "l", branches: [], defaultValue: null };
    expect(await captured((ctx) => caseExpressionApply(ctx, "p", "pl", "n1", input)))
      .toMatchObject({ function: "CaseExpression", outputColumn: "l" });
  });

  it("concatenateStringsApply", async () => {
    expect(await captured((ctx) => concatenateStringsApply(ctx, "p", "pl", "n1", {
      expressions: [], separator: ",", outputColumn: "c", nullOutputIfAnyInputIsNull: false,
    }))).toMatchObject({ function: "ConcatenateStrings", outputColumn: "c" });
  });

  it("formatStringApply", async () => {
    expect(await captured((ctx) => formatStringApply(ctx, "p", "pl", "n1", {
      format: "%s", arguments: [], outputColumn: "f",
    }))).toMatchObject({ function: "FormatString", outputColumn: "f" });
  });

  it("computeIfExpressionAbsentApply", async () => {
    expect(await captured((ctx) => computeIfExpressionAbsentApply(ctx, "p", "pl", "n1", {
      outputColumn: "o", expression: expr({}),
    }))).toMatchObject({ function: "ComputeIfExpressionAbsent", outputColumn: "o" });
  });

  it("textBlockApply", async () => {
    expect(await captured((ctx) => textBlockApply(ctx, "p", "pl", "n1", { text: "t", title: "x" })))
      .toMatchObject({ function: "TextBlock", text: "t", title: "x" });
  });
});
