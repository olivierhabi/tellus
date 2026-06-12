// ---------------------------------------------------------------------------
// SELECT-only enforcement — parser-based gate (libpg-query) negative/positive
// suite. Proves each documented bypass class is rejected, and that legitimate
// read-only SELECTs (incl. string literals that contain SQL keywords) pass.
// Also covers the type-aware watermark comparator.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  assertSelectOnly,
  UnsafeSqlError,
} from "../../../src/services/connectivity/imports/sql-renderer";
import { compareWatermark } from "../../../src/workers/foundry-worker/strategies/stream-extract";

const ALLOWED: Array<[string, string]> = [
  ["simple", "SELECT 1"],
  ["star", `SELECT * FROM "public"."users"`],
  ["join", "SELECT a.id, b.name FROM a JOIN b ON a.id = b.a_id"],
  ["aggregate", "SELECT count(*), max(created_at) FROM orders GROUP BY status"],
  ["read-only CTE", "WITH t AS (SELECT 1 AS x) SELECT x FROM t"],
  ["watermark param", `SELECT * FROM (SELECT * FROM t) s WHERE s."id" > :last_watermark`],
  ["keyword-in-literal", "SELECT * FROM orders WHERE status = 'CREATE' OR note = 'DROP TABLE'"],
  ["ident-named-like-kw", "SELECT id, update_count FROM t WHERE delete_flag = false"],
  ["subselect", "SELECT * FROM (SELECT id FROM t WHERE x > 1) s"],
  ["limit/offset", "SELECT * FROM t ORDER BY id LIMIT 100 OFFSET 50"],
];

const REJECTED: Array<[string, string]> = [
  ["INSERT", "INSERT INTO t VALUES (1)"],
  ["UPDATE", "UPDATE t SET x = 1"],
  ["DELETE", "DELETE FROM t"],
  ["MERGE", "MERGE INTO t USING s ON t.id=s.id WHEN MATCHED THEN DELETE"],
  ["writable CTE (insert)", "WITH x AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM x"],
  ["writable CTE (update)", "WITH x AS (UPDATE t SET a=1 RETURNING id) SELECT * FROM x"],
  ["writable CTE (delete)", "WITH x AS (DELETE FROM t RETURNING id) SELECT * FROM x"],
  ["stacked statements", "SELECT 1; DROP TABLE t"],
  ["stacked selects", "SELECT 1; SELECT 2"],
  ["DO block", "DO $$ BEGIN PERFORM 1; END $$"],
  ["COPY FROM PROGRAM", "COPY t FROM PROGRAM 'curl evil'"],
  ["COPY TO", "COPY t TO '/tmp/x.csv'"],
  ["TRUNCATE", "TRUNCATE t"],
  ["DROP", "DROP TABLE t"],
  ["CREATE", "CREATE TABLE t (id int)"],
  ["CREATE TABLE AS", "CREATE TABLE t2 AS SELECT * FROM t"],
  ["ALTER", "ALTER TABLE t ADD COLUMN c int"],
  ["GRANT", "GRANT ALL ON t TO public"],
  ["SET", "SET work_mem = '1GB'"],
  ["SHOW", "SHOW all"],
  ["BEGIN", "BEGIN"],
  ["COMMIT", "COMMIT"],
  ["LOCK", "LOCK TABLE t"],
  ["SELECT INTO", "SELECT * INTO newtab FROM t"],
  ["SELECT FOR UPDATE", "SELECT * FROM t FOR UPDATE"],
  ["SELECT FOR SHARE", "SELECT * FROM t FOR SHARE"],
  ["pg_read_file", "SELECT pg_read_file('/etc/passwd')"],
  ["pg_ls_dir", "SELECT pg_ls_dir('/')"],
  ["lo_import", "SELECT lo_import('/etc/passwd')"],
  ["lo_export", "SELECT lo_export(1, '/tmp/x')"],
  ["dblink", "SELECT * FROM dblink('host=evil', 'SELECT 1') AS t(x int)"],
  ["pg_sleep (DoS)", "SELECT pg_sleep(9999)"],
  ["set_config", "SELECT set_config('work_mem','1GB',false)"],
  ["pg_terminate_backend", "SELECT pg_terminate_backend(1)"],
  ["nested pg_read_file in CTE", "WITH a AS (SELECT pg_read_file('/x') AS r) SELECT * FROM a"],
  ["empty", "   "],
];

describe("SELECT-only gate (parser-based, fail-closed)", () => {
  for (const [name, sql] of ALLOWED) {
    it(`allows: ${name}`, async () => {
      await expect(assertSelectOnly(sql)).resolves.toBeUndefined();
    });
  }
  for (const [name, sql] of REJECTED) {
    it(`rejects: ${name}`, async () => {
      await expect(assertSelectOnly(sql)).rejects.toBeInstanceOf(UnsafeSqlError);
    });
  }
});

describe("type-aware watermark comparator (D4)", () => {
  it("compares integer strings numerically, not lexicographically", () => {
    expect(compareWatermark("10", "9")).toBeGreaterThan(0); // bug was: "10" < "9"
    expect(compareWatermark("9", "10")).toBeLessThan(0);
    expect(compareWatermark("100", "99")).toBeGreaterThan(0);
  });
  it("handles bigint-scale integers without precision loss", () => {
    expect(compareWatermark("9223372036854775807", "9223372036854775806")).toBeGreaterThan(0);
  });
  it("compares decimals numerically", () => {
    expect(compareWatermark("9.5", "10.2")).toBeLessThan(0);
  });
  it("compares Dates chronologically", () => {
    expect(compareWatermark(new Date("2026-01-02"), new Date("2026-01-01"))).toBeGreaterThan(0);
  });
  it("compares ISO timestamp strings chronologically", () => {
    expect(compareWatermark("2026-01-02T00:00:00Z", "2026-01-01T23:59:59Z")).toBeGreaterThan(0);
  });
  it("compares text lexicographically", () => {
    expect(compareWatermark("banana", "apple")).toBeGreaterThan(0);
  });
  it("treats null as the smallest", () => {
    expect(compareWatermark(5, null)).toBeGreaterThan(0);
    expect(compareWatermark(null, null)).toBe(0);
  });
});
