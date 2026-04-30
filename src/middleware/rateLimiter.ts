// ---------------------------------------------------------------------------
// Action Execution Rate Limiter (Task 27)
//
// In-memory sliding window rate limiter for action execution endpoints.
// Provides granular rate limiting at three scopes:
//
//   1. Per action type  — max 100 executions per minute per action type
//   2. Per user         — max 500 executions per minute per user
//   3. Global           — max 2000 executions per minute across entire system
//   4. Batch per user   — max 10 batch requests per minute per user
//
// This is separate from the global express-rate-limit middleware (200 req/min
// per IP) which protects all endpoints. This rate limiter specifically targets
// action execution to prevent runaway automation and abuse.
//
// In production, this would be backed by Redis for multi-instance deployments.
// The in-memory implementation is sufficient for single-instance deployments.
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { RedisRateLimiter } from "../services/rateLimit/redisRateLimiter";
import { incCounter } from "../services/funnel/metrics";

// ---------------------------------------------------------------------------
// Rate Limit Configuration
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const RATE_LIMITS = {
  /** Per action type: max 100 executions per minute (override: ACTION_RATE_LIMIT_MAX). */
  perActionType: { maxRequests: envInt("ACTION_RATE_LIMIT_MAX", 100), windowMs: 60 * 1000 },
  /** Per user: max 500 executions per minute across all action types (override: USER_RATE_LIMIT_MAX). */
  perUser: { maxRequests: envInt("USER_RATE_LIMIT_MAX", 500), windowMs: 60 * 1000 },
  /**
   * Global: max 5000 executions per minute across entire system
   * (override: GLOBAL_ACTION_RATE_LIMIT_MAX).
   *
   * Raised from 2000/min (33/s) to 5000/min (83/s) to provide 67% headroom
   * above the 50 actions/s SLO. F-P4-12 override-prompt §3 Block D.1.
   */
  global: { maxRequests: envInt("GLOBAL_ACTION_RATE_LIMIT_MAX", 5000), windowMs: 60 * 1000 },
  /** Batch endpoint: max 10 batch requests per minute per user (override: BATCH_RATE_LIMIT_MAX). */
  batchPerUser: { maxRequests: envInt("BATCH_RATE_LIMIT_MAX", 10), windowMs: 60 * 1000 },
};

// ---------------------------------------------------------------------------
// Redis-backed limiter registry (F-P4-12 closure).
//
// When RATE_LIMIT_BACKEND=redis, the middleware routes all rate-limit
// check/record operations through a shared Redis sliding window via
// RedisRateLimiter. Under K8s multi-replica deployments this is the only
// correct behaviour — the in-memory Map path below is kept for
// single-replica dev/test bring-up only.
//
// Initialization: src/server.ts calls initRedisRateLimiters(redisClient)
// once, after the Redis client has connected. Before that call the
// registry is empty and the middleware falls back to the in-memory path
// (tagged in Prometheus via tellus_rate_limit_backend_selected_total).
// ---------------------------------------------------------------------------

let redisLimiters: {
  perActionType: RedisRateLimiter;
  perUser: RedisRateLimiter;
  global: RedisRateLimiter;
  batchPerUser: RedisRateLimiter;
} | null = null;

export function initRedisRateLimiters(client: any /* RedisClientType */): void {
  redisLimiters = {
    perActionType: new RedisRateLimiter({
      client,
      keyPrefix: "tellus:rl:action_type",
      windowMs: RATE_LIMITS.perActionType.windowMs,
      maxRequests: RATE_LIMITS.perActionType.maxRequests,
      scope: "action_type",
    }),
    perUser: new RedisRateLimiter({
      client,
      keyPrefix: "tellus:rl:user",
      windowMs: RATE_LIMITS.perUser.windowMs,
      maxRequests: RATE_LIMITS.perUser.maxRequests,
      scope: "user",
    }),
    global: new RedisRateLimiter({
      client,
      keyPrefix: "tellus:rl:global",
      windowMs: RATE_LIMITS.global.windowMs,
      maxRequests: RATE_LIMITS.global.maxRequests,
      scope: "global",
    }),
    batchPerUser: new RedisRateLimiter({
      client,
      keyPrefix: "tellus:rl:batch",
      windowMs: RATE_LIMITS.batchPerUser.windowMs,
      maxRequests: RATE_LIMITS.batchPerUser.maxRequests,
      scope: "batch_per_user",
    }),
  };
}

function useRedisBackend(): boolean {
  return process.env.RATE_LIMIT_BACKEND === "redis" && redisLimiters !== null;
}

// ---------------------------------------------------------------------------
// RateLimiter Class
// ---------------------------------------------------------------------------

export interface CheckResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfterMs?: number;
}

export class RateLimiter {
  private windows: Map<string, number[]>;
  private _cleanupInterval: ReturnType<typeof setInterval>;

  constructor() {
    this.windows = new Map();

    // Periodic cleanup: remove stale keys to prevent unbounded memory growth.
    // Runs every 60 seconds.
    this._cleanupInterval = setInterval(() => this.cleanup(), 60 * 1000);
  }

  /**
   * Removes keys where all timestamps are older than the longest window (60s).
   */
  cleanup(): void {
    const now = Date.now();
    const maxWindowMs = 60 * 1000; // all current windows are 60 seconds
    for (const [key, timestamps] of this.windows) {
      const active = timestamps.filter((t) => t > now - maxWindowMs);
      if (active.length === 0) {
        this.windows.delete(key);
      } else {
        this.windows.set(key, active);
      }
    }
  }

  /** Call this when shutting down to prevent dangling intervals. */
  destroy(): void {
    clearInterval(this._cleanupInterval);
  }

  /**
   * Check if a request is allowed under the rate limit AND record it.
   *
   * NOTE: This method atomically checks and records in one step. If you are
   * checking multiple scopes and need to ensure that no scope records a
   * timestamp unless ALL scopes allow the request, use `tryCheck()` followed
   * by `record()` instead.
   *
   * @param key         - The rate limit key (e.g., "action:updateSalary")
   * @param maxRequests - Maximum requests allowed in the window
   * @param windowMs    - Window size in milliseconds
   * @returns { allowed, remaining, resetAt, retryAfterMs? }
   */
  check(key: string, maxRequests: number, windowMs: number): CheckResult {
    const now = Date.now();
    if (!this.windows.has(key)) this.windows.set(key, []);

    // Remove expired timestamps
    const timestamps = this.windows
      .get(key)!
      .filter((t) => t > now - windowMs);
    this.windows.set(key, timestamps);

    if (timestamps.length >= maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: new Date(timestamps[0] + windowMs),
        retryAfterMs: timestamps[0] + windowMs - now,
      };
    }

    timestamps.push(now);
    return {
      allowed: true,
      remaining: maxRequests - timestamps.length,
      resetAt: new Date(now + windowMs),
    };
  }

  /**
   * Read-only check: returns whether a request would be allowed WITHOUT
   * recording a timestamp. Use this to pre-check multiple scopes before
   * committing any of them via `record()`.
   *
   * @param key         - The rate limit key (e.g., "action:updateSalary")
   * @param maxRequests - Maximum requests allowed in the window
   * @param windowMs    - Window size in milliseconds
   * @returns { allowed, remaining, resetAt, retryAfterMs? }
   */
  tryCheck(key: string, maxRequests: number, windowMs: number): CheckResult {
    const now = Date.now();
    if (!this.windows.has(key)) this.windows.set(key, []);

    // Remove expired timestamps
    const timestamps = this.windows
      .get(key)!
      .filter((t) => t > now - windowMs);
    this.windows.set(key, timestamps);

    if (timestamps.length >= maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: new Date(timestamps[0] + windowMs),
        retryAfterMs: timestamps[0] + windowMs - now,
      };
    }

    // Do NOT push a timestamp — this is a read-only check
    return {
      allowed: true,
      remaining: maxRequests - timestamps.length,
      resetAt: new Date(now + windowMs),
    };
  }

  /**
   * Record a request timestamp for the given key. Call this after all
   * `tryCheck()` calls have passed to atomically commit the request across
   * all scopes.
   *
   * @param key      - The rate limit key
   * @param windowMs - Window size in milliseconds (used to prune expired entries)
   */
  record(key: string, windowMs: number): void {
    const now = Date.now();
    if (!this.windows.has(key)) this.windows.set(key, []);

    // Prune expired timestamps, then append the new one
    const timestamps = this.windows
      .get(key)!
      .filter((t) => t > now - windowMs);
    timestamps.push(now);
    this.windows.set(key, timestamps);
  }

  /**
   * Reset all rate limit windows. Useful for testing.
   */
  reset(): void {
    this.windows.clear();
  }

  /**
   * Get the current count for a given key within the window.
   * Useful for debugging and testing.
   */
  getCount(key: string, windowMs: number): number {
    const now = Date.now();
    const timestamps = this.windows.get(key);
    if (!timestamps) return 0;
    return timestamps.filter((t) => t > now - windowMs).length;
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

export const limiter = new RateLimiter();

// ---------------------------------------------------------------------------
// Express Middleware: Action Rate Limiter
//
// Applied to POST /:actionTypeApiName/apply
// Checks: perActionType, perUser, global
// ---------------------------------------------------------------------------

export function actionRateLimiter(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (useRedisBackend()) {
    void actionRateLimiterRedis(req, res, next);
    return;
  }
  incCounter("tellus_rate_limit_backend_selected_total", { backend: "memory" });

  const actionType = req.params.actionTypeApiName;
  const user = (req as any).user?.id || "anonymous";

  // Scope definitions: key, limit config, and human-readable scope name.
  const scopes = [
    { key: `action:${actionType}`, config: RATE_LIMITS.perActionType, scope: "action_type" },
    { key: `user:${user}`,         config: RATE_LIMITS.perUser,       scope: "user" },
    { key: "global",               config: RATE_LIMITS.global,        scope: "global" },
  ];

  // Phase 1: Read-only check on ALL scopes. No timestamps are recorded yet,
  // so a later scope blocking the request won't leave phantom counts on
  // earlier scopes that passed.
  const checks = scopes.map((s) => ({
    ...limiter.tryCheck(s.key, s.config.maxRequests, s.config.windowMs),
    ...s,
  }));

  const blocked = checks.find((c) => !c.allowed);
  if (blocked) {
    const retryAfterSec = Math.ceil((blocked.retryAfterMs || 1000) / 1000);
    res.set("Retry-After", String(retryAfterSec));
    res.set("X-RateLimit-Scope", blocked.scope);
    res.set("X-RateLimit-Remaining", "0");
    res.status(429).json({
      errorCode: "RATE_LIMIT_EXCEEDED",
      errorName: "RateLimitExceededError",
      errorInstanceId: crypto.randomUUID(),
      message: `Rate limit exceeded for scope '${blocked.scope}'. Retry after ${retryAfterSec} seconds.`,
      parameters: {
        scope: blocked.scope,
        retryAfterMs: blocked.retryAfterMs,
      },
    });
    return;
  }

  // Phase 2: All scopes allow the request — now record timestamps.
  for (const s of scopes) {
    limiter.record(s.key, s.config.windowMs);
  }

  // Remaining counts from tryCheck are still accurate (we just added 1 to
  // each scope, so subtract 1 from each remaining value).
  const minRemaining = Math.min(
    ...checks.map((c) => Math.max(0, c.remaining - 1))
  );
  res.set("X-RateLimit-Remaining", String(minRemaining));

  next();
}

// ---------------------------------------------------------------------------
// Async Redis-backed variants (F-P4-12 closure).
//
// Invoked from the sync entrypoints when `RATE_LIMIT_BACKEND=redis` and
// the Redis registry has been initialized. Structured identically to the
// in-memory variants — two-phase check, same 429 envelope, same headers —
// but using RedisRateLimiter so all replicas share state.
// ---------------------------------------------------------------------------

function emit429(
  res: Response,
  scope: string,
  retryAfterMs: number,
): void {
  const retryAfterSec = Math.ceil((retryAfterMs || 1000) / 1000);
  res.set("Retry-After", String(retryAfterSec));
  res.set("X-RateLimit-Scope", scope);
  res.set("X-RateLimit-Remaining", "0");
  res.status(429).json({
    errorCode: "RATE_LIMIT_EXCEEDED",
    errorName: "RateLimitExceededError",
    errorInstanceId: crypto.randomUUID(),
    message: `Rate limit exceeded for scope '${scope}'. Retry after ${retryAfterSec} seconds.`,
    parameters: { scope, retryAfterMs },
  });
  incCounter("tellus_rate_limit_exceeded_total", { scope });
}

async function actionRateLimiterRedis(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  incCounter("tellus_rate_limit_backend_selected_total", { backend: "redis" });
  const r = redisLimiters!;
  const actionType = req.params.actionTypeApiName ?? "unknown";
  const user = (req as any).user?.id || "anonymous";

  // Phase 1 — parallel checks on all three scopes, no recording.
  const [checkAction, checkUser, checkGlobal] = await Promise.all([
    r.perActionType.check(actionType),
    r.perUser.check(user),
    r.global.check("all"),
  ]);

  const blocked =
    !checkAction.allowed ? { res: checkAction, scope: "action_type" } :
    !checkUser.allowed   ? { res: checkUser,   scope: "user" } :
    !checkGlobal.allowed ? { res: checkGlobal, scope: "global" } :
    null;

  if (blocked) {
    emit429(res, blocked.scope, blocked.res.retryAfterMs ?? 1000);
    return;
  }

  // Phase 2 — record on all three scopes. Parallel; failures surface via
  // the RedisRateLimiter's own fail-open counters and are non-fatal.
  await Promise.all([
    r.perActionType.record(actionType),
    r.perUser.record(user),
    r.global.record("all"),
  ]);

  const minRemaining = Math.min(
    Math.max(0, checkAction.remaining - 1),
    Math.max(0, checkUser.remaining - 1),
    Math.max(0, checkGlobal.remaining - 1),
  );
  res.set("X-RateLimit-Remaining", String(minRemaining));
  next();
}

async function batchRateLimiterRedis(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  incCounter("tellus_rate_limit_backend_selected_total", { backend: "redis" });
  const r = redisLimiters!;
  const user = (req as any).user?.id || "anonymous";

  const [checkBatch, checkGlobal] = await Promise.all([
    r.batchPerUser.check(user),
    r.global.check("all"),
  ]);

  const blocked =
    !checkBatch.allowed  ? { res: checkBatch,  scope: "batch_per_user" } :
    !checkGlobal.allowed ? { res: checkGlobal, scope: "global" } :
    null;

  if (blocked) {
    emit429(res, blocked.scope, blocked.res.retryAfterMs ?? 1000);
    return;
  }

  await Promise.all([r.batchPerUser.record(user), r.global.record("all")]);

  const minRemaining = Math.min(
    Math.max(0, checkBatch.remaining - 1),
    Math.max(0, checkGlobal.remaining - 1),
  );
  res.set("X-RateLimit-Remaining", String(minRemaining));
  next();
}

// ---------------------------------------------------------------------------
// Express Middleware: Batch Rate Limiter
//
// Applied to POST /:actionTypeApiName/applyBatch
// Checks: batchPerUser, global
// ---------------------------------------------------------------------------

export function batchRateLimiter(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (useRedisBackend()) {
    void batchRateLimiterRedis(req, res, next);
    return;
  }
  incCounter("tellus_rate_limit_backend_selected_total", { backend: "memory" });

  const user = (req as any).user?.id || "anonymous";

  // Scope definitions: key, limit config, and human-readable scope name.
  const scopes = [
    { key: `batch:${user}`, config: RATE_LIMITS.batchPerUser, scope: "batch_per_user" },
    { key: "global",        config: RATE_LIMITS.global,       scope: "global" },
  ];

  // Phase 1: Read-only check on ALL scopes. No timestamps are recorded yet,
  // so a later scope blocking the request won't leave phantom counts on
  // earlier scopes that passed.
  const checks = scopes.map((s) => ({
    ...limiter.tryCheck(s.key, s.config.maxRequests, s.config.windowMs),
    ...s,
  }));

  const blocked = checks.find((c) => !c.allowed);
  if (blocked) {
    const retryAfterSec = Math.ceil((blocked.retryAfterMs || 1000) / 1000);
    res.set("Retry-After", String(retryAfterSec));
    res.set("X-RateLimit-Scope", blocked.scope);
    res.set("X-RateLimit-Remaining", "0");
    res.status(429).json({
      errorCode: "RATE_LIMIT_EXCEEDED",
      errorName: "RateLimitExceededError",
      errorInstanceId: crypto.randomUUID(),
      message: `Rate limit exceeded for scope '${blocked.scope}'. Retry after ${retryAfterSec} seconds.`,
      parameters: {
        scope: blocked.scope,
        retryAfterMs: blocked.retryAfterMs,
      },
    });
    return;
  }

  // Phase 2: All scopes allow the request — now record timestamps.
  for (const s of scopes) {
    limiter.record(s.key, s.config.windowMs);
  }

  // Remaining counts from tryCheck are still accurate (we just added 1 to
  // each scope, so subtract 1 from each remaining value).
  const minRemaining = Math.min(
    ...checks.map((c) => Math.max(0, c.remaining - 1))
  );
  res.set("X-RateLimit-Remaining", String(minRemaining));

  next();
}
