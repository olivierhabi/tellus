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
  /** Global: max 2000 executions per minute across entire system (override: GLOBAL_ACTION_RATE_LIMIT_MAX). */
  global: { maxRequests: envInt("GLOBAL_ACTION_RATE_LIMIT_MAX", 2000), windowMs: 60 * 1000 },
  /** Batch endpoint: max 10 batch requests per minute per user (override: BATCH_RATE_LIMIT_MAX). */
  batchPerUser: { maxRequests: envInt("BATCH_RATE_LIMIT_MAX", 10), windowMs: 60 * 1000 },
};

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
   * Check if a request is allowed under the rate limit.
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
  const actionType = req.params.actionTypeApiName;
  const user = (req as any).user?.id || "anonymous";

  const checks = [
    {
      ...limiter.check(
        `action:${actionType}`,
        RATE_LIMITS.perActionType.maxRequests,
        RATE_LIMITS.perActionType.windowMs
      ),
      scope: "action_type",
    },
    {
      ...limiter.check(
        `user:${user}`,
        RATE_LIMITS.perUser.maxRequests,
        RATE_LIMITS.perUser.windowMs
      ),
      scope: "user",
    },
    {
      ...limiter.check(
        "global",
        RATE_LIMITS.global.maxRequests,
        RATE_LIMITS.global.windowMs
      ),
      scope: "global",
    },
  ];

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

  // Set rate limit headers on successful requests
  const minRemaining = Math.min(...checks.map((c) => c.remaining));
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
  const user = (req as any).user?.id || "anonymous";

  const checks = [
    {
      ...limiter.check(
        `batch:${user}`,
        RATE_LIMITS.batchPerUser.maxRequests,
        RATE_LIMITS.batchPerUser.windowMs
      ),
      scope: "batch_per_user",
    },
    {
      ...limiter.check(
        "global",
        RATE_LIMITS.global.maxRequests,
        RATE_LIMITS.global.windowMs
      ),
      scope: "global",
    },
  ];

  const blocked = checks.find((c) => !c.allowed);
  if (blocked) {
    const retryAfterSec = Math.ceil((blocked.retryAfterMs || 1000) / 1000);
    res.set("Retry-After", String(retryAfterSec));
    res.set("X-RateLimit-Scope", blocked.scope || "batch_per_user");
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

  const minRemaining = Math.min(...checks.map((c) => c.remaining));
  res.set("X-RateLimit-Remaining", String(minRemaining));

  next();
}
