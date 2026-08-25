// ---------------------------------------------------------------------------
// tests/integration/code-repos/_helpers/pg.ts
//
// Schema-isolated Postgres helper for Code Repositories integration tests.
//
// Why isolated schemas? The default tellus_db has dozens of pre-existing
// tables (ontology, funnel, audit, …). Creating B1 tables in `public` would
// either collide with future stemma_* tables in the real schema or pollute
// test runs with leftover state. Each test file gets a fresh schema; on
// teardown the schema is dropped CASCADE so nothing leaks.
//
// Usage:
//   const ctx = await openTestSchema("stemma_ddl_roundtrip");
//   await ctx.exec("...");
//   await ctx.close();
// ---------------------------------------------------------------------------

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

export interface SchemaContext {
  /** The Postgres pool — direct access for advanced cases. */
  readonly pool: Pool;
  /** Name of the isolated schema, e.g. `stemma_test_ab12cd34`. */
  readonly schema: string;
  /** Quick exec (no parameter binding). */
  exec(sql: string): Promise<QueryResult>;
  /** Parameterised query. */
  query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
  /** Run a transaction with a fresh client; rolls back on throw. */
  withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** Read a migration file from disk and execute its SQL inside this schema. */
  applyMigration(relPath: string): Promise<void>;
  /**
   * Execute pre-loaded migration SQL inside this schema with the
   * same hermetic guarantee as `applyMigration` (search_path =
   * `<schema>` only, public excluded, no fallthrough).  Use this
   * for tests that hold SQL strings as module-level constants
   * (e.g. `const UP = readFileSync(...)`).  NEVER call
   * `ctx.query(sql)` for migration SQL — public-on-path lets DROP
   * IF EXISTS walk into live `public.<table>`.  Bug 2026-05-04.
   */
  applyMigrationSql(sql: string): Promise<void>;
  /** Drop the schema CASCADE and end the pool. Idempotent. */
  close(): Promise<void>;
}

export async function openTestSchema(label: string): Promise<SchemaContext> {
  const suffix = randomBytes(4).toString("hex");
  const schema = `crc_${sanitize(label)}_${suffix}`;

  const pool = new Pool({
    host: process.env.PGHOST ?? "localhost",
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? "tellus_db",
    user: process.env.PGUSER ?? "tellus",
    password: process.env.PGPASSWORD ?? "tellus123",
    max: 4,
    // Tolerate a saturated dev box (parallel dev servers +
    // back-to-back suite runs churn connections): connect
    // waits up to 15s before failing loudly. Assertions are
    // unaffected — this only absorbs infra-level latency.
    connectionTimeoutMillis: 15_000,
  });

  // Pin every connection acquired from this pool to the per-test schema so
  // unqualified `CREATE TABLE foo` lands inside `<schema>.foo`. This must
  // happen on every NEW connection, hence `pool.on("connect", ...)`.
  //
  // search_path = "<schema>, public":
  //   * "<schema>" first so unqualified DDL/DML targets the test schema.
  //   * "public" second so extension functions (pgcrypto's `digest()`,
  //     `gen_random_uuid()`, etc.) resolve.  pgcrypto installs into
  //     `public` by default; migration 036 + 051 use `digest()` and
  //     break with schema-only paths.
  //
  // BUT this means an unqualified `DROP TABLE IF EXISTS foo CASCADE`
  // can fall through to `public.foo` if the test schema doesn't have
  // it — exactly the bug that nuked `public.code_repos_idempotency`
  // on 2026-05-04 when migration 051 was run through `ctx.query(sql)`.
  // The mitigation is in two places:
  //
  //   1. `applyMigration` below uses `SET search_path TO "<schema>"`
  //      (no public) for the duration of the migration.  All DDL
  //      including DROP IF EXISTS resolves only within the test
  //      schema.  This is the contract every test SHOULD use to apply
  //      a migration file.
  //
  //   2. Tests that historically bypassed (1) with raw
  //      `ctx.query(loadSql(...))` have been migrated to
  //      `ctx.applyMigration(...)`.  Any new test that reads a
  //      `src/migrations/*.sql` file MUST go through `applyMigration`.
  //      A grep guard (`tests/integration/code-repos/_helpers/
  //      lint-migration-bypass.test.ts`) enforces this.
  pool.on("connect", (client) => {
    client.query(`SET search_path TO "${schema}", public`).catch(() => {
      // Best-effort: if the schema doesn't exist yet (race during bootstrap),
      // the next call will surface the error to the test.
    });
  });

  // Bootstrap the schema on the first connection.
  const bootstrap = await pool.connect();
  try {
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    await bootstrap.query(`SET search_path TO "${schema}", public`);
  } finally {
    bootstrap.release();
  }

  let closed = false;

  const ctx: SchemaContext = {
    pool,
    schema,
    async exec(sql) {
      return pool.query(sql);
    },
    async query(sql, params = []) {
      return pool.query(sql, params);
    },
    async withTx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(client);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* swallow — we're surfacing the original */
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async applyMigration(relPath) {
      const abs = path.join(REPO_ROOT, relPath);
      const sql = readFileSync(abs, "utf8");
      await this.applyMigrationSql(sql);
    },
    async applyMigrationSql(sql) {
      // Migrations include their own BEGIN/COMMIT; we need search_path set on
      // a single client so the BEGIN/COMMIT see this schema. Use one client
      // for the whole file.
      //
      // CRITICAL hermetic contract (post-mortem 2026-05-04):
      //
      // search_path = `"<schema>", public`.  We keep `public` on the
      // path because pgcrypto extension functions (`digest()`,
      // `gen_random_uuid()`) live in `public.*` and are referenced
      // unqualified by migrations 036, 051.  Functions ARE subject
      // to search_path — schema-only path produces
      // `function digest(unknown, unknown) does not exist`.
      //
      // BUT keeping `public` on the path means an unqualified
      // `DROP TABLE IF EXISTS code_repos_idempotency CASCADE`
      // (051_code_repos_audit.sql:216) walks the path: not in
      // `<schema>` → falls through to `public.code_repos_idempotency`
      // → drops the live production table.  This nuked production
      // data twice on 2026-05-04 before the rewrite below was added.
      //
      // Mitigation: rewrite unqualified DROP statements to be
      // schema-qualified.  The rewrite is safe because:
      //
      //   * Migration files are owned by us, not external input.
      //   * The regex only matches *unqualified* identifiers (negative
      //     lookahead bails on `schema.table` and `"schema".table`).
      //   * Object types covered: TABLE, INDEX, VIEW, SEQUENCE, TYPE,
      //     FUNCTION (all the DDL-DROPs that have appeared in any
      //     code-repos migration to date).
      //   * Trigger DROPs are not rewritten because they take
      //     `<trigger> ON <table>` syntax; the table reference there
      //     is the safety boundary.
      //
      // If a future migration adds a new DROP-able object type,
      // extend `SCHEMA_QUALIFIED_DROP_KINDS` below.
      const qualifiedSql = qualifyUnqualifiedDrops(sql, schema);
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${schema}", public`);
        await client.query(qualifiedSql);
      } finally {
        client.release();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    },
  };

  return ctx;
}

function sanitize(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Hermetic SQL rewriter — see CRITICAL comment in `applyMigrationSql`.
//
// Rewrites unqualified DDL DROPs in migration SQL to be schema-qualified so
// they cannot fall through search_path to `public`.  Conservative: matches
// only unquoted, unqualified identifiers; bails on anything already
// schema.x or "schema".x.
//
// Exported for unit testing.
// ---------------------------------------------------------------------------
const SCHEMA_QUALIFIED_DROP_KINDS = ["TABLE", "INDEX", "VIEW", "SEQUENCE", "TYPE", "FUNCTION"] as const;

export function qualifyUnqualifiedDrops(sql: string, schema: string): string {
  // Build one alternation matching every drop kind we care about.
  const kinds = SCHEMA_QUALIFIED_DROP_KINDS.join("|");
  //
  // Match: DROP <kind> [IF EXISTS] <name>
  //
  // Critical constraints (each one fixes a real failure in the unit suite):
  //
  //   1. The negative lookahead `(?!IF\s+EXISTS\b)` AFTER the optional
  //      `IF EXISTS` group prevents the regex from backtracking past
  //      `IF EXISTS` and matching `IF` as the identifier when a *later*
  //      lookahead fails (e.g. on `DROP TABLE IF EXISTS "other".foo`,
  //      the IF EXISTS group consumes correctly, then `(?!")` fails on
  //      the leading quote, the engine tries to backtrack out of
  //      IF EXISTS, and lands on `IF` as the identifier).
  //
  //   2. The negative lookahead `(?!")` rejects already-qualified
  //      `"schema".x` form.
  //
  //   3. The negative lookahead `(?![a-z_][a-z0-9_]*\s*\.)` rejects
  //      already-qualified `schema.x` (unquoted) form.
  //
  //   4. The trailing `(?!\s*\.)` after `<name>` rejects `name.something`
  //      (e.g. avoids matching the schema part of `schema.table`).
  //
  // Migrations are owned by us; identifiers are guaranteed lowercase
  // (`[a-z_][a-z0-9_]*`).  Quoted identifiers in DROPs are not used in
  // any current code-repos migration.
  const re = new RegExp(
    String.raw`\bDROP\s+(${kinds})\s+(?:(IF\s+EXISTS)\s+)?(?!IF\s+EXISTS\b)(?!")(?![a-z_][a-z0-9_]*\s*\.)([a-z_][a-z0-9_]*)\b(?!\s*\.)`,
    "gi",
  );
  return sql.replace(re, (_match, kind, ifExistsCapture, name) => {
    const ifExists = ifExistsCapture ? " IF EXISTS" : "";
    const upperKind = String(kind).toUpperCase();
    return `DROP ${upperKind}${ifExists} "${schema}".${name}`;
  });
}
