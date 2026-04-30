// ---------------------------------------------------------------------------
// Shared DuckDB pool — PB-B2 acceptance (f) + (g).
//
// One in-memory DuckDB Database per pod. Every caller (Funnel merge stage,
// Pipeline Builder transform engine, any future compute substrate) takes a
// connection off this single Database instead of opening its own — this
// is what satisfies PB-B2 (g) "single DuckDB process per pod" and keeps
// the extension loads (httpfs, iceberg) cached rather than re-installing
// on every read.
//
// The bootstrap runs exactly once per connection (LOAD is per-session on
// the DuckDB side, even though INSTALL is process-wide). We apply the
// PB-B2 (f) resource caps there — `memory_limit=12GB`,
// `temp_directory=/tmp/duckdb_spill` — so a runaway chain spills to disk
// instead of OOMing the API pod.
//
// Designed as a drop-in for the pattern in services/funnel/duckdbIceberg.ts
// (`openInMemory()` + `ensureIcebergExtension`): that file is refactored
// in a separate commit to route through this pool so there is literally
// one `Database` handle across the process.
// ---------------------------------------------------------------------------

// Lazy-loaded native binding, same pattern as duckdbIceberg.ts. If the
// native module is missing (Alpine ARM64 without prebuilds, CI minimal
// sandbox, etc.) the caller is expected to feature-detect via
// `isDuckDBAvailable()` and fall back to the legacy Node.js engine.
type DuckDBDatabaseCtor = new (p: string) => DuckDBDatabase;
interface DuckDBDatabase {
  connect(): DuckDBConnection;
  close(cb?: (err: Error | null) => void): void;
}
export interface DuckDBConnection {
  run(sql: string, cb: (err: Error | null) => void): void;
  all<T>(sql: string, cb: (err: Error | null, rows: T[]) => void): void;
}

let DatabaseCtor: DuckDBDatabaseCtor | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  DatabaseCtor = require("duckdb").Database as DuckDBDatabaseCtor;
} catch {
  /* native binary unavailable — caller falls back to legacy engine */
}

export function isDuckDBAvailable(): boolean {
  return DatabaseCtor !== null;
}

// Single Database per pod. We deliberately do NOT destroy it on
// `releaseConnection`; it lives until process exit. That mirrors DuckDB's
// best practice for long-running servers (opening a DuckDB Database has
// non-trivial cost; connections are cheap).
let sharedDb: DuckDBDatabase | null = null;

function ensureDb(): DuckDBDatabase {
  if (!DatabaseCtor) {
    throw new Error(
      "duckdb native module is not available. Install `duckdb` (or switch pipeline compute_type to legacy_nodejs) before using the DuckDB path.",
    );
  }
  if (sharedDb) return sharedDb;
  sharedDb = new DatabaseCtor(":memory:");
  return sharedDb;
}

export function runAll(conn: DuckDBConnection, sql: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    conn.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

export function queryAll<T>(conn: DuckDBConnection, sql: string): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    conn.all<T>(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

export interface PoolOptions {
  /** Override memory_limit (default 12GB per PB-B2 (f)). */
  memoryLimit?: string;
  /** Override PRAGMA temp_directory for spills. */
  tempDirectory?: string;
  /** Skip httpfs load (unit tests that only touch local files). */
  skipHttpfs?: boolean;
}

/**
 * Acquire a connection with the PB-B2 bootstrap already applied. The
 * connection is cheap; callers should take one per logical unit of work
 * (one preview, one deploy) and release it when done so the underlying
 * thread pool recycles cleanly.
 */
export async function acquireConnection(
  options: PoolOptions = {},
): Promise<DuckDBConnection> {
  const db = ensureDb();
  const conn = db.connect();
  await applyBootstrap(conn, options);
  // PB-B9 — sample DuckDB process memory so the SRE dashboard's
  // duckdb_memory_bytes gauge has real data. RSS proxy: process.memoryUsage().
  // Labelled by "pool" since the gauge's node_id isn't bound to a
  // Pipeline node at this layer — the deploy-side metric emitter can
  // later override with a per-node label when it has one.
  try {
    const { recordDuckdbMemory } = await import(
      "../pipelines/metrics"
    );
    recordDuckdbMemory("pool", process.memoryUsage().rss);
  } catch {
    /* metrics must never block acquire */
  }
  return conn;
}

/**
 * Release a connection. Today DuckDB has no explicit connection close
 * handle on this binding — sweeping references is enough — but wrapping
 * the release in one call keeps the code symmetric with other pools and
 * gives us a hook if we swap bindings (e.g. @duckdb/node-api, follow-up
 * PB-B2.follow-6).
 */
export function releaseConnection(_conn: DuckDBConnection): void {
  // no-op: the binding's connection is a lightweight JS object; GC reclaims.
}

/**
 * For tests that need a pristine DB (e.g. to verify extension load order).
 * Do NOT call this in production — it destroys state shared with every
 * other consumer of the pool.
 */
export async function __resetPoolForTests(): Promise<void> {
  if (sharedDb) {
    try {
      await new Promise<void>((resolve) => sharedDb!.close(() => resolve()));
    } catch {
      /* ignore */
    }
    sharedDb = null;
  }
  bootstrapApplied = new WeakSet();
}

let bootstrapApplied = new WeakSet<DuckDBConnection>();

async function applyBootstrap(
  conn: DuckDBConnection,
  options: PoolOptions,
): Promise<void> {
  if (bootstrapApplied.has(conn)) return;
  bootstrapApplied.add(conn);

  const memoryLimit = options.memoryLimit ?? process.env.DUCKDB_MEMORY_LIMIT ?? "12GB";
  const tempDir = options.tempDirectory ?? process.env.DUCKDB_TEMP_DIR ?? "/tmp/duckdb_spill";

  // (f) bounded spill: DuckDB will spill hashtables, sort runs, and
  // aggregate state to this directory when the in-memory limit is
  // reached. Without the pragma, a big JOIN on a small pod OOMs.
  await runAll(conn, `SET memory_limit='${memoryLimit}'`);
  await runAll(conn, `PRAGMA temp_directory='${tempDir}'`);
  // Default thread count — tuned so a 4-vCPU pod doesn't oversubscribe.
  const threads = Number(process.env.DUCKDB_THREADS ?? "0");
  if (threads > 0) {
    await runAll(conn, `SET threads=${threads}`);
  }

  if (!options.skipHttpfs) {
    await installAndLoad(conn, "httpfs");
    await applyS3Credentials(conn);
  }
}

/**
 * INSTALL is idempotent across the process; LOAD must run per connection.
 * We swallow INSTALL errors because a second call after the first success
 * is still reported as an error on older DuckDB builds.
 */
export async function installAndLoad(
  conn: DuckDBConnection,
  extension: string,
): Promise<void> {
  try {
    await runAll(conn, `INSTALL ${extension}`);
  } catch {
    /* already installed, or offline mirror — LOAD still works */
  }
  await runAll(conn, `LOAD ${extension}`);
}

// F-P4-24: `minioadmin` fallbacks removed. DuckDB S3 credentials now
// fail loudly via requireSecret; a misconfigured pod cannot silently
// connect to prod S3 with the well-known MinIO root credential.
// Also: quote-escape credentials before interpolating into DuckDB SQL
// so a secret containing `'` does not produce malformed SQL.
async function applyS3Credentials(conn: DuckDBConnection): Promise<void> {
  const { envWithDefault, requireSecret } = await import("../../utils/requireEnv");
  const endpoint = (
    envWithDefault("ICEBERG_S3_ENDPOINT", "") ||
    envWithDefault("S3_ENDPOINT", "")
  ).replace(/^https?:\/\//, "");
  const region = envWithDefault("S3_REGION", "us-east-1");
  const akid = requireSecret("S3_ACCESS_KEY_ID", "DuckDB S3 access key required.");
  const sak = requireSecret("S3_SECRET_ACCESS_KEY", "DuckDB S3 secret key required.");
  const pathStyle =
    envWithDefault("S3_FORCE_PATH_STYLE", "true") === "true" ? "path" : "vhost";
  const sqlQuote = (v: string) => v.replace(/'/g, "''");
  await runAll(conn, `SET s3_region='${sqlQuote(region)}'`);
  if (endpoint) await runAll(conn, `SET s3_endpoint='${sqlQuote(endpoint)}'`);
  await runAll(conn, `SET s3_access_key_id='${sqlQuote(akid)}'`);
  await runAll(conn, `SET s3_secret_access_key='${sqlQuote(sak)}'`);
  await runAll(conn, `SET s3_url_style='${sqlQuote(pathStyle)}'`);
  await runAll(conn, "SET s3_use_ssl=false");
}
