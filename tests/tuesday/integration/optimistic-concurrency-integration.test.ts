// ---------------------------------------------------------------------------
// Optimistic Concurrency Control Integration Tests (Task 22)
//
// Verifies that $expectedVersion prevents lost updates when two clients
// modify the same object concurrently. Tests cover:
//
//   1. Update without $expectedVersion succeeds (backward compatible)
//   2. Update with correct $expectedVersion succeeds
//   3. __version is incremented after each update
//   4. Update with stale $expectedVersion fails with CONCURRENCY_CONFLICT
//   5. Retry after refresh with new version succeeds
//   6. $expectedVersion on multi-object actions returns 400
//   7. $expectedVersion on create-only actions returns 400
//   8. Invalid $expectedVersion values return 400
//   9. Created objects start with __version = 1
//  10. Multiple sequential updates increment __version correctly
//
// These tests hit the live server at http://localhost:3000 and require
// PostgreSQL + OpenSearch to be running.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://localhost:3000";

let serverReachable = false;
let ontologyId = "";

// Unique suffix for this test run
const RUN_ID = Date.now().toString(36).slice(-6);

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
) {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
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
// Helper: create an action type (idempotent — 201 or 409)
// ---------------------------------------------------------------------------

async function ensureActionType(def: Record<string, unknown>): Promise<void> {
  const res = await request(
    "POST",
    `/api/v2/ontologies/${ontologyId}/actionTypes`,
    def
  );
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(
      `Failed to create action type '${def.apiName}': ${res.status} ${JSON.stringify(res.body).substring(0, 300)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Helper: execute an action with optional $expectedVersion
// ---------------------------------------------------------------------------

async function executeAction(
  actionTypeApiName: string,
  parameters: Record<string, unknown>,
  expectedVersion?: number
) {
  const body: Record<string, unknown> = { parameters };
  if (expectedVersion !== undefined) {
    body.$expectedVersion = expectedVersion;
  }
  return request(
    "POST",
    `/api/v2/ontologies/${ontologyId}/actions/${actionTypeApiName}/apply`,
    body
  );
}

// ---------------------------------------------------------------------------
// Helper: fetch an object from OpenSearch
// ---------------------------------------------------------------------------

async function fetchObject(objectType: string, primaryKey: string) {
  return request(
    "GET",
    `/api/v2/objects/${objectType}/${encodeURIComponent(primaryKey)}`
  );
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
      "Server not reachable at http://localhost:3000 — skipping OCC tests"
    );
    return;
  }

  const ont = await request("GET", "/api/v2/ontologies");
  if (ont.status === 200 && ont.body?.data?.length > 0) {
    const seedOnt = ont.body.data.find((o: any) => o.displayName === "RRA Tax Ontology") || ont.body.data[0];
    ontologyId = seedOnt.ontologyId;
  } else {
    console.warn("No ontologies found — skipping OCC tests");
    serverReachable = false;
  }
});

function skip(): boolean {
  return !serverReachable || !ontologyId;
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe("Optimistic Concurrency Control (Task 22)", () => {
  // =========================================================================
  // Setup: Create action types for testing
  // =========================================================================

  const CREATE_ACTION = "occCreateTaxpayer";
  const MODIFY_ACTION = "occModifyTaxpayer";
  const MULTI_MODIFY_ACTION = "occMultiModify";

  beforeAll(async () => {
    if (skip()) return;

    // Create taxpayer action
    await ensureActionType({
      apiName: CREATE_ACTION,
      displayName: "OCC Test: Create Taxpayer",
      parameters: [
        {
          apiName: "tin",
          displayName: "TIN",
          type: "string",
          required: true,
        },
        {
          apiName: "fullName",
          displayName: "Full Name",
          type: "string",
          required: true,
        },
        {
          apiName: "riskScore",
          displayName: "Risk Score",
          type: "double",
          required: false,
        },
      ],
      rules: [
        {
          type: "createObject",
          objectType: "Taxpayer",
          properties: {
            tin: { source: "parameter", param: "tin" },
            fullName: { source: "parameter", param: "fullName" },
            riskScore: { source: "parameter", param: "riskScore" },
          },
        },
      ],
    });

    // Modify taxpayer action (single object — OCC supported)
    await ensureActionType({
      apiName: MODIFY_ACTION,
      displayName: "OCC Test: Modify Taxpayer",
      parameters: [
        {
          apiName: "tin",
          displayName: "TIN",
          type: "string",
          required: true,
        },
        {
          apiName: "fullName",
          displayName: "Full Name",
          type: "string",
          required: false,
        },
        {
          apiName: "riskScore",
          displayName: "Risk Score",
          type: "double",
          required: false,
        },
      ],
      rules: [
        {
          type: "modifyObject",
          objectType: "Taxpayer",
          objectReference: { source: "parameter", param: "tin" },
          properties: {
            fullName: { source: "parameter", param: "fullName" },
            riskScore: { source: "parameter", param: "riskScore" },
          },
        },
      ],
    });

    // Multi-object modify action (OCC NOT supported in week 1)
    await ensureActionType({
      apiName: MULTI_MODIFY_ACTION,
      displayName: "OCC Test: Multi-Modify",
      parameters: [
        {
          apiName: "tin1",
          displayName: "TIN 1",
          type: "string",
          required: true,
        },
        {
          apiName: "tin2",
          displayName: "TIN 2",
          type: "string",
          required: true,
        },
        {
          apiName: "fullName",
          displayName: "Full Name",
          type: "string",
          required: true,
        },
      ],
      rules: [
        {
          type: "modifyObject",
          objectType: "Taxpayer",
          objectReference: { source: "parameter", param: "tin1" },
          properties: {
            fullName: { source: "parameter", param: "fullName" },
          },
        },
        {
          type: "modifyObject",
          objectType: "Taxpayer",
          objectReference: { source: "parameter", param: "tin2" },
          properties: {
            fullName: { source: "parameter", param: "fullName" },
          },
        },
      ],
    });
  });

  // -------------------------------------------------------------------------
  // Test 1: Update without $expectedVersion succeeds (backward compatible)
  // -------------------------------------------------------------------------

  it("update without $expectedVersion succeeds (backward compatible)", async () => {
    if (skip()) return;

    const tin = `OCC-NOVERSION-${RUN_ID}`;

    // Create the object first
    const createRes = await executeAction(CREATE_ACTION, {
      tin,
      fullName: "No Version Check",
      riskScore: 10,
    });
    expect(createRes.status).toBe(200);

    // Wait for OpenSearch to be searchable
    await new Promise((r) => setTimeout(r, 500));

    // Modify without $expectedVersion — should work
    const modRes = await executeAction(MODIFY_ACTION, {
      tin,
      fullName: "No Version Updated",
    });
    expect(modRes.status).toBe(200);
    expect(modRes.body.result).toBe("success");
  });

  // -------------------------------------------------------------------------
  // Test 2: Update with correct $expectedVersion succeeds
  // -------------------------------------------------------------------------

  it("update with correct $expectedVersion succeeds", async () => {
    if (skip()) return;

    const tin = `OCC-CORRECT-${RUN_ID}`;

    // Create the object
    const createRes = await executeAction(CREATE_ACTION, {
      tin,
      fullName: "Correct Version",
      riskScore: 50,
    });
    expect(createRes.status).toBe(200);

    await new Promise((r) => setTimeout(r, 500));

    // Fetch the object and get its __version
    const obj = await fetchObject("Taxpayer", tin);
    expect(obj.status).toBe(200);
    const version = obj.body.__version;
    expect(version).toBe(1); // newly created = version 1

    // Update with correct version
    const modRes = await executeAction(
      MODIFY_ACTION,
      { tin, fullName: "Correct Version Updated" },
      version
    );
    expect(modRes.status).toBe(200);
    expect(modRes.body.result).toBe("success");
  });

  // -------------------------------------------------------------------------
  // Test 3: __version is incremented after each update
  // -------------------------------------------------------------------------

  it("increments __version after each update", async () => {
    if (skip()) return;

    const tin = `OCC-INCR-${RUN_ID}`;

    // Create
    await executeAction(CREATE_ACTION, {
      tin,
      fullName: "Version Increment",
      riskScore: 10,
    });
    await new Promise((r) => setTimeout(r, 500));

    // Check version after create
    const obj1 = await fetchObject("Taxpayer", tin);
    expect(obj1.body.__version).toBe(1);

    // First update
    await executeAction(MODIFY_ACTION, { tin, riskScore: 20 });
    await new Promise((r) => setTimeout(r, 500));

    const obj2 = await fetchObject("Taxpayer", tin);
    expect(obj2.body.__version).toBe(2);

    // Second update
    await executeAction(MODIFY_ACTION, { tin, riskScore: 30 });
    await new Promise((r) => setTimeout(r, 500));

    const obj3 = await fetchObject("Taxpayer", tin);
    expect(obj3.body.__version).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Test 4: Update with stale $expectedVersion fails (CONCURRENCY_CONFLICT)
  // -------------------------------------------------------------------------

  it("fails with CONCURRENCY_CONFLICT when $expectedVersion is stale", async () => {
    if (skip()) return;

    const tin = `OCC-STALE-${RUN_ID}`;

    // Create the object
    await executeAction(CREATE_ACTION, {
      tin,
      fullName: "Stale Version",
      riskScore: 100,
    });
    await new Promise((r) => setTimeout(r, 500));

    // Fetch version (should be 1)
    const obj = await fetchObject("Taxpayer", tin);
    const originalVersion = obj.body.__version;
    expect(originalVersion).toBe(1);

    // "User A" updates with correct version — succeeds
    const resA = await executeAction(
      MODIFY_ACTION,
      { tin, riskScore: 120 },
      originalVersion
    );
    expect(resA.status).toBe(200);

    await new Promise((r) => setTimeout(r, 500));

    // "User B" tries to update with the OLD version — fails
    const resB = await executeAction(
      MODIFY_ACTION,
      { tin, riskScore: 130 },
      originalVersion // stale!
    );
    expect(resB.status).toBe(409);
    expect(resB.body.errorCode).toBe("CONCURRENCY_CONFLICT");
    expect(resB.body.parameters.expectedVersion).toBe(originalVersion);
    expect(resB.body.parameters.currentVersion).toBe(2);
    expect(resB.body.message).toContain("has been modified since you last read it");
  });

  // -------------------------------------------------------------------------
  // Test 5: Retry after refresh with new version succeeds
  // -------------------------------------------------------------------------

  it("succeeds when retrying with refreshed version", async () => {
    if (skip()) return;

    const tin = `OCC-REFRESH-${RUN_ID}`;

    // Create
    await executeAction(CREATE_ACTION, {
      tin,
      fullName: "Refresh Test",
      riskScore: 100,
    });
    await new Promise((r) => setTimeout(r, 500));

    // Fetch version
    const obj = await fetchObject("Taxpayer", tin);
    const v1 = obj.body.__version;

    // User A updates
    await executeAction(MODIFY_ACTION, { tin, riskScore: 150 }, v1);
    await new Promise((r) => setTimeout(r, 500));

    // User B fails with stale version
    const failRes = await executeAction(
      MODIFY_ACTION,
      { tin, riskScore: 200 },
      v1
    );
    expect(failRes.status).toBe(409);

    // User B refreshes the object
    const refreshed = await fetchObject("Taxpayer", tin);
    const v2 = refreshed.body.__version;
    expect(v2).toBe(2);

    // User B retries with the new version — succeeds
    const retryRes = await executeAction(
      MODIFY_ACTION,
      { tin, riskScore: 200 },
      v2
    );
    expect(retryRes.status).toBe(200);
    expect(retryRes.body.result).toBe("success");

    // Verify the final state
    await new Promise((r) => setTimeout(r, 500));
    const final = await fetchObject("Taxpayer", tin);
    expect(final.body.riskScore).toBe(200);
    expect(final.body.__version).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Test 6: $expectedVersion on multi-object action returns 400
  // -------------------------------------------------------------------------

  it("rejects $expectedVersion on multi-object actions", async () => {
    if (skip()) return;

    const tin1 = `OCC-MULTI1-${RUN_ID}`;
    const tin2 = `OCC-MULTI2-${RUN_ID}`;

    // Create two objects
    await executeAction(CREATE_ACTION, {
      tin: tin1,
      fullName: "Multi 1",
    });
    await executeAction(CREATE_ACTION, {
      tin: tin2,
      fullName: "Multi 2",
    });
    await new Promise((r) => setTimeout(r, 500));

    // Try multi-modify with $expectedVersion
    const res = await executeAction(
      MULTI_MODIFY_ACTION,
      { tin1, tin2, fullName: "Multi Updated" },
      1
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toContain(
      "Optimistic concurrency control is only supported for single-object actions"
    );
  });

  // -------------------------------------------------------------------------
  // Test 7: $expectedVersion on create-only action returns 400
  // -------------------------------------------------------------------------

  it("rejects $expectedVersion on create-only actions", async () => {
    if (skip()) return;

    const tin = `OCC-CREATE-EV-${RUN_ID}`;

    const res = await executeAction(
      CREATE_ACTION,
      { tin, fullName: "Create With Version" },
      0
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toContain(
      "$expectedVersion is only applicable to actions with modifyObject rules"
    );
  });

  // -------------------------------------------------------------------------
  // Test 8: Invalid $expectedVersion values return 400
  // -------------------------------------------------------------------------

  it("rejects invalid $expectedVersion values", async () => {
    if (skip()) return;

    const tin = `OCC-INVALID-${RUN_ID}`;

    // Negative number
    const res1 = await request(
      "POST",
      `/api/v2/ontologies/${ontologyId}/actions/${MODIFY_ACTION}/apply`,
      { parameters: { tin }, $expectedVersion: -1 }
    );
    expect(res1.status).toBe(400);
    expect(res1.body.message).toContain("non-negative integer");

    // Non-integer
    const res2 = await request(
      "POST",
      `/api/v2/ontologies/${ontologyId}/actions/${MODIFY_ACTION}/apply`,
      { parameters: { tin }, $expectedVersion: 1.5 }
    );
    expect(res2.status).toBe(400);
    expect(res2.body.message).toContain("non-negative integer");

    // String
    const res3 = await request(
      "POST",
      `/api/v2/ontologies/${ontologyId}/actions/${MODIFY_ACTION}/apply`,
      { parameters: { tin }, $expectedVersion: "abc" }
    );
    expect(res3.status).toBe(400);
    expect(res3.body.message).toContain("non-negative integer");
  });

  // -------------------------------------------------------------------------
  // Test 9: Created objects start with __version = 1
  // -------------------------------------------------------------------------

  it("sets __version = 1 on newly created objects", async () => {
    if (skip()) return;

    const tin = `OCC-V1-${RUN_ID}`;

    await executeAction(CREATE_ACTION, {
      tin,
      fullName: "Version One",
    });
    await new Promise((r) => setTimeout(r, 500));

    const obj = await fetchObject("Taxpayer", tin);
    expect(obj.status).toBe(200);
    expect(obj.body.__version).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 10: Multiple sequential updates increment __version correctly
  // -------------------------------------------------------------------------

  it("correctly increments __version over 5 sequential updates", async () => {
    if (skip()) return;

    const tin = `OCC-SEQ-${RUN_ID}`;

    // Create
    await executeAction(CREATE_ACTION, {
      tin,
      fullName: "Sequential",
      riskScore: 0,
    });
    await new Promise((r) => setTimeout(r, 500));

    // 5 sequential updates with version checking
    for (let i = 1; i <= 5; i++) {
      const obj = await fetchObject("Taxpayer", tin);
      expect(obj.body.__version).toBe(i);

      const res = await executeAction(
        MODIFY_ACTION,
        { tin, riskScore: i * 10 },
        i
      );
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 500));
    }

    // Final version should be 6
    const final = await fetchObject("Taxpayer", tin);
    expect(final.body.__version).toBe(6);
    expect(final.body.riskScore).toBe(50);
  });
});
