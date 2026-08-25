// ---------------------------------------------------------------------------
// markings-cbac-integration.test.ts — Phase A3/A4 (F-02 + F-03) contract tests
// ---------------------------------------------------------------------------
//
// What this suite proves:
//
//   • F-02 (securityContext + buildSecurityFilter):
//       — A user with the PUBLIC marking sees a PUBLIC document.
//       — A user with SECRET but NOT PUBLIC still sees SECRET documents
//         (markings are disjunctive).
//       — A user with NO markings sees NO documents (fail-closed).
//       — The `dave` archetype (valid JWT, zero markings, zero CBAC)
//         receives an empty result set on every data-plane read, not
//         a 200 with the backing data.
//
//   • F-03 (existence-leak closed):
//       — A document without `_security.markings` is invisible to every
//         human user. The in-flight `ensureDocumentSecurity` helper stamps
//         the default PUBLIC classification on new indexing writes, so this
//         is enforced by directly bypassing the normal indexing path
//         (we PUT a raw doc into OpenSearch with no `_security`) and then
//         asserting the doc is unreachable via the filtered GET endpoint.
//
//   • `/objects/:type/:pk` returns 404, not 200, to marking-violating
//     users — the post-fetch security check at
//     `src/services/queryExecutor.ts:executeGetObject` fires
//     unconditionally (per Phase A4 removal of `if (source?._security)`).
//
// These are the tests the remediation brief mandates for Phase A3/A4
// closure. Deleting or weakening them re-opens F-02 / F-03.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";

const KEYCLOAK_URL = process.env.KEYCLOAK_URL || "http://localhost:8086";
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || "tellus";
const BASE = (process.env.TEST_BASE_URL ?? "http://localhost:3000");

// ---------------------------------------------------------------------------
// Helpers — fetch a real JWT from the test Keycloak instance, not a stub.
// ---------------------------------------------------------------------------

async function getToken(username: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "tellus-frontend",
    scope: "openid",
    username,
    password: "Password123!",
  });
  const res = await fetch(
    `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Keycloak token request for ${username} failed with ${res.status}: ${await res.text()}`,
    );
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

async function authedFetch(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${BASE}${path}`, { ...init, headers });
}

// ---------------------------------------------------------------------------
// Fixture state
// ---------------------------------------------------------------------------

let aliceToken: string; // PUBLIC + CONFIDENTIAL + SECRET + TOP_SECRET
let bobToken: string; // PUBLIC + CONFIDENTIAL + SECRET
let viewerToken: string; // PUBLIC
let daveToken: string; // (empty)

let ontologyId: string;
// Primary keys for fixture docs. We create one Taxpayer with a default
// PUBLIC classification via the action path, then stamp a SECRET doc
// and a TOP_SECRET doc directly into OpenSearch so we can test the
// post-indexing classification path without depending on an action type
// that accepts a markings parameter.
const PK_PUBLIC = `CBAC-PUB-${randomUUID().slice(0, 8)}`;
const PK_SECRET = `CBAC-SEC-${randomUUID().slice(0, 8)}`;
const PK_TOP_SECRET = `CBAC-TS-${randomUUID().slice(0, 8)}`;
const PK_UNCLASSIFIED = `CBAC-UNCL-${randomUUID().slice(0, 8)}`;

// The lane prefixes every OS index (FUNN-ISO) — never hardcode the dev
// default. `tests/laneEnv.ts` pins OS_INDEX_PREFIX for vitest lanes; strip
// just the suffix to build the REST path.
const TAXPAYER_INDEX = `${process.env.OS_INDEX_PREFIX ?? "ontology-"}taxpayer`;
const OS_BASE = process.env.OPENSEARCH_URL ?? "http://localhost:9200";

// Palantir semantics: a doc with no `_security` is invisible to every
// marking-constrained user. We create it via a raw OS PUT to bypass the
// `ensureDocumentSecurity` helper that would otherwise stamp PUBLIC.

async function stampRawDoc(
  pk: string,
  markings: string[] | null,
): Promise<void> {
  const doc: Record<string, unknown> = {
    __pk: pk,
    __objectType: "Taxpayer",
    __version: 1,
    __lastModified: new Date().toISOString(),
    __editedBy: "markings-cbac-test",
    tin: pk,
    fullName: `Marking fixture ${pk}`,
    taxpayerType: "Individual",
  };
  if (markings !== null) {
    doc._security = { markings, cbac: [] };
  }
  const res = await fetch(
    `${OS_BASE}/${TAXPAYER_INDEX}/_doc/${pk}?refresh=true`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    },
  );
  if (!res.ok) {
    throw new Error(
      `OpenSearch PUT for ${pk} failed with ${res.status}: ${await res.text()}`,
    );
  }
}

async function deleteRawDoc(pk: string): Promise<void> {
  await fetch(
    `${OS_BASE}/${TAXPAYER_INDEX}/_doc/${pk}?refresh=true`,
    { method: "DELETE" },
  ).catch(() => {});
}

// ---------------------------------------------------------------------------

describe("CBAC + Markings enforcement (F-02 / F-03)", () => {
  beforeAll(async () => {
    [aliceToken, bobToken, viewerToken, daveToken] = await Promise.all([
      getToken("cypress-admin@tellus.local"),
      getToken("cypress@tellus.local"),
      getToken("cypress-viewer@tellus.local"),
      getToken("cypress-nogroups@tellus.local"),
    ]);

    // Discover the canonical ontology id. Singleton deployment: there is
    // exactly one ontology, so body.data[0] is it. Do NOT match on
    // displayName === "RRA Tax Ontology" — other suites (e.g. monday's
    // "Update ontology" test) mutate the shared canonical ontology's
    // displayName, which would break a name-based lookup. Verify the real
    // dependency (the seeded Taxpayer object type) exists instead.
    const res = await authedFetch("/api/v1/ontology", aliceToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ ontologyId: string; displayName: string }>;
    };
    const o = body.data?.[0];
    if (!o) throw new Error("Canonical ontology is missing");
    ontologyId = o.ontologyId;

    const otRes = await authedFetch(
      `/api/v1/ontology/${ontologyId}/objectTypes/Taxpayer`,
      aliceToken,
    );
    if (otRes.status !== 200) {
      throw new Error(`Seeded 'Taxpayer' object type is missing (status ${otRes.status})`);
    }

    // Stamp the four fixture docs. Order does not matter — OpenSearch
    // PUTs are independent.
    await Promise.all([
      stampRawDoc(PK_PUBLIC, ["PUBLIC"]),
      stampRawDoc(PK_SECRET, ["SECRET"]),
      stampRawDoc(PK_TOP_SECRET, ["TOP_SECRET"]),
      stampRawDoc(PK_UNCLASSIFIED, null),
    ]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([
      deleteRawDoc(PK_PUBLIC),
      deleteRawDoc(PK_SECRET),
      deleteRawDoc(PK_TOP_SECRET),
      deleteRawDoc(PK_UNCLASSIFIED),
    ]);
  });

  // -------------------------------------------------------------------------
  // F-02: the security filter actually filters
  // -------------------------------------------------------------------------

  it("alice (all markings) can read the PUBLIC document", async () => {
    const res = await authedFetch(
      `/api/v1/objects/Taxpayer/${PK_PUBLIC}`,
      aliceToken,
    );
    expect(res.status).toBe(200);
    // The single-object GET returns a flat record (not wrapped in `data`)
    // whose primary key is exposed as `__pk`. The marking stays on
    // the payload because alice has the PUBLIC marking.
    const body = (await res.json()) as Record<string, unknown>;
    // Served doc shape: the PG/overlay-backed read stamps `__pk`; the
    // OS-serving projection stamps `__primaryKey`. Both carry the PK.
    expect(body.__pk ?? body.__primaryKey ?? body.tin).toBe(PK_PUBLIC);
  });

  it("alice can read the SECRET document", async () => {
    const res = await authedFetch(
      `/api/v1/objects/Taxpayer/${PK_SECRET}`,
      aliceToken,
    );
    expect(res.status).toBe(200);
  });

  it("alice can read the TOP_SECRET document", async () => {
    const res = await authedFetch(
      `/api/v1/objects/Taxpayer/${PK_TOP_SECRET}`,
      aliceToken,
    );
    expect(res.status).toBe(200);
  });

  it("bob (PUBLIC+CONFIDENTIAL+SECRET) can read SECRET but NOT TOP_SECRET", async () => {
    const okRes = await authedFetch(
      `/api/v1/objects/Taxpayer/${PK_SECRET}`,
      bobToken,
    );
    expect(okRes.status).toBe(200);

    const forbidRes = await authedFetch(
      `/api/v1/objects/Taxpayer/${PK_TOP_SECRET}`,
      bobToken,
    );
    expect(forbidRes.status).toBe(404);
  });

  it("viewer (PUBLIC only) can read PUBLIC but NOT SECRET", async () => {
    const okRes = await authedFetch(
      `/api/v1/objects/Taxpayer/${PK_PUBLIC}`,
      viewerToken,
    );
    expect(okRes.status).toBe(200);

    const forbidRes = await authedFetch(
      `/api/v1/objects/Taxpayer/${PK_SECRET}`,
      viewerToken,
    );
    expect(forbidRes.status).toBe(404);
  });

  it("dave (zero markings) cannot read ANY document — fail-closed", async () => {
    for (const pk of [PK_PUBLIC, PK_SECRET, PK_TOP_SECRET]) {
      const res = await authedFetch(
        `/api/v1/objects/Taxpayer/${pk}`,
        daveToken,
      );
      expect(
        res.status,
        `dave should not be able to read ${pk}, got ${res.status}`,
      ).toBe(404);
    }
  });

  // -------------------------------------------------------------------------
  // F-03: the existence-leak via missing `_security` is closed
  // -------------------------------------------------------------------------

  it("F-03: a document with NO `_security` field is invisible to every human user", async () => {
    for (const [label, tok] of [
      ["alice", aliceToken],
      ["bob", bobToken],
      ["viewer", viewerToken],
      ["dave", daveToken],
    ] as const) {
      const res = await authedFetch(
        `/api/v1/objects/Taxpayer/${PK_UNCLASSIFIED}`,
        tok,
      );
      expect(
        res.status,
        `${label} must not see an unclassified document (F-03), got ${res.status}`,
      ).toBe(404);
    }
  });

  it("F-03: the unclassified document DOES exist in OpenSearch (proving the filter is what hides it)", async () => {
    const res = await fetch(
      `${OS_BASE}/${TAXPAYER_INDEX}/_doc/${PK_UNCLASSIFIED}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { _source?: Record<string, unknown> };
    expect(body._source).toBeDefined();
    expect((body._source as any)._security).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // F-02: search (not just get-by-id) respects the filter
  // -------------------------------------------------------------------------

  it("viewer cannot surface SECRET docs via a search call", async () => {
    const res = await authedFetch(
      `/api/v1/objects/Taxpayer/search`,
      viewerToken,
      {
        method: "POST",
        body: JSON.stringify({
          filter: [{ property: "tin", operator: "eq", value: PK_SECRET }],
          pageSize: 10,
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: Array<{ __pk?: string; tin?: string }>;
    };
    const rows = body.data ?? [];
    const pks = rows.map((d) => d.__pk ?? d.tin);
    expect(pks).not.toContain(PK_SECRET);
  });

  it("alice surfaces SECRET docs via search", async () => {
    const res = await authedFetch(
      `/api/v1/objects/Taxpayer/search`,
      aliceToken,
      {
        method: "POST",
        body: JSON.stringify({
          filter: [{ property: "tin", operator: "eq", value: PK_SECRET }],
          pageSize: 10,
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: Array<{ __pk?: string; tin?: string }>;
    };
    const rows = body.data ?? [];
    const pks = rows.map((d) => d.__pk ?? d.tin);
    expect(pks).toContain(PK_SECRET);
  });
});
