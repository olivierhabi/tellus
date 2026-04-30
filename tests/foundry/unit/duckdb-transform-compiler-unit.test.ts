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

function compile(transforms: TransformStep[], limit?: number): string {
  return compileTransformChain(transforms, { inputPath: IN, limit }).sql;
}

describe("duckdbTransformEngine compiler", () => {
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
});
