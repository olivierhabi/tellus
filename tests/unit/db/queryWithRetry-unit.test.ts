// ---------------------------------------------------------------------------
// F-P4-10 — queryWithRetry SQL-awareness.
//
// Unit coverage for `isIdempotentSql` — the predicate that gates whether
// `queryWithRetry` replays a statement when the pg client observes a
// transient connection error. Retrying a write that the server already
// committed double-applies the mutation; the predicate is the only
// thing keeping at-most-once semantics on the mutate paths.
//
// These cases fail against the pre-F-P4-10 helper (which retried every
// statement): reproducing the regression is a one-line delete of the
// `retryable` gate in queryWithRetry + re-running this file.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { isIdempotentSql } from "../../../src/db";

describe("isIdempotentSql (F-P4-10)", () => {
  describe("idempotent — retry is safe", () => {
    it.each([
      ["plain SELECT", "SELECT 1"],
      ["SELECT with leading whitespace", "   SELECT NOW()"],
      ["SELECT with leading comment", "-- pull audit row\nSELECT * FROM audit_log"],
      ["SELECT with block comment", "/* planner hint */ SELECT * FROM t WHERE id = $1"],
      ["SHOW", "SHOW search_path"],
      ["EXPLAIN", "EXPLAIN SELECT * FROM branching_state"],
      ["SET LOCAL", "SET LOCAL statement_timeout = 5000"],
      ["SET SESSION", "SET SESSION timezone = 'UTC'"],
      ["VALUES", "VALUES (1,2),(3,4)"],
      [
        "INSERT ON CONFLICT DO NOTHING (single-line)",
        "INSERT INTO idempotency_key (key, body) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      ],
      [
        "INSERT ON CONFLICT DO NOTHING (multi-line)",
        "INSERT INTO ledger (k, v)\n  VALUES ($1, $2)\n  ON CONFLICT (k) DO NOTHING;",
      ],
    ])("%s is idempotent", (_name, sql) => {
      expect(isIdempotentSql(sql)).toBe(true);
    });
  });

  describe("non-idempotent — retry would double-apply", () => {
    it.each([
      ["INSERT without ON CONFLICT", "INSERT INTO object_edits (id, body) VALUES ($1, $2)"],
      [
        "INSERT ON CONFLICT DO UPDATE",
        "INSERT INTO t (k, v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v",
      ],
      ["UPDATE", "UPDATE action_audit_log SET status = 'done' WHERE id = $1"],
      ["DELETE", "DELETE FROM link_edit WHERE source_pk = $1"],
      ["MERGE", "MERGE INTO t USING src ON t.k = src.k WHEN MATCHED THEN UPDATE SET v=src.v"],
      ["ALTER", "ALTER TABLE ontology ADD COLUMN foo TEXT"],
      ["CREATE", "CREATE TABLE foo (id INT)"],
      ["DROP", "DROP TABLE foo"],
      ["TRUNCATE", "TRUNCATE TABLE t"],
      ["BEGIN", "BEGIN"],
      ["COMMIT", "COMMIT"],
      [
        "CTE producing a write",
        "WITH del AS (DELETE FROM t WHERE id = $1 RETURNING *) INSERT INTO audit SELECT * FROM del",
      ],
      ["CALL (stored procedure)", "CALL refresh_materialized_view('mv_funnel')"],
    ])("%s is NOT idempotent", (_name, sql) => {
      expect(isIdempotentSql(sql)).toBe(false);
    });
  });

  it("empty / whitespace-only is treated as non-idempotent (fail-closed)", () => {
    expect(isIdempotentSql("")).toBe(false);
    expect(isIdempotentSql("   ")).toBe(false);
    expect(isIdempotentSql("\n\t\n")).toBe(false);
  });
});
