// ---------------------------------------------------------------------------
// src/lib/redisConnect.ts
//
// The ONE place that knows how to open a node-redis connection safely.
//
// WHY THIS EXISTS — 2026-08-16 production incident. Six modules had each
// hand-rolled the same client bootstrap, and five of them shared the same
// latent deadlock:
//
//     reconnectStrategy: (retries) => Math.min(retries * 500, 30_000)
//
// In node-redis v4 a **numeric** return means "retry again after N ms", so
// that strategy retries FOREVER. `client.connect()` only settles when a
// connection is established or the strategy gives up — so with a dead Redis
// it NEVER settles. Every one of those modules caches the pending promise in
// a module-level `redisConnecting` / `redisInstance` slot, so the first caller
// hangs and every subsequent caller awaits the same never-settling promise.
//
// Observed blast radius when `tellus-redis-1` was down for three days:
//   * funnel/mergeProgress.ts  → the merge stage hung forever at its first
//     `readMergeProgress()`, so ObjectStorage V2 indexing sat on "Merge
//     changes" indefinitely. Its own header comment promised "fail open …
//     Redis can never block or fail the merge" — the code did the opposite.
//   * boot/cacheAndRateLimit.ts → server BOOT hung when
//     RATE_LIMIT_BACKEND=redis.
//   * uploadProgress / linkPagination / bffSessionService → uploads, link
//     pagination and BFF session reads all block on first use.
//
// A `socket.connectTimeout` does NOT save you: it bounds only the TCP
// SYN/ACK. A frozen-but-listening Redis (cgroup freezer, a paused container,
// an overloaded instance) completes the TCP handshake and then never answers
// AUTH/HELLO, so connect() still hangs with connectTimeout set.
//
// TWO defenses are therefore required, and both live here:
//   1. a reconnect strategy that GIVES UP (returns `false`) after a bounded
//      number of attempts, so connect() rejects instead of retrying forever;
//   2. a wall-clock `Promise.race` deadline around connect() itself, which is
//      the only thing that bounds a post-TCP handshake stall.
//
// This is the generalization of the already-correct implementation in
// services/overlay/getOverlayStore.ts (F-P4-05 / F-P4-05b), which was the
// one module that got it right.
//
// CONTRACT
//   * `connectRedisBounded` NEVER hangs. It resolves with a client or rejects
//     within roughly REDIS_CONNECT_DEADLINE_MS (default 3s).
//   * On rejection the client socket is destroyed, so a failed attempt leaves
//     no background reconnect loop and no leaked handle keeping the event
//     loop alive.
//   * Callers decide the failure policy. Fail-open callers (progress
//     checkpoints, caches) should catch and degrade; fail-closed callers
//     should propagate.
// ---------------------------------------------------------------------------

/** Bounded number of reconnect attempts before the strategy gives up. */
const MAX_RECONNECT_ATTEMPTS = Number(
  process.env.REDIS_MAX_RECONNECT_ATTEMPTS ?? 3,
);

/** Wall-clock ceiling on the whole connect handshake, incl. AUTH/HELLO. */
export function redisConnectDeadlineMs(): number {
  const raw = Number(process.env.REDIS_CONNECT_DEADLINE_MS ?? 3_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 3_000;
}

/**
 * The reconnect strategy every Tellus Redis client must use.
 *
 * Returning `false` tells node-redis to stop retrying and settle the pending
 * `connect()` with an error — the behaviour the numeric-return form can never
 * produce. Exported so tests can assert the give-up boundary directly.
 */
export function boundedReconnectStrategy(
  retries: number,
): number | false {
  if (retries >= MAX_RECONNECT_ATTEMPTS) return false;
  return Math.min((retries + 1) * 500, 2_000);
}

/** Socket options carrying both defenses. Spread into createClient options. */
export function boundedRedisSocketOptions(): {
  connectTimeout: number;
  reconnectStrategy: (retries: number) => number | false;
} {
  return {
    connectTimeout: 5_000,
    reconnectStrategy: boundedReconnectStrategy,
  };
}

export function describeRedisError(err: unknown): string {
  if (err instanceof Error) {
    // node-redis wraps socket failures in AggregateError with an empty
    // message, which makes logs useless. Unwrap the first real cause.
    const agg = err as Error & { errors?: unknown[] };
    if (Array.isArray(agg.errors) && agg.errors.length > 0) {
      const first = agg.errors[0];
      if (first instanceof Error && first.message) {
        return `${err.name}: ${first.message}`;
      }
    }
    return err.message || err.name;
  }
  return String(err);
}

interface MinimalClient {
  connect(): Promise<unknown>;
  on(event: string, cb: (err: Error) => void): unknown;
  destroy?(): void;
  disconnect?(): Promise<unknown> | void;
}

export interface ConnectRedisOptions {
  /** Redis URL. Defaults to REDIS_URL, then redis://localhost:6379. */
  url?: string;
  /** Optional password (used by the rate-limit boot path). */
  password?: string;
  /** Log prefix for the single warning emitted on error, e.g. "[merge]". */
  logPrefix?: string;
  /** Override the connect deadline (tests). */
  deadlineMs?: number;
}

/**
 * Open a node-redis client that is guaranteed to settle.
 *
 * Rejects (never hangs) when Redis is down, frozen, or the `redis` package is
 * not installed. Callers own the degrade-vs-fail decision.
 */
export async function connectRedisBounded<T = unknown>(
  options: ConnectRedisOptions = {},
): Promise<T> {
  const url =
    options.url ?? process.env.REDIS_URL ?? "redis://localhost:6379";
  const prefix = options.logPrefix ?? "[redis]";
  const deadlineMs = options.deadlineMs ?? redisConnectDeadlineMs();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import("redis");
  const client: MinimalClient = mod.createClient({
    url,
    ...(options.password ? { password: options.password } : {}),
    socket: boundedRedisSocketOptions(),
  });

  // node-redis emits 'error' on every failed (re)connect attempt. Log only
  // the first so a transient outage cannot flood the log; the connect()
  // rejection below is what actually drives the caller's fallback.
  let loggedError = false;
  client.on("error", (err: Error) => {
    if (loggedError) return;
    loggedError = true;
    console.warn(`${prefix} redis error: ${describeRedisError(err)}`);
  });

  let deadlineTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimeout(
          () =>
            reject(
              new Error(
                `redis connect deadline exceeded after ${deadlineMs}ms (${url})`,
              ),
            ),
          deadlineMs,
        );
        // Do not let the deadline timer alone keep the process alive.
        deadlineTimer.unref?.();
      }),
    ]);
  } catch (err) {
    // Tear the socket down so a rejected attempt leaves no background
    // reconnect loop and no open handle. `destroy()` is node-redis v4.7+;
    // fall back to disconnect() on older builds.
    try {
      if (typeof client.destroy === "function") client.destroy();
      else await client.disconnect?.();
    } catch {
      /* already closed — nothing to release */
    }
    throw err;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }

  return client as unknown as T;
}
