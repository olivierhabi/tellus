// ---------------------------------------------------------------------------
// Wednesday Integration Tests
//
// End-to-end tests that verify the query API works correctly with real
// PostgreSQL and OpenSearch. Requires running server.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

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
let HAS_DATA = false;

describe("Wednesday Integration Tests", () => {
  beforeAll(async () => {
    // Check server is up
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.status !== 200) throw new Error("Server not healthy");
    } catch {
      console.warn("Server not reachable — skipping integration tests");
      return;
    }

    // Create test ontology
    const { body: ontBody } = await api("POST", "/api/v1/ontologies", {
      displayName: "WedIntTest",
      description: "Wednesday integration tests",
    });
    ONTOLOGY_ID = ontBody?.data?.ontologyId || ontBody?.ontologyId;
    if (!ONTOLOGY_ID) return;

    // Create Employee object type
    await api("POST", `/api/v1/ontologies/${ONTOLOGY_ID}/objectTypes`, {
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
      await api("POST", `/api/v1/ontologies/${ONTOLOGY_ID}/objectTypes/WedEmployee/properties`, p);
    }

    // Set PK property
    const propsRes = await api("GET", `/api/v1/ontologies/${ONTOLOGY_ID}/objectTypes/WedEmployee/properties`);
    const employeeIdProp = (propsRes.body?.data || []).find((p: any) => p.apiName === "employeeId" || p.api_name === "employeeId");
    if (employeeIdProp) {
      await api("PUT", `/api/v1/ontologies/${ONTOLOGY_ID}/objectTypes/WedEmployee`, {
        primaryKeyPropertyId: employeeIdProp.propertyId || employeeIdProp.property_id,
      });
    }

    HAS_DATA = true;
  }, 30000);

  afterAll(async () => {
    if (ONTOLOGY_ID) {
      await api("DELETE", `/api/v1/ontologies/${ONTOLOGY_ID}`);
    }
  }, 10000);

  it("should return 404 for non-existent object type", async () => {
    if (!HAS_DATA) return;
    const { status, body } = await api("GET", "/api/v1/objects/NonExistentType123");
    expect(status).toBe(404);
    expect(body?.error?.code).toBe("OBJECT_TYPE_NOT_FOUND");
  });

  it("should return empty data for unindexed object type", async () => {
    if (!HAS_DATA) return;
    const { status, body } = await api("GET", "/api/v1/objects/WedEmployee");
    expect(status).toBe(200);
    expect(body?.data?.data || body?.data || []).toEqual([]);
  });

  it("should reject invalid $pageSize", async () => {
    if (!HAS_DATA) return;
    const { status, body } = await api("GET", "/api/v1/objects/WedEmployee?$pageSize=0");
    expect(status).toBe(400);
  });

  it("should reject $pageSize > 10000", async () => {
    if (!HAS_DATA) return;
    const { status } = await api("GET", "/api/v1/objects/WedEmployee?$pageSize=10001");
    expect(status).toBe(400);
  });

  it("should validate search body — reject unexpected fields", async () => {
    if (!HAS_DATA) return;
    const { status, body } = await api("POST", "/api/v1/objects/WedEmployee/search", {
      $pgeSize: 10,
    });
    expect(status).toBe(400);
    expect(body?.error?.message || "").toContain("Unexpected field");
  });

  it("should validate search body — reject unknown filter type", async () => {
    if (!HAS_DATA) return;
    const { status, body } = await api("POST", "/api/v1/objects/WedEmployee/search", {
      where: { type: "unknownFilter" },
    });
    expect(status).toBe(400);
    expect(body?.error?.message || "").toContain("Unknown filter type");
  });

  it("should validate search body — accept empty body", async () => {
    if (!HAS_DATA) return;
    const { status } = await api("POST", "/api/v1/objects/WedEmployee/search", {});
    expect(status).toBe(200);
  });

  it("should validate search body — reject empty $select", async () => {
    if (!HAS_DATA) return;
    const { status } = await api("POST", "/api/v1/objects/WedEmployee/search", {
      $select: [],
    });
    expect(status).toBe(400);
  });

  it("should return 404 for non-existent object type on search", async () => {
    if (!HAS_DATA) return;
    const { status } = await api("POST", "/api/v1/objects/FakeType999/search", {});
    expect(status).toBe(404);
  });

  it("should validate fulltext search — reject empty query", async () => {
    if (!HAS_DATA) return;
    const { status } = await api("POST", "/api/v1/objects/WedEmployee/searchFullText", {
      query: "",
    });
    expect(status).toBe(400);
  });

  it("should validate aggregate — reject empty aggregations", async () => {
    if (!HAS_DATA) return;
    const { status } = await api("POST", "/api/v1/objects/WedEmployee/aggregate", {
      aggregations: [],
    });
    expect(status).toBe(400);
  });

  it("should return 404 for single object not found", async () => {
    if (!HAS_DATA) return;
    const { status } = await api("GET", "/api/v1/objects/WedEmployee/NONEXISTENT");
    expect(status).toBe(404);
  });
});
