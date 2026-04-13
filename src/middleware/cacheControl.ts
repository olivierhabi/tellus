/**
 * Cache-Control middleware for read-heavy API endpoints.
 *
 * Adds appropriate `Cache-Control` headers to GET responses so that
 * the browser (and any CDN/proxy in front) can cache responses briefly.
 *
 * This is especially effective when the frontend prefetches data —
 * the browser cache can serve the response instantly on actual navigation,
 * avoiding a network round-trip entirely.
 *
 * Two tiers:
 *   - `shortCache(seconds)` — for data that changes infrequently (projects list,
 *     folder tree, stats). Default 30s private cache.
 *   - `noCache()` — explicit no-cache for mutation endpoints or dynamic data.
 */

import { Request, Response, NextFunction } from 'express';

/**
 * Adds `Cache-Control: private, max-age=<seconds>` to GET responses.
 *
 * Uses `private` because these responses contain user-specific data
 * (authenticated endpoints). The browser can cache them, but shared
 * caches (CDN) should not.
 *
 * Also sets `Vary: Authorization` so different users don't share cached
 * responses.
 */
export function shortCache(seconds = 30) {
  return (_req: Request, res: Response, next: NextFunction) => {
    // Only cache GET/HEAD requests
    if (_req.method === 'GET' || _req.method === 'HEAD') {
      res.setHeader('Cache-Control', `private, max-age=${seconds}, stale-while-revalidate=${seconds * 2}`);
      res.setHeader('Vary', 'Authorization');
    }
    next();
  };
}

/**
 * Explicitly prevents caching. Use for mutation responses or
 * rapidly-changing data (e.g., dataset status polling).
 */
export function noCache() {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    next();
  };
}
