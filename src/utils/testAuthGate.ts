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
// ---------------------------------------------------------------------------

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
  "TELLUS_TEST_HOOKS",
] as const;
