/**
 * patScopes.ts
 * ------------
 * Closed enum of scopes that Personal Access Tokens can be minted
 * with. Each scope corresponds to a coarse-grained permission on the
 * tellus API. PAT creation (/api/v1/auth/tokens) rejects anything
 * outside this set, and the requirePatScope() middleware gates
 * protected endpoints on the appropriate scope when the caller
 * authenticated with a PAT.
 *
 * Adding a scope: extend TELLUS_PAT_SCOPES here AND document it in
 * OpenAPI (src/docs/openapi.ts). Never add a wildcard scope ("*") —
 * scope drift is a cheap way to get yourself owned.
 */

import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/foundryAppError';

export const TELLUS_PAT_SCOPES = [
  'api:read',
  'api:write',
  'ontology:read',
  'ontology:write',
  'datasets:read',
  'datasets:upload',
  'pats:read',
  'audit:read',
] as const;

export type TellusPatScope = (typeof TELLUS_PAT_SCOPES)[number];

const PAT_SCOPE_SET = new Set<string>(TELLUS_PAT_SCOPES);

export function isValidPatScope(scope: string): scope is TellusPatScope {
  return PAT_SCOPE_SET.has(scope);
}

export function validatePatScopes(scopes: string[]): { ok: true } | { ok: false; invalid: string[] } {
  const invalid = scopes.filter((s) => !isValidPatScope(s));
  if (invalid.length > 0) return { ok: false, invalid };
  return { ok: true };
}

import crypto from 'crypto';

function envelope(code: string, status: number, message: string, req: Request) {
  return {
    errorCode: code,
    errorName: 'AuthenticationError',
    message,
    statusCode: status,
    requestId: (req.headers['x-request-id'] as string) || crypto.randomUUID(),
  };
}

/**
 * Express middleware factory. When the current request is
 * authenticated via a PAT, require the given scope. When the request
 * is authenticated via a JWT / cookie session (i.e. an interactive
 * user), the middleware is a no-op because interactive users are
 * gated by realm roles, not PAT scopes.
 *
 * The rejection path sends the response DIRECTLY (not via next(err))
 * so the envelope matches the spec shape the rest of the auth surface
 * uses. Routing the error through the global handler would still
 * produce the spec envelope now that unified it, but sending here
 * skips the extra hop and keeps the error path readable on every
 * endpoint that gates on a scope.
 */
export function requirePatScope(scope: TellusPatScope) {
  return (req: Request, res: Response, next: NextFunction) => {
    const principal = req.tellusPrincipal;
    if (!principal) {
      return res.status(401).json(envelope('UNAUTHORIZED', 401, 'Authentication required', req));
    }
    if (principal.source !== 'pat') {
      return next();
    }
    if (!principal.scopes.includes(scope)) {
      return res
        .status(403)
        .json(
          envelope(
            'PAT_SCOPE_INSUFFICIENT',
            403,
            `Token is missing required scope: ${scope}`,
            req,
          ),
        );
    }
    next();
  };
}

/**
 * Route → scope mapping for the /api/v1/auth/me/* surface. Interactive
 * sessions pass straight through; PATs must carry the listed scope.
 * Kept in one place so the audit-export / tokens-list / sessions
 * access model is obvious in review.
 */
export const PAT_SCOPE_MAP: Readonly<Record<string, TellusPatScope>> = Object.freeze({
  'GET /api/v1/auth/me/audit': 'audit:read',
  'GET /api/v1/auth/me/audit/export': 'audit:read',
  'GET /api/v1/auth/me/sessions': 'api:read',
  'GET /api/v1/auth/me/webauthn/credentials': 'api:read',
  'GET /api/v1/auth/me/totp/status': 'api:read',
  'GET /api/v1/auth/tokens': 'pats:read',
});
