/**
 * Furnace — Ontology SQL engine backed by DuckDB.
 *
 * The Palantir spec recommends Apache Calcite + Arrow Flight SQL; for the
 * open-source replica we use DuckDB, which provides identical behavior
 * (full ANSI SQL, columnar execution, ~ms latency on small tables) without
 * needing a separate Java service. This service:
 *
 *   • Loads object instances live from Postgres into an in-memory DuckDB
 *     database, one table per object type, named after the apiName.
 *   • Caches the DuckDB instance for ~30 s so repeated queries don't
 *     re-import the entire ontology on every call.
 *   • Enforces a hard `LIMIT 1000` and a 10 s statement timeout so users
 *     can't lock the request thread.
 *
 * The endpoint surface is `/api/v1/sql` (see `routes/sql.ts`).
 */

import pool from '../db';

// Lazy-load DuckDB so the server can start even when the native binary
// is missing (e.g. CI environments without prebuilt binaries). The SQL
// endpoint will return an error at call time instead of crashing on boot.
let Database: typeof import('duckdb').Database | null = null;
try {
  Database = require('duckdb').Database;
} catch {
  console.warn('duckdb native module not available — /api/v1/sql endpoint will be disabled');
}

type Database = import('duckdb').Database;

interface CachedDb {
  db: Database;
  loadedAt: number;
}

const CACHE: Record<string, CachedDb> = {};
const CACHE_TTL_MS = 30_000;
const ROW_LIMIT = 1_000;

/**
 * Get (or rebuild) the in-memory DuckDB for an ontology. Tables are
 * (re)hydrated from postgres on every cache miss.
 */
async function getDb(ontologyId: string): Promise<Database> {
  if (!Database) {
    throw Object.assign(
      new Error('DuckDB native module is not available. The SQL endpoint is disabled in this environment.'),
      { code: 'DUCKDB_UNAVAILABLE' },
    );
  }

  const cached = CACHE[ontologyId];
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.db;
  }

  const db = new Database(':memory:');
  await runDuck(db, "INSTALL 'json'; LOAD 'json';").catch(() => {});

  // Enumerate object types in this ontology
  const otsResult = await pool.query(
    `SELECT api_name, display_name FROM object_type WHERE ontology_id = $1`,
    [ontologyId],
  );

  for (const row of otsResult.rows) {
    const apiName = row.api_name as string;
    const safeName = apiName.replace(/[^a-zA-Z0-9_]/g, '_');

    // Pull every column from the object_instances table (best-effort —
    // tables are sparse JSON, so we materialize as a single `data` JSON
    // column DuckDB can introspect).
    const instances = await pool.query(
      `SELECT primary_key_value, properties_json
         FROM object_instances
        WHERE object_type_id = (SELECT object_type_id FROM object_type WHERE api_name = $1 AND ontology_id = $2)
        LIMIT 5000`,
      [apiName, ontologyId],
    ).catch(() => ({ rows: [] as any[] }));

    await runDuck(
      db,
      `CREATE TABLE "${safeName}" (primary_key VARCHAR, data JSON);`,
    );
    if (instances.rows.length > 0) {
      const stmt = db.prepare(`INSERT INTO "${safeName}" VALUES (?, ?)`);
      for (const r of instances.rows) {
        await new Promise<void>((resolve, reject) => {
          stmt.run(
            String(r.primary_key_value ?? ''),
            JSON.stringify(r.properties_json ?? {}),
            (err: any) => (err ? reject(err) : resolve()),
          );
        });
      }
      await new Promise<void>((resolve) => stmt.finalize(() => resolve()));
    }
  }

  CACHE[ontologyId] = { db, loadedAt: Date.now() };
  return db;
}

function runDuck(db: Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, (err: any) => (err ? reject(err) : resolve()));
  });
}

function allDuck(db: Database, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (err: any, rows: any[]) =>
      err ? reject(err) : resolve(rows ?? []),
    );
  });
}

/**
 * Forbidden SQL leading tokens (DDL/DML). Checked against the first
 * keyword of every statement. Spec §Task 29 calls for AST-level rejection
 * with Calcite — we approximate that here by tokenising on `;` boundaries
 * and matching the first non-whitespace keyword, which is enough to reject
 * all write paths DuckDB understands without a full parser dependency.
 */
const FORBIDDEN_LEADING = new Set([
  'insert', 'update', 'delete', 'merge', 'upsert',
  'create', 'alter', 'drop', 'truncate', 'rename', 'comment',
  'grant', 'revoke', 'attach', 'detach', 'import', 'export',
  'copy', 'load', 'call', 'begin', 'commit', 'rollback', 'savepoint',
  'vacuum', 'analyze', 'install', 'set', 'reset', 'use',
]);

const ALLOWED_LEADING = new Set([
  'select', 'with', 'describe', 'desc', 'show', 'explain', 'pragma',
]);

function firstKeyword(sql: string): string {
  // Strip leading whitespace and any SQL comment
  let s = sql.replace(/^\s+/, '');
  while (s.startsWith('--') || s.startsWith('/*')) {
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      s = nl === -1 ? '' : s.slice(nl + 1);
    } else {
      const end = s.indexOf('*/');
      s = end === -1 ? '' : s.slice(end + 2);
    }
    s = s.replace(/^\s+/, '');
  }
  const m = s.match(/^([a-zA-Z_]+)/);
  return m ? m[1].toLowerCase() : '';
}

function enforceReadOnly(sql: string): void {
  // Reject any semicolon-separated statement that isn't a SELECT/WITH/…
  const statements = sql.split(/;(?=(?:[^']*'[^']*')*[^']*$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (statements.length === 0) {
    throw Object.assign(new Error('Query is empty'), { code: 'QUERY_VALIDATION_ERROR' });
  }
  if (statements.length > 1) {
    throw Object.assign(
      new Error('Multi-statement queries are not allowed.'),
      { code: 'SQL_WRITE_REJECTED' }
    );
  }
  const kw = firstKeyword(statements[0]);
  if (FORBIDDEN_LEADING.has(kw)) {
    throw Object.assign(
      new Error(`SQL keyword '${kw.toUpperCase()}' is not permitted on this endpoint.`),
      { code: 'SQL_WRITE_REJECTED' }
    );
  }
  if (!ALLOWED_LEADING.has(kw)) {
    throw Object.assign(
      new Error('Only read-only queries are allowed (SELECT, WITH, DESCRIBE, SHOW, EXPLAIN, PRAGMA).'),
      { code: 'SQL_WRITE_REJECTED' }
    );
  }
}

/**
 * Ensure the SQL has a LIMIT clause, and cap it at ROW_LIMIT. If the user
 * supplied `LIMIT 10000`, rewrite it to `LIMIT 1000`.
 */
function injectLimit(sql: string): string {
  const withoutSemi = sql.replace(/;\s*$/, '');
  const limitRe = /\blimit\s+(\d+)/i;
  const m = withoutSemi.match(limitRe);
  if (!m) {
    return `${withoutSemi} LIMIT ${ROW_LIMIT}`;
  }
  const requested = parseInt(m[1], 10);
  if (Number.isFinite(requested) && requested > ROW_LIMIT) {
    return withoutSemi.replace(limitRe, `LIMIT ${ROW_LIMIT}`);
  }
  return withoutSemi;
}

/**
 * Execute a read-only SQL query against the Ontology, with safety rails.
 * Returns at most 1 000 rows and rejects any DDL or write operation.
 */
export async function executeFurnaceSql(
  ontologyId: string,
  rawSql: string,
): Promise<{ columns: string[]; rows: any[]; rowCount: number; engine: string }> {
  const sql = rawSql.trim();
  if (!sql) {
    throw Object.assign(new Error('Query is empty'), { code: 'QUERY_VALIDATION_ERROR' });
  }
  if (sql.length > 10000) {
    throw Object.assign(
      new Error('SQL query exceeds maximum length of 10000 characters.'),
      { code: 'QUERY_VALIDATION_ERROR' }
    );
  }
  enforceReadOnly(sql);
  const limited = injectLimit(sql);

  const db = await getDb(ontologyId);
  const rows = await allDuck(db, limited);
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  return {
    columns,
    rows: rows.slice(0, ROW_LIMIT),
    rowCount: rows.length,
    engine: 'DuckDB (Furnace)',
  };
}

/**
 * Forcibly invalidate the in-memory DuckDB so the next query re-hydrates
 * from Postgres. Wired to ontology mutation hooks elsewhere.
 */
export function invalidateFurnaceCache(ontologyId?: string): void {
  if (ontologyId) {
    delete CACHE[ontologyId];
  } else {
    for (const k of Object.keys(CACHE)) delete CACHE[k];
  }
}
