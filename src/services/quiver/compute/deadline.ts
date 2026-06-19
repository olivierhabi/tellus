/**
 * B5 — Deadline parsing + propagation.
 *
 * Per G-06 / B5 C-09:
 *   - Client supplies `X-Deadline: <isoInstant>` (ISO-8601, UTC).
 *   - Or `deadlineMs` in the body for direct relative budget.
 *   - Coordinator computes remainingMs = deadline - now() and propagates
 *     the reduced budget to backends.
 *   - Backend that estimates work > remainingMs returns DEADLINE_EXCEEDED
 *     at the boundary (not at completion).
 */

export interface Deadline {
  /** Absolute deadline as epoch ms. */
  readonly deadlineEpochMs: number;
  /** Snapshot of remaining budget at construction time, in ms. */
  readonly initialBudgetMs: number;
}

export class DeadlineExceededError extends Error {
  readonly code = 'DEADLINE_EXCEEDED';
  constructor(message = 'Deadline exceeded') {
    super(message);
    this.name = 'DeadlineExceededError';
  }
}

export function parseDeadlineHeader(headerValue: string | undefined, nowMs: number): Deadline | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`X-Deadline: not a valid ISO-8601 instant: ${trimmed}`);
  }
  return {
    deadlineEpochMs: parsed,
    initialBudgetMs: parsed - nowMs,
  };
}

export function deadlineFromBudget(budgetMs: number, nowMs: number): Deadline {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new Error(`invalid deadlineMs: ${budgetMs}`);
  }
  return {
    deadlineEpochMs: nowMs + budgetMs,
    initialBudgetMs: budgetMs,
  };
}

export function remainingMs(deadline: Deadline, nowMs: number): number {
  return deadline.deadlineEpochMs - nowMs;
}

export function assertBudget(deadline: Deadline, requiredMs: number, nowMs: number): void {
  const remaining = remainingMs(deadline, nowMs);
  if (remaining < requiredMs) {
    throw new DeadlineExceededError(
      `remaining budget ${remaining}ms < required ${requiredMs}ms`,
    );
  }
}

/**
 * Run `fn(remainingMs)` against a deadline; if the budget is already exhausted
 * we throw DeadlineExceededError synchronously (B5 C-09: at the boundary).
 */
export async function withDeadline<T>(
  deadline: Deadline,
  fn: (remainingMs: number) => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const remaining = remainingMs(deadline, now());
  if (remaining <= 0) {
    throw new DeadlineExceededError(`remaining budget ${remaining}ms <= 0`);
  }
  // Race fn() against a setTimeout that throws when the deadline elapses.
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError(`deadline exceeded after ${remaining}ms`)), remaining);
    if (timer.unref) timer.unref();
  });
  try {
    return await Promise.race([fn(remaining), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
