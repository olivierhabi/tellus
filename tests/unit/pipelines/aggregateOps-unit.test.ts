// ---------------------------------------------------------------------------
// Unit tests for the extracted aggregate-family ops
// (src/services/pipelines/ops/aggregateOps.ts).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  aggregateApply,
  aggregateOnConditionApply,
  aggregateOnConditionPreview,
  aggregatePreview,
  aggregationOutputType,
  buildOnConditionAggregations,
  computeAggregations,
  computeRollup,
  evalAggregation,
  resolveOnConditionTargets,
  rollupApply,
  rollupPreview,
} from "../../../src/services/pipelines/ops/aggregateOps";
import type { TransformOpsContext } from "../../../src/services/pipelines/ops/transformOpsContext";

const ROWS = [
  { c: "US", a: "10", b: "x" },
  { c: "US", a: "20", b: "y" },
  { c: "CA", a: "30", b: "z" },
  { c: "CA", a: "", b: "x" },
];

describe("aggregateOps — aggregationOutputType", () => {
  it("maps functions to output types", () => {
    expect(aggregationOutputType({ function: "count", outputColumn: "o" }, "string")).toBe("integer");
    expect(aggregationOutputType({ function: "count_distinct", column: "a", outputColumn: "o" }, "string")).toBe("integer");
    expect(aggregationOutputType({ function: "avg", column: "a", outputColumn: "o" }, "integer")).toBe("double");
    expect(aggregationOutputType({ function: "stddev", column: "a", outputColumn: "o" }, "integer")).toBe("double");
    expect(aggregationOutputType({ function: "variance", column: "a", outputColumn: "o" }, "integer")).toBe("double");
    expect(aggregationOutputType({ function: "sum", column: "a", outputColumn: "o" }, "integer")).toBe("integer");
    expect(aggregationOutputType({ function: "sum", outputColumn: "o" }, "string")).toBe("double");
    expect(aggregationOutputType({ function: "min", column: "a", outputColumn: "o" }, "date")).toBe("date");
  });
});

describe("aggregateOps — evalAggregation", () => {
  it("count(col) counts non-nulls; bare count is COUNT(*)", () => {
    expect(evalAggregation({ function: "count", column: "a", outputColumn: "o" }, ROWS)).toBe(3);
    expect(evalAggregation({ function: "count", outputColumn: "o" }, ROWS)).toBe(4);
  });

  it("count_distinct counts distinct non-null values", () => {
    expect(evalAggregation({ function: "count_distinct", column: "b", outputColumn: "o" }, ROWS)).toBe(3);
  });

  it("sum/avg/min/max skip nulls and coerce numerics", () => {
    expect(evalAggregation({ function: "sum", column: "a", outputColumn: "o" }, ROWS)).toBe(60);
    expect(evalAggregation({ function: "avg", column: "a", outputColumn: "o" }, ROWS)).toBe(20);
    expect(evalAggregation({ function: "min", column: "a", outputColumn: "o" }, ROWS)).toBe(10);
    expect(evalAggregation({ function: "max", column: "a", outputColumn: "o" }, ROWS)).toBe(30);
  });

  it("all-null numeric group → null", () => {
    expect(evalAggregation({ function: "sum", column: "a", outputColumn: "o" }, [{ a: "" }, { a: null }])).toBeNull();
  });

  it("stddev/variance are sample statistics; n<2 → null", () => {
    const rows = [{ a: "2" }, { a: "4" }, { a: "6" }];
    expect(evalAggregation({ function: "variance", column: "a", outputColumn: "o" }, rows)).toBe(4);
    expect(evalAggregation({ function: "stddev", column: "a", outputColumn: "o" }, rows)).toBe(2);
    expect(evalAggregation({ function: "stddev", column: "a", outputColumn: "o" }, [{ a: "2" }])).toBeNull();
  });
});

describe("aggregateOps — computeAggregations", () => {
  it("groups in first-appearance order; nulls form their own group", () => {
    const out = computeAggregations(ROWS, ["c"], [{ column: "a", function: "sum", outputColumn: "s" }]);
    expect(out).toEqual([{ c: "US", s: 30 }, { c: "CA", s: 30 }]);
  });

  it("empty groupBy yields a single global row", () => {
    const out = computeAggregations(ROWS, [], [{ column: "a", function: "sum", outputColumn: "s" }]);
    expect(out).toEqual([{ s: 60 }]);
  });

  it("empty aggregations → DISTINCT group keys", () => {
    const out = computeAggregations(ROWS, ["c"], []);
    expect(out).toEqual([{ c: "US" }, { c: "CA" }]);
  });
});

describe("aggregateOps — computeRollup", () => {
  it("emits most-detailed first down to the grand total", () => {
    const out = computeRollup(ROWS, ["c", "b"], [{ column: "a", function: "sum", outputColumn: "s" }]);
    // level 2: (c,b); level 1: (c); level 0: ()
    expect(out.filter((r) => r.c === null && r.b === null)).toEqual([{ c: null, b: null, s: 60 }]);
    expect(out.filter((r) => r.c === "US" && r.b === null)).toEqual([{ c: "US", b: null, s: 30 }]);
    expect(out).toHaveLength(4 /* (c,b) */ + 2 /* (c) */ + 1 /* () */);
  });
});

describe("aggregateOps — on-condition resolution", () => {
  const cols = [
    { name: "a", type: "integer" },
    { name: "b", type: "double" },
    { name: "c", type: "string" },
  ];

  it("kind 'all' returns every column", () => {
    expect(resolveOnConditionTargets({ kind: "all" }, cols)).toEqual(["a", "b", "c"]);
  });

  it("columnHasType matches numeric-ish and integer-ish families", () => {
    expect(resolveOnConditionTargets({ kind: "columnHasType", columnType: "numeric" }, cols)).toEqual(["b"]);
    expect(resolveOnConditionTargets({ kind: "columnHasType", columnType: "integer" }, cols)).toEqual(["a"]);
    expect(resolveOnConditionTargets({ kind: "columnHasType", columnType: "string" }, cols)).toEqual(["c"]);
  });

  it("buildOnConditionAggregations expands targets × expressions with suffix naming", () => {
    const items = buildOnConditionAggregations(["a", "b"], [{ function: "sum", suffix: "_total" }]);
    expect(items).toEqual([
      { function: "sum", column: "a", outputColumn: "a_total" },
      { function: "sum", column: "b", outputColumn: "b_total" },
    ]);
  });
});

// ---------------------------------------------------------------------------

function stubCtx(overrides: Partial<TransformOpsContext> = {}): TransformOpsContext {
  return {
    resolvePreviewInput: async () => ({
      dataset: { id: "d1", file_path: "k.csv", status: "ready" },
      sourceColumns: [
        { name: "c", type: "string" },
        { name: "a", type: "integer" },
      ],
      existingTransforms: [],
      baseRows: ROWS,
    }),
    applyExistingTransforms: (rows) => rows,
    applyExistingTransformColumns: (cols) => cols,
    fetchNodeConfig: async () => ({ id: "n1", config: {} }),
    saveNodeConfig: async (_n, _p, config) => ({ id: "n1", config }),
    assertColumnsExist: (names, needed, fnName) => {
      for (const col of needed) {
        if (!names.has(col)) throw new Error(`${fnName} column "${col}" does not exist`);
      }
    },
    resolveNodeData: async () => ({ columns: [], rows: [] }),
    persistExecutionSnapshot: async () => {},
    walkTransitiveInputs: async () => [],
    unionPreview: async () => ({ columns: [], rows: [] }),
    ...overrides,
  };
}

describe("aggregateOps — previews", () => {
  it("aggregatePreview groups and aggregates", async () => {
    const out = await aggregatePreview(stubCtx(), "p", "pl", "n1", {
      groupBy: ["c"],
      aggregations: [{ column: "a", function: "sum", outputColumn: "s" }],
      limit: 10,
    });
    expect(out.rows).toEqual([{ c: "US", s: 30 }, { c: "CA", s: 30 }]);
    expect(out.columns).toEqual([{ name: "c", type: "string" }, { name: "s", type: "integer" }]);
  });

  it("rollupPreview requires at least one column and one aggregation", async () => {
    await expect(
      rollupPreview(stubCtx(), "p", "pl", "n1", {
        rollupColumns: [], aggregations: [{ column: "a", function: "sum", outputColumn: "s" }], limit: 10,
      }),
    ).rejects.toThrowError(/at least one column and one aggregation/);
  });

  it("rollupPreview emits grouping sets", async () => {
    const out = await rollupPreview(stubCtx(), "p", "pl", "n1", {
      rollupColumns: ["c"],
      aggregations: [{ column: "a", function: "sum", outputColumn: "s" }],
      limit: 10,
    });
    expect(out.rows).toEqual([{ c: "US", s: 30 }, { c: "CA", s: 30 }, { c: null, s: 60 }]);
  });

  it("aggregateOnConditionPreview expands over matched columns and reports them", async () => {
    const out = await aggregateOnConditionPreview(stubCtx(), "p", "pl", "n1", {
      predicate: { kind: "columnHasType", columnType: "integer" },
      groupBy: ["c"],
      aggregations: [{ function: "sum", suffix: "_total" }],
      limit: 10,
    });
    expect(out.matchedColumns).toEqual(["a"]);
    expect(out.rows).toEqual([{ c: "US", a_total: 30 }, { c: "CA", a_total: 30 }]);
  });

  it("aggregateOnConditionPreview rejects a predicate matching nothing", async () => {
    await expect(
      aggregateOnConditionPreview(stubCtx(), "p", "pl", "n1", {
        predicate: { kind: "columnHasType", columnType: "timestamp" },
        groupBy: [], aggregations: [{ function: "sum", suffix: "_s" }], limit: 10,
      }),
    ).rejects.toThrowError(/matched no columns/);
  });
});

describe("aggregateOps — applies persist the right transform records", () => {
  async function captured(fn: (ctx: TransformOpsContext) => Promise<unknown>) {
    let saved: Record<string, unknown> | undefined;
    const ctx = stubCtx({ saveNodeConfig: async (_n, _p, c) => { saved = c; return {}; } });
    await fn(ctx);
    return (saved?.transforms as Array<Record<string, unknown>>)[0];
  }

  it("aggregateApply", async () => {
    expect(await captured((ctx) => aggregateApply(ctx, "p", "pl", "n1", {
      groupBy: ["c"], aggregations: [],
    }))).toMatchObject({ function: "Aggregate", groupBy: ["c"] });
  });

  it("rollupApply", async () => {
    expect(await captured((ctx) => rollupApply(ctx, "p", "pl", "n1", {
      rollupColumns: ["c"], aggregations: [],
    }))).toMatchObject({ function: "Rollup", rollupColumns: ["c"] });
  });

  it("aggregateOnConditionApply", async () => {
    expect(await captured((ctx) => aggregateOnConditionApply(ctx, "p", "pl", "n1", {
      predicate: { kind: "all" }, groupBy: [], aggregations: [],
    }))).toMatchObject({ function: "AggregateOnCondition", predicate: { kind: "all" } });
  });
});
