// ---------------------------------------------------------------------------
// Security Backfill — OpenSearch-resilient helper (Gap M)
//
// Stamps `_security.markings: ['PUBLIC']` on documents that predate the
// Phase A4 remediation. The script (`scripts/backfill-security.ts`) is run
// at test-server startup and as a one-shot migration. The previous version
// FATAL-exited (status 1) whenever OpenSearch was slow or unreachable,
// which the completion directive (§17) calls out: "OpenSearch security
// backfill can still time out when OpenSearch is unavailable."
//
// This module makes the backfill OpenSearch-resilient per §17:
//   * `classifyBackfillError` distinguishes a transient OpenSearch
//     UNAVAILABILITY (connection refused / timeout / 5xx) from a NOT_FOUND
//     index (no-op) and a genuine FATAL (logic / 4xx-non-404 error).
//   * `withBoundedRetry` retries only on UNAVAILABILITY with bounded
//     exponential backoff (no infinite startup blocking); when OS stays
//     unavailable it returns `{ deferred: true }` so the caller DEFERS the
//     backfill (exit 0, clear log) — idempotent, so the next run picks it
//     up. No silent data loss: a deferred run wrote nothing.
//   * `backfillIndexOnce` is the single update-by-query, isolated so tests
//     inject a mock OpenSearch client.
//
// OpenSearch is NOT optional for action execution (objectChecker reads it,
// editApplicator writes it), but it IS optional for STARTUP: the server must
// boot and serve even when OpenSearch is briefly unavailable, and the
// security backfill must not block or fatal-exit on a transient outage.
// ---------------------------------------------------------------------------

export type BackfillErrorClass = "unavailable" | "not_found" | "fatal";

export interface OpenSearchLike {
  updateByQuery: (params: Record<string, unknown>) => Promise<{ body: unknown }>;
  cat?: { indices: (params: Record<string, unknown>) => Promise<{ body: unknown }> };
}

export interface BackfillResult {
  index: string;
  updated: number;
  noop: number;
  failures: number;
}

export interface RetryOutcome<T> {
  result?: T;
  deferred: boolean;
  attempts: number;
  lastErrorClass?: BackfillErrorClass;
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  jitterMs: number;
}

export const DEFAULT_BACKFILL_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 500,
  jitterMs: 200,
};

/**
 * Classify an OpenSearch error from an update-by-query / cat call.
 *
 *   * `not_found` — HTTP 404. The index does not exist yet. The backfill is
 *     a no-op for this index (a future write will create it; no data loss).
 *   * `unavailable` — connection-level failure (ECONNREFUSED, ECONNRESET,
 *     socket timeout), or HTTP 503/502/504/408. Transient — retried.
 *   * `fatal` — anything else (a 4xx-non-404, a script error, a logic bug).
 *     NOT retried — surfacing it is the correct behaviour.
 */
export function classifyBackfillError(err: any): BackfillErrorClass {
  const status =
    err?.statusCode ??
    err?.meta?.statusCode ??
    err?.body?.status ??
    err?.body?.error?.status ??
    (typeof err?.status === "number" ? err.status : undefined);
  if (status === 404) return "not_found";
  const code = err?.code ?? err?.meta?.body?.error?.type;
  const message = String(err?.message ?? err ?? "").toLowerCase();
  if (
    status === 503 ||
    status === 502 ||
    status === 504 ||
    status === 408 ||
    code === " ConnectionError ".trim() ||
    code === "ConnectionError" ||
    code === "ResponseTimeoutError" ||
    code === "RequestAbortedError" ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("connect etimedout") ||
    message.includes("no living connections")
  ) {
    return "unavailable";
  }
  return "fatal";
}

/**
 * Run `fn` with bounded retry on the `unavailable` class only. Returns a
 * deferred outcome when every attempt was unavailable (OpenSearch down).
 * `not_found` and `fatal` are NOT retried: not_found is a no-op success,
 * fatal must surface.
 *
 * Determinism: the jitter is injected via `random()` callable so tests can
 * stub the clock + randomness (the workflow-script sandbox forbids
 * Math.random, but this module runs in vitest/tsx, not the sandbox).
 */
export async function withBoundedRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = DEFAULT_BACKFILL_RETRY,
  inject: { sleep: (ms: number) => Promise<void>; random: () => number } = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    random: Math.random,
  },
): Promise<RetryOutcome<T>> {
  let lastClass: BackfillErrorClass | undefined;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
    try {
      const result = await fn();
      return { result, deferred: false, attempts: attempt };
    } catch (err: any) {
      lastClass = classifyBackfillError(err);
      if (lastClass === "not_found") {
        // No-op success — index absent. Not an error to the caller.
        return { result: undefined as unknown as T, deferred: false, attempts: attempt, lastErrorClass: "not_found" };
      }
      if (lastClass === "fatal") {
        return { deferred: false, attempts: attempt, lastErrorClass: "fatal" };
      }
      // unavailable → retry after bounded backoff (non-final attempt only).
      if (attempt < opts.maxAttempts) {
        const backoff = opts.baseDelayMs * 2 ** (attempt - 1) + inject.random() * opts.jitterMs;
        await inject.sleep(backoff);
      }
    }
  }
  return { deferred: true, attempts: opts.maxAttempts, lastErrorClass: lastClass ?? "unavailable" };
}

const SECURITY_BACKFILL_SCRIPT = `
  if (ctx._source._security == null) {
    ctx._source._security = ['markings': params.defaultMarkings, 'cbac': []];
  } else if (ctx._source._security.markings == null || ctx._source._security.markings.size() == 0) {
    ctx._source._security.markings = params.defaultMarkings;
    if (ctx._source._security.cbac == null) { ctx._source._security.cbac = []; }
  } else {
    ctx.op = 'noop';
  }
`.trim();

/**
 * One backfill attempt for a single index. Isolated so tests inject a mock
 * client. Returns the per-index result; throws on non-404 errors so the
 * bounded-retry wrapper can classify them.
 */
export async function backfillIndexOnce(
  client: OpenSearchLike,
  indexName: string,
  defaultMarking: string,
): Promise<BackfillResult> {
  try {
    const { body } = await client.updateByQuery({
      index: indexName,
      refresh: true,
      conflicts: "proceed",
      body: {
        script: { source: SECURITY_BACKFILL_SCRIPT, params: { defaultMarkings: [defaultMarking] } },
        query: { match_all: {} },
      },
    });
    const resp = body as { updated?: number; noops?: number; failures?: Array<unknown> };
    return {
      index: indexName,
      updated: resp.updated ?? 0,
      noop: resp.noops ?? 0,
      failures: Array.isArray(resp.failures) ? resp.failures.length : 0,
    };
  } catch (err: any) {
    if (classifyBackfillError(err) === "not_found") {
      return { index: indexName, updated: 0, noop: 0, failures: 0 };
    }
    throw err;
  }
}

/**
 * Run-classify result the script aggregates to decide exit code + log.
 */
export interface BackfillRunReport {
  indices: number;
  totalUpdated: number;
  totalFailures: number;
  deferred: number;
  fatal: number;
  perIndex: BackfillResult[];
}

/**
 * Drive the full backfill over a list of indices with per-index bounded
 * retry. Returns the aggregate report the script logs + uses for its exit
 * decision. A deferred index does NOT fatal-exit (OpenSearch unavailable) —
 * the script exits 0 with a DEFERRED log so the next run retries idempotently.
 * A fatal index DOES fatal-exit (genuine script / 4xx error). Per-index 404
 * (not_found) is a no-op success.
 */
export async function runSecurityBackfill(
  client: OpenSearchLike,
  indices: string[],
  defaultMarking: string,
  retry: RetryOptions = DEFAULT_BACKFILL_RETRY,
  inject: { sleep: (ms: number) => Promise<void>; random: () => number } = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    random: Math.random,
  },
): Promise<BackfillRunReport> {
  const perIndex: BackfillResult[] = [];
  let deferred = 0;
  let fatal = 0;
  for (const index of indices) {
    const outcome = await withBoundedRetry(
      () => backfillIndexOnce(client, index, defaultMarking),
      retry,
      inject,
    );
    if (outcome.deferred) {
      deferred += 1;
      perIndex.push({ index, updated: 0, noop: 0, failures: 0 });
      console.error(`  [DEFERRED] ${index} — OpenSearch unavailable; idempotent retry on next run`);
    } else if (outcome.lastErrorClass === "fatal") {
      fatal += 1;
      perIndex.push({ index, updated: 0, noop: 0, failures: 1 });
      console.error(`  [FATAL] ${index} — backfill script/logic error (not retried)`);
    } else if (outcome.result) {
      perIndex.push(outcome.result);
      const r = outcome.result;
      const tag = r.failures > 0 ? "FAIL" : r.updated > 0 ? "MIG" : "OK";
      console.error(`  [${tag}] ${r.index}  updated=${r.updated}  noop=${r.noop}  failures=${r.failures}`);
    } else {
      // not_found no-op.
      perIndex.push({ index, updated: 0, noop: 0, failures: 0 });
      console.error(`  [OK] ${index} — index absent (no-op)`);
    }
  }
  return {
    indices: perIndex.length,
    totalUpdated: perIndex.reduce((s, r) => s + r.updated, 0),
    totalFailures: perIndex.reduce((s, r) => s + r.failures, 0),
    deferred,
    fatal,
    perIndex,
  };
}
