/**
 * Furnace — Ontology SQL engine backed by DuckDB.
 *
 * T-03 hardening (closes B-2 / B-6 / H-13 / H-8):
 *
 *   1. **Cache key includes a security fingerprint and a branchId**, so
 *      two callers with different markings/CBAC tags or different branch
 *      contexts cannot share the same in-memory snapshot.
 *   2. **In-flight-promise mutex** collapses N concurrent buildDb()
 *      attempts on the same key into one PG/OS load (closes the
 *      thundering-herd on cache miss).
 *   3. **`buildDb` reads from OpenSearch via `applyContextToBody`**,
 *      not from Postgres. The 5000-row sample is preserved as an
 *      explicit, documented limitation (operator-overridable via
 *      `FURNACE_SAMPLE_LIMIT`).
 *   4. **Sandbox lockdown** — `configureSandbox` SETs
 *      `enable_external_access = false`, disables external extensions,
 *      caps memory and threads. `INSTALL 'json'; LOAD 'json';` is
 *      removed; `read_csv_auto`, `read_json` are unavailable.
 *   5. **Statement timeout** wraps `db.all(...)` in a Promise.race
 *      against a `SQL_STATEMENT_TIMEOUT_MS` clock; `db.interrupt()` is
 *      called when the clock fires.
 *   6. **`pragma`** is no longer in `ALLOWED_LEADING_KEYWORDS`. A new
 *      `SQL_DISALLOWED_KEYWORD` error is raised for `pragma`, `set`,
 *      `reset`, etc., distinct from the existing `SQL_WRITE_REJECTED`
 *      shape on writes.
 *
 * The endpoint surface is `/api/v1/sql` (see `routes/sql.ts`).
 */

import crypto from 'node:crypto';
import { client as osClient } from './opensearch/client';
import { applyContextToBody } from './opensearch/applyContext';
import { buildSecurityFilter } from '../middleware/securityContext';
import type { SecurityContext } from '../middleware/securityContext';
import { incCounter, observeHistogram } from './funnel/metrics';
import pool from '../db';
import {
  SQL_STATEMENT_TIMEOUT_MS,
  SQL_CACHE_TTL_MS,
  SQL_ROW_LIMIT,
  SQL_MAX_QUERY_LENGTH,
  ALLOWED_LEADING_KEYWORDS,
  FORBIDDEN_LEADING_KEYWORDS,
  resolveSampleLimit,
} from './furnaceSqlConstants';

// Lazy-load DuckDB so the server can start even when the native binary
// is missing (e.g. CI environments without prebuilt binaries). The SQL
// endpoint will return an error at call time instead of crashing on boot.
type DuckDatabase = import('duckdb').Database;
let DuckDatabaseCtor: typeof import('duckdb').Database | null = null;
try {
  DuckDatabaseCtor = require('duckdb').Database;
} catch {
  console.warn(
    'duckdb native module not available — /api/v1/sql endpoint will be disabled',
  );
}

interface CachedDb {
  db: DuckDatabase;
  loadedAt: number;
}

/**
 * Cache key shape: `${ontologyId}:${branchId ?? "_main"}:${securityFingerprint}`.
 *
 * The fingerprint is a 16-char SHA-256 prefix over the JSON-serialised
 * security filter clause. Two callers whose `buildSecurityFilter(ctx)`
 * outputs are byte-identical share a snapshot; everyone else gets a
 * fresh DB. This is the strictest plausible defence against the cache
 * being a side-channel for marking/CBAC information.
 */
type CacheKey = string;

const CACHE: Map<CacheKey, CachedDb> = new Map();

/**
 * In-flight promise collapse. When N concurrent requests miss the cache
 * for the same key, only the first triggers a buildDb(); the rest await
 * the same Promise. The metric `tellus_sql_cache_hits_total{result}`
 * counts hit/miss/inflight_join.
 */
const PENDING: Map<CacheKey, Promise<DuckDatabase>> = new Map();

function securityFingerprint(ctx: SecurityContext | null | undefined): string {
  // Distinguish "no context" (e.g. system caller) from any user context
  // by passing the null clause through deterministic JSON.
  const filter = ctx ? buildSecurityFilter(ctx) : null;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(filter ?? null))
    .digest('hex')
    .slice(0, 16);
}

function makeCacheKey(
  ontologyId: string,
  branchId: string | null,
  ctx: SecurityContext | null | undefined,
): CacheKey {
  return `${ontologyId}:${branchId ?? '_main'}:${securityFingerprint(ctx)}`;
}

/**
 * DuckDB sandbox lockdown. Every block here corresponds to a documented
 * egress / write / extension-load surface. Removing any one of them
 * widens the surface; therefore each MUST have a matching test.
 */
function configureSandbox(db: DuckDatabase): Promise<void> {
  // The settings are split across multiple statements so a parser
  // change in one DuckDB version doesn't silently skip later ones.
  const stmts = [
    "SET enable_external_access = false",
    "SET disabled_filesystems = 'LocalFileSystem,HTTPFileSystem,S3FileSystem'",
    "SET allow_unsigned_extensions = false",
    "SET enable_http_metadata_cache = false",
    "SET threads = 2",
    "SET memory_limit = '512MB'",
  ];
  return (async (): Promise<void> => {
    for (const s of stmts) {
      // best-effort: some flags are version-gated. Failure to set a flag
      // is recorded as a metric so operators can detect drift.
      try {
        await runDuck(db, s);
      } catch (err) {
        incCounter('tellus_sql_sandbox_set_failed_total', {
          flag: s.split(' ')[1] ?? 'unknown',
        });
        // Re-throw the *first* failure on `enable_external_access`. We
        // refuse to operate without that one specifically.
        if (s.includes('enable_external_access')) {
          throw err;
        }
      }
    }
  })();
}

function runDuck(db: DuckDatabase, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

/**
 * Wrap `db.all(sql)` in a `SQL_STATEMENT_TIMEOUT_MS` deadline. On
 * timeout the timer fires `db.interrupt()` (best-effort) and we throw a
 * canonical `SQL_STATEMENT_TIMEOUT` error.
 */
async function runUserSql(
  db: DuckDatabase,
  sql: string,
): Promise<unknown[]> {
  return new Promise<unknown[]>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        const interrupt = (db as unknown as { interrupt?: () => void }).interrupt;
        if (typeof interrupt === 'function') {
          interrupt.call(db);
        }
      } catch {
        // best-effort
      }
      reject(
        Object.assign(
          new Error(
            `SQL exceeded ${SQL_STATEMENT_TIMEOUT_MS}ms statement budget.`,
          ),
          { code: 'SQL_STATEMENT_TIMEOUT' },
        ),
      );
    }, SQL_STATEMENT_TIMEOUT_MS);
    timer.unref?.();
    db.all(sql, (err: Error | null, rows: unknown[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(
          Object.assign(new Error(err.message), {
            code: 'SQL_EXECUTION_ERROR',
          }),
        );
      } else {
        resolve(rows ?? []);
      }
    });
  });
}

/**
 * Enumerate object types within an ontology. PG is the source of truth
 * for the API-name list; OS is the source of truth for the row data.
 * Tests that don't have PG can mock this via `__internals.listObjectTypes`.
 */
async function listObjectTypes(
  ontologyId: string,
): Promise<Array<{ apiName: string; primaryKeyApiName: string }>> {
  const result = await pool
    .query(
      `SELECT api_name, primary_key_api_name
         FROM object_type
        WHERE ontology_id = $1`,
      [ontologyId],
    )
    .catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  return result.rows.map((r) => ({
    apiName: String(r.api_name ?? ''),
    primaryKeyApiName: String(r.primary_key_api_name ?? 'pk'),
  }));
}

function indexFor(apiName: string): string {
  return `ontology-${String(apiName).toLowerCase()}`;
}

function safeIdent(apiName: string): string {
  // DuckDB identifiers are quoted with double-quotes; we strip everything
  // that's not in [A-Za-z0-9_] to make the quoted form safe even before
  // quoting.
  return apiName.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Build a fresh DuckDB instance for a given (ontology, branch, ctx)
 * triple. Reads rows from OpenSearch through `applyContextToBody` so
 * the security filter and branch clause are enforced at the data layer.
 */
async function buildDb(
  ontologyId: string,
  ctx: SecurityContext | null | undefined,
  branchId: string | null,
): Promise<DuckDatabase> {
  if (!DuckDatabaseCtor) {
    throw Object.assign(
      new Error(
        'DuckDB native module is not available. The SQL endpoint is disabled in this environment.',
      ),
      { code: 'DUCKDB_UNAVAILABLE' },
    );
  }
  const db = new DuckDatabaseCtor(':memory:');
  await configureSandbox(db);
  const sampleLimit = resolveSampleLimit();
  const ots = await __internals.listObjectTypes(ontologyId);
  const securityClause = ctx ? buildSecurityFilter(ctx) : null;
  for (const ot of ots) {
    if (!ot.apiName) continue;
    const ident = safeIdent(ot.apiName);
    await runDuck(db, `CREATE TABLE "${ident}" (pk VARCHAR, data JSON)`);
    let rows: Array<{ pk: string; data: unknown }> = [];
    try {
      const body = applyContextToBody(
        { size: sampleLimit, query: { match_all: {} }, _source: true },
        securityClause,
        branchId,
      );
      const searchRes = await osClient.search({
        index: indexFor(ot.apiName),
        body,
      });
      const hits = (searchRes.body as { hits?: { hits?: unknown[] } })?.hits?.hits ?? [];
      rows = hits.map((h) => {
        const hit = h as { _source?: Record<string, unknown> };
        const source = hit._source ?? {};
        const pk = String(source[ot.primaryKeyApiName] ?? '');
        return { pk, data: source };
      });
    } catch {
      // Index missing or OS unavailable — leave the table empty so
      // SELECT * still returns 0 rows rather than 500ing the request.
      rows = [];
    }
    if (rows.length === 0) continue;
    const stmt = db.prepare(`INSERT INTO "${ident}" VALUES (?, ?)`);
    for (const r of rows) {
      await new Promise<void>((resolve, reject) => {
        stmt.run(r.pk, JSON.stringify(r.data), (err: Error | null) =>
          err ? reject(err) : resolve(),
        );
      });
    }
    await new Promise<void>((resolve) => stmt.finalize(() => resolve()));
  }
  return db;
}

/**
 * Get-or-build the DuckDB for a (key) triple, with TTL eviction and
 * an in-flight promise mutex.
 */
async function getDb(
  ontologyId: string,
  ctx: SecurityContext | null | undefined,
  branchId: string | null,
): Promise<DuckDatabase> {
  const key = makeCacheKey(ontologyId, branchId, ctx);
  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.loadedAt < SQL_CACHE_TTL_MS) {
    incCounter('tellus_sql_cache_hits_total', { result: 'hit' });
    return cached.db;
  }
  const inflight = PENDING.get(key);
  if (inflight) {
    incCounter('tellus_sql_cache_hits_total', { result: 'inflight_join' });
    return inflight;
  }
  incCounter('tellus_sql_cache_hits_total', { result: 'miss' });
  const promise = (async (): Promise<DuckDatabase> => {
    try {
      const db = await __internals.buildDb(ontologyId, ctx, branchId);
      CACHE.set(key, { db, loadedAt: Date.now() });
      return db;
    } finally {
      PENDING.delete(key);
    }
  })();
  PENDING.set(key, promise);
  return promise;
}

/**
 * First-keyword tokeniser. Strips leading whitespace and SQL comments
 * (line and block) before extracting the first identifier. Used by
 * `enforceReadOnly` to reject DDL/DML and disallowed sessions.
 */
function firstKeyword(sql: string): string {
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
  const statements = sql
    .split(/;(?=(?:[^']*'[^']*')*[^']*$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (statements.length === 0) {
    throw Object.assign(new Error('Query is empty'), {
      code: 'QUERY_VALIDATION_ERROR',
    });
  }
  if (statements.length > 1) {
    throw Object.assign(
      new Error('Multi-statement queries are not allowed.'),
      { code: 'SQL_WRITE_REJECTED' },
    );
  }
  const kw = firstKeyword(statements[0]);
  if (FORBIDDEN_LEADING_KEYWORDS.has(kw)) {
    // PRAGMA / SET / RESET / etc. — distinct from a write attempt because
    // we want operators to spot session-flag exfiltration in their logs.
    if (
      kw === 'pragma' ||
      kw === 'set' ||
      kw === 'reset' ||
      kw === 'attach' ||
      kw === 'detach' ||
      kw === 'install' ||
      kw === 'load'
    ) {
      throw Object.assign(
        new Error(
          `SQL keyword '${kw.toUpperCase()}' is not permitted on this endpoint.`,
        ),
        { code: 'SQL_DISALLOWED_KEYWORD' },
      );
    }
    throw Object.assign(
      new Error(
        `SQL keyword '${kw.toUpperCase()}' is not permitted on this endpoint.`,
      ),
      { code: 'SQL_WRITE_REJECTED' },
    );
  }
  if (!ALLOWED_LEADING_KEYWORDS.has(kw)) {
    throw Object.assign(
      new Error(
        'Only read-only queries are allowed (SELECT, WITH, DESCRIBE, SHOW, EXPLAIN).',
      ),
      { code: 'SQL_DISALLOWED_KEYWORD' },
    );
  }
}

/**
 * Ensure the SQL has a LIMIT clause, and cap it at SQL_ROW_LIMIT.
 */
function injectLimit(sql: string): string {
  const withoutSemi = sql.replace(/;\s*$/, '');
  const limitRe = /\blimit\s+(\d+)/i;
  const m = withoutSemi.match(limitRe);
  if (!m) {
    return `${withoutSemi} LIMIT ${SQL_ROW_LIMIT}`;
  }
  const requested = parseInt(m[1], 10);
  if (Number.isFinite(requested) && requested > SQL_ROW_LIMIT) {
    return withoutSemi.replace(limitRe, `LIMIT ${SQL_ROW_LIMIT}`);
  }
  return withoutSemi;
}

export interface FurnaceSqlResult {
  columns: string[];
  rows: unknown[];
  rowCount: number;
  engine: string;
}

/**
 * Execute a read-only SQL query against the Ontology, with safety rails.
 * Returns at most `SQL_ROW_LIMIT` rows and rejects any DDL / write /
 * disallowed-keyword statement.
 *
 * Signature accepts an optional `ctx` and `branchId` so the cache and
 * `applyContextToBody` can scope correctly. Existing callers that pass
 * neither get the system-fingerprint cache slot, which is segregated
 * from any user fingerprint by the `null` JSON token in `securityFingerprint`.
 */
export async function executeFurnaceSql(
  ontologyId: string,
  rawSql: string,
  ctx: SecurityContext | null = null,
  branchId: string | null = null,
): Promise<FurnaceSqlResult> {
  const sql = rawSql.trim();
  if (!sql) {
    incCounter('tellus_sql_query_total', { outcome: 'rejected' });
    throw Object.assign(new Error('Query is empty'), {
      code: 'QUERY_VALIDATION_ERROR',
    });
  }
  if (sql.length > SQL_MAX_QUERY_LENGTH) {
    incCounter('tellus_sql_query_total', { outcome: 'rejected' });
    throw Object.assign(
      new Error(
        `SQL query exceeds maximum length of ${SQL_MAX_QUERY_LENGTH} characters.`,
      ),
      { code: 'QUERY_VALIDATION_ERROR' },
    );
  }
  try {
    enforceReadOnly(sql);
  } catch (err) {
    incCounter('tellus_sql_query_total', { outcome: 'rejected' });
    throw err;
  }
  const limited = injectLimit(sql);

  const start = Date.now();
  let outcome: 'ok' | 'timeout' | 'execution_error' | 'rejected' = 'ok';
  try {
    const db = await getDb(ontologyId, ctx, branchId);
    const rows = await runUserSql(db, limited);
    const columns = rows[0]
      ? Object.keys(rows[0] as Record<string, unknown>)
      : [];
    return {
      columns,
      rows: rows.slice(0, SQL_ROW_LIMIT),
      rowCount: rows.length,
      engine: 'DuckDB (Furnace)',
    };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'SQL_STATEMENT_TIMEOUT') outcome = 'timeout';
    else if (code === 'SQL_EXECUTION_ERROR') outcome = 'execution_error';
    else outcome = 'rejected';
    throw err;
  } finally {
    const durationSeconds = (Date.now() - start) / 1000;
    observeHistogram('tellus_sql_query_duration_seconds', durationSeconds, {
      outcome,
    });
    incCounter('tellus_sql_query_total', { outcome });
  }
}

/**
 * Forcibly invalidate the in-memory DuckDB so the next query rebuilds.
 * Wired to ontology mutation hooks elsewhere.
 *
 * If `ontologyId` is provided, every cache slot whose key starts with
 * `${ontologyId}:` is dropped (covers all branch+ctx combinations).
 * If omitted, the entire cache is dropped.
 */
export function invalidateFurnaceCache(ontologyId?: string): void {
  if (typeof ontologyId === 'string' && ontologyId.length > 0) {
    const prefix = `${ontologyId}:`;
    for (const key of Array.from(CACHE.keys())) {
      if (key.startsWith(prefix)) CACHE.delete(key);
    }
    return;
  }
  CACHE.clear();
}

/**
 * Test-only seam. Vitest can swap `listObjectTypes` and `buildDb` for
 * deterministic stubs without an OpenSearch / Postgres testcontainer.
 * Production code paths use these via the indirection.
 */
export const __internals = {
  listObjectTypes,
  buildDb,
};

/** Test-only: drop every cache slot AND reset the pending mutex map. */
export function __resetCacheForTesting(): void {
  CACHE.clear();
  PENDING.clear();
}
