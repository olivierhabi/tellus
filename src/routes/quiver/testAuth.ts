import {
  isTestAuthBypassEnabled,
  isTestAuthTokenValueBound,
  TEST_AUTH_TOKEN_HEADER,
} from "../../utils/testAuthGate";
// ---------------------------------------------------------------------------
// testAuth.ts — single source of truth for the Quiver test-auth bypass guard.
//
// Several Quiver route handlers (and the OT WebSocket gateway) accept an
// `x-test-user` header as the acting principal so the integration/e2e suite
// can drive endpoints without minting real Multipass tokens. That bypass MUST
// never be reachable in production: a single mis-set env var would otherwise
// turn a request header into an unauthenticated identity-injection vector.
//
// We therefore require BOTH:
//   • `QUIVER_ALLOW_TEST_AUTH === "1"` (the explicit opt-in), AND
//   • `NODE_ENV !== "production"` (a hard backstop the opt-in cannot override).
//
// `assertQuiverTestAuthSafe()` is called at boot so the process refuses to
// start if the dangerous combination is ever configured, turning a latent
// runtime hole into an immediate, loud deploy-time failure.
// ---------------------------------------------------------------------------

/**
 * True only when the test-auth `x-test-user` bypass is permitted for the
 * current process. Fail-closed: production always returns false regardless
 * of `QUIVER_ALLOW_TEST_AUTH`.
 */
export function isQuiverTestAuthAllowed(): boolean {
  return isTestAuthBypassEnabled("QUIVER_ALLOW_TEST_AUTH");
}

/**
 * Boot-time assertion: refuse to start a production process that has the
 * test-auth bypass enabled. Mirrors the other fail-fast boot guards in
 * `server.ts`.
 */
export function assertQuiverTestAuthSafe(): void {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.QUIVER_ALLOW_TEST_AUTH === "1"
  ) {
    throw new Error(
      "QUIVER_ALLOW_TEST_AUTH=1 is set in a production process. The x-test-user " +
        "auth bypass must never be enabled in production. Unset it before deploying.",
    );
  }
}

// ---------------------------------------------------------------------------
// Token binding (vuln: unauth test-user injection). The flag only says "test
// mode is allowed in this process" — it does not authenticate the CALLER.
// The caller must additionally prove possession of the shared harness token
// (CODE_REPOS_TEST_AUTH_TOKEN, >= 32 chars, timing-safe). The primary
// channel is the X-Tellus-Test-Auth-Token header; the WebSocket gateway
// additionally accepts the `x-tellus-test-auth-token` query parameter
// because browsers cannot set headers on the upgrade request (the FE
// wsClient already sends x-test-user the same way). Query delivery is
// opt-in per call site — HTTP routes stay header-only.
// ---------------------------------------------------------------------------

/** Query-string twin of the harness-token header (WS-browser path only). */
export const TEST_AUTH_TOKEN_QUERY_PARAM = "x-tellus-test-auth-token";

/** Minimal request shape shared by Express requests and raw upgrade messages. */
export interface QuiverTestAuthRequest {
  header?: (name: string) => string | undefined;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  url?: string;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.find((v): v is string => typeof v === "string");
  }
  return undefined;
}

function headerToken(req: QuiverTestAuthRequest): string | undefined {
  try {
    const viaFn = req.header?.(TEST_AUTH_TOKEN_HEADER);
    if (typeof viaFn === "string" && viaFn.length > 0) return viaFn;
  } catch {
    // A throwing header accessor must never grant the bypass.
  }
  const headers = req.headers;
  if (headers && typeof headers === "object") {
    // Node lowercases incoming header names on the raw upgrade request.
    return firstString(
      (headers as Record<string, unknown>)[TEST_AUTH_TOKEN_HEADER.toLowerCase()],
    );
  }
  return undefined;
}

function queryToken(req: QuiverTestAuthRequest): string | undefined {
  const query = req.query;
  if (query && typeof query === "object") {
    const parsed = firstString(
      (query as Record<string, unknown>)[TEST_AUTH_TOKEN_QUERY_PARAM],
    );
    if (parsed !== undefined) return parsed;
  }
  if (typeof req.url === "string") {
    try {
      const value = new URL(req.url, "http://localhost").searchParams.get(
        TEST_AUTH_TOKEN_QUERY_PARAM,
      );
      if (value !== null) return value;
    } catch {
      // Malformed URLs fail closed (no token extracted).
    }
  }
  return undefined;
}

/**
 * True only when the test bypass is enabled for this process AND the
 * request proves possession of the shared harness token. All `x-test-user`
 * acceptance sites MUST use this (not the bare flag check): an untokened
 * header binds no identity. `allowQueryToken` is reserved for the
 * WebSocket gateway — browsers cannot set upgrade-request headers.
 */
export function isQuiverTestAuthBound(
  req: QuiverTestAuthRequest,
  opts?: { allowQueryToken?: boolean },
): boolean {
  if (!isQuiverTestAuthAllowed()) return false;
  if (isTestAuthTokenValueBound(headerToken(req) ?? "")) return true;
  if (opts?.allowQueryToken) {
    return isTestAuthTokenValueBound(queryToken(req) ?? "");
  }
  return false;
}
