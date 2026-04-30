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
import { api, BASE_URL } from "../../helpers/api";

const BASE = BASE_URL;

let serverReachable = false;

// F-01 / Phase A2: route requests through the shared `api()` helper so the
// default alice JWT (installed by tests/setupFiles.ts) is attached on every
// call. A bare `fetch()` here would 401 against the globalAuth gate.
async function request(method: string, path: string, body?: unknown) {
  return api(method, path, body);
}

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`health probe returned ${res.status}`);
    serverReachable = true;
  } catch (err) {
    throw new Error(
      "F-P2-01: integration server unreachable at " + BASE +
      " — beforeAll fails loudly rather than ghost-passing. " +
      "Start the server (pnpm dev) before running integration tests. " +
      "Root cause: " + ((err as Error)?.message || err)
    );
  }
});

describe("Thursday Integration Tests", () => {
  // ---------------------------------------------------------------------------
  // Link Type CRUD
  // ---------------------------------------------------------------------------

  it("should create a link type", async () => {

    // First get an ontology
    const ont = await request("GET", "/api/v1/ontology");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    // Check if object types exist
    const ot = await request("GET", `/api/v1/ontology/${ontologyId}/objectTypes`);
    if (ot.status !== 200 || !ot.body?.data?.length || ot.body.data.length < 2) return;

    const srcType = ot.body.data[0].apiName;
    const tgtType = ot.body.data.length > 1 ? ot.body.data[1].apiName : ot.body.data[0].apiName;

    // Try to create a link type (may already exist)
    const res = await request("POST", `/api/v1/ontology/${ontologyId}/linkTypes`, {
      apiName: "integTestLink",
      displayName: "Integration Test Link",
      cardinality: "ONE_TO_MANY",
      sourceObjectTypeApiName: srcType,
      targetObjectTypeApiName: tgtType,
    });

    expect([201, 409]).toContain(res.status);
  });

  it("should list link types", async () => {

    const ont = await request("GET", "/api/v1/ontology");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("GET", `/api/v1/ontology/${ontologyId}/linkTypes`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("totalCount");
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("should return 404 for non-existent link type", async () => {

    const ont = await request("GET", "/api/v1/ontology");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("GET", `/api/v1/ontology/${ontologyId}/linkTypes/nonExistentLink`);
    expect(res.status).toBe(404);
  });

  it("should validate create — missing fields", async () => {

    const ont = await request("GET", "/api/v1/ontology");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v1/ontology/${ontologyId}/linkTypes`, {
      apiName: "testBad",
    });
    expect(res.status).toBe(400);
  });

  it("should validate create — invalid cardinality", async () => {

    const ont = await request("GET", "/api/v1/ontology");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v1/ontology/${ontologyId}/linkTypes`, {
      apiName: "testBadCard",
      displayName: "Bad Card",
      cardinality: "INVALID",
      sourceObjectTypeApiName: "Foo",
      targetObjectTypeApiName: "Bar",
    });
    expect(res.status).toBe(400);
  });

  it("should validate PUT — immutable field rejection", async () => {

    const ont = await request("GET", "/api/v1/ontology");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    // Try to change apiName via PUT
    const res = await request("PUT", `/api/v1/ontology/${ontologyId}/linkTypes/integTestLink`, {
      apiName: "renamedLink",
    });
    // Should return 400 (immutable) or 404 (not found)
    expect([400, 404]).toContain(res.status);
  });

  // ---------------------------------------------------------------------------
  // Resolution endpoints
  // ---------------------------------------------------------------------------

  it("should require objectPK and direction for resolve", async () => {

    const ont = await request("GET", "/api/v1/ontology");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v1/ontology/${ontologyId}/linkTypes/integTestLink/resolve`, {});
    expect([400, 404]).toContain(res.status);
  });

  it("should require direction for searchAround", async () => {

    const ont = await request("GET", "/api/v1/ontology");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v1/ontology/${ontologyId}/linkTypes/integTestLink/searchAround`, {});
    expect([400, 404]).toContain(res.status);
  });

  it("should require objectPK and direction for count", async () => {

    const ont = await request("GET", "/api/v1/ontology");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v1/ontology/${ontologyId}/linkTypes/integTestLink/count`, {});
    expect([400, 404]).toContain(res.status);
  });

  // ---------------------------------------------------------------------------
  // Bulk count
  // ---------------------------------------------------------------------------

  it("should validate bulkCount requests", async () => {

    const ont = await request("GET", "/api/v1/ontology");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v1/ontology/${ontologyId}/linkTypes/bulkCount`, {});
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Multi-hop
  // ---------------------------------------------------------------------------

  it("should validate multiHop — missing steps", async () => {

    const ont = await request("GET", "/api/v1/ontology");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v1/ontology/${ontologyId}/linkTypes/multiHop`, {
      startingPKs: ["pk1"],
    });
    expect(res.status).toBe(400);
  });

  it("should validate multiHop — missing startingPKs", async () => {

    const ont = await request("GET", "/api/v1/ontology");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v1/ontology/${ontologyId}/linkTypes/multiHop`, {
      steps: [{ linkTypeApiName: "test", direction: "forward" }],
    });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  it("should export link types as JSON", async () => {

    const ont = await request("GET", "/api/v1/ontology");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("GET", `/api/v1/ontology/${ontologyId}/linkTypes/export`);
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

    const ont = await request("GET", "/api/v1/ontology");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v1/ontology/${ontologyId}/linkTypes/import`, {});
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Validate migration
  // ---------------------------------------------------------------------------

  it("should validate migration — missing targetCardinality", async () => {

    const ont = await request("GET", "/api/v1/ontology");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("POST", `/api/v1/ontology/${ontologyId}/linkTypes/integTestLink/validateMigration`, {});
    expect([400, 404]).toContain(res.status);
  });

  // ---------------------------------------------------------------------------
  // Objects /:objectType/:pk/links/:linkType endpoint
  // ---------------------------------------------------------------------------

  it("should return 404 for link on non-existent object type", async () => {

    const res = await request("GET", "/api/v1/objects/NonExistentType/pk1/links/someLink");
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Objects searchAround
  // ---------------------------------------------------------------------------

  it("should validate searchAround — missing linkType", async () => {

    const ont = await request("GET", "/api/v1/ontology");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;
    const ot = await request("GET", `/api/v1/ontology/${ontologyId}/objectTypes`);
    if (ot.status !== 200 || !ot.body?.data?.length) return;

    const objectType = ot.body.data[0].apiName;
    const res = await request("POST", `/api/v1/objects/${objectType}/searchAround`, {
      direction: "forward",
    });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Cleanup: delete integration test link type
  // ---------------------------------------------------------------------------

  it("should delete the test link type", async () => {

    const ont = await request("GET", "/api/v1/ontology");
    if (ont.status !== 200 || !ont.body?.data?.length) return;
    const ontologyId = ont.body.data[0].ontologyId;

    const res = await request("DELETE", `/api/v1/ontology/${ontologyId}/linkTypes/integTestLink`);
    expect([200, 204, 404]).toContain(res.status);
  });
});
