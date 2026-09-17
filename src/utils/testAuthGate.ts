// ---------------------------------------------------------------------------
// testAuthGate.ts — the single place that decides whether a test-auth
// bypass (X-Tellus-Test-Principal, X-Tellus-Test-Hook, x-test-user) may
// be honored.
//
// Rules:
//   1. The bypass flag must be explicitly set ("1").
//   2. NODE_ENV must never be "production".
//   3. An UNSET NODE_ENV follows the Express convention (development)
//      for surfaces that historically allowed it (code-repos,
//      quiver) — local dev and the cypress harness boot without
//      NODE_ENV. Surfaces that were deliberately fail-closed on
//      unset (code-assistant) keep that stricter policy via
//      `allowUnsetNodeEnv: false`.
//
// Every acceptance path MUST go through isTestAuthBypassEnabled so
// the production-rejection semantics cannot drift between routers.
//
// vuln (unauth test-principal injection): the FLAG alone only says "test mode
// is allowed in this process" — it does not authenticate the CALLER. The
// TCP-peer loopback check is not a boundary on port-forwarded deployments
// (Docker Desktop's host.docker.internal proxy presents remote callers as
// loopback to the host process), so every header-driven test-principal
// bypass MUST additionally prove possession of the shared harness token
// (CODE_REPOS_TEST_AUTH_TOKEN, >= 32 chars, compared timing-safely) via the
// X-Tellus-Test-Auth-Token header. Fail closed: an unset/short env token
// disables the bypass entirely.
// ---------------------------------------------------------------------------

import { timingSafeEqual } from "node:crypto";

export interface TestAuthGateOptions {
  /** When false, an unset NODE_ENV disables the bypass (fail-closed). */
  readonly allowUnsetNodeEnv?: boolean;
}

export function isTestAuthBypassEnabled(
  flag: string,
  opts: TestAuthGateOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[flag] !== "1") return false;
  if (env.NODE_ENV === "production") return false;
  if (!env.NODE_ENV && opts.allowUnsetNodeEnv === false) return false;
  return true;
}

/**
 * Boot-time assertion: in production, NONE of the bypass flags may be
 * set. Throws (fail fast) naming the offending flag. Mirrors and
 * supersedes the per-flag inline checks in server.ts.
 */
export function assertNoTestAuthInProduction(
  flags: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== "production") return;
  for (const flag of flags) {
    if (env[flag] === "1") {
      throw new Error(
        `${flag}=1 is set in production — test-auth bypasses must never ` +
          "be enabled in production. Unset it before deploying.",
      );
    }
  }
}

/** All test-auth bypass flags honored anywhere in the server. */
export const TEST_AUTH_FLAGS = [
  "CODE_REPOS_TEST_AUTH",
  "CODE_ASSISTANT_TEST_AUTH",
  "QUIVER_ALLOW_TEST_AUTH",
  "TELLUS_AUTH_TEST_HOOKS",
  "TELLUS_TEST_HOOKS",
] as const;

/**
 * Request header that must carry the shared harness token
 * ({@link isTestAuthTokenBound}) for any test-principal bypass to bind an
 * identity to the request.
 */
export const TEST_AUTH_TOKEN_HEADER = "X-Tellus-Test-Auth-Token";

/**
 * True only when the presented token matches the shared harness token
 * (`CODE_REPOS_TEST_AUTH_TOKEN`, compared timing-safely). Fail closed: an
 * unset or too-short env token rejects every presented value, and a
 * length-mismatched presented value is rejected before the timing-safe
 * comparison (which would otherwise throw on unequal Buffer lengths).
 */
export function isTestAuthTokenValueBound(presented: string): boolean {
  const expected = process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "";
  if (expected.length < 32 || presented.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(presented, "utf8"),
  );
}

/**
 * True only when the request proves possession of the shared harness token
 * (`CODE_REPOS_TEST_AUTH_TOKEN`, compared timing-safely against the
 * {@link TEST_AUTH_TOKEN_HEADER} header). Fail closed: an unset or
 * too-short env token rejects every request, and a length-mismatched
 * presented token is rejected before the timing-safe comparison (which
 * would otherwise throw on unequal Buffer lengths).
 */
export function isTestAuthTokenBound(req: {
  header: (name: string) => string | undefined;
}): boolean {
  return isTestAuthTokenValueBound(req.header(TEST_AUTH_TOKEN_HEADER) ?? "");
}
