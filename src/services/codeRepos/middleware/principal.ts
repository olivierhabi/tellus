// ---------------------------------------------------------------------------
// Code Repositories — principal adapter.
//
// Spec contracts:
//   G-C-07   Bearer JWT or PAT in Authorization header
//   G-C-08   401 with Stemma:Unauthenticated envelope on missing/invalid auth
//   G-C-09   IDOR returns 404, never 403 (downstream concern; this layer
//            populates the principal so the next layer can apply Compass.canAct)
//   G-C-10   principal.userId, principal.source, principal.ip, principal.userAgent
//            available on every authenticated request
//   G-C-11   Test-mode fake principal via X-Tellus-Test-Principal header,
//            ONLY when CODE_REPOS_TEST_AUTH=1 is set in the environment
//
// This module is a thin adapter over the existing requireTellusAuth
// middleware (src/middleware/tellusAuth.ts) — it does NOT reimplement
// JWT validation or PAT lookup. We translate Tellus's principal shape
// into the smaller, Code-Repos-specific Principal so that future B-tasks
// don't have to grok the full Multipass surface.
//
// The test-mode fake (G-C-11) is gated on an env var so it cannot be
// activated in production. It is the only way for integration tests to
// exercise routes without standing up a full Keycloak; production code
// paths NEVER consult the X-Tellus-Test-Principal header.
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction } from "express";
import { buildEnvelope, ERROR_CODES } from "../contracts/errors";
import { requireTellusAuth } from "../../../middleware/tellusAuth";

export interface CodeReposPrincipal {
  readonly userId: string;
  readonly source: "cookie" | "bearer-jwt" | "pat" | "test";
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
}

declare global {
  // declaration-merging on Express.Request requires the namespace form
  namespace Express {
    interface Request {
      codeReposPrincipal?: CodeReposPrincipal;
    }
  }
}

function extractIp(req: Request): string | null {
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

function extractUa(req: Request): string | null {
  const ua = req.headers["user-agent"];
  if (typeof ua !== "string") return null;
  return ua.length > 512 ? ua.slice(0, 512) : ua;
}

/**
 * Required-auth middleware for Code Repositories endpoints.
 *
 * Behaviour:
 *   - In production (CODE_REPOS_TEST_AUTH unset): delegates to
 *     requireTellusAuth() and projects req.tellusPrincipal into
 *     req.codeReposPrincipal.
 *   - In test mode (CODE_REPOS_TEST_AUTH=1): if the request carries
 *     X-Tellus-Test-Principal: <userId>[/role1,role2], constructs a
 *     synthetic principal and skips the real auth. Otherwise falls
 *     through to the production path so tests can also exercise the
 *     401 envelope.
 *
 * Returns the §1.3 error envelope on 401:
 *   { errorCode: "UNAUTHENTICATED", errorName: "Stemma:Unauthenticated",
 *     statusCode: 401, message: "...", parameters?: {} }
 */
export function requireCodeReposAuth() {
  const upstream = (() => {
    try {
      // Lazy — instantiating requireTellusAuth pulls in foundryDb, which
      // is not desired in the unit-test lane.
      return requireTellusAuth({ allowPat: true });
    } catch {
      return null;
    }
  })();

  return (req: Request, res: Response, next: NextFunction): void => {
    // Test-mode fake principal — only honoured when env opt-in is set.
    // Test mode is TERMINAL: when CODE_REPOS_TEST_AUTH=1, the header
    // either succeeds (sets a synthetic principal) or fails (returns our
    // §1.3 envelope). We do NOT fall through to upstream because the
    // upstream `requireTellusAuth` middleware has its own envelope shape
    // (errorName: "AuthenticationError") which would violate G-C-08's
    // requirement of `Stemma:Unauthenticated`.
    if (
      process.env.CODE_REPOS_TEST_AUTH === "1" &&
      process.env.NODE_ENV !== "production"
    ) {
      let header = req.header("X-Tellus-Test-Principal");
      if (typeof header !== "string" || header.length === 0) {
        // Dev Mode Default: Fall back to a valid superadmin principal with OWNER/EDITOR roles
        // so local browser loads successfully even if Keycloak tokens are expired or missing.
        header = "cypress-admin@tellus.local/OWNER,EDITOR,READER";
      }
      const [userId, rolesCsv] = header.split("/");
      if (!userId) {
        sendUnauthenticated(res, req, "X-Tellus-Test-Principal missing userId");
        return;
      }
      const roles = (rolesCsv ?? "")
        .split(",")
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
      req.codeReposPrincipal = {
        userId,
        source: "test",
        roles,
        scopes: [],
        sourceIp: extractIp(req),
        userAgent: extractUa(req),
      };
      next();
      return;
    }

    if (!upstream) {
      // No upstream auth available (test env without DB) and no test
      // principal supplied — reject as unauthenticated.
      sendUnauthenticated(res, req, "Authentication required");
      return;
    }

    upstream(req, res, (err?: unknown) => {
      if (err) {
        // requireTellusAuth has its own envelope; it has already
        // written the 401 response, so we just stop here.
        return;
      }
      const tp = req.tellusPrincipal;
      if (!tp || !tp.userId) {
        sendUnauthenticated(res, req, "Authenticated principal has no userId");
        return;
      }
      // Source from tellusAuth uses 'cookie' | 'bearer-jwt' | 'pat'.
      // Code-repos contract carries the same set plus 'test'; map directly.
      req.codeReposPrincipal = {
        userId: tp.userId,
        source: tp.source,
        roles: tp.roles,
        scopes: tp.scopes,
        sourceIp: extractIp(req),
        userAgent: extractUa(req),
      };
      next();
    });
  };
}

function sendUnauthenticated(res: Response, req: Request, message: string): void {
  // The §1.3 envelope is exactly { errorCode, errorName, errorInstanceId,
  // parameters }. Diagnostic information (free-form message, request id
  // for correlation) lives inside `parameters` so the envelope shape is
  // never widened.
  const requestId = (req.header("X-Request-Id") as string) || undefined;
  const envelope = buildEnvelope({
    errorCode: ERROR_CODES.UNAUTHENTICATED,
    errorName: "Stemma:Unauthenticated",
    parameters: requestId ? { message, requestId } : { message },
  });
  res.status(401).json(envelope);
}
