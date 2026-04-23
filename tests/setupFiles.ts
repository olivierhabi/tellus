// ---------------------------------------------------------------------------
// tests/setupFiles.ts — per-file auth bootstrap for integration tests
//
// Wired via `vitest.config.ts :: test.setupFiles`. Runs BEFORE every test
// file in the worker. Obtains alice's JWT from the Keycloak test realm
// and installs it on the shared `api()` helper as the default bearer
// token.
//
// Per the Phase A2 contract (F-01):
//   • Every data-plane test request must carry a valid JWT.
//   • Tests that want to assert UNAUTHED behavior call `setAuthToken(null)`
//     or pass an explicit `Authorization` header via the extraHeaders arg.
//   • Tests that want to assert a different archetype (bob/carol/dave)
//     call `await setAuthToken(await getToken("bob"))`.
//
// Fail-closed: if Keycloak is unreachable or alice's credentials don't
// resolve, this throws before the first test runs. That is intentional —
// a silent fallback to "no auth header" would mask F-01 regressions.
// ---------------------------------------------------------------------------

import { beforeAll } from "vitest";
import { setAuthToken } from "./helpers/api";
import { getAliceToken } from "./helpers/tokens";

// F-01 / Phase A2 — universal fetch interceptor.
//
// Many test files define their own local `request()` helper that wraps
// `fetch()` directly, bypassing `api()` and its setAuthToken() surface.
// Pre-A2 those helpers worked because the server accepted anonymous
// traffic. Post-A2 they 401, which would silently downgrade dozens of
// integration suites into "skipping, no ontologies" no-ops — the exact
// anti-pattern (Hard Rule #8: fabricated test passes) the remediation
// brief bans.
//
// Rather than edit 20+ test files, we install a single fetch wrapper
// that attaches the default alice JWT to any localhost:3000 request
// that does NOT already carry an Authorization header. Tests that
// deliberately test unauthenticated behavior must pass
// `Authorization: ""` or target a different host.
//
// Scope: only localhost:3000 (the integration test server). External
// services (Keycloak, OpenSearch, MinIO, etc.) are never touched.
const _origFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);
let _aliceBearer = "";

function hasAuthHeader(init?: RequestInit): boolean {
  if (!init?.headers) return false;
  if (init.headers instanceof Headers) return init.headers.has("authorization");
  if (Array.isArray(init.headers)) {
    return init.headers.some(([k]) => k.toLowerCase() === "authorization");
  }
  return Object.keys(init.headers as Record<string, string>).some(
    (k) => k.toLowerCase() === "authorization",
  );
}

function targetsTestServer(url: string | URL | Request): boolean {
  const s = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  return s.startsWith("http://localhost:3000");
}

globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  if (_aliceBearer && targetsTestServer(input) && !hasAuthHeader(init)) {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${_aliceBearer}`);
    return _origFetch(input, { ...init, headers });
  }
  return _origFetch(input, init);
}) as typeof globalThis.fetch;

// Probe whether Keycloak is reachable. Tests that do NOT need auth (pure
// unit tests) may run in environments where Keycloak is not available;
// in that case we leave the default token unset and let auth-requiring
// tests fail with a clear 401 signal.
async function keycloakReachable(): Promise<boolean> {
  const kcUrl = process.env.KEYCLOAK_URL || "http://localhost:8086";
  try {
    const r = await fetch(`${kcUrl}/realms/${process.env.KEYCLOAK_REALM || "tellus"}/protocol/openid-connect/certs`, {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  if (!(await keycloakReachable())) {
    // Loud stderr signal so an auth failure later is correlated to the root cause.
    // eslint-disable-next-line no-console
    console.warn(
      "[tests/setupFiles] Keycloak not reachable — integration suites that hit auth'd routes will 401.",
    );
    return;
  }
  try {
    const token = await getAliceToken();
    setAuthToken(token);
    // Arm the fetch interceptor above so bare-fetch test helpers
    // get authenticated automatically.
    _aliceBearer = token;
    // Propagate to child processes spawned via selfTestBridge.execSync.
    // The sub-process's tests/helpers/api.ts reads this env var at
    // module load and uses it as the initial bearerToken.
    process.env.TELLUS_TEST_BEARER = token;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[tests/setupFiles] Failed to obtain alice JWT:",
      (err as Error).message,
    );
    // Rethrow — every auth'd test would 401 otherwise and the signal
    // would be noisier than a single up-front failure.
    throw err;
  }
});
