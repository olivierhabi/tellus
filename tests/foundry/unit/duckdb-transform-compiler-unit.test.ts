// ---------------------------------------------------------------------------
// PB-B2 — duckdbTransformEngine SQL compiler (unit).
//
// Pure-TS assertions over the emitted SQL: no DuckDB native binding is
// required so this suite runs in a minimal CI sandbox. Pins the exact
// SQL shape for each transform kind + the compile-time rejection paths
// (Normalize, cross-join).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  compileTransformChain,
  type TransformStep,
} from "../../../src/services/pipelines/duckdbTransformEngine";

const IN = "/tmp/orders.csv";

function compile(
  transforms: TransformStep[],
  limit?: number,
  extra?: { sourceColumns?: string[] },
): string {
  return compileTransformChain(transforms, { inputPath: IN, limit, ...extra }).sql;
}

describe("duckdbTransformEngine compiler", () => {
  it("compiles Foundry Case with ordered branches and a null default", () => {
    const sql = compile([{
      function: "CaseExpression",
      branches: [{
        condition: {
          left: { kind: "column", value: "claim_kind" },
          operator: "==",
          right: { kind: "literal", value: "HEALTH", literalType: "string" },
        },
        value: { kind: "column", value: "claim_id" },
      }],
      defaultValue: null,
      outputColumn: "health_claim_id",
      outputType: "string",
    }]);
    expect(sql).toContain(`CASE WHEN ("claim_kind" IS NOT DISTINCT FROM 'HEALTH') THEN "claim_id" ELSE NULL END`);
    expect(sql).toContain(`AS "health_claim_id"`);
  });

  it("compiles ConcatenateStrings with separator and Palantir null modes", () => {
    const base = { function: "ConcatenateStrings" as const, expressions: [
      { kind: "column" as const, value: "first" },
      { kind: "literal" as const, value: "world", literalType: "string" as const },
    ], separator: "--", outputColumn: "joined" };
    expect(compile([base])).toContain(`concat_ws('--', CAST("first" AS VARCHAR), CAST('world' AS VARCHAR)) AS "joined"`);
    expect(compile([{ ...base, nullOutputIfAnyInputIsNull: true }])).toContain('CASE WHEN CAST("first" AS VARCHAR) IS NULL OR');
  });
  it("empty chain emits a passthrough SELECT over read_csv_auto", () => {
    const sql = compile([]);
    expect(sql).toMatch(/WITH t0 AS \(SELECT \* FROM read_csv_auto\('\/tmp\/orders\.csv'\)\)/);
    expect(sql).toMatch(/SELECT \* FROM t0$/);
  });

  it("LIMIT is appended when a preview row cap is supplied", () => {
    const sql = compile([], 5000);
    expect(sql.endsWith("LIMIT 5000")).toBe(true);
  });

  it("Cast replace-in-place uses EXCLUDE + TRY_CAST to preserve column order", () => {
    const sql = compile([
      { function: "Cast", expression: "amount", targetType: "numeric" },
    ]);
    expect(sql).toMatch(
      /SELECT \* EXCLUDE \("amount"\), TRY_CAST\("amount" AS DOUBLE\) AS "amount" FROM t0/,
    );
  });

  it("Cast with a distinct outputColumn appends the new column", () => {
    const sql = compile([
      {
        function: "Cast",
        expression: "amount",
        outputColumn: "amount_dbl",
        targetType: "numeric",
      },
    ]);
    expect(sql).toMatch(
      /SELECT \*, TRY_CAST\("amount" AS DOUBLE\) AS "amount_dbl" FROM t0/,
    );
  });

  // A bare TRY_CAST(col AS DATE) nulls every 2-digit-year value ('7/30/23'),
  // which is what produced the "500 of 500 values could not be cast to Date"
  // report. Worse, TRY_CAST does not fail on '30/7/23' — it returns year 0030 —
  // so shape dispatch has to run before any TRY_CAST for date targets.
  it("Cast to date emits shape-dispatched strptime, not a bare TRY_CAST", () => {
    const sql = compile([
      { function: "Cast", expression: "order_due_date", targetType: "date" },
    ]);
    expect(sql).not.toMatch(/TRY_CAST\("order_due_date" AS DATE\) AS "order_due_date"/);
    // Both 2-digit and 4-digit slash shapes are handled explicitly.
    expect(sql).toContain("'%m/%d/%y'");
    expect(sql).toContain("'%d/%m/%y'");
    expect(sql).toContain("'%m/%d/%Y'");
    expect(sql).toContain("'%d/%m/%Y'");
    // ISO YYYY/MM/DD keeps its own branch.
    expect(sql).toContain("'%Y/%m/%d'");
    // Separators are normalised so '-' and '.' take the same path as '/'.
    expect(sql).toContain("regexp_replace");
    // Column order is still preserved via EXCLUDE.
    expect(sql).toMatch(/SELECT \* EXCLUDE \("order_due_date"\),/);
  });

  it("Cast to date infers day/month order from the column's own values", () => {
    const sql = compile([
      { function: "Cast", expression: "order_due_date", targetType: "date" },
    ]);
    // The probe counts values decisive for each reading and branches on the
    // majority, so an mdy column and a dmy column both parse correctly.
    expect(sql).toMatch(/__p2 > 12 AND __p1 <= 12/);
    expect(sql).toMatch(/__p1 > 12 AND __p2 <= 12/);
    // Probe reads from the same upstream CTE the cast projects from.
    expect(sql).toMatch(/FROM \(SELECT regexp_replace\([\s\S]*?FROM t0\)\)/);
  });

  it("Cast to timestamp gets the same shape dispatch as date", () => {
    const sql = compile([
      { function: "Cast", expression: "seen_at", targetType: "timestamp" },
    ]);
    expect(sql).toContain("AS TIMESTAMP");
    expect(sql).toContain("'%m/%d/%y'");
    expect(sql).not.toMatch(/TRY_CAST\("seen_at" AS TIMESTAMP\) AS "seen_at"/);
  });

  it("non-date cast targets stay on a plain lenient TRY_CAST", () => {
    for (const [target, sqlType] of [
      ["integer", "BIGINT"],
      ["string", "VARCHAR"],
      ["boolean", "BOOLEAN"],
    ] as const) {
      const sql = compile([
        { function: "Cast", expression: "c", targetType: target },
      ]);
      expect(sql).toMatch(
        new RegExp(`TRY_CAST\\("c" AS ${sqlType}\\) AS "c"`),
      );
      expect(sql).not.toContain("strptime");
    }
  });

  it("Filter with match=all emits an AND-joined predicate", () => {
    const sql = compile([
      {
        function: "Filter",
        mode: "keep",
        match: "all",
        conditions: [
          { column: "status", operator: "eq", value: "open" },
          { column: "amount", operator: "is_not_null" },
        ],
      },
    ]);
    expect(sql).toMatch(/WHERE \(.* = 'open'\) AND \(.*\)/);
  });

  it("Filter with mode=drop negates the predicate", () => {
    const sql = compile([
      {
        function: "Filter",
        mode: "drop",
        match: "any",
        conditions: [{ column: "status", operator: "eq", value: "closed" }],
      },
    ]);
    expect(sql).toMatch(/WHERE NOT \(/);
  });

  it("Filter lt column-to-column emits numeric-coercing comparison with null guards", () => {
    const sql = compile([
      {
        function: "Filter",
        mode: "keep",
        match: "all",
        conditions: [
          { column: "service_at", operator: "lt", value: "valid_from", valueIsColumn: true },
        ],
      },
    ]);
    expect(sql).toContain('"valid_from"');
    expect(sql).toMatch(/TRY_CAST\(.*AS DOUBLE\) IS NOT NULL AND/);
    expect(sql).toMatch(/ELSE .* < .*/
);
  });

  it("Filter gt against a numeric literal emits a double-typed comparison", () => {
    const sql = compile([
      {
        function: "Filter",
        mode: "keep",
        match: "all",
        conditions: [{ column: "amount", operator: "gt", value: "65000" }],
      },
    ]);
    expect(sql).toContain("'65000'");
    expect(sql).toMatch(/TRY_CAST\(.*AS DOUBLE\) >/);
  });

  it("Filter lt against an empty literal is always false (filterV1 null semantics)", () => {
    const sql = compile([
      {
        function: "Filter",
        mode: "keep",
        match: "all",
        conditions: [{ column: "amount", operator: "lt", value: "" }],
      },
    ]);
    expect(sql).toMatch(/WHERE \(FALSE\)/);
  });

  it("Drop emits a SELECT * EXCLUDE listing the columns", () => {
    const sql = compile([{ function: "Drop", columns: ["ssn", "dob"] }]);
    expect(sql).toMatch(/SELECT \* EXCLUDE \("ssn", "dob"\) FROM t0/);
  });

  it("Rename emits a SELECT * RENAME list", () => {
    const sql = compile([
      {
        function: "Rename",
        renames: [{ from: "o_id", to: "order_id" }],
      },
    ]);
    expect(sql).toMatch(/SELECT \* RENAME \("o_id" AS "order_id"\) FROM t0/);
  });

  it("Union emits UNION ALL BY NAME by default", () => {
    const sql = compile([{ function: "Union", otherPath: "/tmp/o2.csv" }]);
    expect(sql).toMatch(/UNION ALL BY NAME SELECT \* FROM read_csv_auto\('\/tmp\/o2\.csv'\)/);
  });

  it("Parquet right-sides route through read_parquet", () => {
    const sql = compile([{ function: "Union", otherPath: "/tmp/o2.parquet" }]);
    expect(sql).toMatch(/read_parquet\('\/tmp\/o2\.parquet'\)/);
  });

  it("Join with on-clause emits INNER JOIN with qualified predicates", () => {
    const sql = compile([
      {
        function: "Join",
        rightPath: "/tmp/customers.csv",
        rightAlias: "c",
        joinType: "inner",
        on: [{ left: "customer_id", right: "id" }],
      },
    ]);
    expect(sql).toMatch(/INNER JOIN read_csv_auto\('\/tmp\/customers\.csv'\) AS "c"/);
    expect(sql).toMatch(/l\."customer_id" = "c"\."id"/);
  });

  it("Join missing on-clause (non-cross) is rejected at compile time", () => {
    expect(() =>
      compile([
        {
          function: "Join",
          rightPath: "/tmp/c.csv",
          joinType: "inner",
          on: [],
        },
      ]),
    ).toThrow(/at least one on=/);
  });

  it("Cross-join without allowCrossJoin is rejected with typed error", () => {
    try {
      compile([
        {
          function: "Join",
          rightPath: "/tmp/c.csv",
          joinType: "cross",
        },
      ]);
      throw new Error("expected throw");
    } catch (err) {
      const code = (err as { code?: string }).code;
      expect(code).toBe("CROSS_JOIN_NOT_ALLOWED");
    }
  });

  it("Cross-join with cardinality >= 10M is rejected", () => {
    try {
      compile([
        {
          function: "Join",
          rightPath: "/tmp/c.csv",
          joinType: "cross",
          allowCrossJoin: true,
          estimatedCardinality: 10_000_000,
        },
      ]);
      throw new Error("expected throw");
    } catch (err) {
      const code = (err as { code?: string }).code;
      expect(code).toBe("CROSS_JOIN_CARDINALITY_TOO_LARGE");
    }
  });

  it("Cross-join under the cap compiles to a comma-join", () => {
    const sql = compile([
      {
        function: "Join",
        rightPath: "/tmp/c.csv",
        joinType: "cross",
        allowCrossJoin: true,
        estimatedCardinality: 500,
      },
    ]);
    expect(sql).toMatch(/FROM t0 AS l, read_csv_auto\('\/tmp\/c\.csv'\) AS "r"/);
  });

  it("Normalize is rejected with NORMALIZE_REQUIRES_LEGACY_ENGINE", () => {
    try {
      compile([{ function: "Normalize" }]);
      throw new Error("expected throw");
    } catch (err) {
      const code = (err as { code?: string }).code;
      expect(code).toBe("NORMALIZE_REQUIRES_LEGACY_ENGINE");
    }
  });

  it("chains all supported steps into one CTE pipeline", () => {
    const sql = compile([
      { function: "Cast", expression: "amount", targetType: "numeric" },
      {
        function: "Filter",
        conditions: [{ column: "status", operator: "eq", value: "open" }],
      },
      { function: "Drop", columns: ["internal_notes"] },
      { function: "Rename", renames: [{ from: "o_id", to: "order_id" }] },
    ]);
    // CTE naming is deterministic (t0..t4) so the suite pins the
    // dependency order the caller relies on for debug output.
    expect(sql).toMatch(/t1 AS \(SELECT \* EXCLUDE \("amount"\)/);
    expect(sql).toMatch(/t2 AS \(SELECT \* FROM t1 WHERE/);
    expect(sql).toMatch(/t3 AS \(SELECT \* EXCLUDE \("internal_notes"\) FROM t2/);
    expect(sql).toMatch(/t4 AS \(SELECT \* RENAME \("o_id" AS "order_id"\) FROM t3/);
    expect(sql.endsWith("SELECT * FROM t4")).toBe(true);
  });

  // -------------------------------------------------------------------
  // PB-B2.follow-2 — Tier B aggregate-family transforms
  // -------------------------------------------------------------------

  it("Aggregate emits GROUP BY with named aggregation outputs", () => {
    const sql = compile([
      {
        function: "Aggregate",
        groupBy: ["country"],
        aggregations: [
          { column: "amount", function: "sum", outputColumn: "total" },
          { function: "count", outputColumn: "n" },
        ],
      },
    ]);
    expect(sql).toMatch(
      /SELECT "country", SUM\("amount"\) AS "total", COUNT\(\*\) AS "n" FROM t0 GROUP BY "country"/,
    );
  });

  it("Aggregate without groupBy emits a global aggregation row", () => {
    const sql = compile([
      {
        function: "Aggregate",
        aggregations: [{ column: "a", function: "avg", outputColumn: "m" }],
      },
    ]);
    expect(sql).toMatch(/SELECT AVG\("a"\) AS "m" FROM t0/);
    expect(sql).not.toMatch(/GROUP BY/);
  });

  it("count(col) counts non-null values; count_distinct dedupes", () => {
    const sql = compile([
      {
        function: "Aggregate",
        aggregations: [
          { column: "a", function: "count", outputColumn: "nn" },
          { column: "a", function: "count_distinct", outputColumn: "dc" },
        ],
      },
    ]);
    expect(sql).toMatch(/COUNT\("a"\) AS "nn"/);
    expect(sql).toMatch(/COUNT\(DISTINCT "a"\) AS "dc"/);
  });

  it("stddev/variance emit sample statistics (STDDEV_SAMP / VAR_SAMP)", () => {
    const sql = compile([
      {
        function: "Aggregate",
        aggregations: [
          { column: "a", function: "stddev", outputColumn: "s" },
          { column: "a", function: "variance", outputColumn: "v" },
        ],
      },
    ]);
    expect(sql).toMatch(/STDDEV_SAMP\("a"\) AS "s"/);
    expect(sql).toMatch(/VAR_SAMP\("a"\) AS "v"/);
  });

  it("Rollup emits GROUP BY ROLLUP over the declared columns", () => {
    const sql = compile([
      {
        function: "Rollup",
        rollupColumns: ["year", "month"],
        aggregations: [{ column: "v", function: "sum", outputColumn: "s" }],
      },
    ]);
    expect(sql).toMatch(/GROUP BY ROLLUP\("year", "month"\)/);
  });

  it("AggregateOnCondition kind=all expands one expr per source column with suffix names", () => {
    const sql = compile(
      [
        {
          function: "AggregateOnCondition",
          predicate: { kind: "all" },
          groupBy: ["g"],
          aggregations: [
            { function: "sum", suffix: "_total" },
            { function: "count", suffix: "_n" },
          ],
        },
      ],
      undefined,
      { sourceColumns: ["price", "qty"] },
    );
    expect(sql).toMatch(/GROUP BY "g"/);
    expect(sql).toMatch(/SUM\("price"\) AS "price_total"/);
    expect(sql).toMatch(/SUM\("qty"\) AS "qty_total"/);
    expect(sql).toMatch(/COUNT\("price"\) AS "price_n"/);
  });

  it("AggregateOnCondition with a column-type predicate defers to the legacy engine", () => {
    try {
      compile([
        {
          function: "AggregateOnCondition",
          predicate: { kind: "columnHasType", columnType: "integer" },
          aggregations: [{ function: "sum", suffix: "_s" }],
        },
      ]);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("AOC_REQUIRES_LEGACY_ENGINE");
    }
  });

  it("TopRows emits ROW_NUMBER() OVER partition with the row cap", () => {
    const sql = compile([
      {
        function: "TopRows",
        partitionBy: ["region"],
        sorts: [{ column: "score", direction: "desc" }],
        topN: 3,
      },
    ]);
    expect(sql).toMatch(/ROW_NUMBER\(\) OVER \(PARTITION BY "region" ORDER BY "score" DESC NULLS FIRST\)/);
    expect(sql).toMatch(/__top_rows_rn <= 3/);
    expect(sql).toMatch(/SELECT \* EXCLUDE \(__top_rows_rn\)/);
  });

  it("Pivot expands one filtered aggregate per (pivotValue × aggregation) with prefix aliases", () => {
    const sql = compile([
      {
        function: "Pivot",
        groupBy: ["airline"],
        pivotColumn: "airport",
        pivotValues: [
          { value: "JFK", alias: "new_york" },
          { value: "LHR", alias: "london" },
        ],
        aggregations: [{ column: "miles", function: "avg", outputColumn: "avg_miles" }],
      },
    ]);
    expect(sql).toMatch(/GROUP BY "airline"/);
    expect(sql).toMatch(
      /AVG\(CASE WHEN CAST\("airport" AS VARCHAR\) = 'JFK' THEN "miles" END\) AS "new_york_avg_miles"/,
    );
    expect(sql).toMatch(/AS "london_avg_miles"/);
  });

  it("Pivot with aliasPosition=suffix puts the aggregation name first", () => {
    const sql = compile([
      {
        function: "Pivot",
        pivotColumn: "c",
        pivotValues: [{ value: "X", alias: "x" }],
        aggregations: [{ column: "m", function: "sum", outputColumn: "s" }],
        aliasPosition: "suffix",
      },
    ]);
    expect(sql).toMatch(/AS "s_x"/);
  });

  it("Unpivot emits one SELECT branch per column joined by UNION ALL BY NAME, keeping nulls", () => {
    const sql = compile([
      {
        function: "Unpivot",
        columns: ["air", "sea"],
        nameColumn: "mode",
        valueColumn: "hours",
      },
    ]);
    expect(sql).toMatch(/SELECT 'air' AS "mode", "air" AS "hours", \* EXCLUDE \("air", "sea"\) FROM t0/);
    expect(sql).toMatch(/UNION ALL BY NAME/);
    expect(sql).toMatch(/SELECT 'sea' AS "mode", "sea" AS "hours"/);
  });

  it("KeepDuplicates with a subset emits COUNT(*) OVER (PARTITION BY …)", () => {
    const sql = compile([
      { function: "KeepDuplicates", columns: ["col2", "col3"] },
    ]);
    expect(sql).toMatch(/COUNT\(\*\) OVER \(PARTITION BY "col2", "col3"\) AS __keep_dups_n/);
    expect(sql).toMatch(/WHERE __keep_dups_n > 1/);
  });

  it("KeepDuplicates with an empty subset requires legacy (compile-time column knowledge)", () => {
    try {
      compile([{ function: "KeepDuplicates", columns: [] }]);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("VALIDATION_ERROR");
    }
  });

  it("semi join emits SELECT l.* with SEMI JOIN (left columns only)", () => {
    const sql = compile([
      {
        function: "Join",
        rightPath: "/tmp/c.csv",
        joinType: "semi",
        on: [{ left: "id", right: "id" }],
      },
    ]);
    expect(sql).toMatch(/SELECT l\.\* FROM t0 AS l SEMI JOIN/);
  });

  it("anti join emits SELECT l.* with ANTI JOIN", () => {
    const sql = compile([
      {
        function: "Join",
        rightPath: "/tmp/c.csv",
        joinType: "anti",
        on: [{ left: "id", right: "id" }],
      },
    ]);
    expect(sql).toMatch(/ANTI JOIN read_csv_auto\('\/tmp\/c\.csv'\)/);
  });

  it("Union mode=wide compiles to UNION ALL BY NAME; first/narrow defer to legacy", () => {
    const wide = compile([{ function: "Union", otherPath: "/tmp/o2.csv", mode: "wide" }]);
    expect(wide).toMatch(/UNION ALL BY NAME/);
    try {
      compile([{ function: "Union", otherPath: "/tmp/o2.csv", mode: "first" }]);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("UNION_MODE_REQUIRES_LEGACY_ENGINE");
    }
  });
});
