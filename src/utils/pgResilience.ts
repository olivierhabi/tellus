// ---------------------------------------------------------------------------
// PostgreSQL Connection Resilience (Task 23)
//
// Retry, error classification, and health monitoring for PostgreSQL
// operations. Complements the OpenSearch resilience module.
//
// Features:
//   - withPgRetry(): Retry transient PG errors with exponential backoff
//   - isTransientError(): Classify PG errors as transient vs. permanent
//   - withQueryTimeout(): Wrap queries with statement_timeout
//   - PgHealthMonitor: Monitor connection pool health
//
// Run self-tests: npx tsx src/utils/pgResilience.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PgRetryOptions {
  /** Maximum number of retry attempts (default 3). */
  maxRetries?: number;
  /** Initial delay in ms before first retry (default 100). */
  initialDelayMs?: number;
  /** Maximum delay in ms between retries (default 5000). */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default 2). */
  backoffMultiplier?: number;
  /** Optional label for logging. */
  label?: string;
}

export interface PgHealthState {
  /** Whether the pool is considered healthy. */
  healthy: boolean;
  /** Number of consecutive health check failures. */
  consecutiveFailures: number;
  /** Timestamp of last successful health check. */
  lastSuccessAt: string | null;
  /** Timestamp of last failed health check. */
  lastFailureAt: string | null;
  /** Last error message if unhealthy. */
  lastError: string | null;
  /** Average query response time in ms (from recent checks). */
  avgResponseMs: number;
}

export interface PgHealthMonitorOptions {
  /** Interval between health checks in ms (default 30000). */
  checkIntervalMs?: number;
  /** Threshold for consecutive failures to mark as unhealthy (default 3). */
  unhealthyThreshold?: number;
  /** Slow query threshold in ms (default 5000). */
  slowQueryThresholdMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * PostgreSQL error codes classified as transient.
 *
 * These errors can occur under load or during brief network issues
 * and may succeed if retried. Non-transient errors (like syntax errors,
 * constraint violations) should NOT be retried.
 *
 * See: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const TRANSIENT_PG_ERROR_CODES = new Set([
  // Connection errors
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure

  // Insufficient resources
  "53000", // insufficient_resources
  "53100", // disk_full
  "53200", // out_of_memory
  "53300", // too_many_connections

  // Operator intervention
  "57000", // operator_intervention
  "57014", // query_canceled (e.g., statement_timeout)
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now

  // Serialization failures (safe to retry)
  "40001", // serialization_failure
  "40P01", // deadlock_detected
]);

/**
 * Node.js system-level error codes that indicate transient network issues.
 */
const TRANSIENT_SYSTEM_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

const DEFAULT_RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
};

// ---------------------------------------------------------------------------
// isTransientError
// ---------------------------------------------------------------------------

/**
 * Determine if a PostgreSQL error is transient and safe to retry.
 *
 * Checks:
 *   1. PostgreSQL error code (5-digit string) against TRANSIENT_PG_ERROR_CODES
 *   2. System-level error code (ECONNREFUSED, etc.)
 *   3. Error message patterns (connection terminated, etc.)
 *
 * Returns false for permanent errors (constraint violations, syntax errors,
 * permission denied, etc.) which should NOT be retried.
 */
export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const error = err as Record<string, unknown>;

  const pgCode = error.code as string | undefined;

  // Check system-level error code first (e.g., ECONNREFUSED, EPIPE)
  if (typeof pgCode === "string" && TRANSIENT_SYSTEM_CODES.has(pgCode)) {
    return true;
  }

  // Check PostgreSQL error code (5-char string starting with digit, like "53300" or "40P01")
  if (typeof pgCode === "string" && /^\d[0-9A-Z]{4}$/i.test(pgCode)) {
    return TRANSIENT_PG_ERROR_CODES.has(pgCode);
  }

  // Check error message patterns
  const message = ((error as unknown as Error).message || "").toLowerCase();
  if (
    message.includes("connection terminated") ||
    message.includes("connection refused") ||
    message.includes("too many connections") ||
    message.includes("remaining connection slots are reserved") ||
    message.includes("server closed the connection unexpectedly") ||
    message.includes("connect etimedout") ||
    message.includes("the database system is starting up") ||
    message.includes("the database system is shutting down")
  ) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateDelay(
  attempt: number,
  initialMs: number,
  maxMs: number,
  multiplier: number
): number {
  const exponentialDelay = initialMs * Math.pow(multiplier, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, maxMs);
  // Add ±25% jitter
  const jitter = cappedDelay * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

// ---------------------------------------------------------------------------
// withPgRetry
// ---------------------------------------------------------------------------

/**
 * Execute a function with retry on transient PostgreSQL errors.
 *
 * Only transient errors (connection issues, serialization failures, etc.)
 * are retried. Permanent errors (constraint violations, syntax errors)
 * are thrown immediately.
 *
 * @param fn - The async function to execute.
 * @param options - Retry configuration.
 * @returns The result of the function.
 * @throws The last error if all retries are exhausted.
 */
export async function withPgRetry<T>(
  fn: () => Promise<T>,
  options: PgRetryOptions = {}
): Promise<T> {
  const {
    maxRetries = DEFAULT_RETRY_OPTIONS.maxRetries,
    initialDelayMs = DEFAULT_RETRY_OPTIONS.initialDelayMs,
    maxDelayMs = DEFAULT_RETRY_OPTIONS.maxDelayMs,
    backoffMultiplier = DEFAULT_RETRY_OPTIONS.backoffMultiplier,
    label = "pg-operation",
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Don't retry on the last attempt or non-transient errors
      if (attempt > maxRetries || !isTransientError(err)) {
        throw err;
      }

      const delay = calculateDelay(attempt, initialDelayMs, maxDelayMs, backoffMultiplier);
      console.warn(
        `[PgRetry] ${label} attempt ${attempt}/${maxRetries} failed: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// withQueryTimeout
// ---------------------------------------------------------------------------

/**
 * Execute a query function with a statement timeout.
 *
 * Wraps the operation in a SET statement_timeout / RESET statement_timeout
 * sequence. Requires a pg client or pool with a query method.
 *
 * Note: This is a higher-order function — it doesn't execute the query
 * directly, but wraps the provided function with timeout setup/teardown.
 */
export async function withQueryTimeout<T>(
  queryFn: (text: string, values?: unknown[]) => Promise<any>,
  operation: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  await queryFn(`SET statement_timeout = ${Math.round(timeoutMs)}`);
  try {
    return await operation();
  } finally {
    await queryFn("SET statement_timeout = 0").catch(() => {
      // Ignore errors resetting timeout (connection may be broken)
    });
  }
}

// ---------------------------------------------------------------------------
// PgHealthMonitor
// ---------------------------------------------------------------------------

/**
 * Monitors PostgreSQL connection pool health.
 *
 * Periodically checks the pool with a lightweight query and tracks
 * success/failure patterns to determine overall health status.
 */
export class PgHealthMonitor {
  private healthy: boolean = true;
  private consecutiveFailures: number = 0;
  private lastSuccessAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastError: string | null = null;
  private responseTimes: number[] = [];
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  private readonly checkIntervalMs: number;
  private readonly unhealthyThreshold: number;
  private readonly slowQueryThresholdMs: number;
  private readonly queryFn: (text: string) => Promise<any>;

  constructor(
    queryFn: (text: string) => Promise<any>,
    options: PgHealthMonitorOptions = {}
  ) {
    this.queryFn = queryFn;
    this.checkIntervalMs = options.checkIntervalMs ?? 30000;
    this.unhealthyThreshold = options.unhealthyThreshold ?? 3;
    this.slowQueryThresholdMs = options.slowQueryThresholdMs ?? 5000;
  }

  /** Get the current health state. */
  getState(): PgHealthState {
    const avgResponseMs =
      this.responseTimes.length > 0
        ? Math.round(
            this.responseTimes.reduce((a, b) => a + b, 0) /
              this.responseTimes.length
          )
        : 0;

    return {
      healthy: this.healthy,
      consecutiveFailures: this.consecutiveFailures,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastError: this.lastError,
      avgResponseMs,
    };
  }

  /** Run a single health check. */
  async check(): Promise<boolean> {
    const start = performance.now();
    try {
      await this.queryFn("SELECT 1");
      const responseMs = Math.round(performance.now() - start);

      // Track response times (keep last 10)
      this.responseTimes.push(responseMs);
      if (this.responseTimes.length > 10) {
        this.responseTimes.shift();
      }

      if (responseMs > this.slowQueryThresholdMs) {
        console.warn(
          `[PgHealthMonitor] Slow health check: ${responseMs}ms (threshold: ${this.slowQueryThresholdMs}ms)`
        );
      }

      this.consecutiveFailures = 0;
      this.lastSuccessAt = new Date().toISOString();
      this.lastError = null;
      this.healthy = true;

      return true;
    } catch (err) {
      const responseMs = Math.round(performance.now() - start);
      this.responseTimes.push(responseMs);
      if (this.responseTimes.length > 10) {
        this.responseTimes.shift();
      }

      this.consecutiveFailures++;
      this.lastFailureAt = new Date().toISOString();
      this.lastError = err instanceof Error ? err.message : String(err);

      if (this.consecutiveFailures >= this.unhealthyThreshold) {
        this.healthy = false;
      }

      return false;
    }
  }

  /** Start periodic health checks. */
  start(): void {
    if (this.intervalHandle) return;

    // Run an initial check immediately
    this.check().catch(() => {});

    this.intervalHandle = setInterval(() => {
      this.check().catch(() => {});
    }, this.checkIntervalMs);

    // Unref so the interval doesn't prevent process exit
    if (this.intervalHandle.unref) {
      this.intervalHandle.unref();
    }
  }

  /** Stop periodic health checks. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Reset the monitor state. */
  reset(): void {
    this.healthy = true;
    this.consecutiveFailures = 0;
    this.lastSuccessAt = null;
    this.lastFailureAt = null;
    this.lastError = null;
    this.responseTimes = [];
  }
}

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/utils/pgResilience.ts)
// ---------------------------------------------------------------------------

export async function runSelfTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      console.log(`  PASS: ${label}`);
      passed++;
    } else {
      console.error(`  FAIL: ${label}`);
      /* v8 ignore next 2 */
      failed++;
    }
  }

  console.log("Running pgResilience self-tests...\n");

  // =========================================================================
  // 1. isTransientError: PostgreSQL error codes
  // =========================================================================
  console.log("=== 1. isTransientError: PG error codes ===");
  {
    // Transient codes
    assert(isTransientError({ code: "53300" }), "53300 (too_many_connections) is transient");
    assert(isTransientError({ code: "40001" }), "40001 (serialization_failure) is transient");
    assert(isTransientError({ code: "40P01" }), "40P01 (deadlock_detected) is transient");
    assert(isTransientError({ code: "08006" }), "08006 (connection_failure) is transient");
    assert(isTransientError({ code: "57P01" }), "57P01 (admin_shutdown) is transient");
    assert(isTransientError({ code: "57014" }), "57014 (query_canceled) is transient");

    // Non-transient codes
    assert(!isTransientError({ code: "23505" }), "23505 (unique_violation) is NOT transient");
    assert(!isTransientError({ code: "23503" }), "23503 (foreign_key_violation) is NOT transient");
    assert(!isTransientError({ code: "42601" }), "42601 (syntax_error) is NOT transient");
    assert(!isTransientError({ code: "42501" }), "42501 (insufficient_privilege) is NOT transient");
    assert(!isTransientError({ code: "23502" }), "23502 (not_null_violation) is NOT transient");
  }

  // =========================================================================
  // 2. isTransientError: system error codes
  // =========================================================================
  console.log("\n=== 2. isTransientError: system codes ===");
  {
    assert(isTransientError({ code: "ECONNREFUSED" }), "ECONNREFUSED is transient");
    assert(isTransientError({ code: "ECONNRESET" }), "ECONNRESET is transient");
    assert(isTransientError({ code: "ETIMEDOUT" }), "ETIMEDOUT is transient");
    assert(isTransientError({ code: "EPIPE" }), "EPIPE is transient");
    assert(isTransientError({ code: "EHOSTUNREACH" }), "EHOSTUNREACH is transient");
    assert(!isTransientError({ code: "ENOENT" }), "ENOENT is NOT transient");
    assert(!isTransientError({ code: "EACCES" }), "EACCES is NOT transient");
  }

  // =========================================================================
  // 3. isTransientError: message patterns
  // =========================================================================
  console.log("\n=== 3. isTransientError: message patterns ===");
  {
    assert(
      isTransientError(new Error("Connection terminated unexpectedly")),
      "connection terminated is transient"
    );
    assert(
      isTransientError(new Error("too many connections for role")),
      "too many connections is transient"
    );
    assert(
      isTransientError(new Error("remaining connection slots are reserved")),
      "reserved slots is transient"
    );
    assert(
      isTransientError(new Error("the database system is starting up")),
      "database starting up is transient"
    );
    assert(
      isTransientError(new Error("server closed the connection unexpectedly")),
      "unexpected close is transient"
    );
    assert(
      !isTransientError(new Error("column 'xyz' does not exist")),
      "column not exist is NOT transient"
    );
    assert(!isTransientError(null), "null is not transient");
    assert(!isTransientError(undefined), "undefined is not transient");
    assert(!isTransientError("string"), "string is not transient");
  }

  // =========================================================================
  // 4. withPgRetry: success on first attempt
  // =========================================================================
  console.log("\n=== 4. withPgRetry: immediate success ===");
  {
    let callCount = 0;
    const result = await withPgRetry(async () => {
      callCount++;
      return "data";
    }, { label: "test-success" });

    assert(result === "data", "returns result");
    assert(callCount === 1, "called once");
  }

  // =========================================================================
  // 5. withPgRetry: success after transient failures
  // =========================================================================
  console.log("\n=== 5. withPgRetry: success after retries ===");
  {
    let callCount = 0;
    const result = await withPgRetry(async () => {
      callCount++;
      if (callCount < 3) {
        const err = new Error("Connection terminated unexpectedly");
        throw err;
      }
      return "recovered";
    }, {
      maxRetries: 3,
      initialDelayMs: 10,
      maxDelayMs: 50,
      label: "test-retry",
    });

    assert(result === "recovered", "returns result after recovery");
    assert(callCount === 3, `called 3 times (got: ${callCount})`);
  }

  // =========================================================================
  // 6. withPgRetry: does not retry permanent errors
  // =========================================================================
  console.log("\n=== 6. withPgRetry: permanent error ===");
  {
    let callCount = 0;
    let threw = false;

    try {
      await withPgRetry(async () => {
        callCount++;
        const err = new Error("duplicate key value violates unique constraint") as any;
        err.code = "23505";
        throw err;
      }, {
        maxRetries: 3,
        initialDelayMs: 10,
        label: "test-permanent",
      });
    } catch {
      threw = true;
    }

    assert(threw, "throws immediately for permanent error");
    assert(callCount === 1, `called only once (got: ${callCount})`);
  }

  // =========================================================================
  // 7. withPgRetry: exhausts retries
  // =========================================================================
  console.log("\n=== 7. withPgRetry: exhausts retries ===");
  {
    let callCount = 0;
    let threw = false;

    try {
      await withPgRetry(async () => {
        callCount++;
        throw { code: "ECONNREFUSED", message: "Connection refused" };
      }, {
        maxRetries: 2,
        initialDelayMs: 10,
        maxDelayMs: 50,
        label: "test-exhaust",
      });
    } catch {
      threw = true;
    }

    assert(threw, "throws after exhausting retries");
    assert(callCount === 3, `called 3 times (got: ${callCount})`);
  }

  // =========================================================================
  // 8. withQueryTimeout
  // =========================================================================
  console.log("\n=== 8. withQueryTimeout ===");
  {
    const queries: string[] = [];
    const mockQuery = async (text: string) => {
      queries.push(text);
      return { rows: [] };
    };

    const result = await withQueryTimeout(
      mockQuery,
      async () => "query-result",
      5000
    );

    assert(result === "query-result", "returns operation result");
    assert(queries[0] === "SET statement_timeout = 5000", "sets timeout");
    assert(queries[1] === "SET statement_timeout = 0", "resets timeout");
  }

  // =========================================================================
  // 9. withQueryTimeout: resets on error
  // =========================================================================
  console.log("\n=== 9. withQueryTimeout: resets on error ===");
  {
    const queries: string[] = [];
    const mockQuery = async (text: string) => {
      queries.push(text);
      return { rows: [] };
    };

    let threw = false;
    try {
      await withQueryTimeout(
        mockQuery,
        async () => { throw new Error("Query failed"); },
        3000
      );
    } catch {
      threw = true;
    }

    assert(threw, "throws the original error");
    assert(queries[0] === "SET statement_timeout = 3000", "sets timeout");
    assert(queries[1] === "SET statement_timeout = 0", "resets timeout even on error");
  }

  // =========================================================================
  // 10. PgHealthMonitor: initial state
  // =========================================================================
  console.log("\n=== 10. PgHealthMonitor: initial state ===");
  {
    const monitor = new PgHealthMonitor(async () => ({ rows: [] }));
    const state = monitor.getState();

    assert(state.healthy === true, "starts healthy");
    assert(state.consecutiveFailures === 0, "no failures");
    assert(state.lastSuccessAt === null, "no success timestamp");
    assert(state.lastFailureAt === null, "no failure timestamp");
    assert(state.lastError === null, "no error");
    assert(state.avgResponseMs === 0, "no response time data");
  }

  // =========================================================================
  // 11. PgHealthMonitor: successful check
  // =========================================================================
  console.log("\n=== 11. PgHealthMonitor: successful check ===");
  {
    const monitor = new PgHealthMonitor(async () => ({ rows: [{ ok: 1 }] }));
    const result = await monitor.check();
    const state = monitor.getState();

    assert(result === true, "check returns true");
    assert(state.healthy === true, "healthy after success");
    assert(state.consecutiveFailures === 0, "no failures");
    assert(state.lastSuccessAt !== null, "has success timestamp");
    assert(state.avgResponseMs >= 0, "has response time");
  }

  // =========================================================================
  // 12. PgHealthMonitor: becomes unhealthy after threshold
  // =========================================================================
  console.log("\n=== 12. PgHealthMonitor: unhealthy threshold ===");
  {
    const monitor = new PgHealthMonitor(
      async () => { throw new Error("ECONNREFUSED"); },
      { unhealthyThreshold: 3 }
    );

    await monitor.check();
    assert(monitor.getState().healthy === true, "still healthy after 1 failure");

    await monitor.check();
    assert(monitor.getState().healthy === true, "still healthy after 2 failures");

    await monitor.check();
    const state = monitor.getState();
    assert(state.healthy === false, "unhealthy after 3 failures");
    assert(state.consecutiveFailures === 3, "3 consecutive failures");
    assert(state.lastError === "ECONNREFUSED", "last error message");
    assert(state.lastFailureAt !== null, "has failure timestamp");
  }

  // =========================================================================
  // 13. PgHealthMonitor: recovers after success
  // =========================================================================
  console.log("\n=== 13. PgHealthMonitor: recovery ===");
  {
    let shouldFail = true;
    const monitor = new PgHealthMonitor(
      async () => {
        if (shouldFail) throw new Error("ECONNREFUSED");
        return { rows: [{ ok: 1 }] };
      },
      { unhealthyThreshold: 2 }
    );

    await monitor.check();
    await monitor.check();
    assert(monitor.getState().healthy === false, "unhealthy");

    shouldFail = false;
    await monitor.check();
    const state = monitor.getState();
    assert(state.healthy === true, "recovered after success");
    assert(state.consecutiveFailures === 0, "failures reset");
    assert(state.lastError === null, "error cleared");
  }

  // =========================================================================
  // 14. PgHealthMonitor: start/stop
  // =========================================================================
  console.log("\n=== 14. PgHealthMonitor: start/stop ===");
  {
    let checkCount = 0;
    const monitor = new PgHealthMonitor(
      async () => { checkCount++; return { rows: [] }; },
      { checkIntervalMs: 50 }
    );

    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    monitor.stop();

    assert(checkCount >= 2, `ran at least 2 checks (got: ${checkCount})`);

    // Double start should be safe
    monitor.start();
    monitor.start(); // should not create duplicate interval
    monitor.stop();
  }

  // =========================================================================
  // 15. PgHealthMonitor: reset
  // =========================================================================
  console.log("\n=== 15. PgHealthMonitor: reset ===");
  {
    const monitor = new PgHealthMonitor(
      async () => { throw new Error("fail"); },
      { unhealthyThreshold: 1 }
    );

    await monitor.check();
    assert(monitor.getState().healthy === false, "unhealthy before reset");

    monitor.reset();
    const state = monitor.getState();
    assert(state.healthy === true, "healthy after reset");
    assert(state.consecutiveFailures === 0, "failures cleared");
    assert(state.avgResponseMs === 0, "response times cleared");
  }

  // =========================================================================
  // 16. Response time tracking (keeps last 10)
  // =========================================================================
  console.log("\n=== 16. Response time tracking ===");
  {
    const monitor = new PgHealthMonitor(async () => ({ rows: [] }));

    // Run 15 checks
    for (let i = 0; i < 15; i++) {
      await monitor.check();
    }

    const state = monitor.getState();
    assert(state.avgResponseMs >= 0, "has average response time");
    // The internal array should have at most 10 entries
    // We can't directly access it, but avgResponseMs should be calculated
    assert(typeof state.avgResponseMs === "number", "avgResponseMs is a number");
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll pgResilience tests passed");
  } else {
    /* v8 ignore next */
    process.exit(1);
  }
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
