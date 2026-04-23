/**
 * patSecurityGate.ts
 * ------------------
 * App-wide gate that intercepts any request carrying an
 * `Authorization: Bearer tellus_pat_*` header BEFORE the route
 * handler runs. It does three things in order:
 *
 *   1. Resolve the PAT via TellusAuthService.resolvePat() so the
 *      underlying handler sees a populated `req.tellusPrincipal`
 *      even on routes that never add `authenticate` middleware.
 *   2. Consult services/patScopeMap.ts to determine the required
 *      scope for this request.
 *   3. Reject with the spec error envelope (401 / 403) if the token
 *      is invalid or missing the required scope.
 *
 * This closes the hole where un-authenticated ontology / dataset /
 * project routes were previously happy to serve any Bearer token
 * without looking at it. Interactive JWT callers (cookie sessions)
 * are unaffected — the gate only fires on requests whose Authorization
 * header matches the `tellus_pat_` prefix.
 *
 * Mounted at `app.use(patSecurityGate)` in server.ts, BEFORE all
 * route handlers and AFTER cookie-parser / body-parser.
 */

import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { AppError } from '../utils/foundryAppError';
import { TellusAuthService } from '../services/tellusAuthService';
import { getRequiredPatScope } from '../services/patScopeMap';
import foundryDb from '../config/foundryDb';
import { getKeycloakRealm } from "../auth/keycloakConfig"; // F-P4-26

const PAT_PREFIX = 'tellus_pat_';
// Mandatory-passkey enrollment bearer. These tokens are minted by
// /auth/login when the user has no WebAuthn credential and can ONLY
// be used on the two /auth/enroll/passkey/* endpoints. Anywhere else
// they must be hard-rejected — otherwise a caller could skip
// enrollment entirely by carrying the enrollment bearer straight to
// a protected route.
const ENROLL_PREFIX = 'tellus_enroll_';
const ENROLL_ALLOWED_PATHS = new Set([
  '/api/v1/auth/enroll/passkey/options',
  '/api/v1/auth/enroll/passkey/verify',
]);

let _service: TellusAuthService | null = null;
function svc(): TellusAuthService {
  if (!_service) {
    _service = new TellusAuthService(foundryDb as never, {
      kcUrl: process.env.KEYCLOAK_URL || 'http://localhost:8086',
      kcRealm: getKeycloakRealm(),
      kcFrontendClientId: process.env.KEYCLOAK_FRONTEND_CLIENT_ID || 'tellus-frontend',
    });
  }
  return _service;
}

function envelope(code: string, status: number, message: string, req: Request) {
  return {
    errorCode: code,
    errorName: 'AuthenticationError',
    message,
    statusCode: status,
    requestId: (req.headers['x-request-id'] as string) || crypto.randomUUID(),
  };
}

export async function patSecurityGate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const hdr = req.headers.authorization || '';
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return next();
  }
  const token = m[1];

  // Enrollment bearers have their own gate: they're only valid on the
  // two enrollment endpoints. Anywhere else we 401 before the request
  // touches the router, so nobody can trick a protected handler into
  // accepting an enrollment token as a session.
  if (token.startsWith(ENROLL_PREFIX)) {
    const fullPath = ((req.baseUrl || '') + (req.path || '')).split('?')[0] || '/';
    if (!ENROLL_ALLOWED_PATHS.has(fullPath)) {
      res.status(401).json(
        envelope(
          'ENROLLMENT_TOKEN_INVALID',
          401,
          'Enrollment tokens are not valid on this endpoint',
          req,
        ),
      );
      return;
    }
    return next();
  }

  if (!token.startsWith(PAT_PREFIX)) {
    return next();
  }

  try {
    const pat = await svc().resolvePat(token);
    req.tellusPrincipal = {
      userId: pat.userId,
      keycloakSub: pat.keycloakSub,
      source: 'pat',
      roles: [],
      scopes: pat.scopes,
    };
    (req as Request & { user?: unknown }).user = {
      id: pat.userId,
      email: null,
      displayName: 'PAT user',
    };

    // Enforce the scope for THIS request path. Routes that explicitly
    // want PATs (tellusAuthV1.ts endpoints) will also run their own
    // `requireTellusAuth` which is idempotent — it sees the already-
    // populated principal and doesn't re-resolve.
    const required = getRequiredPatScope(req);
    if (required && !pat.scopes.includes(required)) {
      res.status(403).json(
        envelope(
          'PAT_SCOPE_INSUFFICIENT',
          403,
          `Token is missing required scope: ${required}`,
          req,
        ),
      );
      return;
    }
    return next();
  } catch (err) {
    if (err instanceof AppError) {
      res.status(err.statusCode).json(envelope(err.code, err.statusCode, err.message, req));
      return;
    }
    res.status(401).json(envelope('TOKEN_INVALID', 401, 'Invalid PAT', req));
  }
}
