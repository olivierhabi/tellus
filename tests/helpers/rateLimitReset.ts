// ---------------------------------------------------------------------------
// Rate-limiter reset helper for integration tests.
//
// The batch rate limiter keys on `batch:${user.id || "anonymous"}`. Until
// Phase A2 lands (F-01 global auth, per-user JWTs), every unauthenticated
// integration test shares the "anonymous" key, which produces cross-file
// counter contamination when vitest runs test files in parallel.
//
// This helper calls the test-only endpoint mounted by src/server.ts when
// TELLUS_TEST_HOOKS=1. Batch-using test suites call it in their top-level
// beforeAll to start each file with a clean window.
//
// Production has no such endpoint. See src/server.ts around the
// TELLUS_TEST_HOOKS gate.
// ---------------------------------------------------------------------------

const BASE = process.env.TELLUS_TEST_BASE_URL || "http://localhost:3000";

/**
 * Reset the in-process rate-limiter state. Safe to call multiple times.
 * Returns silently on 404 (endpoint not mounted) so unit tests that don't
 * need the helper don't fail.
 */
export async function resetRateLimiter(): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/_test/rate-limiter/reset`, {
    method: "POST",
    // Server gates the reset on this header (Strix Sept 2026) — without it
    // the endpoint answers 403 even from loopback.
    headers: { "x-tellus-test-hook": "1" },
  }).catch(() => null);
  if (!res) return; // server unreachable; suite's own skip guard will handle
  if (res.status === 204) return;
  if (res.status === 404) return; // test hooks not mounted — tolerate
  throw new Error(
    `resetRateLimiter: unexpected status ${res.status} from ${BASE}/api/v1/_test/rate-limiter/reset`,
  );
}
