// ---------------------------------------------------------------------------
// ThroughputGuard — shared between PB-B5 streaming pipelines and the
// Funnel's Changelog activity.
//
// PB-B5 acceptance (f): a per-subject 2 MB/s default cap with an
// admission-control API that rejects bursts above the configured rate.
// PB-B5 also needs hard ceilings (50 MB/s with admin override) and a
// parallelism cap (<=16).
//
// The guard implements a **token bucket** with a `capacity` (burst) and
// `rateBytesPerSec` refill. Every call to `admit(bytes)` returns:
//   * { ok: true, waitMs: 0 }  — tokens are available, caller proceeds.
//   * { ok: true, waitMs: N }  — caller must wait N ms before emitting;
//     used by producers that can pace themselves.
//   * { ok: false, reason }    — bytes exceed the burst capacity OR
//     exceed the hard ceiling; caller must reject (e.g., return a
//     FLINK-side error to upstream).
//
// The Funnel's ChangelogStage wraps its per-batch call into admit(), so
// the same token bucket enforces 2 MB/s at both the Funnel ingest edge
// and the Pipeline-Builder Flink source edge. One implementation, two
// consumers — ship it as a vanilla module (no DB, no I/O) so it's
// cheap to import from a Flink operator wrapper too.
// ---------------------------------------------------------------------------

export interface ThroughputGuardOptions {
  /** Refill rate in bytes / second. Default: 2 MB/s = 2*1024*1024. */
  rateBytesPerSec?: number;
  /** Burst capacity in bytes. Default: 1 second of rate. */
  capacityBytes?: number;
  /**
   * Hard ceiling the caller is forbidden to raise without admin
   * override. Guards against accidental per-subject raises
   * destabilising the whole cluster. Default: 50 MB/s.
   */
  hardCeilingBytesPerSec?: number;
  /**
   * Max parallelism per subject (Flink subtasks). Default: 16.
   */
  maxParallelism?: number;
  /** Time source; swappable for deterministic tests. Default: Date.now. */
  now?: () => number;
}

export interface AdmitResult {
  ok: boolean;
  /** Milliseconds the caller should wait before emitting. 0 if immediate. */
  waitMs: number;
  /** Reason on `ok=false`. */
  reason?:
    | "BYTES_EXCEED_BURST"
    | "RATE_EXCEEDS_HARD_CEILING"
    | "PARALLELISM_EXCEEDS_HARD_CEILING";
  /** Current token snapshot for observability / tests. */
  tokens: number;
}

// Default caps exported so the Funnel and Pipeline-Builder agree on
// baseline without having to coordinate through code review.
export const DEFAULT_RATE_BYTES_PER_SEC = 2 * 1024 * 1024; // 2 MB/s
export const DEFAULT_BURST_BYTES = 2 * 1024 * 1024; // 1 second of burst
export const DEFAULT_HARD_CEILING_BYTES_PER_SEC = 50 * 1024 * 1024; // 50 MB/s
export const DEFAULT_MAX_PARALLELISM = 16;

export class ThroughputGuard {
  readonly rateBytesPerSec: number;
  readonly capacityBytes: number;
  readonly hardCeilingBytesPerSec: number;
  readonly maxParallelism: number;
  private tokens: number;
  private lastRefillMs: number;
  private readonly now: () => number;

  constructor(opts: ThroughputGuardOptions = {}) {
    this.rateBytesPerSec = opts.rateBytesPerSec ?? DEFAULT_RATE_BYTES_PER_SEC;
    this.capacityBytes = opts.capacityBytes ?? DEFAULT_BURST_BYTES;
    this.hardCeilingBytesPerSec =
      opts.hardCeilingBytesPerSec ?? DEFAULT_HARD_CEILING_BYTES_PER_SEC;
    this.maxParallelism = opts.maxParallelism ?? DEFAULT_MAX_PARALLELISM;
    this.now = opts.now ?? Date.now;
    this.tokens = this.capacityBytes;
    this.lastRefillMs = this.now();

    if (this.rateBytesPerSec > this.hardCeilingBytesPerSec) {
      throw new Error(
        `ThroughputGuard: rateBytesPerSec=${this.rateBytesPerSec} exceeds ` +
          `hardCeilingBytesPerSec=${this.hardCeilingBytesPerSec}`,
      );
    }
    if (this.maxParallelism > DEFAULT_MAX_PARALLELISM && !opts.maxParallelism) {
      throw new Error(
        `ThroughputGuard: maxParallelism default exceeds hard ceiling`,
      );
    }
  }

  /**
   * Refill the bucket to the current time. Lazy: called from admit().
   */
  private refill(nowMs: number): void {
    const elapsedMs = nowMs - this.lastRefillMs;
    if (elapsedMs <= 0) return;
    const refill = (elapsedMs / 1000) * this.rateBytesPerSec;
    this.tokens = Math.min(this.capacityBytes, this.tokens + refill);
    this.lastRefillMs = nowMs;
  }

  /**
   * Try to admit `bytes`. If `bytes > capacity`, reject (the caller's
   * input unit is too big — split it). Otherwise consume tokens and
   * return either immediate-ok or an ok-with-wait-ms so the caller
   * paces itself.
   */
  admit(bytes: number): AdmitResult {
    if (bytes < 0) throw new Error("admit(bytes): bytes must be >= 0");
    const nowMs = this.now();
    this.refill(nowMs);

    if (bytes > this.capacityBytes) {
      // Single-unit burst exceeds the full bucket — reject. Splitting
      // inputs into smaller chunks is the caller's responsibility
      // (Flink source operators read in record-sized batches; the
      // Funnel Changelog reads in PK-keyed shards).
      return {
        ok: false,
        reason: "BYTES_EXCEED_BURST",
        waitMs: 0,
        tokens: this.tokens,
      };
    }

    if (this.tokens >= bytes) {
      this.tokens -= bytes;
      return { ok: true, waitMs: 0, tokens: this.tokens };
    }

    // Not enough tokens right now; compute the wait until enough refill
    // has happened. This keeps the caller pacing deterministically.
    const deficit = bytes - this.tokens;
    const waitMs = Math.ceil((deficit / this.rateBytesPerSec) * 1000);
    // Consume speculatively — the caller commits to waiting.
    this.tokens -= bytes;
    return { ok: true, waitMs, tokens: this.tokens };
  }

  /**
   * Validate a requested pipeline-level parallelism against the guard's
   * ceiling (PB-B5: per-pipeline max 16). Used by the streaming deploy
   * path to reject configuration bursts at compile time.
   */
  validateParallelism(requested: number): AdmitResult {
    if (requested <= 0) {
      return {
        ok: false,
        reason: "PARALLELISM_EXCEEDS_HARD_CEILING",
        waitMs: 0,
        tokens: this.tokens,
      };
    }
    if (requested > this.maxParallelism) {
      return {
        ok: false,
        reason: "PARALLELISM_EXCEEDS_HARD_CEILING",
        waitMs: 0,
        tokens: this.tokens,
      };
    }
    return { ok: true, waitMs: 0, tokens: this.tokens };
  }

  /**
   * Validate an operator-configured rate override against the hard
   * ceiling (50 MB/s). Admins who want to go higher must raise the
   * ceiling explicitly — no silent expansion.
   */
  validateRateRequest(requestedBytesPerSec: number): AdmitResult {
    if (requestedBytesPerSec <= 0) {
      return {
        ok: false,
        reason: "RATE_EXCEEDS_HARD_CEILING",
        waitMs: 0,
        tokens: this.tokens,
      };
    }
    if (requestedBytesPerSec > this.hardCeilingBytesPerSec) {
      return {
        ok: false,
        reason: "RATE_EXCEEDS_HARD_CEILING",
        waitMs: 0,
        tokens: this.tokens,
      };
    }
    return { ok: true, waitMs: 0, tokens: this.tokens };
  }
}

// ---------------------------------------------------------------------------
// Process-wide registry of guards keyed by subject (object-type api name
// for the Funnel, pipeline id for the Pipeline-Builder). One guard per
// subject so the 2 MB/s cap is per-OT / per-pipeline, not global.
// ---------------------------------------------------------------------------

const registry = new Map<string, ThroughputGuard>();

export function getGuard(
  subject: string,
  opts?: ThroughputGuardOptions,
): ThroughputGuard {
  const hit = registry.get(subject);
  if (hit) return hit;
  const fresh = new ThroughputGuard(opts);
  registry.set(subject, fresh);
  return fresh;
}

export function resetGuardsForTests(): void {
  registry.clear();
}
