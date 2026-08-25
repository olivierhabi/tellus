import { Request, Response, NextFunction } from 'express';

/**
 * csrfSameOrigin — defense-in-depth for the credential-bearing auth endpoints.
 *
 * The in-place re-auth modal (plan P0-3) POSTs /auth/login with credentials
 * from a same-origin script. SameSite=Strict cookies block CROSS-site credentialed
 * POSTs but not SAME-origin; a same-origin XSS or form could otherwise drive a
 * credential-bearing modal login. This middleware rejects credentialed POSTs
 * whose Origin/Referer isn't allow-listed.
 *
 * Opt-in to avoid breaking existing proxy deployments: only enforced when
 * TELLUS_ALLOWED_ORIGINS is set (comma-separated, e.g.
 * "https://app.tellus.io,http://localhost:3001"). Unset → allow (the FE proxies
 * /api same-origin and deployments that haven't configured the allow-list yet
 * keep working). Pair with strict CSP for the XSS root.
 */
const ALLOWED = (process.env.TELLUS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function csrfSameOrigin(req: Request, res: Response, next: NextFunction) {
  if (ALLOWED.length === 0) return next(); // opt-in — unset = no enforcement
  const origin = req.headers.origin as string | undefined;
  const referer = req.headers.referer as string | undefined;
  let candidate: string | null = null;
  if (origin) candidate = origin;
  else if (referer) {
    try {
      candidate = new URL(referer).origin;
    } catch {
      candidate = null;
    }
  }
  // No Origin/Referer (non-browser caller) or allow-listed → allow.
  if (!candidate || ALLOWED.includes(candidate)) return next();
  return res.status(403).json({
    errorCode: 'CSRF_ORIGIN_REJECTED',
    errorName: 'AuthenticationError',
    message: 'Cross-origin credential request rejected',
    statusCode: 403,
    requestId: (req.headers['x-request-id'] as string) || 'unknown',
  });
}
