import { Pool, types, QueryResult, PoolClient } from "pg";
import { withBreaker } from "./resilience/circuitBreaker";

// F-P4-11: every Pool call site is funneled through a single "pg"
// circuit breaker. Classifying transient-connection errors and the
// admin-shutdown SQLSTATEs as failures (but NOT shutdown-race errors
// from `pool.end()` during tests/boot) keeps the breaker from tripping
// during normal process teardown.
const PG_BREAKER_LABEL = "pg";
const PG_TRANSIENT_SQLSTATES = new Set(["57P01", "57P03", "53300", "08006", "08001", "08004"]);
function isPgFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const msg = err.message;
  // Shutdown-race errors during pool.end() are normal teardown — never
  // let them trip the breaker.
  if (/pool after calling end on the pool|Pool is ending|cannot use a pool/i.test(msg)) {
    return false;
  }
  const code = (err as { code?: string }).code;
  if (code && PG_TRANSIENT_SQLSTATES.has(code)) return true;
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT") return true;
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection terminated|Connection terminated/.test(msg)) {
    return true;
  }
  // Semantic / SQL errors (`23505`, `42P01`, etc.) are the caller's bug,
  // not a dependency failure — the breaker must not trip on them.
  return false;
}

// ---------------------------------------------------------------------------
// Timestamp handling: PostgreSQL returns TIMESTAMPTZ (OID 1184) as JS Date
// objects by default, which causes inconsistent serialization in JSON
// responses. Override the parser to return the raw ISO 8601 string instead.
// This ensures every timestamp in every API response is a consistent string
// like "2025-03-11T14:30:00.000Z" rather than a JS Date that might serialize
// differently depending on the server's timezone.
// ---------------------------------------------------------------------------
types.setTypeParser(1184, (val: string): string => val);

// ---------------------------------------------------------------------------
// Pool configuration
// ---------------------------------------------------------------------------
const pool = new Pool({
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT || "5432", 10),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,

  // Maximum number of clients in the pool. Configurable via PG_POOL_MAX
  // env var. Default 20 is adequate for moderate load; production
  // deployments should tune based on expected concurrency and PG
  // max_connections (pool across all replicas must not exceed it).
  max: parseInt(process.env.PG_POOL_MAX || "20", 10),

  // A connection sitting idle for 30 seconds is released back to PostgreSQL.
  idleTimeoutMillis: 30_000,

  // If a new connection cannot be established within the timeout the query
  // fails with a timeout error. Default 30s (was 5s): parallel pollers can
  // briefly queue past `max` under bursty action-batch load, and a too-short
  // connect timeout turns that into spurious pool churn.
  connectionTimeoutMillis: parseInt(
    process.env.PG_CONNECT_TIMEOUT_MS || "30000",
    10,
  ),

  // TCP keepalive so half-open sockets (server restart, NAT drop, docker
  // network churn) are detected at the TCP layer and evicted from the pool
  // instead of surfacing as mid-query "Connection terminated" errors.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,

  // Server-side deadline for any single statement. Without this a single
  // pathological query (missing index, runaway recompute) holds its pooled
  // connection indefinitely; a handful of them exhaust `max` and wedge the
  // whole service. node-postgres forwards these as libpq connection
  // parameters, so PostgreSQL itself cancels the statement — defence that
  // does not depend on the client staying connected. Generous default (60s)
  // tunable via env; set to 0 to disable for analytics-heavy deployments
  // that drive long queries through this pool.
  statement_timeout: parseInt(
    process.env.PG_STATEMENT_TIMEOUT_MS || "60000",
    10,
  ),
  // Releases a connection left holding an open transaction (a leaked
  // BEGIN without COMMIT/ROLLBACK) so it cannot pin a slot forever. Paired
  // with `withTransaction`'s poison-on-rollback guard below. Default 5min
  // (was 60s): several schedulers legitimately hold a tx across a paged
  // evaluation/claim loop, and a 60s server-side kill derailed the whole
  // pool (FATAL idle-in-transaction kills → connect-time churn).
  idle_in_transaction_session_timeout: parseInt(
    process.env.PG_IDLE_TX_TIMEOUT_MS || "300000",
    10,
  ),
});

// ---------------------------------------------------------------------------
// Pool event listeners
// ---------------------------------------------------------------------------

// The "error" event fires when an idle client encounters an unexpected error
// (e.g. the database restarting). We log it but do NOT crash the process
// because the pool will automatically remove the broken client and create a
// new one on the next query.
pool.on("error", (err: Error) => {
  console.error("Unexpected error on idle PostgreSQL client:", err.message);
});

// The "connect" event fires when a new client is created in the pool.
pool.on("connect", () => {
  console.debug("New PostgreSQL client connected to pool");
});

// ---------------------------------------------------------------------------
// Query helper
// ---------------------------------------------------------------------------

/**
 * Execute a parameterized SQL query against the pool.
 *
 * @param text  - The SQL statement (may contain $1, $2 ... placeholders).
 * @param values - Optional array of parameter values for the placeholders.
 * @returns The full QueryResult from pg.
 *
 * If the query throws, the error is logged together with the SQL text and
 * parameter values (essential for debugging parameterized queries where the
 * error alone doesn't reveal what SQL was executed), then the error is
 * re-thrown so calling code can handle it (usually by sending an error
 * response to the client).
 */
async function query(text: string, values?: unknown[]): Promise<QueryResult> {
  try {
    return await withBreaker(
      PG_BREAKER_LABEL,
      () => pool.query(text, values),
      {},
      isPgFailure,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Shutdown race: a fire-and-forget boot task (ClickHouse bootstrap,
    // Lakekeeper, …) hit pool.end() mid-query. The caller already
    // swallows this as a clean no-op — don't pollute the log with the
    // full SQL stack dump that makes it look like a real failure.
    const isShutdownRace =
      /pool after calling end on the pool|Pool is ending|cannot use a pool/i.test(msg);

    // Unique-violation (Postgres SQLSTATE 23505) is an expected,
    // caller-handled signal in several places — most notably
    // `linkTypeModel.create`'s apiName disambiguation retry loop,
    // which converts a 23505 into a numeric-suffix retry. Logging
    // the full SQL + params on every retry pollutes the journal
    // with what looks like a stack trace but is in fact a controlled
    // happy-path branch. Callers that *don't* handle 23505 will
    // still see the error rethrown below and can log it themselves
    // with their own context.
    const sqlState = (err as { code?: unknown })?.code;
    const isUniqueViolation = sqlState === "23505";

    if (!isShutdownRace && !isUniqueViolation) {
      console.error("PostgreSQL query error:", {
        sql: text,
        sqlState,
        paramCount: Array.isArray(values) ? values.length : 0,
        error: msg,
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// getClient – for transactions
// ---------------------------------------------------------------------------

/**
 * Check out a dedicated client from the pool.
 *
 * This is needed for transactions where multiple queries must execute on the
 * same connection. The calling code is responsible for calling
 * `client.release()` when done.
 *
 * WARNING: Always release the client in a `finally` block to prevent
 * connection pool leaks. Example:
 *
 * ```ts
 * const client = await getClient();
 * try {
 *   await client.query("BEGIN");
 *   // ... transactional queries ...
 *   await client.query("COMMIT");
 * } catch (err) {
 *   await client.query("ROLLBACK");
 *   throw err;
 * } finally {
 *   client.release();
 * }
 * ```
 */
async function getClient(): Promise<PoolClient> {
  return pool.connect();
}

// ---------------------------------------------------------------------------
// withTransaction helper (Task 23)
// ---------------------------------------------------------------------------

/**
 * Execute a callback within a database transaction.
 *
 * Guarantees: BEGIN before callback, COMMIT on success, ROLLBACK on error,
 * and the client is ALWAYS released back to the pool.
 *
 * @param callback - Async function receiving a PoolClient for transactional queries.
 * @returns The result of the callback.
 */
async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  // F-P4-11: route the pool.connect() through the "pg" breaker so a
  // wedged Postgres trips the same global breaker as `query()` /
  // `queryWithRetry()`. Callback failures are NOT the breaker's
  // business — isPgFailure filters them out — but connection-acquire
  // failures here count as dependency failures.
  return withBreaker(
    PG_BREAKER_LABEL,
    () => runTransaction(callback),
    {},
    isPgFailure,
  );
}

async function runTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  // F-P3-07: ROLLBACK-failure pool poisoning. If the callback throws AND
  // the subsequent ROLLBACK throws (network drop between pgbouncer and
  // Postgres, backend crash mid-tx, etc.), node-pg's default behaviour
  // is to put the client back in the pool with an open transaction
  // still on the server. The next borrower inherits the stale tx and
  // either sees phantom reads or — worse — commits the prior mutation
  // when it issues its own COMMIT. Track the abandonment state in
  // `poisoned`; pass a truthy error to `release()` so node-pg discards
  // the connection instead of recycling it.
  let poisoned: Error | null = null;
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      poisoned =
        rollbackErr instanceof Error
          ? rollbackErr
          : new Error(String(rollbackErr));
      console.error(
        JSON.stringify({
          type: "pg_rollback_failed",
          error: poisoned.message,
          // Best-effort tag the original cause so operators can correlate.
          cause: err instanceof Error ? err.message : String(err),
        })
      );
    }
    throw err;
  } finally {
    // Passing a truthy argument to release() signals node-pg to destroy
    // the underlying connection rather than recycling it to the pool.
    // We only do this on ROLLBACK failure — the successful-commit and
    // clean-rollback paths still recycle the connection normally.
    if (poisoned) {
      client.release(poisoned);
    } else {
      client.release();
    }
  }
}

// ---------------------------------------------------------------------------
// queryWithRetry helper (Task 23)
// ---------------------------------------------------------------------------

// F-P4-10: SQL-aware retry predicate. A write that the server committed
// can drop its ack over a dying socket — retrying an INSERT/UPDATE/DELETE
// would double-apply the mutation. The original helper retried every
// statement, which silently violated at-most-once semantics on mutate
// paths. We now:
//   * Retry only SQL verbs that are side-effect-free OR explicitly
//     idempotent (SELECT / SHOW / EXPLAIN / SET / WITH … SELECT; and
//     INSERT … ON CONFLICT DO NOTHING which is naturally idempotent on
//     the primary key).
//   * Retry any statement when the caller opts in via
//     `{ idempotent: true }` — used by the audit verifier job which
//     already guards against double-apply.
//   * For every other verb, fail fast and let the caller either wrap in
//     a transaction + idempotency helper (`src/actions/idempotency.ts`)
//     or surface the error to the user.
const READ_ONLY_VERB = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(?:with\s+[\s\S]+?\))?\s*(select|show|explain|set\s+local|set\s+session|values)\b/i;
const IDEMPOTENT_INSERT =
  /^\s*insert[\s\S]+?on\s+conflict[\s\S]*?do\s+nothing\s*;?\s*$/i;

function isIdempotentSql(text: string): boolean {
  if (READ_ONLY_VERB.test(text)) return true;
  if (IDEMPOTENT_INSERT.test(text)) return true;
  return false;
}

export interface QueryWithRetryOptions {
  /** Override SQL-verb auto-detection. Caller asserts the statement is safe to replay. */
  idempotent?: boolean;
}

/**
 * Execute a parameterized SQL query with automatic retry on transient
 * connection errors (ECONNREFUSED, ECONNRESET, admin_shutdown, etc.).
 *
 * SQL-aware (F-P4-10): retry is only attempted when the statement is
 * proven idempotent — either a read-only verb or an explicit
 * `ON CONFLICT DO NOTHING` insert. Mutate statements fail fast on the
 * first transient error; their callers are responsible for transactional
 * replay via `withTransaction` + `src/actions/idempotency.ts`.
 */
async function queryWithRetry(
  text: string,
  values?: unknown[],
  maxRetries: number = 2,
  options: QueryWithRetryOptions = {},
): Promise<QueryResult> {
  const TRANSIENT_CODES = new Set([
    "ECONNREFUSED", "ECONNRESET", "57P01", "57P03",
  ]);
  const retryable = options.idempotent ?? isIdempotentSql(text);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withBreaker(
        PG_BREAKER_LABEL,
        () => pool.query(text, values),
        {},
        isPgFailure,
      );
    } catch (err: any) {
      const isConnectionError = TRANSIENT_CODES.has(err.code) ||
        (err.message && (
          err.message.includes("ECONNREFUSED") ||
          err.message.includes("ECONNRESET") ||
          err.message.includes("connection terminated")
        ));

      if (isConnectionError && attempt < maxRetries && retryable) {
        console.warn(JSON.stringify({
          type: "pg_query_retry",
          attempt: attempt + 1,
          maxRetries,
          error: err.message,
          sql: text.substring(0, 100),
          idempotent: retryable,
        }));
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }

      if (isConnectionError && !retryable) {
        console.warn(JSON.stringify({
          type: "pg_query_retry_skipped_non_idempotent",
          error: err.message,
          sql: text.substring(0, 100),
        }));
      }

      // Log and re-throw — but skip the noisy SQL/params dump for
      // unique-violation (23505), which is an expected, caller-handled
      // signal (see the matching block in `query()` above for the
      // full rationale).
      const isUniqueViolation =
        (err as { code?: unknown })?.code === "23505";
      if (!isUniqueViolation) {
        console.error("PostgreSQL query error:", {
          sql: text,
          sqlState: (err as { code?: unknown })?.code,
          paramCount: Array.isArray(values) ? values.length : 0,
          error: err.message,
        });
      }
      throw err;
    }
  }

  // Should never reach here, but TypeScript needs a return
  throw new Error("queryWithRetry: unreachable");
}

// ---------------------------------------------------------------------------
// checkPostgresHealth (Task 23)
// ---------------------------------------------------------------------------

/**
 * Check PostgreSQL connection health and return pool stats.
 */
async function checkPostgresHealth(): Promise<Record<string, unknown>> {
  try {
    const result = await pool.query(
      "SELECT NOW() as time, current_database() as database"
    );
    return {
      status: "connected",
      database: result.rows[0].database,
      serverTime: result.rows[0].time,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    };
  } catch (err: any) {
    return {
      status: "disconnected",
      error: err.message,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
export { pool, query, getClient, withTransaction, queryWithRetry, checkPostgresHealth, isIdempotentSql };
export default pool;
