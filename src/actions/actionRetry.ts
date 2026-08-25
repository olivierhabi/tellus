// ---------------------------------------------------------------------------
// Action Retry Wrapper — Bounded Deadlock / Serialization Retry (§6)
//
// Wraps the action's PG transaction with bounded retries for the only
// retryable concurrency failures PostgreSQL raises:
//   * 40P01 — deadlock_detected
//   * 40001 — serialization_failure
//   * 40P02 — concurrent transaction failure (rare, retryable)
//
// Domain-validation errors are NEVER retried. Jittered exponential backoff
// prevents thundering-herd retry storms. On exhaustion, a structured
// DEADLOCK_RETRY_EXHAUSTED error is returned.
// ---------------------------------------------------------------------------

const RETRYABLE_PGCODES = new Set(["40P01", "40001", "40P02"]);

export const ACTION_RETRY_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 25;
const MAX_BACKOFF_MS = 500;

export interface RetryOutcome<T> {
  ok: boolean;
  result?: T;
  error?: { code: "DEADLOCK_RETRY_EXHAUSTED" | "CONCURRENCY_CONFLICT"; message: string; attempts: number };
  attempts: number;
}

/** Is a thrown error a PostgreSQL deadlock/serialization failure worth retrying? */
export function isRetryablePgError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return typeof code === "string" && RETRYABLE_PGCODES.has(code);
}

/** Jittered exponential backoff duration for attempt n (0-indexed). */
export function backoffMs(attempt: number): number {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  // full jitter
  return Math.floor(Math.random() * exp);
}

/**
 * Run `fn` with bounded retries on retryable PG concurrency failures.
 * `fn` must be idempotent at the transaction boundary (it opens and either
 * commits or rolls back its own transaction). Domain errors thrown by `fn`
 * propagate immediately (no retry).
 */
export async function withBoundedRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { maxAttempts?: number; onRetry?: (attempt: number, err: unknown) => void } = {},
): Promise<RetryOutcome<T>> {
  const maxAttempts = opts.maxAttempts ?? ACTION_RETRY_MAX_ATTEMPTS;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await fn(attempt);
      return { ok: true, result, attempts: attempt + 1 };
    } catch (err) {
      lastErr = err;
      if (!isRetryablePgError(err)) {
        // Domain / non-retryable — rethrow as a normal failure.
        throw err;
      }
      opts.onRetry?.(attempt, err);
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      }
    }
  }
  const code = (lastErr as { code?: string } | undefined)?.code;
  return {
    ok: false,
    error: {
      code: code === "40001" ? "CONCURRENCY_CONFLICT" : "DEADLOCK_RETRY_EXHAUSTED",
      message: `Action transaction failed after ${maxAttempts} retry attempt(s) (last PG code: ${code ?? "unknown"}).`,
      attempts: maxAttempts,
    },
    attempts: maxAttempts,
  };
}
