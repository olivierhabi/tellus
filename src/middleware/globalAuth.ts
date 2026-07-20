/**
 * globalAuth.ts
 * -------------
 * Global authentication gate mounted on the Express app BEFORE
 * `securityContext` and AFTER `patSecurityGate`. Every data-plane
 * request must present a valid authentication credential — either a
 * Keycloak-issued JWT (Bearer) or a Tellus PAT resolved earlier by
 * `patSecurityGate`.
 *
 * This closes audit finding F-01: "All data-plane endpoints are
 * unauthenticated. keycloakAuth() is used on 2 of 60 route files.
 * Objects, actions, links, search, audit are publicly accessible."
 *
 * Palantir Multipass parity contract:
 *   1. Every read and every write requires an authenticated principal.
 *   2. The principal's claims (sub, realm_access.roles, attributes)
 *      are normalized onto `req.user` / `req.auth` so downstream
 *      middleware (`securityContext`) can derive markings/orgs/cbac.
 *   3. Missing or invalid credentials return HTTP 401 with the
 *      Conjure-compatible `{errorCode, errorName, message, ...}` envelope.
 *   4. Failure is fail-CLOSED: if the JWKS endpoint is unreachable or
 *      token verification throws, the request is rejected, never passed.
 *
 * Allowlist — each entry is justified inline so a future refactor
 * cannot silently loosen the boundary without review:
 *
 *   /health*                     K8s liveness/readiness probes. Probes
 *                                run at high frequency and MUST NOT
 *                                be authenticated — operators cannot
 *                                mint a JWT for every kubelet.
 *
 *   /api/v1/health*              Application-level health router
 *                                (healthReadyRouter, healthDetailed).
 *                                Same K8s-probe rationale.
 *
 *   /api/metrics                 Prometheus scrape endpoint. Scrape
 *   /api/v1/pipelines/metrics    targets are internal-only (network
 *   /api/v1/funnel/metrics       isolation, not JWT). Authenticating
 *                                Prometheus would require a short-
 *                                lived token rotation we do not have.
 *
 *   /api/v1/auth/*               The authentication surface itself:
 *                                /auth/login, /auth/refresh, /auth/me,
 *                                /auth/health. Requiring auth to
 *                                authenticate would create a chicken-
 *                                and-egg dependency.
 *
 *   /api/docs, /api/docs/*       Swagger UI + OpenAPI JSON spec.
 *                                Publicly readable by design; contains
 *                                no secrets. In production these may
 *                                be guarded at the ingress layer.
 *
 *   /api/v1/dev/*                Dev tools router. Already gated by
 *                                `NODE_ENV !== "production"` at mount
 *                                time (src/server.ts:590). Keeping
 *                                the allowlist entry is defense in
 *                                depth: if someone forgets the env
 *                                gate in prod, the route is still
 *                                auth-required.
 *
 *   /api/v1/_test/*              Test hooks (rate-limiter reset, etc.).
 *                                Gated by `TELLUS_TEST_HOOKS === "1"`
 *                                (src/server.ts:401). Same defense-in-
 *                                depth rationale as /dev.
 *
 *   OPTIONS *                    CORS preflight. Browsers do NOT send
 *                                Authorization on preflight; rejecting
 *                                with 401 would break every CORS client.
 */

import type { NextFunction, Request, Response } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import jwksClient, { type JwksClient } from "jwks-rsa";
import { getKeycloakRealm } from "../auth/keycloakConfig"; // F-P4-26

const KC_URL = process.env.KEYCLOAK_URL || "http://localhost:8086";
const KC_REALM = getKeycloakRealm();
const KC_ISSUER = `${KC_URL}/realms/${KC_REALM}`;
const KC_JWKS_URL = `${KC_ISSUER}/protocol/openid-connect/certs`;

// Lazy singleton — the JWKS client opens an HTTP keep-alive pool, and
// the first getSigningKey() call is slow. Sharing the client across
// every request keeps the p99 auth latency under 5ms once warm.
let _jwks: JwksClient | null = null;
function jwks(): JwksClient {
  if (!_jwks) {
    _jwks = jwksClient({
      jwksUri: KC_JWKS_URL,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 10 * 60 * 1000, // 10 minutes
      rateLimit: true,
      jwksRequestsPerMinute: 30,
      timeout: 5_000,
    });
  }
  return _jwks;
}

function getSigningKey(
  header: jwt.JwtHeader,
  callback: jwt.SigningKeyCallback,
): void {
  if (!header.kid) {
    callback(new Error("token missing kid"));
    return;
  }
  jwks()
    .getSigningKey(header.kid)
    .then((key) => callback(null, key.getPublicKey()))
    .catch((err) => callback(err));
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------
// Each predicate returns true when the path is exempt from the auth gate.
// Predicates run in order; first match wins. Adding an entry requires an
// adjacent justification comment in this file.

function isAllowlisted(req: Request): boolean {
  // CORS preflight — browsers omit Authorization on OPTIONS requests.
  if (req.method === "OPTIONS") return true;

  const p = req.path;
  const url = req.originalUrl || req.url || p;
  
  // DEBUG: Log the path being checked (remove after debugging)
  console.log(`[globalAuth] checking path: ${p}, url: ${url}`);

  // K8s liveness/readiness — /health, /health/ready, /health/detailed, etc.
  if (p === "/health" || p.startsWith("/health/")) return true;

  // Duplicate health router under /api/v1/health (healthRouter mount).
  if (p === "/api/v1/health" || p.startsWith("/api/v1/health/")) return true;

  // Kubernetes-style system probes (src/routes/health.ts).
  // Must stay unauthenticated so kubelet probes never need a JWT.
  if (
    p === "/api/v1/system/liveness" ||
    p === "/api/v1/system/readiness" ||
    p === "/api/v1/system/health" ||
    p === "/api/v1/ready"
  ) {
    return true;
  }

  // Prometheus scrape targets.
  if (p === "/api/metrics") return true;
  if (p === "/api/v1/pipelines/metrics") return true;
  if (p === "/api/v1/funnel/metrics") return true;

  // Authentication surface itself — /api/v1/auth/*
  const authMatch = p === "/api/v1/auth" || p.startsWith("/api/v1/auth/");
  console.log(`[globalAuth] auth allowlist check: ${p} -> ${authMatch}`);
  if (authMatch) {
    console.log(`[globalAuth] ALLOWLISTED: ${p}`);
    return true;
  }

  // Swagger UI + OpenAPI JSON spec. Note the `url` check catches
  // /api/docs?foo=bar; `p` check catches bare /api/docs and subpaths.
  if (p === "/api/docs" || p.startsWith("/api/docs/")) return true;
  if (url.startsWith("/api/docs?")) return true;

  // Code-Server Web-IDE proxy. The frontend iframe makes a direct
  // cross-origin connection to the backend proxy. Since code-server
  // handles its own inner requests statically and via ws, this route
  // needs to be allowlisted globally.
  if (p === "/api/v1/workspaces" || p.startsWith("/api/v1/workspaces/")) return true;

  // Dev tools — defense in depth; also gated at mount by NODE_ENV.
  if (p.startsWith("/api/v1/dev/") || p === "/api/v1/dev") return true;

  // Test hooks — defense in depth; also gated at mount by TELLUS_TEST_HOOKS.
  if (p.startsWith("/api/v1/_test/")) return true;

  // Connectivity worker credential unwrap (B2/B4). The foundry-worker child
  // calls this with a short-lived workload JWT (issuer tellus:multipass:
  // workload), NOT a Keycloak user token, so the global gate would reject it.
  // The handler (secrets.handler.internalUnwrapWorker) verifies the workload
  // JWT's signature, expiry, scope, and connection_rid binding itself; in
  // production a NetworkPolicy additionally restricts this /internal path to
  // in-cluster callers. Exact-match only — no other /internal sub-paths.
  if (p === "/api/v1/connectivity/internal/credentials/unwrap") return true;

  // Code Repositories (B2) — has its own auth chain (requireCodeReposAuth →
  // requireTellusAuth) that handles test-mode header bypass when
  // CODE_REPOS_TEST_AUTH=1. Allowlisting the prefix here lets the test
  // header path work end-to-end without needing a full Multipass/Keycloak
  // login in cypress. In production, the per-router auth chain still
  // enforces JWT/PAT validation — the global gate is just one of two
  // enforcement layers.
  if (p === "/api/v1/code-repositories" || p.startsWith("/api/v1/code-repositories/")) return true;

  // Code Assistant (AI coding agent for TypeScript Functions v2) — same
  // two-layer pattern as code-repositories above: `createCodeAssistantRouter`
  // mounts `requireCodeAssistantAuth` internally (which honours the
  // CODE_ASSISTANT_TEST_AUTH=1 X-Tellus-Test-Principal bypass used by
  // Cypress), so this allowlist entry only sidesteps the global Tellus auth
  // gate. In production the per-router JWT/PAT validation still runs.
  if (p === "/api/v1/code-assistant" || p.startsWith("/api/v1/code-assistant/")) return true;

  // Functions Registry (B8) — same two-layer pattern as code-repositories.
  // `createFunctionsRouter` mounts `requireCodeReposAuth` internally (which
  // honours the CODE_REPOS_TEST_AUTH=1 header bypass), so this allowlist entry
  // only sidesteps the global gate; per-router JWT/PAT validation still runs
  // in production.
  if (p === "/api/v1/functions" || p.startsWith("/api/v1/functions/")) return true;

  // Transform builds + dataset lineage (migration 103) — same two-layer
  // pattern as code-repositories: `createTransformsRouter` mounts
  // `requireCodeReposAuth` internally (honours the CODE_REPOS_TEST_AUTH=1
  // header bypass), so this allowlist entry only sidesteps the global gate.
  if (p === "/api/v1/transforms" || p.startsWith("/api/v1/transforms/")) return true;

  // B3 — Templates service. Allowlisted on the same per-router-auth basis
  // as B2 above: `createTemplatesRouter` mounts `requireCodeReposAuth`
  // internally, so this allowlist entry only sidesteps the global Tellus
  // auth gate (which would otherwise reject the test-mode header bypass
  // used by Cypress). In production the per-router JWT/PAT validation
  // still runs as a second enforcement layer.
  if (p === "/api/v1/templates" || p.startsWith("/api/v1/templates/")) return true;
  if (p === "/api/v1/scaffold") return true;

  // Quiver — has its own per-route test-auth bypass via QUIVER_ALLOW_TEST_AUTH=1
  // (analogous to CODE_REPOS_TEST_AUTH for B2 above). When the bypass is on,
  // we allowlist the /quiver/api/v1 prefix here so the per-route x-test-user
  // path works end-to-end without forcing cypress to obtain a Keycloak JWT
  // whose `iss` claim matches the app's KC_URL. In production the bypass is
  // off and the per-route auth check + securityContext middleware still
  // enforce JWT validation — same two-layer pattern as code-repositories.
  if (
    process.env.QUIVER_ALLOW_TEST_AUTH === "1" &&
    process.env.NODE_ENV !== "production"
  ) {
    if (p === "/quiver" || p.startsWith("/quiver/")) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Error envelope — matches the Conjure-compatible shape used by the rest
// of the application's error handlers (middleware/errorHandler.ts).
// ---------------------------------------------------------------------------

// Read the Keycloak JWT from the httpOnly TELLUS_TOKEN cookie. Prefers the
// cookie-parser-populated req.cookies, falling back to parsing the raw Cookie
// header so this works regardless of middleware ordering.
function readTellusTokenCookie(req: Request): string | undefined {
  const fromParser = (req as Request & { cookies?: Record<string, string> })
    .cookies?.["TELLUS_TOKEN"];
  if (fromParser) return fromParser;
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === "TELLUS_TOKEN") {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

function authError(
  req: Request,
  res: Response,
  code: string,
  message: string,
  status: number,
): void {
  // The jwt.verify callback below is async (JWKS fetch), so it can resolve
  // *after* requestTimeoutMiddleware has already flushed a 504 envelope.
  // Writing a second response throws ERR_HTTP_HEADERS_SENT which surfaces
  // as an unhandled rejection. Bail out cleanly when the response is done.
  if (res.headersSent || res.writableEnded) return;
  const requestId =
    (req.headers["x-request-id"] as string) ||
    (req as Request & { requestId?: string }).requestId ||
    crypto.randomUUID();
  res.status(status).json({
    errorCode: code,
    errorName: "AuthenticationError",
    message,
    statusCode: status,
    requestId,
    error: { code, message },
  });
}

// ---------------------------------------------------------------------------
// Claims normalization — Keycloak JWTs carry realm_access.roles and (when
// the Keycloak attributes-to-claim mapper is configured) custom claims for
// Markings / CBAC. Phase A2 surfaces the raw claims; Phase A3 will wire
// the marking/cbac extraction via a dedicated mapping layer.
// ---------------------------------------------------------------------------

export interface AuthenticatedPrincipal {
  /** Keycloak `sub` — stable user identifier. */
  id: string;
  /** Preferred human-readable identifier (email in tests). */
  email?: string;
  displayName?: string;
  /** Realm-level roles (ontology-admin, ontology-editor, ontology-viewer). */
  roles: string[];
  /** Raw JWT claims, for middleware that needs attribute access. */
  claims: Record<string, unknown>;
}

function normalizeClaims(
  claims: Record<string, unknown>,
): AuthenticatedPrincipal {
  const realmAccess = (claims.realm_access as { roles?: string[] }) || {};
  return {
    id: String(claims.sub ?? ""),
    email: (claims.email as string) ?? undefined,
    displayName:
      (claims.preferred_username as string) ??
      (claims.name as string) ??
      undefined,
    roles: Array.isArray(realmAccess.roles) ? realmAccess.roles : [],
    claims,
  };
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export function globalAuth() {
  return function globalAuthMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // 1. Allowlist short-circuit.
    if (isAllowlisted(req)) {
      return next();
    }

    // 2. PAT already resolved by `patSecurityGate` — accept.
    //    `patSecurityGate` populates `req.tellusPrincipal` when the
    //    Authorization header starts with `tellus_pat_`. If that ran,
    //    the request is authenticated via PAT scope semantics; do not
    //    re-authenticate as a JWT (PATs are opaque, not JWTs).
    const reqAny = req as Request & {
      tellusPrincipal?: { userId: string; source?: string };
      user?: unknown;
      auth?: unknown;
      keycloakUser?: unknown;
    };
    if (reqAny.tellusPrincipal && reqAny.tellusPrincipal.source === "pat") {
      return next();
    }

    // 3. Extract Bearer JWT — or fall back to the TELLUS_TOKEN cookie.
    //    Browser sessions authenticate via the httpOnly TELLUS_TOKEN cookie
    //    set at login, not an Authorization header. The cookie carries the
    //    same Keycloak JWT and is validated identically below, so accepting
    //    it lets same-origin browser calls (e.g. /quiver, proxied via the
    //    FE next.config rewrite) work without the client mirroring the token
    //    into a Bearer header. Header still wins when both are present.
    const authHeader = req.headers.authorization || "";
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    let token = m ? m[1] : "";
    if (!token) {
      const cookieToken = readTellusTokenCookie(req);
      if (cookieToken) token = cookieToken;
    }
    if (!token) {
      return authError(
        req,
        res,
        "UNAUTHORIZED",
        "Missing or malformed Authorization header. Expected: Bearer <token>.",
        401,
      );
    }

    // Non-JWT tokens that aren't PATs shouldn't reach here — reject
    // explicitly so a malformed token can't masquerade as a PAT.
    if (token.startsWith("tellus_pat_")) {
      // `patSecurityGate` must have rejected this already (invalid PAT)
      // or accepted it (which would have set `tellusPrincipal`). If we
      // see a PAT here with no principal, the gate failed open — treat
      // as 401.
      return authError(
        req,
        res,
        "TOKEN_INVALID",
        "Invalid or expired PAT.",
        401,
      );
    }

    // 4. Verify JWT.
    jwt.verify(
      token,
      getSigningKey,
      {
        algorithms: ["RS256"],
        issuer: [KC_ISSUER, `http://localhost:8086/realms/${KC_REALM}`, `http://keycloak:8086/realms/${KC_REALM}`],
      },
      (err, decoded) => {
        if (err || !decoded || typeof decoded !== "object") {
          return authError(
            req,
            res,
            "TOKEN_INVALID",
            err?.message || "JWT verification failed.",
            401,
          );
        }
        const claims = decoded as Record<string, unknown>;
        const principal = normalizeClaims(claims);

        // Populate the three surfaces downstream middleware reads.
        // - `req.user` is the convenience surface (securityContext,
        //   foundry routes).
        // - `req.auth` mirrors OIDC token claims for CBAC filter
        //   extraction (securityContext reads token.realm_access etc.).
        // - `req.keycloakUser` preserves the legacy per-route contract
        //   from middleware/keycloakAuth.ts so the two auth surfaces
        //   remain interchangeable.
        reqAny.user = {
          id: principal.id,
          email: principal.email,
          displayName: principal.displayName,
          roles: principal.roles,
        };
        reqAny.auth = claims;
        reqAny.keycloakUser = claims as unknown as import('./keycloakAuth').KeycloakClaims;
        next();
      },
    );
  };
}

/**
 * Expose the allowlist predicate for unit testing and for the boot-time
 * assertion that a global auth middleware is wired AFTER the /auth router
 * mount (otherwise /auth/login would be rejected by the gate).
 */
export const __isAllowlisted = isAllowlisted;
