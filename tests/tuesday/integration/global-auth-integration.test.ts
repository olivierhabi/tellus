// ---------------------------------------------------------------------------
// global-auth-integration.test.ts
//
// F-01 / Phase A2 closure test. Verifies the `globalAuth()` middleware
// (src/middleware/globalAuth.ts) rejects every data-plane request that
// does not carry a valid Keycloak JWT, and that the explicit allowlist
// (/health, /api/v1/auth/*, /api/docs, /api/metrics family) still accepts
// anonymous traffic because operators cannot authenticate probes and
// scrapers.
//
// This test is the inverse of every other integration test — where the
// others rely on tests/setupFiles.ts silently attaching alice's JWT, this
// one deliberately BYPASSES that setup to probe the unauthenticated
// surface. It does so by targeting the server with a raw fetch using an
// Authorization header of "" (empty), which the setupFiles interceptor
// treats as already-set and leaves alone.
//
// If this test fails, the server has regressed on F-01: some data-plane
// route is publicly accessible. Do not skip, do not loosen.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll } from "vitest";
import { getToken } from "../../helpers/tokens";

const BASE = process.env.TEST_BASE_URL || (process.env.TEST_BASE_URL ?? "http://localhost:3000");

// Probe without the default interceptor by passing an explicit empty
// Authorization header. Setting the header to "" makes
// tests/setupFiles.ts's `hasAuthHeader()` check return true, so the
// interceptor will NOT overwrite it with alice's token.
async function probeAnonymous(method: string, path: string) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: "" },
  });
  await res.text().catch(() => {}); // drain body
  return res.status;
}

async function probeWithBearer(
  method: string,
  path: string,
  token: string,
) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  await res.text().catch(() => {});
  return res.status;
}

describe("F-01 Global Auth — data-plane protection", () => {
  let serverReachable = false;

  beforeAll(async () => {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`health probe returned ${res.status}`);
      serverReachable = true;
    } catch (err) {
      throw new Error(
        "F-P2-01: integration server unreachable at " + BASE +
        " — beforeAll fails loudly. F-01 regression guard must not ghost-pass. " +
        "Root cause: " + ((err as Error)?.message || err)
      );
    }
  });

  // -------------------------------------------------------------------------
  // Allowlist — these MUST NOT be rejected by the gate.
  // -------------------------------------------------------------------------

  it("GET /health without auth → 200 (K8s liveness, allowlisted)", async () => {
    const status = await probeAnonymous("GET", "/health");
    expect(status).toBe(200);
  });

  it("GET /api/v1/auth/health without auth → 200 (auth surface itself, allowlisted)", async () => {
    const status = await probeAnonymous("GET", "/api/v1/auth/health");
    expect(status).toBe(200);
  });

  it("OPTIONS /api/v1/objects/Taxpayer without auth → 204 (CORS preflight)", async () => {
    // Browsers never send Authorization on preflight.
    const res = await fetch(`${BASE}/api/v1/objects/Taxpayer/anything`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
        Authorization: "",
      },
    });
    // 204 is the CORS canonical; 200 also acceptable.
    expect([200, 204]).toContain(res.status);
  });

  // -------------------------------------------------------------------------
  // Data plane — these MUST be rejected without a valid credential.
  // -------------------------------------------------------------------------

  it("GET /api/v1/ontology without auth → 401 (data-plane, gated)", async () => {
    const status = await probeAnonymous("GET", "/api/v1/ontology");
    expect(status).toBe(401);
  });

  it("GET /api/v1/objects/Taxpayer/X without auth → 401 (F-01 regression gate)", async () => {
    const status = await probeAnonymous(
      "GET",
      "/api/v1/objects/Taxpayer/PROBE-NONEXISTENT",
    );
    // MUST be 401, NOT 404. A 404 here would mean globalAuth lets the
    // request through to the handler, which is precisely F-01.
    expect(status).toBe(401);
  });

  it("POST /api/v1/ontology without auth → 401 (write path gated)", async () => {
    const res = await fetch(`${BASE}/api/v1/ontology`, {
      method: "POST",
      headers: {
        Authorization: "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName: "Rogue", description: "n/a" }),
    });
    await res.text().catch(() => {});
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/audit without auth → 401 (audit endpoint gated)", async () => {
    const status = await probeAnonymous("GET", "/api/v1/audit");
    expect(status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Invalid/tampered JWTs — MUST be rejected with 401, not accepted.
  // -------------------------------------------------------------------------

  it("GET /api/v1/ontology with garbage Bearer token → 401", async () => {
    const status = await probeWithBearer(
      "GET",
      "/api/v1/ontology",
      "this.is.not.a.valid.jwt",
    );
    expect(status).toBe(401);
  });

  it("GET /api/v1/ontology with forged HS256 JWT → 401 (RS256 enforced)", async () => {
    // A token signed with HS256 must never be accepted — globalAuth
    // pins `algorithms: ["RS256"]`. Even if the signature were valid,
    // the algorithm mismatch rejects it. We don't bother computing a
    // real HS256 signature; any non-RS256 token will fail JWKS lookup
    // and return 401.
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT", kid: "rogue" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: "rogue",
        iss: "http://localhost:8086/realms/tellus",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    const bogus = `${header}.${payload}.bogusSig`;
    const status = await probeWithBearer("GET", "/api/v1/ontology", bogus);
    expect(status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Positive control — valid JWT MUST succeed.
  // -------------------------------------------------------------------------

  it("GET /api/v1/ontology with alice's valid JWT → 200", async () => {
    const alice = await getToken("alice");
    const status = await probeWithBearer("GET", "/api/v1/ontology", alice);
    expect(status).toBe(200);
  });

  it("GET /api/v1/ontology with dave's valid JWT (no roles) → 200 (authenticated, just no clearance — Phase A3 refines)", async () => {
    // Phase A2 only enforces authentication. Phase A3 will further gate
    // on CBAC/Markings so dave's lack of clearance causes filtered-empty
    // responses — but for now authentication alone is enough.
    const dave = await getToken("dave");
    const status = await probeWithBearer("GET", "/api/v1/ontology", dave);
    expect(status).toBe(200);
  });
});
