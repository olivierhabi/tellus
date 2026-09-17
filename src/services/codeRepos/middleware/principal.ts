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
//            ONLY when CODE_REPOS_TEST_AUTH=1 is set in the environment AND
//            the request carries the shared harness token
//            (X-Tellus-Test-Auth-Token ↔ CODE_REPOS_TEST_AUTH_TOKEN)
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
import {
  isTestAuthBypassEnabled,
  isTestAuthTokenBound,
} from "../../../utils/testAuthGate";
import { buildEnvelope, ERROR_CODES } from "../contracts/errors";
import { requireTellusAuth } from "../../../middleware/tellusAuth";

export interface CodeReposPrincipal {
  readonly userId: string;
  /** Keycloak `sub` when the principal came from a JWT (undefined for
   *  test-header principals and PATs without a mapped sub). Carried so
   *  the Function publish trust gate (functions/executionPolicy.ts) can
   *  match either the local users.id or the stable IdP identity. */
  readonly keycloakSub?: string;
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
 * Build a synthetic `test`-source principal from a
 * `<userId>[/<role1>,<role2>...]` header string + call next(). Shared by the
 * X-Tellus-Test-Principal override.
 *
 * Additional roles come from the documented `X-Tellus-Test-Role` /
 * `X-Tellus-Test-Roles: r1,r2` headers (api/docs/CODE_REPOSITORY_API.md).
 * Roles embedded in the principal header are passed through verbatim
 * (existing callers pin exact case, e.g. `tellus-superadmin`), but the two
 * role headers carry the Compass repo-role vocabulary, so the well-known
 * names are canonicalized case-insensitively (viewer/editor/owner/reader
 * → VIEWER/EDITOR/OWNER/READER) before the Compass policy sees them.
 *
 * Security (vuln-0038): the Function publish role (`function:publish`, or
 * whatever `executionPolicy().publishRole` resolves to) is NEVER accepted
 * from the header — it is stripped from the embedded roles so a forged
 * X-Tellus-Test-Principal cannot self-authorize Function publication. The
 * real publish authorization still flows through authorizePublish()
 * (Keycloak role or a function_publish_grants row).
 */
const PUBLISH_ROLE_BLOCKLIST = new Set(["function:publish"]);

// ---------------------------------------------------------------------------
// Loopback peer check — mirrors globalAuth.ts's gating of the
// X-Tellus-Test-Auth header (vuln-0034). The X-Tellus-Test-Principal bypass
// is a test-only affordance: it must never bind an identity to a request
// arriving from a non-local peer. Behind the dev stack's proxy every remote
// caller appears loopback, so this is defense-in-depth on top of the
// CODE_REPOS_TEST_AUTH flag — but on a directly-exposed deployment it is the
// difference between "anyone on the network can forge any principal" and
// "only same-host test harnesses can".
// ---------------------------------------------------------------------------
function isLoopbackPeer(req: Request): boolean {
  const ip = req.socket?.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function applyHeaderPrincipal(
  req: Request,
  res: Response,
  next: NextFunction,
  header: string,
): void {
  const CANONICAL_REPO_ROLES: Record<string, string> = {
    viewer: "VIEWER",
    editor: "EDITOR",
    owner: "OWNER",
    reader: "READER",
  };
  const canonicalize = (r: string) =>
    CANONICAL_REPO_ROLES[r.trim().toLowerCase()] ?? r.trim();
  const extraRoleHeaders = [req.header("X-Tellus-Test-Role"), req.header("X-Tellus-Test-Roles")]
    .filter((h): h is string => typeof h === "string" && h.length > 0);
  const [userId, rolesCsv] = header.split("/");
  if (!userId) {
    sendUnauthenticated(res, req, "X-Tellus-Test-Principal missing userId");
    return;
  }
  const embeddedRoles = (rolesCsv ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0 && !PUBLISH_ROLE_BLOCKLIST.has(r.toLowerCase()));
  const headerRoles = extraRoleHeaders
    .flatMap((h) => h.split(","))
    .map(canonicalize)
    .filter((r) => r.length > 0 && !PUBLISH_ROLE_BLOCKLIST.has(r.toLowerCase()));
  const roles = [...embeddedRoles, ...headerRoles];
  req.codeReposPrincipal = {
    userId,
    source: "test",
    roles,
    scopes: [],
    sourceIp: extractIp(req),
    userAgent: extractUa(req),
  };
  next();
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
    // Test/dev mode — only honoured when the env opt-in is set.
    // Test mode is TERMINAL: when CODE_REPOS_TEST_AUTH=1, we either set a
    // synthetic principal (from the X-Tellus-Test-Principal header, or the
    // localhost dev fallback) or return our §1.3 envelope. We do NOT fall
    // through to upstream because the upstream `requireTellusAuth` middleware
    // has its own envelope shape (errorName: "AuthenticationError") which would
    // violate G-C-08's requirement of `Stemma:Unauthenticated`.
    if (isTestAuthBypassEnabled("CODE_REPOS_TEST_AUTH")) {
      // 1. Explicit test-principal override (G-C-11). Honoured ONLY when the
      //    caller proves possession of the shared harness secret
      //    (CODE_REPOS_TEST_AUTH_TOKEN, compared timing-safely) — the flag
      //    alone merely enables test mode in this process; it does not
      //    authenticate the caller. The peer address cannot distinguish
      //    harness from attacker on forwarded deployments (every remote
      //    caller appears loopback behind the dev stack's proxy), so the
      //    shared token is the actual boundary; the loopback check remains
      //    defense-in-depth. Fail closed when the env token is unset, too
      //    short, or mismatched.
      const header = req.header("X-Tellus-Test-Principal");
      if (
        typeof header === "string" &&
        header.length > 0 &&
        isLoopbackPeer(req) &&
        isTestAuthTokenBound(req)
      ) {
        applyHeaderPrincipal(req, res, next, header);
        return;
      }
      // 2. No header + test mode: fail closed with 401 (vuln-0024/0038/0042).
      //    The previous "localhost dev fallback" fabricated a superadmin
      //    principal (tellus-superadmin + a pre-seeded publish grant) for any
      //    loopback-appearing caller — behind a proxy/gateway every remote
      //    caller satisfies that, so a zero-role/no-header request could
      //    self-grant publish rights and publish executable Functions. There
      //    is no legitimate reason to bind an unauthenticated request to a
      //    privileged identity; require an explicit X-Tellus-Test-Principal
      //    header (tests) or a real credential instead.
      sendUnauthenticated(res, req, "Authentication required (no test principal header)");
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
        keycloakSub: tp.keycloakSub ?? undefined,
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
