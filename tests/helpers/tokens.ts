// ---------------------------------------------------------------------------
// tokens.ts — Keycloak JWT acquisition helper for integration tests
//
// F-01 / Phase A2:
//   Every data-plane route is now guarded by `globalAuth()`. Integration
//   tests must present a real Keycloak-issued JWT on every request.
//   Mocks/stubs would defeat the middleware, so we obtain actual tokens
//   from the Keycloak test realm via direct-grant OAuth flow.
//
// Archetypes (matching the Palantir Multipass test-user archetypes
// described in docs/TEST-FIXTURES.md):
//
//   alice  — cypress-admin@tellus.local   (ontology-admin)
//            Full clearance. Default principal for most integration tests.
//   bob    — cypress@tellus.local         (ontology-editor)
//            Editor. Used in CBAC tests for write permission boundaries.
//   carol  — cypress-viewer@tellus.local  (ontology-viewer)
//            Read-only. Used in CBAC tests for write-path 403 assertions.
//   dave   — cypress-nogroups@tellus.local (no realm roles)
//            Zero clearance, zero CBAC. Used in A3 fail-closed tests.
//
// Each archetype's access token is cached at module scope for the life of
// the worker. Keycloak's default access-token TTL is 5 minutes — longer
// than any integration test suite — so refresh is not required in-band.
// If a test runs past the TTL (unlikely), calling `resetTokenCache()` and
// re-requesting re-fetches.
// ---------------------------------------------------------------------------

export type Archetype = "alice" | "bob" | "carol" | "dave";

interface ArchetypeConfig {
  username: string;
  password: string;
}

const DEFAULT_PASSWORD =
  process.env.KEYCLOAK_TEST_PASS || "Password123!";

const ARCHETYPES: Record<Archetype, ArchetypeConfig> = {
  alice: {
    username: process.env.KEYCLOAK_ADMIN_TEST_USER || "cypress-admin@tellus.local",
    password: DEFAULT_PASSWORD,
  },
  bob: {
    username: process.env.KEYCLOAK_TEST_USER || "cypress@tellus.local",
    password: DEFAULT_PASSWORD,
  },
  carol: {
    username: process.env.KEYCLOAK_VIEWER_TEST_USER || "cypress-viewer@tellus.local",
    password: DEFAULT_PASSWORD,
  },
  dave: {
    username: process.env.KEYCLOAK_NOGROUPS_TEST_USER || "cypress-nogroups@tellus.local",
    password: DEFAULT_PASSWORD,
  },
};

const KC_URL = process.env.KEYCLOAK_URL || "http://localhost:8086";
const KC_REALM = process.env.KEYCLOAK_REALM || "tellus";
const KC_CLIENT_ID =
  process.env.KEYCLOAK_FRONTEND_CLIENT_ID || "tellus-frontend";

const tokenCache = new Map<Archetype, string>();

async function directGrant(archetype: Archetype): Promise<string> {
  const cfg = ARCHETYPES[archetype];
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: KC_CLIENT_ID,
    username: cfg.username,
    password: cfg.password,
    scope: "openid",
  });
  const res = await fetch(
    `${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(
      `[tokens] Direct-grant failed for ${archetype} (${cfg.username}): ` +
        `HTTP ${res.status} ${txt.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error(
      `[tokens] Direct-grant response missing access_token for ${archetype}`,
    );
  }
  return data.access_token;
}

/**
 * Return a cached JWT for the requested archetype, fetching on first call.
 * Throws on Keycloak unreachable or invalid credentials — tests should fail
 * fast with a clear signal, never fall back to unauthenticated requests.
 */
export async function getToken(archetype: Archetype): Promise<string> {
  const cached = tokenCache.get(archetype);
  if (cached) return cached;
  const token = await directGrant(archetype);
  tokenCache.set(archetype, token);
  return token;
}

/**
 * Force-refresh the cached token for an archetype. Used only when a test
 * deliberately invalidates a session (logout, token revocation tests).
 */
export function resetTokenCache(archetype?: Archetype): void {
  if (archetype) {
    tokenCache.delete(archetype);
  } else {
    tokenCache.clear();
  }
}

/**
 * Convenience: obtain alice's token (the default for most integration tests).
 */
export async function getAliceToken(): Promise<string> {
  return getToken("alice");
}
