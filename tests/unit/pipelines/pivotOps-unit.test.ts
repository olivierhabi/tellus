// ---------------------------------------------------------------------------
// Unit tests for the extracted Pivot / Unpivot ops
// (src/services/pipelines/ops/pivotOps.ts).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  computePivot,
  computeUnpivot,
  pivotApply,
  pivotPreview,
  unpivotApply,
  unpivotPreview,
} from "../../../src/services/pipelines/ops/pivotOps";
import type { TransformOpsContext } from "../../../src/services/pipelines/ops/transformOpsContext";

const ROWS = [
  { g: "US", q: "Q1", rev: "10" },
  { g: "US", q: "Q2", rev: "20" },
  { g: "CA", q: "Q1", rev: "5" },
];

describe("pivotOps — computePivot", () => {
  const pvs = [
    { value: "Q1", alias: "q1" },
    { value: "Q2", alias: "q2" },
  ];
  const aggs = [{ column: "rev", function: "sum" as const, outputColumn: "total" }];

  it("produces one column per (pivotValue × aggregation), prefix naming", () => {
    const { rows, valueColumns } = computePivot(ROWS, ["g"], "q", pvs, aggs, "prefix");
    expect(valueColumns).toEqual(["q1_total", "q2_total"]);
    expect(rows).toEqual([
      { g: "US", q1_total: 10, q2_total: 20 },
      { g: "CA", q1_total: 5, q2_total: null },
    ]);
  });

  it("suffix naming flips the name parts", () => {
    const { valueColumns } = computePivot(ROWS, ["g"], "q", pvs, aggs, "suffix");
    expect(valueColumns).toEqual(["total_q1", "total_q2"]);
  });

  it("count over an empty cell is 0 (SQL-consistent), sum is null", () => {
    const { rows } = computePivot(ROWS, ["g"], "q", pvs, [
      { column: "rev", function: "count", outputColumn: "n" },
    ], "prefix");
    expect(rows[1]).toEqual({ g: "CA", q1_n: 1, q2_n: 0 });
  });
});

describe("pivotOps — computeUnpivot", () => {
  it("emits one row per (kept key, unpivoted column), keeping nulls", () => {
    const out = computeUnpivot(
      [{ id: "1", q1: "10", q2: null }],
      ["q1", "q2"],
      "quarter",
      "revenue",
      ["id"],
    );
    expect(out).toEqual([
      { quarter: "q1", revenue: "10", id: "1" },
      { quarter: "q2", revenue: null, id: "1" },
    ]);
  });
});

// ---------------------------------------------------------------------------

function stubCtx(overrides: Partial<TransformOpsContext> = {}): TransformOpsContext {
  return {
    resolvePreviewInput: async () => ({
      dataset: { id: "d1", file_path: "k.csv", status: "ready" },
      sourceColumns: [
        { name: "g", type: "string" },
        { name: "q", type: "string" },
        { name: "rev", type: "integer" },
      ],
      existingTransforms: [],
      baseRows: ROWS,
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

describe("pivotOps — previews", () => {
  it("pivotPreview widens long data", async () => {
    const out = await pivotPreview(stubCtx(), "p", "pl", "n1", {
      groupBy: ["g"],
      pivotColumn: "q",
      pivotValues: [{ value: "Q1", alias: "q1" }],
      aggregations: [{ column: "rev", function: "sum", outputColumn: "total" }],
      aliasPosition: "prefix",
      limit: 10,
    });
    expect(out.rows).toEqual([{ g: "US", q1_total: 10 }, { g: "CA", q1_total: 5 }]);
  });

  it("pivotPreview rejects count(*) aggregations", async () => {
    await expect(
      pivotPreview(stubCtx(), "p", "pl", "n1", {
        groupBy: ["g"], pivotColumn: "q",
        pivotValues: [{ value: "Q1", alias: "q1" }],
        aggregations: [{ function: "count", outputColumn: "n" }],
        aliasPosition: "prefix", limit: 10,
      }),
    ).rejects.toThrowError(/require a column/);
  });

  it("unpivotPreview lengthens wide data and rejects name collisions", async () => {
    const out = await unpivotPreview(stubCtx(), "p", "pl", "n1", {
      columns: ["q", "rev"],
      nameColumn: "metric",
      valueColumn: "val",
      limit: 20,
    });
    expect(out.rows).toHaveLength(6);
    expect(out.columns.map((c) => c.name)).toEqual(["metric", "val", "g"]);

    await expect(
      unpivotPreview(stubCtx(), "p", "pl", "n1", {
        columns: ["q"], nameColumn: "g", valueColumn: "val", limit: 10,
      }),
    ).rejects.toThrowError(/must not collide/);
  });
});

describe("pivotOps — applies persist the right transform records", () => {
  async function captured(fn: (ctx: TransformOpsContext) => Promise<unknown>) {
    let saved: Record<string, unknown> | undefined;
    const ctx = stubCtx({ saveNodeConfig: async (_n, _p, c) => { saved = c; return {}; } });
    await fn(ctx);
    return (saved?.transforms as Array<Record<string, unknown>>)[0];
  }

  it("pivotApply", async () => {
    expect(await captured((ctx) => pivotApply(ctx, "p", "pl", "n1", {
      groupBy: ["g"], pivotColumn: "q",
      pivotValues: [], aggregations: [], aliasPosition: "prefix",
    }))).toMatchObject({ function: "Pivot", pivotColumn: "q" });
  });

  it("unpivotApply", async () => {
    expect(await captured((ctx) => unpivotApply(ctx, "p", "pl", "n1", {
      columns: ["q"], nameColumn: "n", valueColumn: "v",
    }))).toMatchObject({ function: "Unpivot", columns: ["q"], nameColumn: "n", valueColumn: "v" });
  });
});
