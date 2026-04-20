import { Pool, types, QueryResult, PoolClient } from "pg";

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

  // Maximum number of clients in the pool. Our Express server can handle
  // dozens of concurrent requests and each request may need its own
  // database connection.
  max: 20,

  // A connection sitting idle for 30 seconds is released back to PostgreSQL.
  idleTimeoutMillis: 30_000,

  // If a new connection cannot be established within 5 seconds the query
  // fails with a timeout error.
  connectionTimeoutMillis: 5_000,
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
    return await pool.query(text, values);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Shutdown race: a fire-and-forget boot task (ClickHouse bootstrap,
    // Lakekeeper, …) hit pool.end() mid-query. The caller already
    // swallows this as a clean no-op — don't pollute the log with the
    // full SQL stack dump that makes it look like a real failure.
    const isShutdownRace =
      /pool after calling end on the pool|Pool is ending|cannot use a pool/i.test(msg);
    if (!isShutdownRace) {
      console.error("PostgreSQL query error:", {
        sql: text,
        params: values,
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// queryWithRetry helper (Task 23)
// ---------------------------------------------------------------------------

/**
 * Execute a parameterized SQL query with automatic retry on transient
 * connection errors (ECONNREFUSED, ECONNRESET, admin_shutdown, etc.).
 */
async function queryWithRetry(
  text: string,
  values?: unknown[],
  maxRetries: number = 2
): Promise<QueryResult> {
  const TRANSIENT_CODES = new Set([
    "ECONNREFUSED", "ECONNRESET", "57P01", "57P03",
  ]);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await pool.query(text, values);
    } catch (err: any) {
      const isConnectionError = TRANSIENT_CODES.has(err.code) ||
        (err.message && (
          err.message.includes("ECONNREFUSED") ||
          err.message.includes("ECONNRESET") ||
          err.message.includes("connection terminated")
        ));

      if (isConnectionError && attempt < maxRetries) {
        console.warn(JSON.stringify({
          type: "pg_query_retry",
          attempt: attempt + 1,
          maxRetries,
          error: err.message,
          sql: text.substring(0, 100),
        }));
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }

      // Log and re-throw
      console.error("PostgreSQL query error:", {
        sql: text,
        params: values,
        error: err.message,
      });
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
export { pool, query, getClient, withTransaction, queryWithRetry, checkPostgresHealth };
export default pool;
