// ---------------------------------------------------------------------------
// PB-B2.follow-2 — legacy TS-engine parity for the aggregate family.
//
// The pure helper cores of TransformService (computeAggregations /
// computeRollup / computeTopRows / computePivot / computeUnpivot /
// computeKeepDuplicates / executeJoin) are exercised directly with an
// inert knex stub: none of them touch the database. Their results must
// match the SQL the DuckDB compiler emits (pinned in
// duckdb-transform-compiler-unit.test.ts), because previews run through
// this path while deploys run through the engine.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { Knex } from "knex";
import { TransformService } from "../../../src/services/transformService";
import type { AggregationItem } from "../../../src/types/pipeline";

type Row = Record<string, unknown>;

type Priv = {
  computeAggregations: (rows: Row[], groupBy: string[], aggs: AggregationItem[]) => Row[];
  computeRollup: (rows: Row[], rollupColumns: string[], aggs: AggregationItem[]) => Row[];
  computeTopRows: (
    rows: Row[],
    partitionBy: string[],
    sorts: Array<{ column: string; direction: "asc" | "desc"; nulls?: "first" | "last" }>,
    topN: number,
  ) => Row[];
  computePivot: (
    rows: Row[],
    groupBy: string[],
    pivotColumn: string,
    pivotValues: Array<{ value: string; alias: string }>,
    aggs: AggregationItem[],
    aliasPosition: "prefix" | "suffix",
  ) => { rows: Row[]; valueColumns: string[] };
  computeUnpivot: (rows: Row[], cols: string[], name: string, value: string, kept: string[]) => Row[];
  computeKeepDuplicates: (rows: Row[], subset: string[], allColumns: string[]) => Row[];
  resolveOnConditionTargets: (
    predicate: { kind: "all" | "columnHasType"; columnType?: string },
    columns: Array<{ name: string; type: string }>,
  ) => string[];
  buildOnConditionAggregations: (
    targets: string[],
    exprs: Array<{ function: "sum" | "avg" | "min" | "max" | "count"; suffix: string }>,
  ) => AggregationItem[];
  applyExistingTransforms: (rows: Row[], transforms: unknown[]) => Row[];
  applyExistingTransformColumns: (
    cols: Array<{ name: string; type: string }>,
    transforms: unknown[],
  ) => Array<{ name: string; type: string }>;
  executeJoin: (
    left: Row[],
    right: Row[],
    joinType: string,
    conditions: Array<{ leftColumn: string; rightColumn: string }>,
    leftCols: Array<{ name: string; type: string }>,
    rightCols: Array<{ name: string; type: string }>,
  ) => Row[];
};

function svc(): Priv {
  return new TransformService(undefined as unknown as Knex) as unknown as Priv;
}

const ROWS: Row[] = [
  { c: "US", a: "10", b: "x" },
  { c: "US", a: "20", b: "y" },
  { c: "CA", a: "30", b: "z" },
  { c: "CA", a: "", b: "x" },
];

describe("TransformService — aggregation cores", () => {
  it("sum/avg/min/max skip nulls and coerce numerics (CSV strings)", () => {
    const out = svc().computeAggregations(ROWS, ["c"], [
      { column: "a", function: "sum", outputColumn: "s" },
      { column: "a", function: "avg", outputColumn: "m" },
      { column: "a", function: "min", outputColumn: "lo" },
      { column: "a", function: "max", outputColumn: "hi" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ c: "US", s: 30, m: 15, lo: 10, hi: 20 });
    expect(out[1]).toEqual({ c: "CA", s: 30, m: 30, lo: 30, hi: 30 });
  });

  it("bare count is COUNT(*) (nulls included); count(col) counts non-nulls", () => {
    const out = svc().computeAggregations(ROWS, ["c"], [
      { function: "count", outputColumn: "star" },
      { column: "a", function: "count", outputColumn: "nn" },
      { column: "b", function: "count_distinct", outputColumn: "dc" },
    ]);
    expect(out[0]).toEqual({ c: "US", star: 2, nn: 2, dc: 2 });
    expect(out[1]).toEqual({ c: "CA", star: 2, nn: 1, dc: 2 });
  });

  it("empty groupBy yields a single global row; all-null numeric group yields null", () => {
    const out = svc().computeAggregations(
      [{ a: "" }, { a: null }],
      [],
      [{ column: "a", function: "sum", outputColumn: "s" }],
    );
    expect(out).toEqual([{ s: null }]);
  });

  it("stddev/variance are sample statistics; n<2 → null", () => {
    const out = svc().computeAggregations(
      [{ a: "2" }, { a: "4" }, { a: "6" }],
      [],
      [
        { column: "a", function: "variance", outputColumn: "v" },
        { column: "a", function: "stddev", outputColumn: "s" },
      ],
    );
    expect(out[0].v).toBeCloseTo(4);
    expect(out[0].s).toBeCloseTo(2);
    const single = svc().computeAggregations(
      [{ a: "2" }],
      [],
      [{ column: "a", function: "stddev", outputColumn: "s" }],
    );
    expect(single[0].s).toBeNull();
  });

  it("rollup emits one block per prefix level, null-filling dropped columns", () => {
    const rows: Row[] = [
      { year: "2024", month: "01", v: "1" },
      { year: "2024", month: "02", v: "2" },
    ];
    const out = svc().computeRollup(rows, ["year", "month"], [
      { column: "v", function: "sum", outputColumn: "s" },
    ]);
    expect(out).toEqual([
      { year: "2024", month: "01", s: 1 },
      { year: "2024", month: "02", s: 2 },
      { year: "2024", month: null, s: 3 },
      { year: null, month: null, s: 3 },
    ]);
  });
});

describe("TransformService — on-condition, top rows, pivot, unpivot, keep-duplicates", () => {
  it("on-condition: kind=all targets every column; columnHasType maps numeric aliases", () => {
    const cols = [
      { name: "name", type: "string" },
      { name: "qty", type: "integer" },
      { name: "price", type: "double" },
    ];
    const s = svc();
    expect(s.resolveOnConditionTargets({ kind: "all" }, cols)).toEqual(["name", "qty", "price"]);
    expect(s.resolveOnConditionTargets({ kind: "columnHasType", columnType: "numeric" }, cols)).toEqual(["price"]);
    expect(s.resolveOnConditionTargets({ kind: "columnHasType", columnType: "integer" }, cols)).toEqual(["qty"]);
  });

  it("on-condition expansion names outputs as <column><suffix>", () => {
    const aggs = svc().buildOnConditionAggregations(
      ["price", "qty"],
      [{ function: "sum", suffix: "_total" }],
    );
    expect(aggs).toEqual([
      { function: "sum", column: "price", outputColumn: "price_total" },
      { function: "sum", column: "qty", outputColumn: "qty_total" },
    ]);
  });

  it("topRows picks the first N rows per partition after sorting", () => {
    const rows: Row[] = [
      { r: "x", score: "1", id: 1 },
      { r: "x", score: "9", id: 2 },
      { r: "y", score: "5", id: 3 },
      { r: "y", score: "0", id: 4 },
    ];
    const out = svc().computeTopRows(
      rows,
      ["r"],
      [{ column: "score", direction: "desc" }],
      1,
    );
    expect(out.map((o) => o.id)).toEqual([2, 3]);
    const all = svc().computeTopRows(rows, [], [{ column: "score", direction: "asc" }], 2);
    expect(all.map((o) => o.id)).toEqual([4, 1]);
  });

  it("pivot: one column per (value × aggregation); missing cells are SQL-consistent (count=0, sum=null)", () => {
    const rows: Row[] = [
      { grocery: "fruit", store: "air", count: "2" },
      { grocery: "fruit", store: "sea", count: "4" },
      { grocery: "veg", store: "sea", count: "6" },
    ];
    const { rows: out, valueColumns } = svc().computePivot(
      rows,
      ["grocery"],
      "store",
      [
        { value: "air", alias: "air" },
        { value: "sea", alias: "sea" },
      ],
      [
        { column: "count", function: "sum", outputColumn: "sc" },
        { column: "count", function: "count", outputColumn: "n" },
      ],
      "prefix",
    );
    expect(valueColumns).toEqual(["air_sc", "air_n", "sea_sc", "sea_n"]);
    expect(out).toEqual([
      { grocery: "fruit", air_sc: 2, air_n: 1, sea_sc: 4, sea_n: 1 },
      { grocery: "veg", air_sc: null, air_n: 0, sea_sc: 6, sea_n: 1 },
    ]);
  });

  it("pivot: aliasPosition=suffix puts the aggregation name first", () => {
    const { valueColumns } = svc().computePivot(
      [{ g: "a", p: "X", v: "1" }],
      ["g"],
      "p",
      [{ value: "X", alias: "x" }],
      [{ column: "v", function: "sum", outputColumn: "s" }],
      "suffix",
    );
    expect(valueColumns).toEqual(["s_x"]);
  });

  it("unpivot fans rows out per column and keeps NULL values", () => {
    const rows: Row[] = [
      { id: "1", air: null, sea: "10" },
      { id: "2", air: "5", sea: "7" },
    ];
    const out = svc().computeUnpivot(rows, ["air", "sea"], "mode", "hours", ["id"]);
    expect(out).toEqual([
      { mode: "air", hours: null, id: "1" },
      { mode: "sea", hours: "10", id: "1" },
      { mode: "air", hours: "5", id: "2" },
      { mode: "sea", hours: "7", id: "2" },
    ]);
  });

  it("keepDuplicates keeps ALL occurrences of repeated keys, in original order", () => {
    const rows: Row[] = [
      { col1: "item", col2: "XB", col3: "123" },
      { col1: "item", col2: "XB", col3: "123" },
      { col1: "toy", col2: "MT", col3: "222" },
      { col1: "toy", col2: "XB", col3: "123" },
      { col1: "toy", col2: "MT", col3: "222" },
      { col1: "watch", col2: "KK", col3: "452" },
    ];
    const out = svc().computeKeepDuplicates(rows, ["col2", "col3"], ["col1", "col2", "col3"]);
    expect(out.map((r) => `${r.col1}:${r.col2}`)).toEqual([
      "item:XB",
      "item:XB",
      "toy:MT",
      "toy:XB",
      "toy:MT",
    ]);
  });

  it("keepDuplicates with an empty subset keys on the whole row", () => {
    const rows: Row[] = [
      { a: "1" },
      { a: "1" },
      { a: "2" },
    ];
    const out = svc().computeKeepDuplicates(rows, [], ["a"]);
    expect(out).toEqual([{ a: "1" }, { a: "1" }]);
  });
});

describe("TransformService — chain replay of persisted configs", () => {
  it("an Aggregate config replays through applyExistingTransforms and shapes columns", () => {
    const s = svc();
    const transforms = [
      {
        function: "Aggregate",
        groupBy: ["c"],
        aggregations: [{ column: "a", function: "sum", outputColumn: "total" }],
      },
    ];
    const rows = s.applyExistingTransforms(ROWS, transforms);
    expect(rows).toEqual([
      { c: "US", total: 30 },
      { c: "CA", total: 30 },
    ]);
    const cols = s.applyExistingTransformColumns(
      [
        { name: "c", type: "string" },
        { name: "a", type: "string" },
        { name: "b", type: "string" },
      ],
      transforms,
    );
    expect(cols).toEqual([
      { name: "c", type: "string" },
      { name: "total", type: "string" },
    ]);
  });

  it("a Pivot config replays and exposes the declared value columns", () => {
    const s = svc();
    const transforms = [
      {
        function: "Pivot",
        groupBy: ["g"],
        pivotColumn: "p",
        pivotValues: [{ value: "X", alias: "x" }],
        aggregations: [{ column: "v", function: "sum", outputColumn: "s" }],
      },
    ];
    const rows = s.applyExistingTransforms([{ g: "1", p: "X", v: "5" }], transforms);
    expect(rows).toEqual([{ g: "1", x_s: 5 }]);
    const cols = s.applyExistingTransformColumns(
      [
        { name: "g", type: "string" },
        { name: "p", type: "string" },
        { name: "v", type: "integer" },
      ],
      transforms,
    );
    expect(cols).toEqual([
      { name: "g", type: "string" },
      { name: "x_s", type: "integer" },
    ]);
  });

  it("an Unpivot config drops the unpivoted columns and adds name/value first", () => {
    const s = svc();
    const transforms = [
      {
        function: "Unpivot",
        columns: ["a", "c"],
        nameColumn: "m",
        valueColumn: "h",
      },
    ];
    const rows = s.applyExistingTransforms([{ id: "1", a: "x", b: "y", c: "z" }], transforms);
    expect(rows).toEqual([
      { m: "a", h: "x", id: "1", b: "y" },
      { m: "c", h: "z", id: "1", b: "y" },
    ]);
    const cols = s.applyExistingTransformColumns(
      [
        { name: "id", type: "string" },
        { name: "a", type: "string" },
        { name: "b", type: "integer" },
        { name: "c", type: "string" },
      ],
      transforms,
    );
    expect(cols.map((c) => c.name)).toEqual(["m", "h", "id", "b"]);
  });
});

describe("TransformService — semi/anti joins", () => {
  const LEFT: Row[] = [
    { id: "1", v: "a" },
    { id: "2", v: "b" },
    { id: "3", v: "c" },
  ];
  const RIGHT: Row[] = [
    { id: "1", w: "p" },
    { id: "3", w: "q" },
    { id: "3", w: "q2" },
  ];
  const LCOLS = [
    { name: "id", type: "string" },
    { name: "v", type: "string" },
  ];
  const RCOLS = [
    { name: "id", type: "string" },
    { name: "w", type: "string" },
  ];
  const CONDS = [{ leftColumn: "id", rightColumn: "id" }];

  it("semi keeps one copy of each matching left row regardless of right multiplicity", () => {
    const out = svc().executeJoin(LEFT, RIGHT, "semi", CONDS, LCOLS, RCOLS);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.id)).toEqual(["1", "3"]);
  });

  it("anti keeps left rows with no right match", () => {
    const out = svc().executeJoin(LEFT, RIGHT, "anti", CONDS, LCOLS, RCOLS);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("2");
  });

  it("semi/anti respect null ≠ null", () => {
    const left: Row[] = [{ id: "" }];
    const right: Row[] = [{ id: "" }];
    expect(svc().executeJoin(left, right, "semi", CONDS, LCOLS, RCOLS)).toHaveLength(0);
    expect(svc().executeJoin(left, right, "anti", CONDS, LCOLS, RCOLS)).toHaveLength(1);
  });
});
