/**
 * Thin shim that delegates every authentication call to the Keycloak-
 * backed `requireTellusAuth` middleware. Kept so existing routes that
 * import `authenticate` / `authorize` compile unchanged, but there is
 * no longer a dev-mode hardcoded-user fallback — Keycloak is the only
 * accepted identity provider (see ontology/tellus-auth.md Phase 1).
 */

import type { Request, Response, NextFunction } from 'express';
import { requireTellusAuth } from './tellusAuth';

const realAuth = requireTellusAuth();

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  realAuth(req, res, next);
}

export function authorize(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const principal = req.tellusPrincipal;
    const user = (req as unknown as { user?: { id: string; role?: string; roles?: string[] } }).user;
    if (!principal && !user) {
      res.status(401).json({
        errorCode: 'UNAUTHORIZED',
        errorName: 'AuthenticationError',
        message: 'Authentication required',
        statusCode: 401,
        requestId: (req.headers['x-request-id'] as string) || 'unknown',
      });
      return;
    }
    if (roles.length === 0) {
      next();
      return;
    }
    const userRoles =
      principal?.roles ?? user?.roles ?? (user?.role ? [user.role] : []);
    if (userRoles.some((r) => roles.includes(r))) {
      next();
      return;
    }
    // PAT principals intentionally have an empty `roles` array — their
    // permission model is scopes, enforced per-route. Allow them through
    // when no realm role is explicitly required.
    if (principal?.source === 'pat' && roles.length === 0) {
      next();
      return;
    }
    res.status(403).json({
      errorCode: 'INSUFFICIENT_ROLE',
      errorName: 'AuthorizationError',
      message: `Insufficient permissions. Required role: ${roles.join(' or ')}`,
      statusCode: 403,
      requestId: (req.headers['x-request-id'] as string) || 'unknown',
    });
  };
}
