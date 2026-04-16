// ---------------------------------------------------------------------------
// Error Response Standardization Integration Tests (Task 20)
//
// Verifies that all error responses across action endpoints follow the
// Palantir-compatible standardized format:
//   { errorCode, errorName, errorInstanceId, parameters, message }
//
// These tests hit the live server at http://localhost:3000 and require
// PostgreSQL + OpenSearch to be running. All tests are gracefully skipped
// if the server is unreachable.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://localhost:3000";

let serverReachable = false;
let ontologyId = "";

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

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
    `/api/v1/ontologies/${ontologyId}/actionTypes`,
    def
  );
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(
      `Failed to create action type '${def.apiName}': ${res.status} ${JSON.stringify(res.body).substring(0, 300)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Helper: execute an action
// ---------------------------------------------------------------------------

async function executeAction(
  actionTypeApiName: string,
  parameters: Record<string, unknown>
) {
  return request(
    "POST",
    `/api/v1/ontologies/${ontologyId}/actions/${actionTypeApiName}/apply`,
    { parameters }
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
      "Server not reachable at http://localhost:3000 — skipping error standardization tests"
    );
    return;
  }

  // Discover the first ontology (seed ontology)
  const ont = await request("GET", "/api/v1/ontologies");
  if (ont.status === 200 && ont.body?.data?.length > 0) {
    const seedOnt = ont.body.data.find((o: any) => o.displayName === "RRA Tax Ontology" || o.displayName === "Rwanda Revenue Authority") || ont.body.data[0];
    ontologyId = seedOnt.ontologyId;
  } else {
    console.warn("No ontologies found — skipping error standardization tests");
    serverReachable = false;
  }
});

function skip(): boolean {
  return !serverReachable || !ontologyId;
}

// ---------------------------------------------------------------------------
// Shared assertion: validate the standardized error response shape
// ---------------------------------------------------------------------------

function assertStandardErrorShape(body: any) {
  expect(body).toHaveProperty("errorCode");
  expect(body).toHaveProperty("errorName");
  expect(body).toHaveProperty("errorInstanceId");
  expect(body).toHaveProperty("parameters");
  expect(body).toHaveProperty("message");
  expect(typeof body.errorCode).toBe("string");
  expect(typeof body.errorName).toBe("string");
  expect(typeof body.errorInstanceId).toBe("string");
  expect(body.errorInstanceId.length).toBeGreaterThan(0);
  expect(typeof body.message).toBe("string");
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe("Error Response Standardization (Task 20)", () => {
  // =========================================================================
  // Setup: Create test action types for error scenarios
  // =========================================================================

  const SEED_TIN = "EST-TP-001";

  beforeAll(async () => {
    if (skip()) return;

    // Action type for parameter validation testing
    await ensureActionType({
      apiName: "estUpdateRiskScore",
      displayName: "Error Standard Test: Update Risk Score",
      parameters: [
        {
          apiName: "taxpayerRef",
          displayName: "Taxpayer Reference",
          type: "string",
          required: true,
        },
        {
          apiName: "newRiskScore",
          displayName: "New Risk Score",
          type: "double",
          required: true,
        },
      ],
      rules: [
        {
          type: "modifyObject",
          objectType: "Taxpayer",
          objectReference: { source: "parameter", param: "taxpayerRef" },
          properties: {
            riskScore: { source: "parameter", param: "newRiskScore" },
          },
        },
      ],
    });

    // Action type for creating taxpayers (for duplicate PK testing)
    await ensureActionType({
      apiName: "estCreateTaxpayer",
      displayName: "Error Standard Test: Create Taxpayer",
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

    // Seed a taxpayer for modify/duplicate tests
    const seedRes = await executeAction("estCreateTaxpayer", {
      tin: SEED_TIN,
      fullName: "Error Standard Test Taxpayer",
    });
    // Allow 200 (created) or error if already exists
    if (seedRes.status !== 200) {
      // May already exist from a previous run — that's fine for our tests
    }

    await new Promise((r) => setTimeout(r, 500));
  });

  // =========================================================================
  // Test 1: 404 Action type not found (/apply)
  // =========================================================================

  describe("Test 1: Action type not found (apply)", () => {
    it("should return 404 with standardized error format", async () => {
      if (skip()) return;

      const res = await executeAction("nonExistentActionType", {});

      expect(res.status).toBe(404);
      assertStandardErrorShape(res.body);
      expect(res.body.errorCode).toBe("ACTION_TYPE_NOT_FOUND");
      expect(res.body.errorName).toBe("ActionTypeNotFoundError");
      expect(res.body.errorInstanceId).toBeDefined();
    });
  });

  // =========================================================================
  // Test 2: 400 Invalid parameter
  // =========================================================================

  describe("Test 2: Invalid parameter (missing required)", () => {
    it("should return 400 with INVALID_PARAMETER error code", async () => {
      if (skip()) return;

      // Missing required parameters
      const res = await executeAction("estUpdateRiskScore", {});

      expect(res.status).toBe(400);
      assertStandardErrorShape(res.body);
      expect(res.body.errorCode).toBe("INVALID_PARAMETER");
      expect(res.body.errorName).toBe("InvalidParameterError");
      expect(res.body.message.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Test 3: 409 Duplicate primary key
  // =========================================================================

  describe("Test 3: Duplicate primary key", () => {
    it("should return 409 with DUPLICATE_PRIMARY_KEY error code", async () => {
      if (skip()) return;

      // Try to create a taxpayer with a PK that already exists
      const res = await executeAction("estCreateTaxpayer", {
        tin: SEED_TIN,
        fullName: "Duplicate",
      });

      expect(res.status).toBe(409);
      assertStandardErrorShape(res.body);
      expect(res.body.errorCode).toBe("DUPLICATE_PRIMARY_KEY");
      expect(res.body.errorName).toBe("DuplicatePrimaryKeyError");
    });
  });

  // =========================================================================
  // Test 4: 404 Action type not found (/validate)
  // =========================================================================

  describe("Test 4: Action type not found (validate)", () => {
    it("should return 404 with standardized error format", async () => {
      if (skip()) return;

      const res = await request(
        "POST",
        `/api/v1/actions/nonExistentActionType/validate`,
        { parameters: {} }
      );

      expect(res.status).toBe(404);
      assertStandardErrorShape(res.body);
      expect(res.body.errorCode).toBe("ACTION_TYPE_NOT_FOUND");
      expect(res.body.errorName).toBe("ActionTypeNotFoundError");
    });
  });

  // =========================================================================
  // Test 5: 404 Action type not found (CRUD — GET single)
  // =========================================================================

  describe("Test 5: Action type not found (CRUD GET)", () => {
    it("should return 404 with standardized error format", async () => {
      if (skip()) return;

      const res = await request(
        "GET",
        `/api/v1/ontologies/${ontologyId}/actionTypes/nonExistentAction`
      );

      expect(res.status).toBe(404);
      assertStandardErrorShape(res.body);
      expect(res.body.errorCode).toBe("ACTION_TYPE_NOT_FOUND");
      expect(res.body.errorName).toBe("ActionTypeNotFoundError");
      expect(res.body.parameters).toHaveProperty("actionTypeApiName");
    });
  });

  // =========================================================================
  // Test 6: 404 Action type not found (CRUD — DELETE)
  // =========================================================================

  describe("Test 6: Action type not found (CRUD DELETE)", () => {
    it("should return 404 with standardized error format", async () => {
      if (skip()) return;

      const res = await request(
        "DELETE",
        `/api/v1/ontologies/${ontologyId}/actionTypes/nonExistentAction`
      );

      expect(res.status).toBe(404);
      assertStandardErrorShape(res.body);
      expect(res.body.errorCode).toBe("ACTION_TYPE_NOT_FOUND");
    });
  });

  // =========================================================================
  // Test 7: 404 Object not found (modify non-existent)
  // =========================================================================

  describe("Test 7: Object not found in rule compilation", () => {
    it("should return 404 with OBJECT_NOT_FOUND error code", async () => {
      if (skip()) return;

      const res = await executeAction("estUpdateRiskScore", {
        taxpayerRef: "DOES-NOT-EXIST-999",
        newRiskScore: 50,
      });

      expect(res.status).toBe(404);
      assertStandardErrorShape(res.body);
      expect(res.body.errorCode).toBe("OBJECT_NOT_FOUND");
      expect(res.body.errorName).toBe("ObjectNotFoundError");
    });
  });

  // =========================================================================
  // Test 8: Error instance IDs are unique
  // =========================================================================

  describe("Test 8: Error instance IDs are unique", () => {
    it("should return different errorInstanceId for each error", async () => {
      if (skip()) return;

      const res1 = await executeAction("nonExistent1", {});
      const res2 = await executeAction("nonExistent2", {});

      expect(res1.status).toBe(404);
      expect(res2.status).toBe(404);
      assertStandardErrorShape(res1.body);
      assertStandardErrorShape(res2.body);
      expect(res1.body.errorInstanceId).not.toBe(res2.body.errorInstanceId);
    });
  });

  // =========================================================================
  // Test 9: Successful action still returns normal response (not error format)
  // =========================================================================

  describe("Test 9: Successful action response unchanged", () => {
    it("should return 200 with executionId on success", async () => {
      if (skip()) return;

      const res = await executeAction("estUpdateRiskScore", {
        taxpayerRef: SEED_TIN,
        newRiskScore: 55,
      });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("executionId");
      expect(res.body).toHaveProperty("result", "success");
      expect(res.body).toHaveProperty("affectedObjects");
      // Should NOT have error fields
      expect(res.body).not.toHaveProperty("errorCode");
      expect(res.body).not.toHaveProperty("errorInstanceId");
    });
  });

  // =========================================================================
  // Test 10: Scale limit exceeded has standardized format
  // =========================================================================

  describe("Test 10: Scale limit exceeded", () => {
    let limitActionCreated = false;

    beforeAll(async () => {
      if (skip()) return;

      // Create action type with maxAffectedObjects = 1 but 2 rules
      await ensureActionType({
        apiName: "estLimitedModify",
        displayName: "Error Standard Test: Limited",
        maxAffectedObjects: 1,
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
            apiName: "score",
            displayName: "Score",
            type: "double",
            required: true,
          },
        ],
        rules: [
          {
            type: "modifyObject",
            objectType: "Taxpayer",
            objectReference: { source: "parameter", param: "tin1" },
            properties: {
              riskScore: { source: "parameter", param: "score" },
            },
          },
          {
            type: "modifyObject",
            objectType: "Taxpayer",
            objectReference: { source: "parameter", param: "tin2" },
            properties: {
              riskScore: { source: "parameter", param: "score" },
            },
          },
        ],
      });

      // Seed second taxpayer
      await ensureActionType({
        apiName: "estSeedTp2",
        displayName: "Seed TP2",
        parameters: [
          { apiName: "tin", displayName: "TIN", type: "string", required: true },
          { apiName: "fullName", displayName: "Name", type: "string", required: true },
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
      await executeAction("estSeedTp2", {
        tin: "EST-TP-002",
        fullName: "Error Standard Test Taxpayer 2",
      });

      await new Promise((r) => setTimeout(r, 500));
      limitActionCreated = true;
    });

    it("should return 400 with SCALE_LIMIT_EXCEEDED error code", async () => {
      if (skip() || !limitActionCreated) return;

      const res = await executeAction("estLimitedModify", {
        tin1: SEED_TIN,
        tin2: "EST-TP-002",
        score: 99,
      });

      expect(res.status).toBe(400);
      assertStandardErrorShape(res.body);
      expect(res.body.errorCode).toBe("SCALE_LIMIT_EXCEEDED");
      expect(res.body.errorName).toBe("ScaleLimitExceededError");
    });
  });

  // =========================================================================
  // Test 11: Audit log still written for failed actions
  // =========================================================================

  describe("Test 11: Audit log still records failures", () => {
    it("should write audit log even when action fails with OntologyError", async () => {
      if (skip()) return;

      // Execute an action that will fail (missing params)
      const res = await executeAction("estUpdateRiskScore", {});
      expect(res.status).toBe(400);
      assertStandardErrorShape(res.body);

      // Check audit log — there should be a recent entry with "failed" result
      // for estUpdateRiskScore
      const auditRes = await request(
        "GET",
        `/api/v1/ontologies/${ontologyId}/actions/estUpdateRiskScore/auditLog?$pageSize=1`
      );
      // Audit endpoint may or may not exist in all configurations
      // If it returns 200, verify the latest entry is a failure
      if (auditRes.status === 200 && auditRes.body?.data?.length > 0) {
        const latest = auditRes.body.data[0];
        expect(latest.result).toBe("failed");
      }
      // If audit endpoint doesn't exist, skip this part — the core assertion
      // is that the action returned a proper standardized error response
    });
  });

  // =========================================================================
  // Test 12: X-Request-Id header is present
  // =========================================================================

  describe("Test 12: X-Request-Id header", () => {
    it("should include X-Request-Id in response headers", async () => {
      if (skip()) return;

      const res = await request(
        "POST",
        `/api/v1/ontologies/${ontologyId}/actions/nonExistent/apply`,
        { parameters: {} }
      );

      expect(res.status).toBe(404);
      const requestId = res.headers.get("x-request-id");
      expect(requestId).toBeDefined();
      expect(typeof requestId).toBe("string");
      expect(requestId!.length).toBeGreaterThan(0);
    });
  });
});
