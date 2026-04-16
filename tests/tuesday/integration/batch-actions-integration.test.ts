// ---------------------------------------------------------------------------
// Bulk Action Execution Integration Tests (Task 25)
//
// Verifies the POST /:actionTypeApiName/applyBatch endpoint that executes
// the same action type multiple times with different parameter sets in a
// single API call. Tests cover:
//
//   1.  Successful batch of 3 create actions
//   2.  Batch with mixed success/failure (some params valid, some not)
//   3.  Batch returns 200 even when all items fail
//   4.  Batch with over 100 requests returns 400
//   5.  Missing requests field returns 400
//   6.  Empty requests array returns 400
//   7.  Non-existent action type fails all items in batch
//   8.  Batch response contains correct structure (batchId, counts, results)
//   9.  Successful batch items have affectedObjects
//  10.  Failed batch items have failureType and errorMessage
//
// These tests hit the live server at http://localhost:3000 and require
// PostgreSQL + OpenSearch to be running.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://localhost:3000";

let serverReachable = false;
let ontologyId = "";

const RUN_ID = Date.now().toString(36).slice(-6);

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function request(
  method: string,
  path: string,
  body?: unknown
) {
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
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function actionTypesPath(suffix = "") {
  return `/api/v1/ontologies/${ontologyId}/actionTypes${suffix}`;
}

function actionsPath(actionApiName: string, suffix = "") {
  return `/api/v1/ontologies/${ontologyId}/actions/${actionApiName}${suffix}`;
}

async function ensureActionType(def: Record<string, unknown>): Promise<void> {
  const res = await request("POST", actionTypesPath(), def);
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(
      `Failed to create action type '${def.apiName}': ${res.status} ${JSON.stringify(res.body).substring(0, 300)}`
    );
  }
}

async function applyBatch(
  actionApiName: string,
  body: Record<string, unknown>
) {
  return request("POST", actionsPath(actionApiName, "/applyBatch"), body);
}

async function fetchObject(objectType: string, primaryKey: string) {
  return request("GET", `/api/v1/objects/${objectType}/${encodeURIComponent(primaryKey)}`);
}

// ---------------------------------------------------------------------------
// Server reachability + ontology discovery
// ---------------------------------------------------------------------------

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    serverReachable = res.ok;
  } catch {
    console.warn(
      "Server not reachable at http://localhost:3000 — skipping batch tests"
    );
    return;
  }

  const ont = await request("GET", "/api/v1/ontologies");
  if (ont.status === 200 && ont.body?.data?.length > 0) {
    const seedOnt = ont.body.data.find((o: any) => o.displayName === "RRA Tax Ontology" || o.displayName === "Rwanda Revenue Authority") || ont.body.data[0];
    ontologyId = seedOnt.ontologyId;
  } else {
    console.warn("No ontologies found — skipping batch tests");
    serverReachable = false;
  }
});

function skip(): boolean {
  return !serverReachable || !ontologyId;
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe("Bulk Action Execution (Task 25)", () => {
  const CREATE_ACTION = `batchCreate${RUN_ID}`;
  const MODIFY_ACTION = `batchModify${RUN_ID}`;

  // Setup: create action types for tests
  beforeAll(async () => {
    if (skip()) return;

    // Create action for creating Taxpayer objects
    await ensureActionType({
      apiName: CREATE_ACTION,
      displayName: "Batch Create Taxpayer",
      parameters: [
        { apiName: "tin", displayName: "TIN", type: "string", required: true },
        { apiName: "fullName", displayName: "Full Name", type: "string", required: true },
      ],
      rules: [
        {
          type: "createObject",
          objectType: "Taxpayer",
          properties: {
            tin: { source: "parameter", param: "tin" },
            fullName: { source: "parameter", param: "fullName" },
          },
        },
      ],
    });

    // Create action for modifying Taxpayer objects
    await ensureActionType({
      apiName: MODIFY_ACTION,
      displayName: "Batch Modify Taxpayer",
      parameters: [
        { apiName: "tin", displayName: "TIN", type: "string", required: true },
        { apiName: "fullName", displayName: "Full Name", type: "string", required: true },
      ],
      rules: [
        {
          type: "modifyObject",
          objectType: "Taxpayer",
          objectReference: { source: "parameter", param: "tin" },
          properties: {
            fullName: { source: "parameter", param: "fullName" },
          },
        },
      ],
    });
  });

  // =========================================================================
  // Test 1: Successful batch of 3 create actions
  // =========================================================================
  it("1. successfully creates 3 objects in a single batch", async () => {
    if (skip()) return;

    const tin1 = `BC1A-${RUN_ID}`;
    const tin2 = `BC1B-${RUN_ID}`;
    const tin3 = `BC1C-${RUN_ID}`;

    const res = await applyBatch(CREATE_ACTION, {
      requests: [
        { parameters: { tin: tin1, fullName: "Alice Batch" } },
        { parameters: { tin: tin2, fullName: "Bob Batch" } },
        { parameters: { tin: tin3, fullName: "Charlie Batch" } },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.totalRequests).toBe(3);
    expect(res.body.successCount).toBe(3);
    expect(res.body.failedCount).toBe(0);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.batchId).toBeDefined();
    expect(typeof res.body.totalDurationMs).toBe("number");

    // Verify all three results are successful
    for (let i = 0; i < 3; i++) {
      expect(res.body.results[i].index).toBe(i);
      expect(res.body.results[i].success).toBe(true);
      expect(res.body.results[i].executionId).toBeDefined();
    }

    // Verify objects were actually created
    // Wait a moment for OpenSearch to index
    await new Promise((r) => setTimeout(r, 1500));

    const obj1 = await fetchObject("Taxpayer", tin1);
    expect(obj1.status).toBe(200);

    const obj2 = await fetchObject("Taxpayer", tin2);
    expect(obj2.status).toBe(200);

    const obj3 = await fetchObject("Taxpayer", tin3);
    expect(obj3.status).toBe(200);
  }, 15000);

  // =========================================================================
  // Test 2: Batch with mixed success/failure
  // =========================================================================
  it("2. handles mixed success and failure within a batch", async () => {
    if (skip()) return;

    // First create an object so the second create will fail as duplicate
    const tinExists = `BC2A-${RUN_ID}`;
    const tinNew = `BC2B-${RUN_ID}`;

    // Create the first object individually
    const setup = await request(
      "POST",
      actionsPath(CREATE_ACTION, "/apply"),
      { parameters: { tin: tinExists, fullName: "Pre-existing" } }
    );
    expect(setup.status).toBe(200);

    // Wait for indexing
    await new Promise((r) => setTimeout(r, 1500));

    // Now batch: one new (will succeed), one duplicate (will fail)
    const res = await applyBatch(CREATE_ACTION, {
      requests: [
        { parameters: { tin: tinNew, fullName: "New Person" } },
        { parameters: { tin: tinExists, fullName: "Duplicate" } },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.totalRequests).toBe(2);
    expect(res.body.successCount).toBe(1);
    expect(res.body.failedCount).toBe(1);

    // First should succeed
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[0].index).toBe(0);

    // Second should fail (duplicate primary key)
    expect(res.body.results[1].success).toBe(false);
    expect(res.body.results[1].index).toBe(1);
    expect(res.body.results[1].failureType).toBeDefined();
    expect(res.body.results[1].errorMessage).toBeDefined();
  }, 15000);

  // =========================================================================
  // Test 3: Batch returns 200 even when all items fail
  // =========================================================================
  it("3. returns 200 even when all batch items fail", async () => {
    if (skip()) return;

    // Modify non-existent objects
    const res = await applyBatch(MODIFY_ACTION, {
      requests: [
        { parameters: { tin: `NOEXIST1-${RUN_ID}`, fullName: "A" } },
        { parameters: { tin: `NOEXIST2-${RUN_ID}`, fullName: "B" } },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.successCount).toBe(0);
    expect(res.body.failedCount).toBe(2);
    expect(res.body.results[0].success).toBe(false);
    expect(res.body.results[1].success).toBe(false);
  }, 15000);

  // =========================================================================
  // Test 4: Batch with over 100 requests returns 400
  // =========================================================================
  it("4. returns 400 when batch exceeds 100 requests", async () => {
    if (skip()) return;

    const requests = Array(101)
      .fill(null)
      .map((_, i) => ({
        parameters: { tin: `OVER-${i}-${RUN_ID}`, fullName: `Person ${i}` },
      }));

    const res = await applyBatch(CREATE_ACTION, { requests });

    expect(res.status).toBe(400);
  });

  // =========================================================================
  // Test 5: Missing requests field returns 400
  // =========================================================================
  it("5. returns 400 when requests field is missing", async () => {
    if (skip()) return;

    const res = await applyBatch(CREATE_ACTION, { parameters: {} });

    expect(res.status).toBe(400);
  });

  // =========================================================================
  // Test 6: Empty requests array returns 400
  // =========================================================================
  it("6. returns 400 when requests array is empty", async () => {
    if (skip()) return;

    const res = await applyBatch(CREATE_ACTION, { requests: [] });

    expect(res.status).toBe(400);
  });

  // =========================================================================
  // Test 7: Non-existent action type fails all items
  // =========================================================================
  it("7. non-existent action type fails all items in batch", async () => {
    if (skip()) return;

    const res = await applyBatch(`noSuchAction${RUN_ID}`, {
      requests: [
        { parameters: { tin: "X", fullName: "Y" } },
        { parameters: { tin: "Z", fullName: "W" } },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.successCount).toBe(0);
    expect(res.body.failedCount).toBe(2);
    expect(res.body.results[0].success).toBe(false);
    expect(res.body.results[0].errorMessage).toContain("not found");
    expect(res.body.results[1].success).toBe(false);
    expect(res.body.results[1].errorMessage).toContain("not found");
  });

  // =========================================================================
  // Test 8: Batch response contains correct structure
  // =========================================================================
  it("8. response has correct structure with batchId, counts, results, duration", async () => {
    if (skip()) return;

    const tin = `BC8-${RUN_ID}`;
    const res = await applyBatch(CREATE_ACTION, {
      requests: [{ parameters: { tin, fullName: "Structure Test" } }],
    });

    expect(res.status).toBe(200);

    // Verify top-level fields
    expect(typeof res.body.batchId).toBe("string");
    expect(res.body.batchId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(typeof res.body.totalRequests).toBe("number");
    expect(typeof res.body.successCount).toBe("number");
    expect(typeof res.body.failedCount).toBe("number");
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(typeof res.body.totalDurationMs).toBe("number");
    expect(res.body.totalDurationMs).toBeGreaterThanOrEqual(0);

    // Verify totalRequests = successCount + failedCount
    expect(res.body.totalRequests).toBe(
      res.body.successCount + res.body.failedCount
    );
  });

  // =========================================================================
  // Test 9: Successful batch items have affectedObjects
  // =========================================================================
  it("9. successful items include affectedObjects array", async () => {
    if (skip()) return;

    const tin = `BC9-${RUN_ID}`;
    const res = await applyBatch(CREATE_ACTION, {
      requests: [{ parameters: { tin, fullName: "Affected Objects Test" } }],
    });

    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(true);
    expect(Array.isArray(res.body.results[0].affectedObjects)).toBe(true);
    expect(res.body.results[0].affectedObjects.length).toBeGreaterThanOrEqual(1);

    const affected = res.body.results[0].affectedObjects[0];
    expect(affected.objectType).toBe("Taxpayer");
    expect(affected.primaryKey).toBe(tin);
    expect(affected.operation).toBe("create");
  });

  // =========================================================================
  // Test 10: Failed batch items have failureType and errorMessage
  // =========================================================================
  it("10. failed items include failureType and errorMessage", async () => {
    if (skip()) return;

    // Use missing required parameter to trigger failure
    const res = await applyBatch(CREATE_ACTION, {
      requests: [{ parameters: {} }],
    });

    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(false);
    expect(typeof res.body.results[0].failureType).toBe("string");
    expect(typeof res.body.results[0].errorMessage).toBe("string");
    expect(res.body.results[0].errorMessage.length).toBeGreaterThan(0);
  });
});
