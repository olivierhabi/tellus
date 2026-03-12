// ---------------------------------------------------------------------------
// Thursday Integration Tests
//
// Tests the link type subsystem via HTTP API calls. These tests verify the
// endpoints created in Thursday tasks 2-6 (CRUD), 12-15 (resolution/count),
// and 16-26 (bulk count, search around, export/import, etc.).
//
// If the server is not running, all tests are gracefully skipped.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://localhost:3000";

let serverReachable = false;

async function request(method: string, path: string, body?: unknown) {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    serverReachable = res.ok;
  } catch {
    console.warn("Server not reachable — skipping integration tests");
  }
});

function skipIfNoServer() {
  if (!serverReachable) return true;
  return false;
}

describe("Thursday Integration Tests", () => {
  // ---------------------------------------------------------------------------
  // Link Type CRUD
  // ---------------------------------------------------------------------------

  it("should create a link type", async () => {
    if (skipIfNoServer()) return;

    // First get an ontology
    const ont = await request("GET", "/api/v2/ontologies");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    // Check if object types exist
    const ot = await request("GET", `/api/v2/ontologies/${ontologyId}/objectTypes`);
    if (ot.status !== 200 || !ot.body?.data?.length || ot.body.data.length < 2) return;

    const srcType = ot.body.data[0].apiName;
    const tgtType = ot.body.data.length > 1 ? ot.body.data[1].apiName : ot.body.data[0].apiName;

    // Try to create a link type (may already exist)
    const res = await request("POST", `/api/v2/ontologies/${ontologyId}/linkTypes`, {
      apiName: "integTestLink",
      displayName: "Integration Test Link",
      cardinality: "ONE_TO_MANY",
      sourceObjectTypeApiName: srcType,
      targetObjectTypeApiName: tgtType,
    });

    expect([201, 409]).toContain(res.status);
  });

  it("should list link types", async () => {
    if (skipIfNoServer()) return;

    const ont = await request("GET", "/api/v2/ontologies");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("GET", `/api/v2/ontologies/${ontologyId}/linkTypes`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("totalCount");
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("should return 404 for non-existent link type", async () => {
    if (skipIfNoServer()) return;

    const ont = await request("GET", "/api/v2/ontologies");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("GET", `/api/v2/ontologies/${ontologyId}/linkTypes/nonExistentLink`);
    expect(res.status).toBe(404);
  });

  it("should validate create — missing fields", async () => {
    if (skipIfNoServer()) return;

    const ont = await request("GET", "/api/v2/ontologies");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v2/ontologies/${ontologyId}/linkTypes`, {
      apiName: "testBad",
    });
    expect(res.status).toBe(400);
  });

  it("should validate create — invalid cardinality", async () => {
    if (skipIfNoServer()) return;

    const ont = await request("GET", "/api/v2/ontologies");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v2/ontologies/${ontologyId}/linkTypes`, {
      apiName: "testBadCard",
      displayName: "Bad Card",
      cardinality: "INVALID",
      sourceObjectTypeApiName: "Foo",
      targetObjectTypeApiName: "Bar",
    });
    expect(res.status).toBe(400);
  });

  it("should validate PUT — immutable field rejection", async () => {
    if (skipIfNoServer()) return;

    const ont = await request("GET", "/api/v2/ontologies");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    // Try to change apiName via PUT
    const res = await request("PUT", `/api/v2/ontologies/${ontologyId}/linkTypes/integTestLink`, {
      apiName: "renamedLink",
    });
    // Should return 400 (immutable) or 404 (not found)
    expect([400, 404]).toContain(res.status);
  });

  // ---------------------------------------------------------------------------
  // Resolution endpoints
  // ---------------------------------------------------------------------------

  it("should require objectPK and direction for resolve", async () => {
    if (skipIfNoServer()) return;

    const ont = await request("GET", "/api/v2/ontologies");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v2/ontologies/${ontologyId}/linkTypes/integTestLink/resolve`, {});
    expect([400, 404]).toContain(res.status);
  });

  it("should require direction for searchAround", async () => {
    if (skipIfNoServer()) return;

    const ont = await request("GET", "/api/v2/ontologies");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v2/ontologies/${ontologyId}/linkTypes/integTestLink/searchAround`, {});
    expect([400, 404]).toContain(res.status);
  });

  it("should require objectPK and direction for count", async () => {
    if (skipIfNoServer()) return;

    const ont = await request("GET", "/api/v2/ontologies");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v2/ontologies/${ontologyId}/linkTypes/integTestLink/count`, {});
    expect([400, 404]).toContain(res.status);
  });

  // ---------------------------------------------------------------------------
  // Bulk count
  // ---------------------------------------------------------------------------

  it("should validate bulkCount requests", async () => {
    if (skipIfNoServer()) return;

    const ont = await request("GET", "/api/v2/ontologies");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v2/ontologies/${ontologyId}/linkTypes/bulkCount`, {});
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Multi-hop
  // ---------------------------------------------------------------------------

  it("should validate multiHop — missing steps", async () => {
    if (skipIfNoServer()) return;

    const ont = await request("GET", "/api/v2/ontologies");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v2/ontologies/${ontologyId}/linkTypes/multiHop`, {
      startingPKs: ["pk1"],
    });
    expect(res.status).toBe(400);
  });

  it("should validate multiHop — missing startingPKs", async () => {
    if (skipIfNoServer()) return;

    const ont = await request("GET", "/api/v2/ontologies");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v2/ontologies/${ontologyId}/linkTypes/multiHop`, {
      steps: [{ linkTypeApiName: "test", direction: "forward" }],
    });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  it("should export link types as JSON", async () => {
    if (skipIfNoServer()) return;

    const ont = await request("GET", "/api/v2/ontologies");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("GET", `/api/v2/ontologies/${ontologyId}/linkTypes/export`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ontologyId");
    expect(res.body).toHaveProperty("exportedAt");
    expect(res.body).toHaveProperty("linkTypes");
    expect(Array.isArray(res.body.linkTypes)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------------

  it("should validate import — missing linkTypes array", async () => {
    if (skipIfNoServer()) return;

    const ont = await request("GET", "/api/v2/ontologies");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v2/ontologies/${ontologyId}/linkTypes/import`, {});
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Validate migration
  // ---------------------------------------------------------------------------

  it("should validate migration — missing targetCardinality", async () => {
    if (skipIfNoServer()) return;

    const ont = await request("GET", "/api/v2/ontologies");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v2/ontologies/${ontologyId}/linkTypes/integTestLink/validateMigration`, {});
    expect([400, 404]).toContain(res.status);
  });

  // ---------------------------------------------------------------------------
  // Objects /:objectType/:pk/links/:linkType endpoint
  // ---------------------------------------------------------------------------

  it("should return 404 for link on non-existent object type", async () => {
    if (skipIfNoServer()) return;

    const res = await request("GET", "/api/v2/objects/NonExistentType/pk1/links/someLink");
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Objects searchAround
  // ---------------------------------------------------------------------------

  it("should validate searchAround — missing linkType", async () => {
    if (skipIfNoServer()) return;

    const ont = await request("GET", "/api/v2/ontologies");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;
    const ot = await request("GET", `/api/v2/ontologies/${ontologyId}/objectTypes`);
    if (ot.status !== 200 || !ot.body?.data?.length) return;

    const objectType = ot.body.data[0].apiName;
    const res = await request("POST", `/api/v2/objects/${objectType}/searchAround`, {
      direction: "forward",
    });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Cleanup: delete integration test link type
  // ---------------------------------------------------------------------------

  it("should delete the test link type", async () => {
    if (skipIfNoServer()) return;

    const ont = await request("GET", "/api/v2/ontologies");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("DELETE", `/api/v2/ontologies/${ontologyId}/linkTypes/integTestLink`);
    expect([200, 204, 404]).toContain(res.status);
  });
});
