import { Request, Response, NextFunction } from 'express';
import { LRUCache } from 'lru-cache';
import { AppError } from '../utils/foundryAppError';

/**
 * Rate limit category definitions.
 * Each category has a max number of requests and a window duration in milliseconds.
 */
export interface RateLimitCategory {
  /** Maximum number of requests in the window */
  max: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

export const RATE_LIMIT_CATEGORIES: Record<string, RateLimitCategory> = {
  upload: { max: 10, windowMs: 60_000 },    // 10 requests per minute
  read: { max: 100, windowMs: 60_000 },     // 100 requests per minute
  write: { max: 30, windowMs: 60_000 },     // 30 requests per minute
  auth: { max: 5, windowMs: 60_000 },       // 5 requests per minute
};

/**
 * Sliding window entry for a single client.
 */
interface WindowEntry {
  timestamps: number[];
}

/**
 * Create a sliding window rate limiter middleware for a given category.
 *
 * Uses an LRU cache keyed by client IP to store request timestamps.
 * Expired timestamps are pruned on each request (sliding window).
 *
 * Sets standard rate limit headers:
 * - X-RateLimit-Limit: max requests in the window
 * - X-RateLimit-Remaining: remaining requests in the current window
 * - X-RateLimit-Reset: Unix timestamp (seconds) when the window resets
 */
export function createRateLimiter(category: string) {
  const config = RATE_LIMIT_CATEGORIES[category];
  if (!config) {
    throw new Error(`Unknown rate limit category: "${category}"`);
  }

  const { max, windowMs } = config;

  // LRU cache to store per-IP sliding windows; evict after 2x the window
  const cache = new LRUCache<string, WindowEntry>({
    max: 10_000,
    ttl: windowMs * 2,
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    const clientKey = getClientKey(req);
    const now = Date.now();
    const windowStart = now - windowMs;

    // Get or create the window entry
    let entry = cache.get(clientKey);
    if (!entry) {
      entry = { timestamps: [] };
    }

    // Prune expired timestamps (sliding window)
    entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

    // Check if limit is exceeded
    if (entry.timestamps.length >= max) {
      // Find the earliest timestamp in the current window to compute reset time
      const oldestTimestamp = entry.timestamps[0];
      const resetTime = Math.ceil((oldestTimestamp + windowMs) / 1000);

      // Set rate limit headers
      res.set('X-RateLimit-Limit', String(max));
      res.set('X-RateLimit-Remaining', '0');
      res.set('X-RateLimit-Reset', String(resetTime));
      res.set('Retry-After', String(Math.ceil((oldestTimestamp + windowMs - now) / 1000)));

      cache.set(clientKey, entry);

      next(
        new AppError(
          `Rate limit exceeded. Maximum ${max} requests per ${windowMs / 1000} seconds for "${category}" operations.`,
          429,
          'RATE_LIMIT_EXCEEDED'
        )
      );
      return;
    }

    // Record this request
    entry.timestamps.push(now);
    cache.set(clientKey, entry);

    const remaining = max - entry.timestamps.length;
    const resetTime = Math.ceil((now + windowMs) / 1000);

    // Set rate limit headers
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));
    res.set('X-RateLimit-Reset', String(resetTime));

    next();
  };
}

/**
 * Extract a unique client key from the request.
 * Uses X-Forwarded-For if behind a proxy, otherwise req.ip.
 */
function getClientKey(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}
