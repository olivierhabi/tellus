# TASK 23: PostgreSQL Connection Resilience

This task has three sub-tasks.

**Depends on:** Task 15 (error handler middleware, for adding the `57014` case)

## Objective
Enhance the PostgreSQL connection pool with proper error handling, connection health monitoring, and automatic reconnection. The pool must handle scenarios like database restarts, network interruptions, and connection limit exhaustion.

## Exact Specification

Update `/src/db.js`:

## Sub-task 23A: Pool Configuration, Health Check, and Helper Functions

```javascript
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE || 'ontology',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'ontology',
  
  // Pool configuration
  max: 20,                    // Maximum 20 connections
  min: 2,                     // Keep at least 2 idle connections
  idleTimeoutMillis: 30000,   // Close idle connections after 30s
  connectionTimeoutMillis: 5000, // Timeout trying to connect after 5s
  
  // Statement timeout — kill any query running longer than 30 seconds
  statement_timeout: 30000,
});

// Connection event monitoring
pool.on('connect', (client) => {
  console.log(JSON.stringify({ type: 'pg_connect', timestamp: new Date().toISOString() }));
});

pool.on('error', (err, client) => {
  console.error(JSON.stringify({
    type: 'pg_pool_error',
    timestamp: new Date().toISOString(),
    error: err.message,
    code: err.code,
  }));
  // Don't crash the process — the pool will handle reconnection
});

pool.on('remove', (client) => {
  // A client was removed from the pool (idle timeout or error)
  // This is informational, not an error
});

// Health check function
async function checkPostgresHealth() {
  try {
    const result = await pool.query('SELECT NOW() as time, current_database() as database');
    return {
      status: 'connected',
      database: result.rows[0].database,
      serverTime: result.rows[0].time,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    };
  } catch (err) {
    return {
      status: 'disconnected',
      error: err.message,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    };
  }
}

// Helper: execute a query with automatic retry on connection errors
async function queryWithRetry(text, params, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      const isConnectionError = ['ECONNREFUSED', 'ECONNRESET', '57P01', '57P03'].some(
        code => err.code === code || (err.message && err.message.includes(code))
      );
      
      if (isConnectionError && attempt < maxRetries) {
        console.warn(JSON.stringify({
          type: 'pg_query_retry',
          attempt: attempt + 1,
          maxRetries,
          error: err.message,
        }));
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); // Exponential backoff
        continue;
      }
      
      throw err;
    }
  }
}

// Helper: execute a transaction with automatic rollback on error
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query: queryWithRetry,
  withTransaction,
  checkPostgresHealth,
};
```

The `withTransaction` helper is critical. Multiple existing route handlers (Interface creation in Task 2, Action execution in Day 5) manually manage transactions with BEGIN/COMMIT/ROLLBACK. These should ALL be refactored to use the `withTransaction` helper, which guarantees that:
1. A client is obtained from the pool
2. BEGIN is executed
3. The callback runs with the transactional client
4. If the callback succeeds, COMMIT is executed
5. If the callback throws, ROLLBACK is executed
6. The client is ALWAYS released back to the pool (in the `finally` block)

Without the `finally` block releasing the client, connection leaks will exhaust the pool over time. This is the single most common PostgreSQL bug in Node.js applications.

---

## Sub-task 23B: Refactor Manual Transaction Code

**Depends on:** Sub-task 23A

Search the entire codebase for manual `BEGIN`/`COMMIT`/`ROLLBACK` patterns. Refactor each occurrence to use the `withTransaction(callback)` helper from `db.js`. List every file modified.

**Acceptance criterion:** `grep -r 'BEGIN\|COMMIT\|ROLLBACK' src/routes/ src/services/` returns zero results (all transaction management is via `withTransaction`).

The `queryWithRetry` function handles transient connection errors with exponential backoff. PostgreSQL error codes `57P01` (admin shutdown) and `57P03` (cannot connect) are transient — the database may be restarting and will come back online shortly.

---

## Sub-task 23C: Add Query Timeout Error Handling

**Depends on:** Task 15 (error handler middleware)

The `statement_timeout: 30000` pool configuration kills any query running longer than 30 seconds. This prevents a runaway query (e.g., a Search Around that traverses too many links) from holding a connection indefinitely. When a query is killed, the `pg` library throws an error with code `57014` (query_canceled), which should be handled by the error handler middleware (Task 15) as:

```javascript
case '57014': // query_canceled (timeout)
  return res.status(504).json({
    error: {
      code: 'QUERY_TIMEOUT',
      message: 'The query timed out after 30 seconds. Try narrowing your search.',
    }
  });
```

Add this case to the `handlePostgresError` function in the error handler.

## Verification
1. Start server with PostgreSQL running → verify pool connects (check logs)
2. Stop PostgreSQL → make a query → verify error message says "disconnected" not raw error
3. Start PostgreSQL again → make a query → verify it works (automatic reconnection)
4. Run a query that takes >30 seconds (e.g., SELECT pg_sleep(35)) → verify timeout error with QUERY_TIMEOUT code
5. Verify all existing transaction code uses `withTransaction` helper (search for manual BEGIN/COMMIT)
6. Verify pool stats in health endpoint show correct idle/total/waiting counts
7. Make 25 concurrent requests (exceeding pool max of 20) → verify requests queue and eventually complete (not crash)
