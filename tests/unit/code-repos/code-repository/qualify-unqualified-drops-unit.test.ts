// ---------------------------------------------------------------------------
// tests/unit/code-repos/code-repository/qualify-unqualified-drops-unit.test.ts
//
// Regression test for the SQL rewriter that prevents `applyMigrationSql`
// from dropping `public.<table>` when running migrations against a test
// schema.  Bug post-mortem: 2026-05-04 (production `code_repos_idempotency`
// dropped twice by integration tests).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { qualifyUnqualifiedDrops } from "../../../integration/code-repos/_helpers/pg";

describe("qualifyUnqualifiedDrops — hermetic migration SQL rewriter", () => {
  const SCHEMA = "crc_test_abcd1234";

  it("rewrites unqualified DROP TABLE IF EXISTS", () => {
    const sql = "DROP TABLE IF EXISTS code_repos_idempotency CASCADE;";
    const out = qualifyUnqualifiedDrops(sql, SCHEMA);
    expect(out).toBe(`DROP TABLE IF EXISTS "${SCHEMA}".code_repos_idempotency CASCADE;`);
  });

  it("rewrites unqualified DROP TABLE without IF EXISTS", () => {
    const sql = "DROP TABLE foo;";
    const out = qualifyUnqualifiedDrops(sql, SCHEMA);
    expect(out).toBe(`DROP TABLE "${SCHEMA}".foo;`);
  });

  it("rewrites multiple DROPs", () => {
    const sql = [
      "DROP TABLE IF EXISTS code_repos_idempotency CASCADE;",
      "DROP TABLE IF EXISTS code_repos_audit_hash_head CASCADE;",
      "DROP TABLE IF EXISTS code_repos_audit_events CASCADE;",
    ].join("\n");
    const out = qualifyUnqualifiedDrops(sql, SCHEMA);
    expect(out).toContain(`"${SCHEMA}".code_repos_idempotency`);
    expect(out).toContain(`"${SCHEMA}".code_repos_audit_hash_head`);
    expect(out).toContain(`"${SCHEMA}".code_repos_audit_events`);
    expect(out).not.toMatch(/DROP TABLE IF EXISTS code_repos/);
  });

  it("does NOT rewrite already-qualified DROPs", () => {
    const sql = `DROP TABLE IF EXISTS "other_schema".foo;`;
    const out = qualifyUnqualifiedDrops(sql, SCHEMA);
    expect(out).toBe(sql);
  });

  it("does NOT rewrite schema.table (unquoted) DROPs", () => {
    const sql = "DROP TABLE IF EXISTS public.foo CASCADE;";
    const out = qualifyUnqualifiedDrops(sql, SCHEMA);
    expect(out).toBe(sql);
  });

  it("rewrites DROP INDEX", () => {
    const sql = "DROP INDEX IF EXISTS my_idx;";
    const out = qualifyUnqualifiedDrops(sql, SCHEMA);
    expect(out).toBe(`DROP INDEX IF EXISTS "${SCHEMA}".my_idx;`);
  });

  it("rewrites DROP VIEW, DROP SEQUENCE, DROP TYPE, DROP FUNCTION", () => {
    expect(qualifyUnqualifiedDrops("DROP VIEW v;", SCHEMA))
      .toBe(`DROP VIEW "${SCHEMA}".v;`);
    expect(qualifyUnqualifiedDrops("DROP SEQUENCE s;", SCHEMA))
      .toBe(`DROP SEQUENCE "${SCHEMA}".s;`);
    expect(qualifyUnqualifiedDrops("DROP TYPE t;", SCHEMA))
      .toBe(`DROP TYPE "${SCHEMA}".t;`);
    expect(qualifyUnqualifiedDrops("DROP FUNCTION f;", SCHEMA))
      .toBe(`DROP FUNCTION "${SCHEMA}".f;`);
  });

  it("does NOT touch DROP TRIGGER (table is the safety boundary)", () => {
    const sql = "DROP TRIGGER my_trg ON code_repos_idempotency;";
    const out = qualifyUnqualifiedDrops(sql, SCHEMA);
    // Trigger is not in the rewrite list; left intact.  The `ON <table>`
    // clause's table reference is the safety surface — if that table is
    // schema-qualified or doesn't exist in public, the trigger drop is safe.
    expect(out).toBe(sql);
  });

  it("preserves CASCADE and other trailing tokens", () => {
    const sql = "DROP TABLE IF EXISTS foo CASCADE;";
    const out = qualifyUnqualifiedDrops(sql, SCHEMA);
    expect(out).toBe(`DROP TABLE IF EXISTS "${SCHEMA}".foo CASCADE;`);
  });

  it("handles mixed-case DROP/IF EXISTS keywords", () => {
    const sql = "drop table if exists foo;";
    const out = qualifyUnqualifiedDrops(sql, SCHEMA);
    expect(out).toBe(`DROP TABLE IF EXISTS "${SCHEMA}".foo;`);
  });

  it("does NOT break CREATE TABLE statements", () => {
    const sql = `
      CREATE TABLE foo (id int);
      DROP TABLE IF EXISTS bar;
      CREATE TABLE baz (id int);
    `;
    const out = qualifyUnqualifiedDrops(sql, SCHEMA);
    expect(out).toContain("CREATE TABLE foo");
    expect(out).toContain("CREATE TABLE baz");
    expect(out).toContain(`DROP TABLE IF EXISTS "${SCHEMA}".bar`);
  });

  it("regression: real migration 051 leading DROP block", () => {
    const sql = `BEGIN;
DROP TABLE IF EXISTS code_repos_idempotency CASCADE;
DROP TABLE IF EXISTS code_repos_audit_hash_head CASCADE;
DROP TABLE IF EXISTS code_repos_audit_events CASCADE;
CREATE TABLE code_repos_audit_events (audit_id UUID);
COMMIT;`;
    const out = qualifyUnqualifiedDrops(sql, SCHEMA);
    expect(out).toContain(`DROP TABLE IF EXISTS "${SCHEMA}".code_repos_idempotency`);
    expect(out).toContain(`DROP TABLE IF EXISTS "${SCHEMA}".code_repos_audit_hash_head`);
    expect(out).toContain(`DROP TABLE IF EXISTS "${SCHEMA}".code_repos_audit_events`);
    // CREATE is untouched.
    expect(out).toContain("CREATE TABLE code_repos_audit_events");
    // No bare unqualified DROP remains.
    expect(out).not.toMatch(/DROP TABLE IF EXISTS code_repos_/);
  });
});
