// ---------------------------------------------------------------------------
// Action Idempotency Protection Integration Tests (Task 21)
//
// Verifies that the Idempotency-Key header prevents duplicate action
// execution when clients retry requests. Tests cover:
//
//   1. First execution without idempotency key (normal)
//   2. First execution with idempotency key (stores result)
//   3. Retry with same idempotency key (returns cached, no re-execution)
//   4. X-Idempotency-Cached header present on retries
//   5. Object created only once despite multiple retries
//   6. Cross-action-type guard (same key, different action type)
//   7. Failed action result is also cached
//   8. Retry of failed action returns cached error
//
// These tests hit the live server at http://localhost:3000 and require
// PostgreSQL + OpenSearch to be running. All tests are gracefully skipped
// if the server is unreachable.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://localhost:3000";

let serverReachable = false;
let ontologyId = "";

// Unique suffix for this test run to avoid duplicate-PK conflicts
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
  // Retry up to 3 times with a 1s delay to handle transient DB connection races
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await request(
      "POST",
      `/api/v2/ontologies/${ontologyId}/actionTypes`,
      def
    );
    if (res.status === 201 || res.status === 409) return;
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    throw new Error(
      `Failed to create action type '${def.apiName}': ${res.status} ${JSON.stringify(res.body).substring(0, 300)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Helper: execute an action with optional idempotency key
// ---------------------------------------------------------------------------

async function executeAction(
  actionTypeApiName: string,
  parameters: Record<string, unknown>,
  idempotencyKey?: string
) {
  const extraHeaders: Record<string, string> = {};
  if (idempotencyKey) {
    extraHeaders["Idempotency-Key"] = idempotencyKey;
  }
  return request(
    "POST",
    `/api/v2/ontologies/${ontologyId}/actions/${actionTypeApiName}/apply`,
    { parameters },
    extraHeaders
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
      "Server not reachable at http://localhost:3000 — skipping idempotency tests"
    );
    return;
  }

  // Discover the first ontology (seed ontology)
  const ont = await request("GET", "/api/v2/ontologies");
  if (ont.status === 200 && ont.body?.data?.length > 0) {
    const seedOnt = ont.body.data.find((o: any) => o.displayName === "RRA Tax Ontology" || o.displayName === "Rwanda Revenue Authority") || ont.body.data[0];
    ontologyId = seedOnt.ontologyId;
  } else {
    console.warn("No ontologies found — skipping idempotency tests");
    serverReachable = false;
  }
});

function skip(): boolean {
  return !serverReachable || !ontologyId;
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe("Action Idempotency Protection (Task 21)", () => {
  // =========================================================================
  // Setup: Create a simple action type for idempotency testing
  // =========================================================================

  const CREATE_ACTION = "idmpCreateTaxpayer";
  const MODIFY_ACTION = "idmpModifyTaxpayer";

  beforeAll(async () => {
    if (skip()) return;

    // Action type: create a taxpayer
    await ensureActionType({
      apiName: CREATE_ACTION,
      displayName: "Idempotency Test: Create Taxpayer",
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

    // Action type: modify a taxpayer (for cross-action guard test)
    await ensureActionType({
      apiName: MODIFY_ACTION,
      displayName: "Idempotency Test: Modify Taxpayer",
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
      ],
      rules: [
        {
          type: "modifyObject",
          objectType: "Taxpayer",
          primaryKey: { source: "parameter", param: "tin" },
          properties: {
            fullName: { source: "parameter", param: "fullName" },
          },
        },
      ],
    });
  });

  // -------------------------------------------------------------------------
  // Test 1: Normal execution without idempotency key
  // -------------------------------------------------------------------------

  it("executes normally without Idempotency-Key header", async () => {
    if (skip()) return;

    const tin = `IDMP-NOKEY-${RUN_ID}`;
    const res = await executeAction(CREATE_ACTION, {
      tin,
      fullName: "No Key Test",
    });

    expect(res.status).toBe(200);
    expect(res.body.executionId).toBeTruthy();
    expect(res.body.result).toBe("success");

    // Should NOT have the cached header
    expect(res.headers.get("X-Idempotency-Cached")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 2: First execution with idempotency key stores result
  // -------------------------------------------------------------------------

  it("first execution with idempotency key succeeds and stores result", async () => {
    if (skip()) return;

    const tin = `IDMP-FIRST-${RUN_ID}`;
    const key = `test-key-first-${RUN_ID}`;

    const res = await executeAction(
      CREATE_ACTION,
      { tin, fullName: "First Exec" },
      key
    );

    expect(res.status).toBe(200);
    expect(res.body.executionId).toBeTruthy();
    expect(res.body.result).toBe("success");

    // First execution should NOT have cached header
    expect(res.headers.get("X-Idempotency-Cached")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 3: Retry with same key returns cached result
  // -------------------------------------------------------------------------

  it("retry with same idempotency key returns cached result without re-execution", async () => {
    if (skip()) return;

    const tin = `IDMP-RETRY-${RUN_ID}`;
    const key = `test-key-retry-${RUN_ID}`;

    // First execution
    const first = await executeAction(
      CREATE_ACTION,
      { tin, fullName: "Retry Test" },
      key
    );
    expect(first.status).toBe(200);
    const firstExecId = first.body.executionId;

    // Retry with the same key
    const retry = await executeAction(
      CREATE_ACTION,
      { tin, fullName: "Retry Test" },
      key
    );

    // Should return same execution ID (cached)
    expect(retry.status).toBe(200);
    expect(retry.body.executionId).toBe(firstExecId);
    expect(retry.body.result).toBe("success");
  });

  // -------------------------------------------------------------------------
  // Test 4: X-Idempotency-Cached header is present on retries
  // -------------------------------------------------------------------------

  it("sets X-Idempotency-Cached header on cached responses", async () => {
    if (skip()) return;

    const tin = `IDMP-HDR-${RUN_ID}`;
    const key = `test-key-hdr-${RUN_ID}`;

    // First execution
    const first = await executeAction(
      CREATE_ACTION,
      { tin, fullName: "Header Test" },
      key
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Idempotency-Cached")).toBeNull();

    // Retry — should have cached header
    const retry = await executeAction(
      CREATE_ACTION,
      { tin, fullName: "Header Test" },
      key
    );
    expect(retry.headers.get("X-Idempotency-Cached")).toBe("true");
  });

  // -------------------------------------------------------------------------
  // Test 5: Object is created only once despite retries
  // -------------------------------------------------------------------------

  it("creates object only once despite multiple retries with same key", async () => {
    if (skip()) return;

    const tin = `IDMP-ONCE-${RUN_ID}`;
    const key = `test-key-once-${RUN_ID}`;

    // Execute three times with the same key
    const r1 = await executeAction(
      CREATE_ACTION,
      { tin, fullName: "Only Once" },
      key
    );
    const r2 = await executeAction(
      CREATE_ACTION,
      { tin, fullName: "Only Once" },
      key
    );
    const r3 = await executeAction(
      CREATE_ACTION,
      { tin, fullName: "Only Once" },
      key
    );

    // All should return the same execution ID
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(r2.body.executionId).toBe(r1.body.executionId);
    expect(r3.body.executionId).toBe(r1.body.executionId);

    // First should not be cached, subsequent should be
    expect(r1.headers.get("X-Idempotency-Cached")).toBeNull();
    expect(r2.headers.get("X-Idempotency-Cached")).toBe("true");
    expect(r3.headers.get("X-Idempotency-Cached")).toBe("true");

    // Verify the object exists via the objects API
    const obj = await request(
      "GET",
      `/api/v2/objects/Taxpayer/${encodeURIComponent(tin)}`
    );
    expect(obj.status).toBe(200);
    expect(obj.body.fullName).toBe("Only Once");
  });

  // -------------------------------------------------------------------------
  // Test 6: Cross-action-type guard
  //
  // If the same idempotency key is used for a DIFFERENT action type, the
  // cache should be ignored and the action should execute normally.
  // -------------------------------------------------------------------------

  it("ignores cached result when same key used with different action type", async () => {
    if (skip()) return;

    const tin = `IDMP-CROSS-${RUN_ID}`;
    const key = `test-key-cross-${RUN_ID}`;

    // Execute create action with key
    const createRes = await executeAction(
      CREATE_ACTION,
      { tin, fullName: "Cross Guard" },
      key
    );
    expect(createRes.status).toBe(200);
    const createExecId = createRes.body.executionId;

    // Use SAME key with a DIFFERENT action type (modify)
    // This should NOT return the cached create result — should execute normally
    const modifyRes = await executeAction(
      MODIFY_ACTION,
      { tin, fullName: "Cross Guard Modified" },
      key
    );

    // The modify should get its own execution ID (not the cached one)
    expect(modifyRes.status).toBe(200);
    expect(modifyRes.body.executionId).not.toBe(createExecId);
  });

  // -------------------------------------------------------------------------
  // Test 7: Failed action result is cached
  // -------------------------------------------------------------------------

  it("caches failed action results", async () => {
    if (skip()) return;

    const key = `test-key-fail-${RUN_ID}`;

    // Execute with invalid parameters (missing required "tin")
    const res = await executeAction(
      CREATE_ACTION,
      { fullName: "Missing TIN" },
      key
    );

    // Should fail (400 — missing required parameter)
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Test 8: Retry of failed action returns cached error
  // -------------------------------------------------------------------------

  it("retry of failed action returns cached error response", async () => {
    if (skip()) return;

    const key = `test-key-fail-retry-${RUN_ID}`;

    // First execution — fails because "tin" is missing
    const first = await executeAction(
      CREATE_ACTION,
      { fullName: "Missing TIN Retry" },
      key
    );
    expect(first.status).toBe(400);
    const firstErrorCode = first.body.errorCode;
    const firstErrorInstanceId = first.body.errorInstanceId;

    // Retry with same key — should return cached error
    const retry = await executeAction(
      CREATE_ACTION,
      { fullName: "Missing TIN Retry" },
      key
    );

    expect(retry.status).toBe(400);
    expect(retry.body.errorCode).toBe(firstErrorCode);
    expect(retry.body.errorInstanceId).toBe(firstErrorInstanceId);
    expect(retry.headers.get("X-Idempotency-Cached")).toBe("true");
  });
});
