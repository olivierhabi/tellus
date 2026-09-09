// ---------------------------------------------------------------------------
// applyExisting (chain replay) — extracted from TransformService during the
// god-file breakup. These tests pin the replay semantics directly against
// the standalone module: every transform family must behave exactly as it
// did through the service wrappers.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  applyExistingTransformColumns,
  applyExistingTransforms,
} from "../../../../src/services/transform/applyExisting";

const COLS = [
  { name: "name", type: "string" },
  { name: "age", type: "string" },
  { name: "city", type: "string" },
];

const ROWS: Array<Record<string, unknown>> = [
  { name: "amy", age: "30", city: "kigali" },
  { name: "bob", age: "25", city: "paris" },
  { name: "cid", age: "30", city: "kigali" },
];

describe("applyExistingTransformColumns", () => {
  it("returns a copy with no transforms", () => {
    const out = applyExistingTransformColumns(COLS, []);
    expect(out).toEqual(COLS);
    expect(out).not.toBe(COLS);
  });

  it("retypes on Cast and adds the output column when new", () => {
    const out = applyExistingTransformColumns(COLS, [
      { function: "Cast", expression: "age", targetType: "integer" },
      { function: "Cast", expression: "age", outputColumn: "age_num", targetType: "integer" },
    ]);
    expect(out.find((c) => c.name === "age")).toEqual({ name: "age", type: "integer" });
    expect(out.find((c) => c.name === "age_num")).toEqual({ name: "age_num", type: "integer" });
  });

  it("drops and renames columns", () => {
    const out = applyExistingTransformColumns(COLS, [
      { function: "Drop", columns: ["city"] },
      { function: "Rename", renames: [{ from: "name", to: "full_name" }] },
    ]);
    expect(out.map((c) => c.name).sort()).toEqual(["age", "full_name"]);
  });

  it("uppercases names and declares RowSize output", () => {
    const out = applyExistingTransformColumns(COLS, [
      { function: "UppercaseColumnNames" },
      { function: "RowSize", outputColumn: "n" },
    ]);
    expect(out.map((c) => c.name)).toContain("NAME");
    expect(out.find((c) => c.name === "n")).toEqual({ name: "n", type: "integer" });
  });

  it("collapses to group-by + aggregation outputs on Aggregate", () => {
    const out = applyExistingTransformColumns(COLS, [
      {
        function: "Aggregate",
        groupBy: ["city"],
        aggregations: [{ function: "count", outputColumn: "n" }],
      },
    ]);
    expect(out).toEqual([
      { name: "city", type: "string" },
      { name: "n", type: "integer" },
    ]);
  });

  it("expands Unpivot to name/value + kept columns", () => {
    const out = applyExistingTransformColumns(COLS, [
      { function: "Unpivot", columns: ["age"], nameColumn: "metric", valueColumn: "val" },
    ]);
    expect(out.map((c) => c.name)).toEqual(["metric", "val", "name", "city"]);
  });

  it("declares the CurrentTimestamp column once", () => {
    const once = applyExistingTransformColumns(COLS, [
      { function: "CurrentTimestamp", outputColumn: "built_at" },
    ]);
    const twice = applyExistingTransformColumns(once, [
      { function: "CurrentTimestamp", outputColumn: "built_at" },
    ]);
    expect(once.filter((c) => c.name === "built_at")).toHaveLength(1);
    expect(twice.filter((c) => c.name === "built_at")).toHaveLength(1);
    expect(once.find((c) => c.name === "built_at")?.type).toBe("timestamp");
  });

  it("leaves metadata untouched for row-only ops", () => {
    const out = applyExistingTransformColumns(COLS, [
      { function: "Sort", sorts: [{ column: "age", direction: "asc" }] },
      { function: "TextBlock", text: "note" },
      { function: "NoSuchOp" },
    ]);
    expect(out).toEqual(COLS);
  });
});

describe("applyExistingTransforms", () => {
  it("chains Cast then Filter on the casted values", () => {
    const out = applyExistingTransforms(ROWS, [
      { function: "Cast", expression: "age", targetType: "integer" },
      {
        function: "Filter",
        mode: "keep",
        match: "all",
        conditions: [{ column: "age", operator: "gt", value: "25" }],
      },
    ]);
    expect(out.map((r) => r.name).sort()).toEqual(["amy", "cid"]);
    expect(out[0].age).toBe(30);
  });

  it("drops, renames and selects", () => {
    const out = applyExistingTransforms(ROWS, [
      { function: "Drop", columns: ["city"] },
      { function: "Rename", renames: [{ from: "name", to: "n" }] },
      { function: "Select", columns: ["n"] },
    ]);
    expect(out[0]).toEqual({ n: "amy" });
  });

  it("sorts and keeps TopRows", () => {
    const out = applyExistingTransforms(ROWS, [
      { function: "Sort", sorts: [{ column: "age", direction: "desc" }] },
      { function: "TopRows", partitionBy: [], sorts: [{ column: "age", direction: "desc" }], topN: 1 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].age).toBe("30");
  });

  it("aggregates groups with count", () => {
    const out = applyExistingTransforms(ROWS, [
      {
        function: "Aggregate",
        groupBy: ["city"],
        aggregations: [{ function: "count", outputColumn: "n" }],
      },
    ]);
    const byCity = new Map(out.map((r) => [r.city, r.n]));
    expect(byCity.get("kigali")).toBe(2);
    expect(byCity.get("paris")).toBe(1);
  });

  it("stamps every row with one CurrentTimestamp value", () => {
    const out = applyExistingTransforms(ROWS, [
      { function: "CurrentTimestamp", outputColumn: "built_at" },
    ]);
    expect(out).toHaveLength(3);
    for (const r of out) expect(typeof r.built_at).toBe("string");
    expect(new Set(out.map((r) => r.built_at)).size).toBe(1);
  });

  it("passes TextBlock and unknown functions through unchanged", () => {
    expect(applyExistingTransforms(ROWS, [{ function: "TextBlock" }])).toEqual(ROWS);
    expect(applyExistingTransforms(ROWS, [{ function: "NoSuchOp" }])).toEqual(ROWS);
  });
});
