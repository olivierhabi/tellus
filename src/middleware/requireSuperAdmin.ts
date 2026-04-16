/**
 * requireSuperAdmin.ts
 * --------------------
 * Role-gated middleware that only lets through requests whose resolved
 * principal carries the `tellus-superadmin` Keycloak realm role. Used
 * to guard the /api/v1/auth/admin/users and /admin/settings endpoints
 * that power the superadmin console.
 *
 * This is deliberately a separate middleware (not a flag on
 * `requireTellusAuth`) because:
 *   • the role name is hard-coded here, not configurable per-route —
 *     a single grep tells a reviewer which routes are superadmin-only
 *   • PATs are rejected regardless of scope: superadmin operations
 *     must run under an interactive session so every action ties to
 *     a real human in the audit log, not a long-lived service token
 *   • the failure envelope is its own error code (INSUFFICIENT_ROLE
 *     with `requiredRole: 'tellus-superadmin'` in the detail) so the
 *     FE can distinguish "need to log in" from "wrong account"
 */

import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { AppError } from '../utils/foundryAppError';

export const TELLUS_SUPERADMIN_ROLE = 'tellus-superadmin';

function envelope(code: string, status: number, message: string, req: Request) {
  return {
    errorCode: code,
    errorName: 'AuthorizationError',
    message,
    statusCode: status,
    requestId: (req.headers['x-request-id'] as string) || crypto.randomUUID(),
    details: { requiredRole: TELLUS_SUPERADMIN_ROLE },
  };
}

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  const principal = req.tellusPrincipal;
  if (!principal) {
    res.status(401).json(envelope('UNAUTHORIZED', 401, 'Authentication required', req));
    return;
  }
  if (principal.source === 'pat') {
    // PATs cannot be used for superadmin operations — every admin
    // action must tie back to a live human session in the audit log.
    res
      .status(403)
      .json(envelope('PAT_NOT_ALLOWED', 403, 'Superadmin operations require an interactive session', req));
    return;
  }
  const roles = principal.roles ?? [];
  if (!roles.includes(TELLUS_SUPERADMIN_ROLE)) {
    res
      .status(403)
      .json(envelope('INSUFFICIENT_ROLE', 403, 'tellus-superadmin role required', req));
    return;
  }
  next();
}

/**
 * Shared helper that throws inside a route handler. Useful when the
 * handler does additional auth work (e.g., requireTellusAuth is
 * already applied at the router level, and we only need a conditional
 * check deeper inside a handler). Not wired into any route yet but
 * exported for parity with other requireX helpers.
 */
export function assertSuperAdmin(req: Request): void {
  const principal = req.tellusPrincipal;
  if (!principal || principal.source === 'pat') {
    throw new AppError('Superadmin operations require an interactive session', 403, 'PAT_NOT_ALLOWED');
  }
  if (!(principal.roles ?? []).includes(TELLUS_SUPERADMIN_ROLE)) {
    throw new AppError('tellus-superadmin role required', 403, 'INSUFFICIENT_ROLE');
  }
}
