// =============================================================================
// B05 — per-user token-bucket rate limiter for hot-path object set load /
// aggregate. Spec §B05: 100 req/s per user; sustained 200 req/s for 10s →
// ≥50% rejected with 429 + `Retry-After` header.
//
// Token bucket: capacity = burst (default 100), refill = ratePerSecond
// (default 100). Tokens accumulate at refill rate up to capacity.
// Per-user state in-process; for multi-process deployments swap with
// Redis-backed implementation behind the same interface.
// =============================================================================

import type { Request, Response, NextFunction } from "express";
import { workshopError } from "./errors.js";

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

let _ratePerSecond = Number(process.env.WORKSHOP_RATE_PER_SECOND ?? "100");
let _burst = Number(process.env.WORKSHOP_RATE_BURST ?? "100");
const _buckets = new Map<string, Bucket>();

export function setRateLimit(opts: { ratePerSecond?: number; burst?: number }): {
  ratePerSecond: number;
  burst: number;
} {
  const prev = { ratePerSecond: _ratePerSecond, burst: _burst };
  if (opts.ratePerSecond != null) _ratePerSecond = opts.ratePerSecond;
  if (opts.burst != null) _burst = opts.burst;
  return prev;
}

export function resetRateLimit(): void {
  _buckets.clear();
}

/**
 * Returns whether the request is allowed and the seconds the client should
 * wait before the next attempt.
 */
export function tryConsume(userId: string, now: number = Date.now()): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  let b = _buckets.get(userId);
  if (!b) {
    b = { tokens: _burst, lastRefillMs: now };
    _buckets.set(userId, b);
  }
  // Refill since last seen.
  const elapsed = (now - b.lastRefillMs) / 1000;
  if (elapsed > 0) {
    b.tokens = Math.min(_burst, b.tokens + elapsed * _ratePerSecond);
    b.lastRefillMs = now;
  }
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
  // Compute time until next token. ceil to whole second per HTTP spec.
  const secondsToNext = Math.max(1, Math.ceil((1 - b.tokens) / _ratePerSecond));
  return { allowed: false, retryAfterSeconds: secondsToNext };
}

/**
 * Express middleware. Drops `Tellus:Workshop:RateLimited` 429 with a
 * `Retry-After` header on overflow.
 */
export function workshopRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const userId =
    (req as unknown as { user?: { id?: string } }).user?.id ?? "anonymous";
  const decision = tryConsume(userId);
  if (!decision.allowed) {
    res.setHeader("Retry-After", String(decision.retryAfterSeconds));
    const err = workshopError({
      errorName: "Tellus:Workshop:RateLimited",
      status: 429,
      parameters: {
        retryAfterSeconds: decision.retryAfterSeconds,
        userId,
      },
    });
    res.status(429).json(err.toEnvelope());
    return;
  }
  next();
}
