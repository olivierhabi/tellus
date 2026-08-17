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
// PB-B2 (f) resource caps there — `memory_limit=1GB` by default,
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
  /** Stream rows lazily (DuckDB node binding). Unlike `all` — which
   *  materializes the FULL result into one JS array — `stream` returns an
   *  async-iterable drained with native backpressure, so memory stays flat
   *  regardless of result size. Used by the changelog DuckDB-dedup and the
   *  streaming parquet read-back so a 5.6M-row result never OOMs the pod
   *  the way `queryAll` would. */
  stream<T>(sql: string): AsyncIterable<T>;
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

/**
 * Lazily stream a query's rows as an async generator (flat memory). The
 * DuckDB node binding's `conn.stream(sql)` returns an async-iterable; this
 * wraps it so callers can `for await (const row of streamQuery(conn, sql))`.
 *
 * Prefer this over `queryAll` for unbounded results — e.g. reading a 5.6M-row
 * deduped-changelog temp table back out, or streaming a large parquet
 * read_parquet scan. `queryAll` would materialize all rows into one JS array
 * (the O(N) heap wall that OOMed OlivierOrder7's changelog); `streamQuery`
 * holds one row at a time, bounded by the binding's internal buffering.
 *
 * Params are inlined into `sql` by the caller (same raw-SQL convention as
 * `runAll`/`queryAll` — escape single quotes via the standard `''` doubling).
 */
export async function* streamQuery<T>(
  conn: DuckDBConnection,
  sql: string,
): AsyncGenerator<T> {
  for await (const row of conn.stream<T>(sql)) {
    yield row;
  }
}

export interface PoolOptions {
  /** Override memory_limit (safe default 1GB; large jobs must opt in). */
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
  // The Database instance was closed — its instance-level settings
  // (temp_directory / memory_limit / threads) don't carry over to the next
  // `:memory:` Database, so the next acquire must re-apply them.
  instanceSettingsApplied = false;
}

// Per-connection guard: `LOAD httpfs` + S3 creds are per-SESSION, so they
// must run on every freshly `db.connect()`-ed connection. (Each
// `acquireConnection` calls `db.connect()`, which returns a NEW connection
// object — so this WeakSet rarely short-circuits in practice; it exists for
// the theoretical same-conn re-acquire.)
let bootstrapApplied = new WeakSet<DuckDBConnection>();

// Instance-level guard. `PRAGMA temp_directory`, `SET memory_limit`, and
// `SET threads` are DATABASE-instance settings (they apply to every
// connection on the shared `:memory:` Database, not just the session that
// ran them). `temp_directory` in particular is set-ONCE-before-spill: after
// ANY query spills to the temp dir, re-running `PRAGMA temp_directory` on ANY
// connection throws
//   "Cannot switch temporary directory after the current one has been used".
//
// The OlivierOrder2 (5.6M) pipeline hit exactly this: the changelog's 5.6M
// DISTINCT-ON dedup spilled → temp dir "used" → the merge stage's next
// `acquireConnection` re-ran `PRAGMA temp_directory` (per-connection guard
// didn't help — new connection object) → throw → workflow FAILED in 2 min.
// Guarding these three with an instance-level flag (set synchronously before
// the first `await`, so Node's single-threaded loop makes the check-and-set
// atomic) makes them run exactly once per Database lifetime.
let instanceSettingsApplied = false;

async function applyBootstrap(
  conn: DuckDBConnection,
  options: PoolOptions,
): Promise<void> {
  if (bootstrapApplied.has(conn)) return;
  bootstrapApplied.add(conn);

  // (f) bounded spill — instance-level, ONCE. DuckDB spills hashtables, sort
  // runs, and aggregate state to this directory when the in-memory limit is
  // reached. Without the pragma, a big JOIN on a small pod OOMs. See the
  // `instanceSettingsApplied` comment for why this is guarded at the
  // instance level (not per-connection like httpfs).
  await applyInstanceSettings(conn, options);

  // Per-session: httpfs + S3 creds. LOAD is per-session even though INSTALL
  // is process-wide, so every new connection must re-LOAD.
  if (!options.skipHttpfs) {
    await installAndLoad(conn, "httpfs");
    await applyS3Credentials(conn);
  }
}

async function applyInstanceSettings(
  conn: DuckDBConnection,
  options: PoolOptions,
): Promise<void> {
  if (instanceSettingsApplied) return;
  // Set BEFORE the first await so a concurrent acquireConnection (queued
  // behind this one's first await in Node's single-threaded loop) sees
  // `true` and skips — no double `PRAGMA temp_directory`.
  instanceSettingsApplied = true;

  // Never default to the host's entire memory allocation. The former 12 GB
  // fallback could starve a 16 GB developer laptop and made an unconfigured
  // container rely on the OOM killer for isolation.
  const memoryLimit = options.memoryLimit ?? process.env.DUCKDB_MEMORY_LIMIT ?? "1GB";
  const tempDir = options.tempDirectory ?? process.env.DUCKDB_TEMP_DIR ?? "/tmp/duckdb_spill";
  // DuckDB resolves extension/cache state through `home_directory`. In the
  // production image we run as an unprivileged user, so make this an
  // application-owned path instead of depending on a host/user home path.
  // This must precede INSTALL/LOAD httpfs below.
  const homeDirectory = process.env.DUCKDB_HOME_DIRECTORY ?? "/app/data/duckdb";
  await runAll(conn, `SET home_directory='${homeDirectory.replace(/'/g, "''")}'`);
  await runAll(conn, `SET memory_limit='${memoryLimit}'`);
  await runAll(conn, `PRAGMA temp_directory='${tempDir}'`);
  // Default thread count — tuned so a 4-vCPU pod doesn't oversubscribe.
  const threads = Number(process.env.DUCKDB_THREADS ?? "0");
  if (threads > 0) {
    await runAll(conn, `SET threads=${threads}`);
  }
  // preserve_insertion_order=false — DuckDB's default (true) keeps result
  // ordering, which inflates memory for big aggregates/sorts. The funnel's
  // merge SQL uses EXPLICIT `ORDER BY` wherever order matters (the glob_seq
  // row_number(), the final `COPY ... ORDER BY primary_key`), so disabling
  // the implicit order-preservation is correctness-neutral + cuts the peak
  // memory that OOMed the 5.6M OlivierOrder2 merge at the 2GB limit.
  // Also recommended by DuckDB's own OOM error message.
  await runAll(conn, `SET preserve_insertion_order=false`);
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

/**
 * Pick the S3 endpoint DuckDB should talk to.
 *
 * Two endpoints exist for the same object store: `ICEBERG_S3_ENDPOINT` is the
 * docker-internal name (`http://minio:9000`) used by containers on the compose
 * network, and `S3_ENDPOINT` is the host-reachable one (`http://localhost:9000`).
 * DuckDB runs in-process inside the Node server, so when that server runs on the
 * host — `npm run dev` — the docker-internal name does not resolve and every
 * httpfs read fails with "Could not establish connection", which surfaced as a
 * 500 from /transforms/execute.
 *
 * The toggle and its default mirror icebergSidecar.ts: on outside production,
 * inheriting whatever the pod sets in production (where both names resolve to
 * the same in-cluster service anyway).
 */
export function resolveS3Endpoint(
  envWithDefault: (key: string, fallback: string) => string,
): string {
  const preferHostReachable =
    (process.env.PB_B4_LOCAL_DNS_OVERRIDE ??
      (process.env.NODE_ENV !== "production" ? "1" : "0")) === "1";
  const iceberg = envWithDefault("ICEBERG_S3_ENDPOINT", "");
  const host = envWithDefault("S3_ENDPOINT", "");
  return preferHostReachable ? host || iceberg : iceberg || host;
}

// F-P4-24: `minioadmin` fallbacks removed. DuckDB S3 credentials now
// fail loudly via requireSecret; a misconfigured pod cannot silently
// connect to prod S3 with the well-known MinIO root credential.
// Also: quote-escape credentials before interpolating into DuckDB SQL
// so a secret containing `'` does not produce malformed SQL.
async function applyS3Credentials(conn: DuckDBConnection): Promise<void> {
  const { envWithDefault, requireSecret } = await import("../../utils/requireEnv");
  const endpoint = resolveS3Endpoint(envWithDefault).replace(/^https?:\/\//, "");
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
