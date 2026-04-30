/**
 * tellusAuth.ts — unified authentication middleware for the Phase 1
 * Palantir-equivalent auth implementation.
 *
 * Resolution order (first match wins):
 *   1. `Authorization: Bearer tellus_pat_*`   → PAT lookup
 *   2. `Authorization: Bearer <jwt>`          → Keycloak JWKS validation
 *   3. `TELLUS_TOKEN` cookie                  → Keycloak JWKS validation
 *
 * On success the middleware sets:
 *   req.tellusClaims   — full JWT claims (only for JWT paths)
 *   req.tellusPrincipal — { userId, keycloakSub?, source, roles, scopes }
 *   req.user            — legacy shape kept so existing routes still work
 *
 * A 401 is returned with the spec's error envelope on any failure. The
 * dev-mode fallback that silently provides a fake test user has been
 * removed: all routes that want optional auth must opt in via the new
 * `optionalTellusAuth` middleware.
 */

import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Knex } from 'knex';
import { AppError } from '../utils/foundryAppError';
import { TellusAuthService, TellusClaims } from '../services/tellusAuthService';
import { ensureLocalUserForClaims } from '../services/userProvisioning';
import foundryDb from '../config/foundryDb';
import { getKeycloakRealm } from "../auth/keycloakConfig"; // F-P4-26

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tellusClaims?: TellusClaims;
      tellusPrincipal?: {
        userId: string | null;
        keycloakSub: string | null;
        source: 'cookie' | 'bearer-jwt' | 'pat';
        roles: string[];
        scopes: string[];
      };
    }
  }
}

const TELLUS_COOKIE = 'TELLUS_TOKEN';
const PAT_PREFIX = 'tellus_pat_';

// Lazily-instantiated singleton so tests can import the middleware without
// Keycloak env vars being set up yet.
let service: TellusAuthService | null = null;
function svc(): TellusAuthService {
  if (!service) {
    service = new TellusAuthService(foundryDb as never, {
      kcUrl: process.env.KEYCLOAK_URL || 'http://localhost:8086',
      kcRealm: getKeycloakRealm(),
      kcFrontendClientId: process.env.KEYCLOAK_FRONTEND_CLIENT_ID || 'tellus-frontend',
    });
  }
  return service;
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

function reject(res: Response, req: Request, err: unknown) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(envelope(err.code, err.statusCode, err.message, req));
  }
  const msg = err instanceof Error ? err.message : 'Authentication failed';
  return res.status(401).json(envelope('TOKEN_INVALID', 401, msg, req));
}

function extractToken(req: Request): { token: string; source: 'bearer' | 'cookie' } | null {
  const hdr = req.headers.authorization || '';
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (m) return { token: m[1], source: 'bearer' };
  // Express only populates req.cookies when cookie-parser is installed.
  const cookieToken = (req.cookies && (req.cookies as Record<string, string>)[TELLUS_COOKIE]) || null;
  if (cookieToken) return { token: cookieToken, source: 'cookie' };
  return null;
}

/**
 * Required auth middleware factory. Pass `{ allowPat: false }` for
 * endpoints that must be hit with a live user session (e.g. PAT creation
 * — a PAT cannot mint another PAT).
 */
export function requireTellusAuth(opts: { allowPat?: boolean } = {}) {
  const allowPat = opts.allowPat !== false;
  return async (req: Request, res: Response, next: NextFunction) => {
    const extracted = extractToken(req);
    if (!extracted) {
      return res
        .status(401)
        .json(envelope('UNAUTHORIZED', 401, 'Authentication required', req));
    }

    try {
      if (extracted.token.startsWith(PAT_PREFIX)) {
        if (!allowPat) {
          return res
            .status(401)
            .json(envelope('TOKEN_INVALID', 401, 'PATs cannot be used on this endpoint', req));
        }
        const pat = await svc().resolvePat(extracted.token);
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
        return next();
      }

      const claims = await svc().verifyAccessToken(extracted.token);
      if (claims.jti && (await svc().isJtiRevoked(claims.jti))) {
        return res
          .status(401)
          .json(envelope('TOKEN_REVOKED', 401, 'Session was revoked', req));
      }

      // Translate the Keycloak identity to a local `users.id`. Every
      // domain table (projects.owner_id, project_members.user_id, …)
      // is keyed on the local UUID, NOT the Keycloak `sub`, so routes
      // that enforce ownership or membership need the translated id
      // on `req.user.id` and `req.tellusPrincipal.userId`. A shadow
      // `users` row is auto-provisioned on first sight.
      const localUserId = await ensureLocalUserForClaims(
        foundryDb as unknown as Knex,
        claims,
      );

      req.tellusClaims = claims;
      req.tellusPrincipal = {
        userId: localUserId,
        keycloakSub: claims.sub,
        source: extracted.source === 'cookie' ? 'cookie' : 'bearer-jwt',
        roles: claims.realm_access?.roles ?? [],
        scopes: [],
      };
      (req as Request & { user?: unknown }).user = {
        id: localUserId,
        email: claims.email,
        displayName: claims.preferred_username || claims.email || claims.sub,
        roles: claims.realm_access?.roles ?? [],
      };
      next();
    } catch (err) {
      reject(res, req, err);
    }
  };
}

/** Best-effort auth: attach principal if present, but don't block. */
export function optionalTellusAuth() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const extracted = extractToken(req);
    if (!extracted) return next();
    try {
      if (extracted.token.startsWith(PAT_PREFIX)) {
        const pat = await svc().resolvePat(extracted.token);
        req.tellusPrincipal = {
          userId: pat.userId,
          keycloakSub: pat.keycloakSub,
          source: 'pat',
          roles: [],
          scopes: pat.scopes,
        };
        (req as Request & { user?: unknown }).user = { id: pat.userId };
        return next();
      }
      const claims = await svc().verifyAccessToken(extracted.token);
      // Mirror the mandatory-auth path: translate Keycloak sub → local
      // users.id so optional-auth routes can safely trust req.user.id.
      // Swallow DB errors so optional auth remains best-effort.
      let localUserId: string | null = null;
      try {
        localUserId = await ensureLocalUserForClaims(
          foundryDb as unknown as Knex,
          claims,
        );
      } catch {
        localUserId = null;
      }
      req.tellusClaims = claims;
      req.tellusPrincipal = {
        userId: localUserId,
        keycloakSub: claims.sub,
        source: extracted.source === 'cookie' ? 'cookie' : 'bearer-jwt',
        roles: claims.realm_access?.roles ?? [],
        scopes: [],
      };
      (req as Request & { user?: unknown }).user = {
        id: localUserId ?? claims.sub,
        email: claims.email,
        displayName: claims.preferred_username || claims.email || claims.sub,
      };
      next();
    } catch {
      // silent — optional auth
      next();
    }
  };
}
