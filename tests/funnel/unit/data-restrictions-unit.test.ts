// ---------------------------------------------------------------------------
// OSv2 data restrictions (Palantir parity) — pure rules + the DuckDB CSV
// aggregate. See src/services/funnel/dataRestrictions.ts.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  IndexingDataRestrictionError,
  OSV2_LIMITS,
  RestrictionTracker,
  buildCsvRestrictionChecks,
  csvRestrictionAggregateSql,
  enforceRestrictions,
  mergeViolations,
  primaryKeyTypeViolation,
  violationsFromCsvAggregate,
  type RestrictionSchema,
} from "../../../src/services/funnel/dataRestrictions";
import { acquireConnection, queryAll, releaseConnection } from "../../../src/services/duckdb/pool";

function schema(over: Partial<RestrictionSchema> = {}): RestrictionSchema {
  return {
    objectTypeApiName: "Orders",
    policy: "lenient",
    primaryKeyColumn: "id",
    primaryKeyBaseType: "string",
    primaryKeyIsArray: false,
    columns: new Map([
      ["id", { column: "id", propertyApiName: "id", baseType: "string", isArray: false }],
      ["name", { column: "name", propertyApiName: "name", baseType: "string", isArray: false }],
      ["price", { column: "price", propertyApiName: "price", baseType: "double", isArray: false }],
      ["tags", { column: "tags", propertyApiName: "tags", baseType: "string_array", isArray: true }],
    ]),
    ...over,
  };
}

describe("primary key types", () => {
  it.each(["geopoint", "geoshape", "timeseries", "decimal", "double", "float", "string_array"])(
    "%s is forbidden",
    (bt) => {
      const v = primaryKeyTypeViolation(schema({ primaryKeyBaseType: bt }));
      expect(v?.code).toBe("forbidden_primary_key_type");
    },
  );
  it.each(["string", "integer", "long", "short", "byte", "date", "timestamp", "boolean"])(
    "%s is allowed",
    (bt) => {
      expect(primaryKeyTypeViolation(schema({ primaryKeyBaseType: bt }))).toBeNull();
    },
  );
  it("an array-flagged primary key is forbidden", () => {
    expect(primaryKeyTypeViolation(schema({ primaryKeyIsArray: true }))?.code).toBe(
      "forbidden_primary_key_type",
    );
  });
});

describe("RestrictionTracker", () => {
  it("flags every OSv2 value rule and keeps counts, samples and columns", () => {
    const t = new RestrictionTracker(schema());
    t.observe("1", { id: "", name: "ok", price: 1.5, tags: ["a"] }); // empty PK is not its job
    t.observe("2", { name: "", price: Number.NaN });
    t.observe("3", { price: Number.POSITIVE_INFINITY, tags: ["a", null] });
    t.observe("4", { price: "-Infinity", tags: [["nested"]] });
    t.observe("5", { name: "NaN", price: "12.5" }); // "NaN" in a string column is just text
    t.observe("6", { tags: new Array(OSV2_LIMITS.maxArrayElements + 1).fill("x") });
    const v = Object.fromEntries(t.violations().map((x) => [x.code, x]));
    expect(Object.keys(v).sort()).toEqual([
      "array_too_large",
      "empty_string",
      "nested_array",
      "non_finite_number",
      "null_array_element",
    ]);
    expect(v.non_finite_number.count).toBe(3);
    expect(v.non_finite_number.columns).toEqual(["price"]);
    expect(v.non_finite_number.samples).toEqual([
      "pk=2 column=price",
      "pk=3 column=price",
      "pk=4 column=price",
    ]);
    expect(v.empty_string).toMatchObject({ count: 1, samples: ["pk=2 column=name"] });
    expect(v.null_array_element.count).toBe(1);
    expect(v.nested_array.count).toBe(1);
    expect(v.array_too_large.count).toBe(1);
  });

  it("flags strings over 12 MB (UTF-8 bytes, not code units)", () => {
    const t = new RestrictionTracker(schema());
    // 4.2M three-byte chars = 12.6 MB in UTF-8 but only 4.2M code units.
    t.observe("1", { name: "€".repeat(4_200_000) });
    t.observe("2", { name: "a".repeat(4_200_000) }); // 4.2 MB: fine
    expect(t.violations()).toEqual([
      { code: "string_too_large", count: 1, samples: ["pk=1 column=name"], columns: ["name"] },
    ]);
  });

  it("caps samples at 5", () => {
    const t = new RestrictionTracker(schema());
    for (let i = 0; i < 20; i++) t.observe(String(i), { name: "" });
    const [v] = t.violations();
    expect(v.count).toBe(20);
    expect(v.samples).toHaveLength(5);
  });
});

describe("policy", () => {
  const violations = [{ code: "duplicate_primary_key" as const, count: 2, samples: ["1", "3"] }];
  it("strict throws with counts and samples", () => {
    expect(() => enforceRestrictions(schema({ policy: "strict" }), violations)).toThrow(
      IndexingDataRestrictionError,
    );
    expect(() => enforceRestrictions(schema({ policy: "strict" }), violations)).toThrow(
      /duplicate_primary_key: 2 samples=\["1","3"\]/,
    );
  });
  it("lenient returns the violations", () => {
    expect(enforceRestrictions(schema(), violations)).toEqual(violations);
  });
  it("strict with no violations passes", () => {
    expect(enforceRestrictions(schema({ policy: "strict" }), [])).toEqual([]);
  });
  it("mergeViolations adds counts and unions samples + columns", () => {
    expect(
      mergeViolations(
        [{ code: "empty_string", count: 2, samples: ["a"], columns: ["x"] }],
        [{ code: "empty_string", count: 3, samples: ["b"], columns: ["y"] }],
      ),
    ).toEqual([{ code: "empty_string", count: 5, samples: ["a", "b"], columns: ["x", "y"] }]);
  });
});

describe("CSV aggregate (real DuckDB)", () => {
  it("counts NaN/Inf on numeric columns only, in one scan; empties are already NULL", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restr-"));
    const csv = path.join(dir, "s.csv");
    fs.writeFileSync(
      csv,
      ["id,name,price", '1,"",1.5', "2,NaN,nan", "3,ok,-Infinity", "4,,inf", "5,fine,2"].join("\n") + "\n",
    );
    const conn = await acquireConnection({ skipHttpfs: true });
    try {
      const src = `read_csv_auto('${csv}', delim=',', PARALLEL=false, all_varchar=true)`;
      const checks = buildCsvRestrictionChecks(["id", "name", "price"], schema());
      // id is the PK: never value-checked here.
      expect(checks.some((c) => c.column === "id")).toBe(false);
      const [row] = await queryAll<Record<string, unknown>>(
        conn,
        `SELECT ${csvRestrictionAggregateSql(checks)} FROM ${src}`,
      );
      const v = Object.fromEntries(violationsFromCsvAggregate(checks, row).map((x) => [x.code, x]));
      // DuckDB reads `,"",` and `,,` as NULL: nothing to flag.
      expect(v.empty_string).toBeUndefined();
      const [nulls] = await queryAll<{ n: unknown }>(
        conn,
        `SELECT CAST(count(*) AS VARCHAR) AS n FROM ${src} WHERE name IS NULL`,
      );
      expect(Number(nulls.n)).toBe(2);
      expect(v.non_finite_number).toMatchObject({ count: 3, columns: ["price"] }); // "NaN" in name ignored
      expect(v.string_too_large).toBeUndefined();
    } finally {
      releaseConnection(conn);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
