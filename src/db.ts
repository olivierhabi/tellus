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
    console.error("PostgreSQL query error:", {
      sql: text,
      params: values,
      error: err instanceof Error ? err.message : err,
    });
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
// Exports
// ---------------------------------------------------------------------------
export { pool, query, getClient };
export default pool;
