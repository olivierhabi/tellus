// ---------------------------------------------------------------------------
// retry.ts — failure classification, authority errors, and backoff for
// functions-publish (Track 1 items #3/#4).
//
// Classification contract (classify BEFORE any state mutation):
//
//   * "authority"     — RunAuthorityLostError only. The worker no longer
//                       owns the run (cancelled or lease reclaimed). It
//                       must stop immediately and write nothing further.
//   * "transient"     — infrastructure bad luck, safe to retry: a
//                       conservative SQLSTATE allowlist (connection
//                       class 08, serialization 40001, deadlock 40P01,
//                       resource exhaustion 53300/53400, admin/crash
//                       shutdown 57P01-57P03), node net codes from the
//                       pg driver, and TransientStageError raised at
//                       explicit I/O boundaries (Stemma adapter
//                       `kind: "transient"` outcomes).
//   * "deterministic" — everything else: FunctionsPublishError (compat,
//                       invalid function, version conflict), stage
//                       failures from repository code (test/lint), and
//                       ALL unknown errors. Unknown errors default to
//                       deterministic so programming defects fail loudly
//                       instead of being retried into the budget.
//
// Retry budget semantics: MAX_TRANSIENT_RETRIES is the number of RETRIES
// AFTER the initial attempt (initial + up to 3 retries = up to 4
// executions of a stage). retry_count counts retries consumed.
// ---------------------------------------------------------------------------

export type ErrorCategory = "deterministic" | "transient" | "authority";

/**
 * Raised when a conditional (authority-guarded) write or renewal affects
 * zero rows: the worker has lost the run — cancellation drove the
 * lifecycle, another worker reclaimed the lease, or the worker is
 * shutting down. Bypasses the deterministic/transient failure path
 * entirely.
 */
export class RunAuthorityLostError extends Error {
  constructor(readonly reason: "lease-lost" | "cancelled" | "shutdown") {
    super(reason === "cancelled"
      ? "run cancelled"
      : reason === "shutdown"
        ? "worker shutdown"
        : "lease lost");
    this.name = "RunAuthorityLostError";
  }
}

/**
 * Raised at explicit infrastructure I/O boundaries (e.g. a Stemma
 * adapter `transient` outcome) so the classifier can recognize a
 * retryable failure without string matching.
 */
export class TransientStageError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "TransientStageError";
  }
}

/**
 * Retryable Postgres SQLSTATEs — conservative allowlist.
 * Class 08 (connection), 40001 (serialization), 40P01 (deadlock),
 * 53300/53400 (too many connections / configuration limit), and the
 * three shutdown codes 57P01/57P02/57P03. Deliberately NOT all of class
 * 57 (e.g. 57014 query_canceled is not retryable infrastructure), NOT
 * class 23 constraint violations (23505 is a semantic conflict).
 */
const TRANSIENT_SQLSTATE_CLASSES = new Set(["08"]);
const TRANSIENT_SQLSTATES = new Set([
  "40001",
  "40P01",
  "53300",
  "53400",
  "57P01",
  "57P02",
  "57P03",
]);

/** Connection-level codes surfaced by node-pg's underlying socket. */
const TRANSIENT_NET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

export function classifyError(error: unknown): ErrorCategory {
  if (error instanceof RunAuthorityLostError) return "authority";
  if (error instanceof TransientStageError) return "transient";
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      if (TRANSIENT_SQLSTATES.has(code)) return "transient";
      if (code.length === 5 && TRANSIENT_SQLSTATE_CLASSES.has(code.slice(0, 2))) return "transient";
      if (TRANSIENT_NET_CODES.has(code)) return "transient";
    }
  }
  return "deterministic";
}

/** Concise, credential-free description for retry log lines. */
export function describeTransientError(error: unknown): string {
  if (error instanceof TransientStageError) return "adapter transient";
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return `code ${code}`;
  return "infrastructure error";
}

/** Run-scoped authority signal: set by the heartbeat on loss, awaited by backoff. */
export class RunAuthority {
  private lostReason: "lease-lost" | "cancelled" | "shutdown" | null = null;
  private notify: (() => void) | null = null;
  readonly lostPromise: Promise<void> = new Promise((resolve) => {
    this.notify = resolve;
  });
  private deadline: AuthorityDeadline | null = null;

  /** Bind the local-lease-horizon deadline so throwIfLost() also checks it. */
  bindDeadline(deadline: AuthorityDeadline): void {
    this.deadline = deadline;
  }

  lose(reason: "lease-lost" | "cancelled" | "shutdown"): void {
    if (this.lostReason !== null) return;
    this.lostReason = reason;
    this.notify?.();
  }

  get lost(): "lease-lost" | "cancelled" | "shutdown" | null {
    return this.lostReason;
  }

  /**
   * Throws if authority is already lost OR the local authority deadline
   * has passed without a confirmed renewal. The deadline check ensures
   * that persistent heartbeat outages stop ALL work — including non-DB
   * work (subprocesses, compilation, blob reads) — before another worker
   * can legally reclaim the lease.
   */
  throwIfLost(): void {
    if (this.lostReason !== null) throw new RunAuthorityLostError(this.lostReason);
    if (this.deadline?.expired()) {
      this.lose("lease-lost");
      throw new RunAuthorityLostError("lease-lost");
    }
  }
}

/**
 * Local authority validity horizon (Blocker 2 remediation).
 *
 * A worker may only trust its lease until
 *   lastConfirmedRenewal + leaseTtl - renewalSafetyMargin
 * on a MONOTONIC clock. A transient renewal failure never extends
 * the horizon; only a successfully affected renewal row may. Once
 * the horizon passes without a confirmed renewal, the worker must
 * assume another worker can legally reclaim and stop ALL work —
 * including non-database work (test subprocesses, compilation,
 * blob reads) that authority-guarded SQL cannot constrain.
 */
export class AuthorityDeadline {
  private deadlineAt: number;

  constructor(
    private readonly leaseTtlMs: number,
    private readonly safetyMarginMs: number,
    private readonly now: () => number,
  ) {
    this.deadlineAt = this.compute();
  }

  private compute(): number {
    return this.now() + this.leaseTtlMs - this.safetyMarginMs;
  }

  /** Only a successfully confirmed renewal may extend the horizon. */
  confirmRenewal(): void {
    this.deadlineAt = this.compute();
  }

  expired(): boolean {
    return this.now() >= this.deadlineAt;
  }
}

export interface LifecycleTunables {
  /** Lease duration; shared by claim and renewal so they cannot drift. */
  readonly leaseTtlMs: number;
  /** Heartbeat cadence; strictly less than leaseTtlMs (clamped in resolve). */
  readonly heartbeatIntervalMs: number;
  /**
   * Local safety horizon: the worker abandons authority this long
   * BEFORE the last confirmed lease expiry, so a persistent renewal
   * outage stops all work (including non-DB work) before another
   * worker can legally reclaim. Clamped to [heartbeatInterval, ttl/2].
   */
  readonly renewalSafetyMarginMs: number;
  /** Grace period stop() waits for aborted executions to settle. */
  readonly shutdownGraceMs: number;
  /** Retries AFTER the initial attempt. */
  readonly maxTransientRetries: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  /** Randomness source for jitter (injected for deterministic tests). */
  readonly random: () => number;
  /** Sleep implementation (injected for deterministic tests). */
  readonly sleep: (ms: number) => Promise<void>;
  /** Monotonic clock in ms (injected for deterministic tests). */
  readonly now: () => number;
  /** Observability hook fired when a run's authority is lost. */
  readonly onAuthorityLost?: (runRid: string, reason: string) => void;
}

export const DEFAULT_LEASE_TTL_MS = 600_000; // 10 minutes — matches the historical claim interval
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
export const DEFAULT_RENEWAL_SAFETY_MARGIN_MS = 30_000;
export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
export const DEFAULT_MAX_TRANSIENT_RETRIES = 3;
export const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
export const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

const LEASE_TTL_BOUNDS = { min: 1_000, max: 3_600_000 } as const;
const HEARTBEAT_BOUNDS = { min: 50, max: 600_000 } as const;
const RETRY_COUNT_BOUNDS = { min: 0, max: 10 } as const;
const RETRY_DELAY_BOUNDS = { min: 10, max: 300_000 } as const;
const SHUTDOWN_GRACE_BOUNDS = { min: 100, max: 120_000 } as const;

export const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const monotonicNow = (): number => performance.now();

/** Env-backed with clamping — same convention as FUNCTIONS_PUBLISH_CONCURRENCY. */
export function resolveLifecycleTunables(
  env: NodeJS.ProcessEnv = process.env,
): LifecycleTunables {
  const leaseTtlMs = bounded(env.FUNCTIONS_PUBLISH_LEASE_TTL_MS, DEFAULT_LEASE_TTL_MS, LEASE_TTL_BOUNDS);
  const requestedHeartbeat = bounded(
    env.FUNCTIONS_PUBLISH_HEARTBEAT_INTERVAL_MS,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
    HEARTBEAT_BOUNDS,
  );
  // Strictly below the TTL: at most a third of it, so a slow tick
  // still renews long before expiry.
  const heartbeatIntervalMs = Math.min(requestedHeartbeat, Math.floor(leaseTtlMs / 3));
  const requestedMargin = bounded(
    env.FUNCTIONS_PUBLISH_RENEWAL_SAFETY_MARGIN_MS,
    DEFAULT_RENEWAL_SAFETY_MARGIN_MS,
    { min: 1, max: leaseTtlMs },
  );
  return {
    leaseTtlMs,
    heartbeatIntervalMs,
    // The margin must exceed the heartbeat cadence (so a missed tick
    // is detected before the true expiry) and stay well below the TTL.
    renewalSafetyMarginMs: Math.min(
      Math.max(requestedMargin, heartbeatIntervalMs),
      Math.floor(leaseTtlMs / 2),
    ),
    shutdownGraceMs: bounded(
      env.FUNCTIONS_PUBLISH_SHUTDOWN_GRACE_MS,
      DEFAULT_SHUTDOWN_GRACE_MS,
      SHUTDOWN_GRACE_BOUNDS,
    ),
    maxTransientRetries: bounded(
      env.FUNCTIONS_PUBLISH_MAX_TRANSIENT_RETRIES,
      DEFAULT_MAX_TRANSIENT_RETRIES,
      RETRY_COUNT_BOUNDS,
    ),
    retryBaseDelayMs: bounded(env.FUNCTIONS_PUBLISH_RETRY_BASE_DELAY_MS, DEFAULT_RETRY_BASE_DELAY_MS, RETRY_DELAY_BOUNDS),
    retryMaxDelayMs: bounded(env.FUNCTIONS_PUBLISH_RETRY_MAX_DELAY_MS, DEFAULT_RETRY_MAX_DELAY_MS, RETRY_DELAY_BOUNDS),
    random: Math.random,
    sleep: realSleep,
    now: monotonicNow,
  };
}

/**
 * Jittered exponential backoff (full jitter):
 *   delay = random(0, min(cap, base * 2^(retryNumber - 1)))
 * retryNumber is 1-based (first retry = 1).
 */
export function computeBackoffMs(
  retryNumber: number,
  tunables: Pick<LifecycleTunables, "retryBaseDelayMs" | "retryMaxDelayMs" | "random">,
): number {
  const ceiling = Math.min(
    tunables.retryMaxDelayMs,
    tunables.retryBaseDelayMs * 2 ** Math.max(0, retryNumber - 1),
  );
  return Math.floor(tunables.random() * ceiling);
}

function bounded(
  raw: string | undefined,
  fallback: number,
  { min, max }: { min: number; max: number },
): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
