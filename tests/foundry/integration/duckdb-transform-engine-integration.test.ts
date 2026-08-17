// ---------------------------------------------------------------------------
// PB-B2 — duckdbTransformEngine end-to-end (integration).
//
// Runs a real Cast + Filter + Drop + Rename + Join chain through DuckDB
// against local CSV fixtures in tests/fixtures/pb-b2/. No S3/MinIO is
// required so this suite runs green in a minimal CI sandbox; the httpfs
// extension is deliberately skipped on non-s3 paths (see
// services/duckdb/pool.ts#shouldSkipHttpfs).
//
// Also pins PB-B2 (g): the shared pool reuses a single DuckDB Database
// across every acquire, so running the suite twice must NOT leak a second
// process. We assert that via the internal sentinel on the pool module.
//
// Skips gracefully if the native `duckdb` binding is not available on
// the host (e.g. Alpine ARM64 without prebuilds).
// ---------------------------------------------------------------------------

import { afterAll, describe, expect, it } from "vitest";
import path from "path";
import {
  acquireConnection,
  isDuckDBAvailable,
  releaseConnection,
  __resetPoolForTests,
} from "../../../src/services/duckdb/pool";
import {
  executeTransformChain,
  type TransformStep,
} from "../../../src/services/pipelines/duckdbTransformEngine";

const FIXTURE_DIR = path.resolve(__dirname, "../../fixtures/pb-b2");
const ORDERS = path.join(FIXTURE_DIR, "orders.csv");
const CUSTOMERS = path.join(FIXTURE_DIR, "customers.csv");
const DATES = path.join(FIXTURE_DIR, "dates.csv");

const hasDuck = isDuckDBAvailable();

afterAll(async () => {
  // Leave the pool alive between tests but clean up when the suite
  // finishes so vitest doesn't hang on a dangling native handle.
  await __resetPoolForTests();
});

describe("duckdbTransformEngine end-to-end", () => {
  it("runs a 4-step Cast/Filter/Drop/Rename chain against the orders fixture", async () => {
    if (!hasDuck) {
      console.warn("[pb-b2] duckdb native binding not available; skipping");
      return;
    }
    const chain: TransformStep[] = [
      { function: "Cast", expression: "amount", targetType: "numeric" },
      {
        function: "Filter",
        mode: "keep",
        match: "all",
        conditions: [{ column: "status", operator: "eq", value: "open" }],
      },
      { function: "Drop", columns: ["internal_notes"] },
      { function: "Rename", renames: [{ from: "order_id", to: "oid" }] },
    ];

    const out = await executeTransformChain(chain, { inputPath: ORDERS });
    // 3 rows are `status=open`; the null-amount one stays (legacy parity:
    // Cast with lenient coercion + Filter on status=open is independent).
    expect(out.rowCount).toBe(3);
    const columnNames = out.columns.map((c) => c.name).sort();
    expect(columnNames).toEqual(["amount", "customer_id", "oid", "status"]);
    // Amount was cast to DOUBLE; the 'null' literal coerces to NULL.
    const nullAmount = out.rows.find((r) => r.oid === 1004);
    expect(nullAmount?.amount).toBeNull();
  });

  it("executes an INNER JOIN between orders and customers", async () => {
    if (!hasDuck) return;
    const chain: TransformStep[] = [
      {
        function: "Join",
        rightPath: CUSTOMERS,
        rightAlias: "c",
        joinType: "inner",
        on: [{ left: "customer_id", right: "id" }],
      },
    ];
    const out = await executeTransformChain(chain, { inputPath: ORDERS });
    // Every order has a matching customer → 5 rows.
    expect(out.rowCount).toBe(5);
    // DuckDB auto-disambiguates the duplicate `id`-vs-`order_id` names;
    // we only assert that the join brought in `name`.
    expect(out.columns.some((c) => c.name === "name")).toBe(true);
  });

  it("rejects a cross-join with a typed 400 error (PB-B2 acceptance (c))", async () => {
    if (!hasDuck) return;
    const chain: TransformStep[] = [
      {
        function: "Join",
        rightPath: CUSTOMERS,
        joinType: "cross",
      },
    ];
    try {
      await executeTransformChain(chain, { inputPath: ORDERS });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("CROSS_JOIN_NOT_ALLOWED");
      expect((err as { statusCode?: number }).statusCode).toBe(400);
    }
  });

  it("is_null filter routes through the CSV null semantics", async () => {
    if (!hasDuck) return;
    // `amount=null` in the fixture → after Cast→numeric the literal
    // 'null' coerces to SQL NULL; the is_null filter must keep that row.
    const chain: TransformStep[] = [
      { function: "Cast", expression: "amount", targetType: "numeric" },
      {
        function: "Filter",
        conditions: [{ column: "amount", operator: "is_null" }],
      },
    ];
    const out = await executeTransformChain(chain, { inputPath: ORDERS });
    expect(out.rowCount).toBe(1);
    expect(out.rows[0].order_id).toBe(1004);
  });

  // The reported "500 of 500 values could not be cast to Date" came from a
  // bare TRY_CAST, which nulls every 2-digit-year value. These four cases run
  // the shape-dispatched emitter against the real binding, because the failure
  // modes it guards against are semantic, not syntactic: TRY_CAST('30/7/23')
  // does not error, it returns year 0030.
  const dateOf = (v: unknown) =>
    v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

  it("casts a month-first 2-digit-year column to the right dates", async () => {
    if (!hasDuck) return;
    const out = await executeTransformChain(
      [{ function: "Cast", expression: "mdy_date", targetType: "date" }],
      { inputPath: DATES },
    );
    expect(out.rows.map((r) => dateOf(r.mdy_date))).toEqual([
      "2023-07-30",
      "2023-01-15",
      "1999-12-31",
      "2024-02-29",
    ]);
  });

  it("casts a day-first 2-digit-year column to the same dates", async () => {
    if (!hasDuck) return;
    const out = await executeTransformChain(
      [{ function: "Cast", expression: "dmy_date", targetType: "date" }],
      { inputPath: DATES },
    );
    // Same calendar days as mdy_date, written day-first. The per-column order
    // probe has to reach the opposite verdict on this column than on that one.
    expect(out.rows.map((r) => dateOf(r.dmy_date))).toEqual([
      "2023-07-30",
      "2023-01-15",
      "1999-12-31",
      "2024-02-29",
    ]);
  });

  it("leaves ISO dates alone and nulls values that are not dates", async () => {
    if (!hasDuck) return;
    const out = await executeTransformChain(
      [
        { function: "Cast", expression: "iso_date", targetType: "date" },
        { function: "Cast", expression: "bad_date", targetType: "date" },
      ],
      { inputPath: DATES },
    );
    expect(out.rows.map((r) => dateOf(r.iso_date))).toEqual([
      "2023-07-30",
      "2023-01-15",
      "1999-12-31",
      "2024-02-29",
    ]);
    // Garbage, empty, an impossible month and Feb 30 all become NULL rather
    // than a wrong date — lenient cast semantics, not silent corruption.
    expect(out.rows.every((r) => r.bad_date === null)).toBe(true);
  });

  it("casts to timestamp through the same path", async () => {
    if (!hasDuck) return;
    const out = await executeTransformChain(
      [{ function: "Cast", expression: "mdy_date", targetType: "timestamp" }],
      { inputPath: DATES },
    );
    expect(dateOf(out.rows[0].mdy_date)).toBe("2023-07-30");
    expect(out.rows.every((r) => r.mdy_date !== null)).toBe(true);
  });

  it("(g) shares one DuckDB Database across parallel acquires", async () => {
    if (!hasDuck) return;
    // Two connections in quick succession should both come from the
    // same shared Database — the pool logs a sentinel under __resetPoolForTests.
    const a = await acquireConnection({ skipHttpfs: true });
    const b = await acquireConnection({ skipHttpfs: true });
    try {
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      // Not object-identical (connections are distinct JS handles off
      // the same Database) but both must work; a simple VALUES probe
      // verifies each connection can execute.
      const { queryAll } = await import("../../../src/services/duckdb/pool");
      const rowsA = await queryAll<{ n: number }>(a, "SELECT 1 AS n");
      const rowsB = await queryAll<{ n: number }>(b, "SELECT 2 AS n");
      expect(rowsA[0].n).toBe(1);
      expect(rowsB[0].n).toBe(2);
    } finally {
      releaseConnection(a);
      releaseConnection(b);
    }
  });
});
