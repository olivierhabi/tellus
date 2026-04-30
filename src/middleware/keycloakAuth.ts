/**
 * Keycloak JWT verification middleware.
 *
 * Implements the Palantir SSO layer the spec calls for: bearer tokens
 * from the Keycloak `tellus` realm are validated against the realm's
 * JWKS, and the resulting claims are surfaced on `req.keycloakUser` so
 * downstream handlers can authorize on roles.
 *
 * Usage on a route:
 *
 *     import { keycloakAuth } from "../middleware/keycloakAuth";
 *     router.get("/whoami", keycloakAuth(), (req, res) => {
 *       res.json({ user: (req as any).keycloakUser });
 *     });
 *
 * Configuration via env vars:
 *
 *   KEYCLOAK_URL                  http://localhost:8086
 *   KEYCLOAK_REALM                tellus
 *   KEYCLOAK_FRONTEND_CLIENT_ID   tellus-frontend  (azp on tokens)
 *   KEYCLOAK_REQUIRED_ROLE        (optional realm role to enforce)
 *
 * The middleware is gated on KEYCLOAK_URL — if unset, every request is
 * rejected with 503 so misconfiguration is loud rather than silent.
 */

import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import { getKeycloakBaseUrl, getKeycloakRealm } from "../auth/keycloakConfig";

// F-P4-26: realm/base-URL no longer read via `|| 'tellus'` / `|| 'http://localhost:8086'`
// directly. Central accessors in ../auth/keycloakConfig fail-closed under
// NODE_ENV=production and keep the dev defaults otherwise. Evaluate lazily
// so the getter throws only on first actual use, not at module import.
const KC_URL = getKeycloakBaseUrl();
const KC_REALM = getKeycloakRealm();
const KC_REQUIRED_ROLE = process.env.KEYCLOAK_REQUIRED_ROLE;
const KC_ISSUER = `${KC_URL}/realms/${KC_REALM}`;
const KC_JWKS_URL = `${KC_ISSUER}/protocol/openid-connect/certs`;

const client = jwksClient({
  jwksUri: KC_JWKS_URL,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 10 * 60 * 1000, // 10 minutes
  rateLimit: true,
  jwksRequestsPerMinute: 30,
});

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback): void {
  if (!header.kid) {
    callback(new Error("token missing kid"));
    return;
  }
  client
    .getSigningKey(header.kid)
    .then((key) => callback(null, key.getPublicKey()))
    .catch((err) => callback(err));
}

export interface KeycloakClaims {
  sub: string;
  email?: string;
  preferred_username?: string;
  realm_access?: { roles: string[] };
  resource_access?: Record<string, { roles: string[] }>;
  azp?: string;
  iss: string;
  exp: number;
  iat: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      keycloakUser?: KeycloakClaims;
    }
  }
}

/**
 * Build the middleware. Per-route options override env defaults.
 */
export function keycloakAuth(opts: { requiredRole?: string } = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!KC_URL) {
      return res.status(503).json({
        error: {
          code: "SSO_NOT_CONFIGURED",
          message: "KEYCLOAK_URL is not set on the backend",
        },
      });
    }

    const auth = req.headers.authorization || "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      return res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Missing Bearer token in Authorization header",
        },
      });
    }
    const token = m[1];

    jwt.verify(
      token,
      getKey,
      {
        algorithms: ["RS256"],
        issuer: KC_ISSUER,
      },
      (err, decoded) => {
        if (err) {
          return res.status(401).json({
            error: { code: "INVALID_TOKEN", message: err.message },
          });
        }
        const claims = decoded as KeycloakClaims;
        const requiredRole = opts.requiredRole || KC_REQUIRED_ROLE;
        if (requiredRole) {
          const roles = claims.realm_access?.roles ?? [];
          if (!roles.includes(requiredRole)) {
            return res.status(403).json({
              error: {
                code: "FORBIDDEN",
                message: `User lacks required realm role '${requiredRole}'`,
              },
            });
          }
        }
        req.keycloakUser = claims;
        next();
      },
    );
  };
}

/** Lightweight introspection helper for ad-hoc checks. */
export async function getJwksUrl(): Promise<string> {
  return KC_JWKS_URL;
}
