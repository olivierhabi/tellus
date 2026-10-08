/**
 * Expectation parity: engine SQL vs the in-heap evaluator, on identical data.
 *
 * The engine deploy path replaces the in-heap evaluator at the build gate, so
 * a divergence here would silently change what severity='fail' MEANS. Every
 * case below runs BOTH evaluators over the SAME rows and asserts identical
 * status AND identical detail text.
 *
 * Uses an in-memory DuckDB so the test needs no object storage.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// The shared DuckDB pool insists on S3 credentials at acquireConnection
// (requireSecret, F-P4-24) even for a purely local in-memory table. This lane
// is offline, so stub placeholders — they are never dialled, and the well-known
// MinIO root credential is deliberately NOT reintroduced here.
vi.stubEnv("S3_ACCESS_KEY_ID", "unit-test-placeholder");
vi.stubEnv("S3_SECRET_ACCESS_KEY", "unit-test-placeholder");
import {
  evaluateExpectations,
  type PipelineExpectation,
} from "../../../src/services/pipelines/expectations";
import {
  evaluateExpectationsOnEngine,
  type EngineQuery,
} from "../../../src/services/pipelines/engineExpectations";
import { acquireConnection, releaseConnection } from "../../../src/services/duckdb/pool";

const exp = (o: Partial<PipelineExpectation>): PipelineExpectation => ({
  id: "e1",
  pipelineId: "p1",
  nodeId: null,
  name: "rule",
  type: "row_count_bounds",
  config: {},
  severity: "fail",
  active: true,
  ...o,
});

/** Load rows into an in-memory DuckDB table and return a query helper. */
async function loadTable(rows: Array<Record<string, unknown>>): Promise<EngineQuery> {
  const conn = await acquireConnection();
  // Column set is derived from the first row; tests declare their shape.
  const cols = Object.keys(rows[0]);
  const typeOf = (v: unknown) => (typeof v === "number" ? "DOUBLE" : typeof v === "boolean" ? "BOOLEAN" : "VARCHAR");
  await conn.run(
    `CREATE OR REPLACE TEMP TABLE parity_src (${cols.map((c) => `"${c}" ${typeOf(rows[0][c])}`).join(", ")})`,
  );
  for (const r of rows) {
    const lit = (v: unknown) => {
      if (v === null || v === undefined) return "NULL";
      if (typeof v === "number") return String(v);
      if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
      return `'${String(v).replace(/'/g, "''")}'`;
    };
    await conn.run(
      `INSERT INTO parity_src VALUES (${cols.map((c) => lit(r[c])).join(", ")})`,
    );
  }
  const qy: EngineQuery = {
    async one(sql: string) {
      const out: Record<string, unknown> = {};
      for await (const r of (conn as unknown as { stream(s: string): AsyncIterable<Record<string, unknown>> }).stream(sql)) {
        for (const [k, v] of Object.entries(r)) {
          out[k] = typeof v === "bigint" ? Number(v) : v;
        }
      }
      return out;
    },
  };
  releaseConnection(conn);
  return qy;
}

const row = (o: Record<string, unknown>) => o;

describe("engine expectations parity (production gate)", () => {
  let qy: EngineQuery;

  beforeAll(async () => {
    qy = await loadTable([
      { id: "a", amount: 1.5, note: "x", tag: "t1" },
      { id: "b", amount: 2.5, note: "y", tag: "t1" },
      { id: "c", amount: null, note: "", tag: "t2" },
      { id: "d", amount: 4.0, note: null, tag: "t2" },
    ]);
  });
  afterAll(async () => {
    releaseConnection(await acquireConnection());
  });

  const both = async (e: PipelineExpectation) => {
    const rowsInHeap = [
      { id: "a", amount: 1.5, note: "x", tag: "t1" },
      { id: "b", amount: 2.5, note: "y", tag: "t1" },
      { id: "c", amount: null, note: "", tag: "t2" },
      { id: "d", amount: 4.0, note: null, tag: "t2" },
    ];
    const [heap] = evaluateExpectations([e], rowsInHeap);
    const [eng] = await evaluateExpectationsOnEngine([e], "parity_src", qy);
    return { heap, eng };
  };

  it("row_count_bounds within range", async () => {
    const { heap, eng } = await both(exp({ type: "row_count_bounds", config: { min: 1, max: 10 } }));
    expect(eng.status).toBe(heap.status);
    expect(eng.detail).toBe(heap.detail);
  });

  it("row_count_bounds below min FAILS", async () => {
    const { heap, eng } = await both(exp({ type: "row_count_bounds", config: { min: 99 } }));
    expect(eng.status).toBe("FAIL");
    expect(eng.detail).toBe(heap.detail);
  });

  it("row_count_bounds above max FAILS", async () => {
    const { heap, eng } = await both(exp({ type: "row_count_bounds", config: { max: 2 } }));
    expect(eng.status).toBe("FAIL");
    expect(eng.detail).toBe(heap.detail);
  });

  it("not_null catches NULL and empty-string and null number", async () => {
    const { heap, eng } = await both(exp({ type: "not_null", config: { columns: ["id", "amount", "note"] } }));
    expect(eng.status).toBe("FAIL");
    expect(eng.detail).toBe(heap.detail);
  });

  it("not_null passes on fully populated columns", async () => {
    const { heap, eng } = await both(exp({ type: "not_null", config: { columns: ["id"] } }));
    expect(eng.status).toBe("PASS");
    expect(eng.detail).toBe(heap.detail);
  });

  it("not_null on zero columns is a no-op PASS", async () => {
    const { heap, eng } = await both(exp({ type: "not_null", config: { columns: [] } }));
    expect(eng.status).toBe(heap.status);
    expect(eng.detail).toBe(heap.detail);
  });

  it("unique detects duplicates", async () => {
    const { heap, eng } = await both(exp({ type: "unique", config: { columns: ["tag"] } }));
    expect(eng.status).toBe("FAIL");
    expect(eng.detail).toBe(heap.detail);
  });

  it("unique passes on distinct keys", async () => {
    const { heap, eng } = await both(exp({ type: "unique", config: { columns: ["id"] } }));
    expect(eng.status).toBe("PASS");
    expect(eng.detail).toBe(heap.detail);
  });

  it("unique over a composite key", async () => {
    const { heap, eng } = await both(exp({ type: "unique", config: { columns: ["id", "tag"] } }));
    expect(eng.status).toBe(heap.status);
    expect(eng.detail).toBe(heap.detail);
  });

  it("unique counts rows BEYOND first, matching in-heap", async () => {
    // tags: t1,t1,t2,t2 -> 4 total, 2 distinct -> exactly 2 duplicates.
    const { heap, eng } = await both(exp({ type: "unique", config: { columns: ["tag"] } }));
    expect(eng.detail).toContain("2 duplicate row(s)");
    expect(heap.detail).toContain("2 duplicate row(s)");
  });
});