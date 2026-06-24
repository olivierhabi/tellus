// ---------------------------------------------------------------------------
// Wednesday Integration Tests
//
// End-to-end tests that verify the query API works correctly with real
// PostgreSQL and OpenSearch. Requires running server.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";

// IMPORTANT: don't read `process.env.BASE_URL` — Vitest (via Vite) sets
// `BASE_URL="/"` in the worker env by default (it mirrors its `base` config),
// which would make every fetch URL become `//health`, `//api/v1/ontology`
// and throw `Failed to parse URL`. Every other test file in this repo reads
// `TEST_BASE_URL` via tests/helpers/api.ts for exactly this reason.
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

async function api(method: string, path: string, body?: unknown) {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

let ONTOLOGY_ID: string;

describe("Wednesday Integration Tests", () => {
  beforeAll(async () => {
    // Check server is up.
    //
    // IMPORTANT: /health is allowlisted by the globalAuth middleware
    // (src/middleware/globalAuth.ts) and must not carry an Authorization
    // header — otherwise the universal fetch interceptor in
    // tests/setupFiles.ts attaches `Bearer <alice-jwt>`, and some
    // JWT-rejection paths (clock skew, JWKS cache miss) can make /health
    // spuriously 4xx at the very start of a vitest worker's lifetime.
    // Passing an explicit empty Authorization bypasses the interceptor.
    try {
      const res = await fetch(`${BASE_URL}/health`, {
        headers: { Authorization: "" },
      });
      if (res.status !== 200) {
        throw new Error(`Server /health returned ${res.status}`);
      }
    } catch (err) {
      // Surface the real cause so CI logs are actionable instead of
      // always reporting a generic "unreachable".
      throw new Error(
        `F-P2-01: integration server unreachable — beforeAll fails loudly: ${(err as Error).message}`,
      );
    }

    // Singleton ontology deployment: POST /api/v1/ontology is frozen
    // (ONTOLOGY_SINGLETON). Resolve the single canonical enterprise
    // ontology instead of creating a fresh one per run.
    const { status: ontStatus, body: ontBody } = await api("GET", "/api/v1/ontology");
    ONTOLOGY_ID = ontBody?.data?.[0]?.ontologyId;
    if (!ONTOLOGY_ID) {
      throw new Error(
        `F-P2-01: canonical ontology not found — beforeAll fails loudly. status=${ontStatus} body=${JSON.stringify(ontBody)?.slice(0, 300)}`,
      );
    }

    // Create Employee object type
    await api("POST", `/api/v1/ontology/${ONTOLOGY_ID}/objectTypes`, {
      apiName: "WedEmployee",
      displayName: "Wed Employee",
      description: "Test employee",
    });

    // Create properties
    const props = [
      { apiName: "employeeId", displayName: "Employee ID", baseType: "string" },
      { apiName: "fullName", displayName: "Full Name", baseType: "string" },
      { apiName: "salary", displayName: "Salary", baseType: "double" },
      { apiName: "department", displayName: "Department", baseType: "string" },
      { apiName: "isActive", displayName: "Is Active", baseType: "boolean" },
    ];

    for (const p of props) {
      await api("POST", `/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/WedEmployee/properties`, p);
    }

    // Set PK property
    const propsRes = await api("GET", `/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/WedEmployee/properties`);
    const employeeIdProp = (propsRes.body?.data || []).find((p: any) => p.apiName === "employeeId" || p.api_name === "employeeId");
    if (employeeIdProp) {
      await api("PUT", `/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/WedEmployee`, {
        primaryKeyPropertyId: employeeIdProp.propertyId || employeeIdProp.property_id,
      });
    }

  }, 30000);

  afterAll(async () => {
    if (ONTOLOGY_ID) {
      await api("DELETE", `/api/v1/ontology/${ONTOLOGY_ID}`);
    }
  }, 10000);

  it("should return 404 for non-existent object type", async () => {
    const { status, body } = await api("GET", "/api/v1/objects/NonExistentType123");
    expect(status).toBe(404);
    expect(body?.error?.code).toBe("OBJECT_TYPE_NOT_FOUND");
  });

  it("should return empty data for unindexed object type", async () => {
    const { status, body } = await api("GET", "/api/v1/objects/WedEmployee");
    expect(status).toBe(200);
    expect(body?.data?.data || body?.data || []).toEqual([]);
  });

  it("should reject invalid $pageSize", async () => {
    // `$pageSize=0` is a VALID "count-only" request (the executor still
    // returns an accurate `totalCount` with an empty `data` array), so it
    // yields 200 — see validatePageSize in src/services/queryValidator.ts.
    // A negative value, by contrast, is genuinely out of range → 400.
    const { status, body } = await api("GET", "/api/v1/objects/WedEmployee?$pageSize=-1");
    expect(status).toBe(400);
  });

  it("should reject $pageSize > 10000", async () => {
    const { status } = await api("GET", "/api/v1/objects/WedEmployee?$pageSize=10001");
    expect(status).toBe(400);
  });

  it("should validate search body — reject unexpected fields", async () => {
    const { status, body } = await api("POST", "/api/v1/objects/WedEmployee/search", {
      $pgeSize: 10,
    });
    expect(status).toBe(400);
    expect(body?.error?.message || "").toContain("Unexpected field");
  });

  it("should validate search body — reject unknown filter type", async () => {
    const { status, body } = await api("POST", "/api/v1/objects/WedEmployee/search", {
      where: { type: "unknownFilter" },
    });
    expect(status).toBe(400);
    expect(body?.error?.message || "").toContain("Unknown filter type");
  });

  it("should validate search body — accept empty body", async () => {
    const { status } = await api("POST", "/api/v1/objects/WedEmployee/search", {});
    expect(status).toBe(200);
  });

  it("should validate search body — reject empty $select", async () => {
    const { status } = await api("POST", "/api/v1/objects/WedEmployee/search", {
      $select: [],
    });
    expect(status).toBe(400);
  });

  it("should return 404 for non-existent object type on search", async () => {
    const { status } = await api("POST", "/api/v1/objects/FakeType999/search", {});
    expect(status).toBe(404);
  });

  it("should validate fulltext search — reject empty query", async () => {
    const { status } = await api("POST", "/api/v1/objects/WedEmployee/searchFullText", {
      query: "",
    });
    expect(status).toBe(400);
  });

  it("should validate aggregate — reject empty aggregations", async () => {
    const { status } = await api("POST", "/api/v1/objects/WedEmployee/aggregate", {
      aggregations: [],
    });
    expect(status).toBe(400);
  });

  it("should return 404 for single object not found", async () => {
    const { status } = await api("GET", "/api/v1/objects/WedEmployee/NONEXISTENT");
    expect(status).toBe(404);
  });
});
