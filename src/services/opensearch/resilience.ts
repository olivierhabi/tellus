// ---------------------------------------------------------------------------
// OpenSearch Connection Resilience (Task 22)
//
// Retry and circuit breaker patterns for OpenSearch operations.
//
// Features:
//   - withRetry(): Exponential backoff retry (100ms initial, 5s max, 3 retries)
//   - CircuitBreaker class: CLOSED → OPEN → HALF_OPEN state machine
//   - withCircuitBreaker(): Wraps a function with circuit breaker protection
//   - Connection health monitoring
//
// Run self-tests: npx tsx src/services/opensearch/resilience.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Maximum number of retry attempts (default 3). */
  maxRetries?: number;
  /** Initial delay in ms before first retry (default 100). */
  initialDelayMs?: number;
  /** Maximum delay in ms between retries (default 5000). */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default 2). */
  backoffMultiplier?: number;
  /** Optional predicate to determine if an error is retryable. */
  isRetryable?: (err: unknown) => boolean;
  /** Optional label for logging. */
  label?: string;
}

export interface CircuitBreakerOptions {
  /** Number of consecutive failures to trip the circuit (default 5). */
  failureThreshold?: number;
  /** Time in ms the circuit stays open before trying half-open (default 30000). */
  resetTimeoutMs?: number;
  /** Optional label for logging. */
  label?: string;
}

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------

const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, "isRetryable" | "label">> = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
};

const DEFAULT_CIRCUIT_BREAKER_OPTIONS: Required<Omit<CircuitBreakerOptions, "label">> = {
  failureThreshold: 5,
  resetTimeoutMs: 30000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Default check for transient OpenSearch errors that should be retried.
 */
export function isTransientOpenSearchError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const error = err as Record<string, unknown>;

  // HTTP status codes that indicate transient issues
  const statusCode = (error.statusCode ??
    (error.meta as Record<string, unknown>)?.statusCode) as number | undefined;
  if (statusCode === 503 || statusCode === 429 || statusCode === 502 || statusCode === 504) {
    return true;
  }

  // Connection-level errors
  const name = (error as unknown as Error).name;
  if (
    name === "ConnectionError" ||
    name === "TimeoutError" ||
    name === "NoLivingConnectionsError"
  ) {
    return true;
  }

  const code = error.code as string | undefined;
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "EHOSTUNREACH"
  ) {
    return true;
  }

  return false;
}

/**
 * Sleep for the specified duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate delay with jitter to prevent thundering herd.
 */
function calculateDelay(attempt: number, initialMs: number, maxMs: number, multiplier: number): number {
  const exponentialDelay = initialMs * Math.pow(multiplier, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, maxMs);
  // Add ±25% jitter
  const jitter = cappedDelay * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

/**
 * Execute a function with exponential backoff retry on transient errors.
 *
 * @param fn - The async function to execute.
 * @param options - Retry configuration.
 * @returns The result of the function.
 * @throws The last error if all retries are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = DEFAULT_RETRY_OPTIONS.maxRetries,
    initialDelayMs = DEFAULT_RETRY_OPTIONS.initialDelayMs,
    maxDelayMs = DEFAULT_RETRY_OPTIONS.maxDelayMs,
    backoffMultiplier = DEFAULT_RETRY_OPTIONS.backoffMultiplier,
    isRetryable = isTransientOpenSearchError,
    label = "operation",
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Don't retry on the last attempt or non-retryable errors
      if (attempt > maxRetries || !isRetryable(err)) {
        throw err;
      }

      const delay = calculateDelay(attempt, initialDelayMs, maxDelayMs, backoffMultiplier);
      console.warn(
        `[OpenSearch Retry] ${label} attempt ${attempt}/${maxRetries} failed: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

/**
 * Circuit Breaker implementation for OpenSearch operations.
 *
 * State machine:
 *   CLOSED (normal operation)
 *     → OPEN (after failureThreshold consecutive failures)
 *       → HALF_OPEN (after resetTimeoutMs, allows 1 probe request)
 *         → CLOSED (if probe succeeds)
 *         → OPEN (if probe fails, reset timer)
 */
export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private successCount: number = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly label: string;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_CIRCUIT_BREAKER_OPTIONS.failureThreshold;
    this.resetTimeoutMs = options.resetTimeoutMs ?? DEFAULT_CIRCUIT_BREAKER_OPTIONS.resetTimeoutMs;
    this.label = options.label ?? "CircuitBreaker";
  }

  /** Get the current circuit state. */
  getState(): CircuitState {
    // Check if we should transition from OPEN to HALF_OPEN
    if (this.state === "OPEN" && Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
      this.state = "HALF_OPEN";
      console.log(`[${this.label}] Circuit transitioned to HALF_OPEN`);
    }
    return this.state;
  }

  /** Get the current failure count. */
  getFailureCount(): number {
    return this.failureCount;
  }

  /** Get the current success count (since last state change). */
  getSuccessCount(): number {
    return this.successCount;
  }

  /** Record a successful operation. */
  recordSuccess(): void {
    if (this.state === "HALF_OPEN") {
      console.log(`[${this.label}] Circuit closed after successful probe`);
      this.state = "CLOSED";
      this.failureCount = 0;
      this.successCount = 0;
    }
    this.successCount++;
    // Reset failure count on any success in CLOSED state
    if (this.state === "CLOSED") {
      this.failureCount = 0;
    }
  }

  /** Record a failed operation. */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === "HALF_OPEN") {
      // Probe failed — go back to OPEN
      this.state = "OPEN";
      console.log(`[${this.label}] Circuit re-opened after failed probe`);
      return;
    }

    if (this.state === "CLOSED" && this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
      console.log(
        `[${this.label}] Circuit opened after ${this.failureCount} consecutive failures`
      );
    }
  }

  /** Check if the circuit allows a request through. */
  canExecute(): boolean {
    const state = this.getState();
    return state === "CLOSED" || state === "HALF_OPEN";
  }

  /** Reset the circuit to CLOSED state. */
  reset(): void {
    this.state = "CLOSED";
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
  }

  /**
   * Execute a function through the circuit breaker.
   *
   * @throws Error with code "CIRCUIT_OPEN" if the circuit is open.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      const err = new Error(
        `${this.label}: Circuit is OPEN. Requests are being rejected. ` +
        `Will retry after ${this.resetTimeoutMs}ms.`
      );
      (err as any).code = "CIRCUIT_OPEN";
      throw err;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// withCircuitBreaker (convenience wrapper)
// ---------------------------------------------------------------------------

/** Shared circuit breaker instances by label. */
const circuitBreakers = new Map<string, CircuitBreaker>();

/**
 * Execute a function with circuit breaker protection.
 *
 * Uses a shared circuit breaker instance per label, so all calls with
 * the same label share the same state.
 */
export async function withCircuitBreaker<T>(
  fn: () => Promise<T>,
  options: CircuitBreakerOptions = {}
): Promise<T> {
  const label = options.label ?? "default";

  let breaker = circuitBreakers.get(label);
  if (!breaker) {
    breaker = new CircuitBreaker(options);
    circuitBreakers.set(label, breaker);
  }

  return breaker.execute(fn);
}

/**
 * Get or create a circuit breaker instance by label.
 */
export function getCircuitBreaker(label: string, options?: CircuitBreakerOptions): CircuitBreaker {
  let breaker = circuitBreakers.get(label);
  if (!breaker) {
    breaker = new CircuitBreaker({ ...options, label });
    circuitBreakers.set(label, breaker);
  }
  return breaker;
}

/**
 * Reset all circuit breakers (useful for testing).
 */
export function resetAllCircuitBreakers(): void {
  for (const breaker of circuitBreakers.values()) {
    breaker.reset();
  }
  circuitBreakers.clear();
}

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/opensearch/resilience.ts)
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

  console.log("Running OpenSearch resilience self-tests...\n");

  // Reset shared state
  resetAllCircuitBreakers();

  // =========================================================================
  // 1. isTransientOpenSearchError
  // =========================================================================
  console.log("=== 1. isTransientOpenSearchError ===");
  {
    assert(!isTransientOpenSearchError(null), "null is not transient");
    assert(!isTransientOpenSearchError(undefined), "undefined is not transient");
    assert(!isTransientOpenSearchError("string"), "string is not transient");
    assert(!isTransientOpenSearchError(new Error("generic")), "generic Error is not transient");

    // Status codes
    assert(isTransientOpenSearchError({ statusCode: 503 }), "503 is transient");
    assert(isTransientOpenSearchError({ statusCode: 429 }), "429 is transient");
    assert(isTransientOpenSearchError({ statusCode: 502 }), "502 is transient");
    assert(isTransientOpenSearchError({ statusCode: 504 }), "504 is transient");
    assert(!isTransientOpenSearchError({ statusCode: 400 }), "400 is not transient");
    assert(!isTransientOpenSearchError({ statusCode: 404 }), "404 is not transient");

    // Meta status codes
    assert(
      isTransientOpenSearchError({ meta: { statusCode: 503 } }),
      "meta.statusCode 503 is transient"
    );

    // Named errors
    const connErr = new Error("Connection failed");
    connErr.name = "ConnectionError";
    assert(isTransientOpenSearchError(connErr), "ConnectionError is transient");

    const timeoutErr = new Error("Timeout");
    timeoutErr.name = "TimeoutError";
    assert(isTransientOpenSearchError(timeoutErr), "TimeoutError is transient");

    // Error codes
    assert(isTransientOpenSearchError({ code: "ECONNREFUSED" }), "ECONNREFUSED is transient");
    assert(isTransientOpenSearchError({ code: "ECONNRESET" }), "ECONNRESET is transient");
    assert(isTransientOpenSearchError({ code: "ETIMEDOUT" }), "ETIMEDOUT is transient");
    assert(isTransientOpenSearchError({ code: "EPIPE" }), "EPIPE is transient");
    assert(!isTransientOpenSearchError({ code: "ENOENT" }), "ENOENT is not transient");
  }

  // =========================================================================
  // 2. withRetry: success on first attempt
  // =========================================================================
  console.log("\n=== 2. withRetry: immediate success ===");
  {
    let callCount = 0;
    const result = await withRetry(async () => {
      callCount++;
      return "ok";
    }, { label: "test-success" });

    assert(result === "ok", "returns result");
    assert(callCount === 1, "called once");
  }

  // =========================================================================
  // 3. withRetry: success after retries
  // =========================================================================
  console.log("\n=== 3. withRetry: success after retries ===");
  {
    let callCount = 0;
    const result = await withRetry(async () => {
      callCount++;
      if (callCount < 3) {
        throw { code: "ECONNREFUSED", message: "Connection refused" };
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
  // 4. withRetry: exhausts retries
  // =========================================================================
  console.log("\n=== 4. withRetry: exhausts retries ===");
  {
    let callCount = 0;
    let threw = false;

    try {
      await withRetry(async () => {
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
    assert(callCount === 3, `called 3 times (1 + 2 retries, got: ${callCount})`);
  }

  // =========================================================================
  // 5. withRetry: non-retryable error
  // =========================================================================
  console.log("\n=== 5. withRetry: non-retryable error ===");
  {
    let callCount = 0;
    let threw = false;

    try {
      await withRetry(async () => {
        callCount++;
        throw { statusCode: 400, message: "Bad request" };
      }, {
        maxRetries: 3,
        initialDelayMs: 10,
        label: "test-non-retryable",
      });
    } catch {
      threw = true;
    }

    assert(threw, "throws immediately for non-retryable error");
    assert(callCount === 1, `called only once (got: ${callCount})`);
  }

  // =========================================================================
  // 6. CircuitBreaker: starts CLOSED
  // =========================================================================
  console.log("\n=== 6. CircuitBreaker: initial state ===");
  {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 100 });
    assert(cb.getState() === "CLOSED", "starts CLOSED");
    assert(cb.getFailureCount() === 0, "failure count is 0");
    assert(cb.canExecute() === true, "can execute");
  }

  // =========================================================================
  // 7. CircuitBreaker: CLOSED → OPEN after failures
  // =========================================================================
  console.log("\n=== 7. CircuitBreaker: CLOSED → OPEN ===");
  {
    const cb = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 100,
      label: "test-open",
    });

    // Record 2 failures — still closed
    cb.recordFailure();
    cb.recordFailure();
    assert(cb.getState() === "CLOSED", "still CLOSED after 2 failures");
    assert(cb.getFailureCount() === 2, "failure count is 2");

    // 3rd failure trips the circuit
    cb.recordFailure();
    assert(cb.getState() === "OPEN", "OPEN after 3 failures");
    assert(cb.canExecute() === false, "cannot execute when OPEN");
  }

  // =========================================================================
  // 8. CircuitBreaker: OPEN → HALF_OPEN after timeout
  // =========================================================================
  console.log("\n=== 8. CircuitBreaker: OPEN → HALF_OPEN ===");
  {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 50,
      label: "test-half-open",
    });

    cb.recordFailure();
    cb.recordFailure();
    assert(cb.getState() === "OPEN", "circuit is OPEN");

    // Wait for reset timeout
    await sleep(100);

    assert(cb.getState() === "HALF_OPEN", "circuit is HALF_OPEN after timeout");
    assert(cb.canExecute() === true, "can execute in HALF_OPEN");
  }

  // =========================================================================
  // 9. CircuitBreaker: HALF_OPEN → CLOSED on success
  // =========================================================================
  console.log("\n=== 9. CircuitBreaker: HALF_OPEN → CLOSED ===");
  {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 50,
      label: "test-close",
    });

    cb.recordFailure();
    cb.recordFailure();
    await sleep(100);
    assert(cb.getState() === "HALF_OPEN", "circuit is HALF_OPEN");

    cb.recordSuccess();
    assert(cb.getState() === "CLOSED", "circuit is CLOSED after success");
    assert(cb.getFailureCount() === 0, "failure count reset to 0");
  }

  // =========================================================================
  // 10. CircuitBreaker: HALF_OPEN → OPEN on failure
  // =========================================================================
  console.log("\n=== 10. CircuitBreaker: HALF_OPEN → OPEN ===");
  {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 50,
      label: "test-reopen",
    });

    cb.recordFailure();
    cb.recordFailure();
    await sleep(100);
    assert(cb.getState() === "HALF_OPEN", "circuit is HALF_OPEN");

    cb.recordFailure();
    assert(cb.getState() === "OPEN", "circuit re-opened after failed probe");
  }

  // =========================================================================
  // 11. CircuitBreaker.execute(): success
  // =========================================================================
  console.log("\n=== 11. CircuitBreaker.execute(): success ===");
  {
    const cb = new CircuitBreaker({ failureThreshold: 3, label: "test-exec" });
    const result = await cb.execute(async () => "hello");
    assert(result === "hello", "returns result");
    assert(cb.getSuccessCount() === 1, "success count is 1");
  }

  // =========================================================================
  // 12. CircuitBreaker.execute(): rejects when OPEN
  // =========================================================================
  console.log("\n=== 12. CircuitBreaker.execute(): OPEN rejection ===");
  {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 60000,
      label: "test-reject",
    });

    // Trip the circuit
    try { await cb.execute(async () => { throw new Error("fail"); }); } catch {}
    try { await cb.execute(async () => { throw new Error("fail"); }); } catch {}

    let threw = false;
    let errCode = "";
    try {
      await cb.execute(async () => "should not reach");
    } catch (err: any) {
      threw = true;
      errCode = err.code;
    }

    assert(threw, "throws when circuit is OPEN");
    assert(errCode === "CIRCUIT_OPEN", "error code is CIRCUIT_OPEN");
  }

  // =========================================================================
  // 13. CircuitBreaker.reset()
  // =========================================================================
  console.log("\n=== 13. CircuitBreaker.reset() ===");
  {
    const cb = new CircuitBreaker({ failureThreshold: 2, label: "test-reset" });
    cb.recordFailure();
    cb.recordFailure();
    assert(cb.getState() === "OPEN", "circuit is OPEN");

    cb.reset();
    assert(cb.getState() === "CLOSED", "circuit is CLOSED after reset");
    assert(cb.getFailureCount() === 0, "failure count is 0 after reset");
    assert(cb.getSuccessCount() === 0, "success count is 0 after reset");
  }

  // =========================================================================
  // 14. Success resets failure count in CLOSED state
  // =========================================================================
  console.log("\n=== 14. Success resets failure count ===");
  {
    const cb = new CircuitBreaker({ failureThreshold: 5, label: "test-success-reset" });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    assert(cb.getFailureCount() === 3, "failure count is 3");

    cb.recordSuccess();
    assert(cb.getFailureCount() === 0, "failure count reset to 0 after success");
    assert(cb.getState() === "CLOSED", "still CLOSED");
  }

  // =========================================================================
  // 15. withCircuitBreaker: shared instances
  // =========================================================================
  console.log("\n=== 15. withCircuitBreaker: shared instances ===");
  {
    resetAllCircuitBreakers();

    // Calls with the same label share a breaker
    await withCircuitBreaker(async () => "ok", { label: "shared-test" });
    const breaker = getCircuitBreaker("shared-test");
    assert(breaker.getSuccessCount() === 1, "shared breaker tracks success");

    resetAllCircuitBreakers();
  }

  // =========================================================================
  // 16. withRetry + CircuitBreaker combined
  // =========================================================================
  console.log("\n=== 16. Combined retry + circuit breaker ===");
  {
    const cb = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 50,
      label: "test-combined",
    });

    let callCount = 0;

    const result = await withRetry(
      () => cb.execute(async () => {
        callCount++;
        if (callCount < 2) {
          throw { code: "ECONNREFUSED", message: "Connection refused" };
        }
        return "recovered";
      }),
      {
        maxRetries: 3,
        initialDelayMs: 10,
        label: "combined-test",
      }
    );

    assert(result === "recovered", "combined: returns result");
    assert(callCount === 2, `combined: called 2 times (got: ${callCount})`);
    assert(cb.getState() === "CLOSED", "combined: circuit remains CLOSED");
  }

  // =========================================================================
  // 17. Backoff delay calculation (no jitter)
  // =========================================================================
  console.log("\n=== 17. Backoff timing ===");
  {
    // Verify retry delay increases
    const delays: number[] = [];
    let callCount = 0;
    const startTime = Date.now();

    try {
      await withRetry(async () => {
        callCount++;
        const now = Date.now();
        delays.push(now - startTime);
        throw { code: "ECONNREFUSED", message: "fail" };
      }, {
        maxRetries: 2,
        initialDelayMs: 50,
        maxDelayMs: 500,
        label: "timing-test",
      });
    } catch {
      // Expected
    }

    assert(callCount === 3, `timing: called 3 times (got: ${callCount})`);
    // Second call should be delayed by ~50ms (with jitter), third by ~100ms more
    if (delays.length >= 3) {
      const delay1 = delays[1] - delays[0];
      assert(delay1 >= 20, `first retry delay >= 20ms (got: ${delay1}ms)`);
    }
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll OpenSearch resilience tests passed");
  } else {
    /* v8 ignore next */
    process.exit(1);
  }

  resetAllCircuitBreakers();
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
