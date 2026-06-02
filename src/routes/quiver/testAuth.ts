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
  return (
    process.env.QUIVER_ALLOW_TEST_AUTH === "1" &&
    process.env.NODE_ENV !== "production"
  );
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
