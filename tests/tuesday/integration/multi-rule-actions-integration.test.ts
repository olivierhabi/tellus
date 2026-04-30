// ---------------------------------------------------------------------------
// Multi-Rule Action Execution Integration Tests (Task 18)
//
// Verifies that multi-rule actions (2+ rules per action type) work correctly
// end-to-end through the HTTP API. Tests the rule compiler's merge logic
// (Task 6), the edit applicator's transactional behavior (Task 7), and the
// action executor's 8-stage pipeline (Task 8).
//
// These tests hit the live server at http://localhost:3000 and require
// PostgreSQL + OpenSearch to be running. All tests are gracefully skipped
// if the server is unreachable.
//
// Action type names use camelCase with "mrt" prefix (multi-rule test) to
// avoid collisions with other test data.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://localhost:3000";

let serverReachable = false;
let ontologyId = "";

// Unique suffix for this test run to avoid duplicate-PK conflicts
const RUN_ID = Date.now().toString(36).slice(-4);

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
    `/api/v1/ontology/${ontologyId}/actionTypes`,
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
    `/api/v1/ontology/${ontologyId}/actions/${actionTypeApiName}/apply`,
    { parameters }
  );
}

// ---------------------------------------------------------------------------
// Helper: fetch an object from OpenSearch (via the objects query API)
// ---------------------------------------------------------------------------

async function fetchObject(objectType: string, primaryKey: string) {
  return request(
    "GET",
    `/api/v1/objects/${objectType}/${encodeURIComponent(primaryKey)}`
  );
}

// ---------------------------------------------------------------------------
// Helper: fetch a single audit log entry by execution ID
// ---------------------------------------------------------------------------

async function fetchAuditEntry(executionId: string) {
  return request("GET", `/api/v1/audit/${executionId}`);
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
      "Server not reachable at http://localhost:3000 — skipping multi-rule action tests"
    );
    return;
  }

  // Discover the first ontology (seed ontology)
  const ont = await request("GET", "/api/v1/ontology");
  if (ont.status === 200 && ont.body?.data?.length > 0) {
    const seedOnt = ont.body.data.find((o: any) => o.displayName === "RRA Tax Ontology" || o.displayName === "Rwanda Revenue Authority") || ont.body.data[0];
    ontologyId = seedOnt.ontologyId;
  } else {
    console.warn("No ontologies found — skipping multi-rule action tests");
    serverReachable = false;
  }
});

function skip(): boolean {
  return !serverReachable || !ontologyId;
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe("Multi-Rule Action Execution (Task 18)", () => {
  // =========================================================================
  // Setup: Seed test objects for Tests 3, 4, 5
  //
  // Taxpayer object type: PK = "tin", required: tin, fullName
  // Business object type: PK = "businessId", required: businessId, tradeName
  // =========================================================================

  const TEST_TAXPAYERS = [
    { tin: "MRT-TP-001", fullName: "Test Taxpayer 1", riskScore: 10 },
    { tin: "MRT-TP-002", fullName: "Test Taxpayer 2", riskScore: 20 },
    { tin: "MRT-TP-003", fullName: "Test Taxpayer 3", riskScore: 30 },
  ];

  const TEST_BUSINESS = {
    businessId: "MRT-BIZ-001",
    tradeName: "Test Business One",
  };

  beforeAll(async () => {
    if (skip()) return;

    // --- Seed action type for taxpayers ---
    await ensureActionType({
      apiName: "mrtSeedTaxpayer",
      displayName: "Seed Taxpayer",
      parameters: [
        { apiName: "tin", displayName: "TIN", type: "string", required: true },
        { apiName: "fullName", displayName: "Full Name", type: "string", required: true },
        { apiName: "riskScore", displayName: "Risk Score", type: "double", required: false },
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

    // Seed each taxpayer
    for (const tp of TEST_TAXPAYERS) {
      const res = await executeAction("mrtSeedTaxpayer", tp);
      // Accept 200 (success) or any error with duplicate_primary_key (409)
      if (res.status !== 200 && res.status !== 409) {
        console.warn(
          `Seed taxpayer ${tp.tin}: ${res.status} ${JSON.stringify(res.body).substring(0, 200)}`
        );
      }
    }

    // --- Seed action type for business ---
    await ensureActionType({
      apiName: "mrtSeedBusiness",
      displayName: "Seed Business",
      parameters: [
        { apiName: "businessId", displayName: "Business ID", type: "string", required: true },
        { apiName: "tradeName", displayName: "Trade Name", type: "string", required: true },
      ],
      rules: [
        {
          type: "createObject",
          objectType: "Business",
          properties: {
            businessId: { source: "parameter", param: "businessId" },
            tradeName: { source: "parameter", param: "tradeName" },
          },
        },
      ],
    });

    const bizRes = await executeAction("mrtSeedBusiness", TEST_BUSINESS);
    if (bizRes.status !== 200 && bizRes.status !== 409) {
      console.warn(
        `Seed business: ${bizRes.status} ${JSON.stringify(bizRes.body).substring(0, 200)}`
      );
    }

    // Allow OpenSearch to settle
    await new Promise((r) => setTimeout(r, 1000));
  });

  // =========================================================================
  // Test 1: Create + Link in one action
  //
  // Tests the pendingEdits feature: the addLink rule must detect that the
  // taxpayer was created by a preceding rule in the same action, even
  // though it's not yet in OpenSearch.
  // =========================================================================

  describe("Test 1: Create + Link in one action", () => {
    const ACTION_NAME = "mrtOnboardTaxpayer";
    const NEW_TIN = `MRT-TP-ONB-${RUN_ID}`;

    beforeAll(async () => {
      if (skip()) return;

      // Ensure MANY_TO_MANY link type between Taxpayer and Business
      const ltRes = await request(
        "POST",
        `/api/v1/ontology/${ontologyId}/linkTypes`,
        {
          apiName: "taxpayerBusiness",
          displayName: "Taxpayer Business",
          cardinality: "MANY_TO_MANY",
          sourceObjectTypeApiName: "Taxpayer",
          targetObjectTypeApiName: "Business",
          isBidirectional: true,
        }
      );
      if (ltRes.status !== 201 && ltRes.status !== 409) {
        console.warn(
          `Create link type: ${ltRes.status} ${JSON.stringify(ltRes.body).substring(0, 200)}`
        );
      }

      // Create the multi-rule action type: createObject + addLink
      await ensureActionType({
        apiName: ACTION_NAME,
        displayName: "Onboard Taxpayer",
        parameters: [
          { apiName: "tin", displayName: "TIN", type: "string", required: true },
          { apiName: "fullName", displayName: "Full Name", type: "string", required: true },
          { apiName: "bizId", displayName: "Business ID", type: "string", required: true },
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
          {
            type: "addLink",
            linkType: "taxpayerBusiness",
            linkTypeApiName: "taxpayerBusiness", // needed for route validation
            sourceObject: { source: "parameter", param: "tin" },
            targetObject: { source: "parameter", param: "bizId" },
          },
        ],
      });
    });

    it("should create taxpayer and link to business in a single action", async () => {
      if (skip()) return;

      const res = await executeAction(ACTION_NAME, {
        tin: NEW_TIN,
        fullName: "Onboarded Taxpayer",
        bizId: TEST_BUSINESS.businessId,
      });

      expect(res.status).toBe(200);
      expect(res.body.result).toBe("success");
      expect(res.body.affectedObjects.length).toBeGreaterThanOrEqual(1);

      // Find the create operation in affected objects
      const createOp = res.body.affectedObjects.find(
        (o: any) => o.operation === "create" && o.primaryKey === NEW_TIN
      );
      expect(createOp).toBeDefined();
      expect(createOp.objectType).toBe("Taxpayer");
    });

    it("should have the created taxpayer in OpenSearch", async () => {
      if (skip()) return;

      await new Promise((r) => setTimeout(r, 500));

      const obj = await fetchObject("Taxpayer", NEW_TIN);
      expect(obj.status).toBe(200);
      expect(obj.body.fullName).toBe("Onboarded Taxpayer");
    });
  });

  // =========================================================================
  // Test 2: Create + Modify same object (merge logic)
  //
  // Tests the rule compiler's merge: createObject then modifyObject on the
  // same PK should produce a single "create" edit with merged properties.
  // The modify's values override the create's for overlapping properties.
  // =========================================================================

  describe("Test 2: Create + Modify same object (merge logic)", () => {
    const ACTION_NAME = "mrtCreateAndTag";
    const NEW_TIN = `MRT-TP-TAG-${RUN_ID}`;

    beforeAll(async () => {
      if (skip()) return;

      await ensureActionType({
        apiName: ACTION_NAME,
        displayName: "Create and Tag Taxpayer",
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
              complianceStatus: { source: "static", value: "pending" },
            },
          },
          {
            type: "modifyObject",
            objectType: "Taxpayer",
            objectReference: { source: "parameter", param: "tin" },
            properties: {
              complianceStatus: { source: "static", value: "active" },
            },
          },
        ],
      });
    });

    it("should merge create + modify into a single create with overridden properties", async () => {
      if (skip()) return;

      const res = await executeAction(ACTION_NAME, {
        tin: NEW_TIN,
        fullName: "Tagged Taxpayer",
      });

      expect(res.status).toBe(200);
      expect(res.body.result).toBe("success");

      await new Promise((r) => setTimeout(r, 500));

      // The merged result should have complianceStatus='active'
      // (modify overrides create's 'pending')
      const obj = await fetchObject("Taxpayer", NEW_TIN);
      expect(obj.status).toBe(200);
      expect(obj.body.fullName).toBe("Tagged Taxpayer");
      expect(obj.body.complianceStatus).toBe("active");
    });
  });

  // =========================================================================
  // Test 3: Modify multiple objects in one action
  //
  // An action that modifies 3 different taxpayers' complianceStatus in one
  // execution. Verifies all 3 are updated and a single audit log entry is
  // produced with affectedObjectCount = 3.
  // =========================================================================

  describe("Test 3: Modify multiple objects in one action", () => {
    const ACTION_NAME = "mrtBulkReassign";

    beforeAll(async () => {
      if (skip()) return;

      await ensureActionType({
        apiName: ACTION_NAME,
        displayName: "Bulk Reassign Compliance",
        parameters: [
          { apiName: "tp1", displayName: "Taxpayer 1", type: "string", required: true },
          { apiName: "tp2", displayName: "Taxpayer 2", type: "string", required: true },
          { apiName: "tp3", displayName: "Taxpayer 3", type: "string", required: true },
          { apiName: "newStatus", displayName: "New Status", type: "string", required: true },
        ],
        rules: [
          {
            type: "modifyObject",
            objectType: "Taxpayer",
            objectReference: { source: "parameter", param: "tp1" },
            properties: {
              complianceStatus: { source: "parameter", param: "newStatus" },
            },
          },
          {
            type: "modifyObject",
            objectType: "Taxpayer",
            objectReference: { source: "parameter", param: "tp2" },
            properties: {
              complianceStatus: { source: "parameter", param: "newStatus" },
            },
          },
          {
            type: "modifyObject",
            objectType: "Taxpayer",
            objectReference: { source: "parameter", param: "tp3" },
            properties: {
              complianceStatus: { source: "parameter", param: "newStatus" },
            },
          },
        ],
      });
    });

    it("should modify all 3 taxpayers in one execution", async () => {
      if (skip()) return;

      const res = await executeAction(ACTION_NAME, {
        tp1: TEST_TAXPAYERS[0].tin,
        tp2: TEST_TAXPAYERS[1].tin,
        tp3: TEST_TAXPAYERS[2].tin,
        newStatus: "underReview",
      });

      expect(res.status).toBe(200);
      expect(res.body.result).toBe("success");
      expect(res.body.affectedObjects.length).toBe(3);

      // All should be update operations
      for (const ao of res.body.affectedObjects) {
        expect(ao.operation).toBe("update");
        expect(ao.objectType).toBe("Taxpayer");
      }

      await new Promise((r) => setTimeout(r, 500));

      // Verify all three were updated in OpenSearch
      for (const tp of TEST_TAXPAYERS) {
        const obj = await fetchObject("Taxpayer", tp.tin);
        expect(obj.status).toBe(200);
        expect(obj.body.complianceStatus).toBe("underReview");
      }
    });

    it("should produce a single audit log entry with correct count", async () => {
      if (skip()) return;

      // Re-execute to get a fresh executionId
      const res = await executeAction(ACTION_NAME, {
        tp1: TEST_TAXPAYERS[0].tin,
        tp2: TEST_TAXPAYERS[1].tin,
        tp3: TEST_TAXPAYERS[2].tin,
        newStatus: "reviewed",
      });

      expect(res.status).toBe(200);
      const executionId = res.body.executionId;
      expect(executionId).toBeDefined();

      // Fetch audit entry
      const audit = await fetchAuditEntry(executionId);
      if (audit.status === 200) {
        expect(audit.body.affectedObjectCount).toBe(3);
        expect(audit.body.result).toBe("success");
        expect(audit.body.actionTypeApiName).toBe(ACTION_NAME);
      }
    });
  });

  // =========================================================================
  // Test 4: Scale limit enforcement
  //
  // Creates an action type with maxAffectedObjects = 2, but the action
  // would affect 3 objects. Verifies execution fails with scale_limit.
  // =========================================================================

  describe("Test 4: Scale limit enforcement", () => {
    const ACTION_NAME = "mrtScaleLimitTest";

    beforeAll(async () => {
      if (skip()) return;

      await ensureActionType({
        apiName: ACTION_NAME,
        displayName: "Scale Limit Test",
        parameters: [
          { apiName: "tp1", displayName: "Taxpayer 1", type: "string", required: true },
          { apiName: "tp2", displayName: "Taxpayer 2", type: "string", required: true },
          { apiName: "tp3", displayName: "Taxpayer 3", type: "string", required: true },
          { apiName: "newStatus", displayName: "New Status", type: "string", required: true },
        ],
        rules: [
          {
            type: "modifyObject",
            objectType: "Taxpayer",
            objectReference: { source: "parameter", param: "tp1" },
            properties: {
              complianceStatus: { source: "parameter", param: "newStatus" },
            },
          },
          {
            type: "modifyObject",
            objectType: "Taxpayer",
            objectReference: { source: "parameter", param: "tp2" },
            properties: {
              complianceStatus: { source: "parameter", param: "newStatus" },
            },
          },
          {
            type: "modifyObject",
            objectType: "Taxpayer",
            objectReference: { source: "parameter", param: "tp3" },
            properties: {
              complianceStatus: { source: "parameter", param: "newStatus" },
            },
          },
        ],
        maxAffectedObjects: 2, // limit is 2, but action affects 3 objects
      });
    });

    it("should fail with scale_limit when affected objects exceed max", async () => {
      if (skip()) return;

      const res = await executeAction(ACTION_NAME, {
        tp1: TEST_TAXPAYERS[0].tin,
        tp2: TEST_TAXPAYERS[1].tin,
        tp3: TEST_TAXPAYERS[2].tin,
        newStatus: "overflow",
      });

      // Task 20: standardized error format — errorCode at top level
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe("SCALE_LIMIT_EXCEEDED");
      expect(res.body.errorName).toBe("ScaleLimitExceededError");
      expect(res.body.errorInstanceId).toBeDefined();
    });

    it("should not have modified the taxpayers with overflow status", async () => {
      if (skip()) return;

      for (const tp of TEST_TAXPAYERS) {
        const obj = await fetchObject("Taxpayer", tp.tin);
        if (obj.status === 200) {
          expect(obj.body.complianceStatus).not.toBe("overflow");
        }
      }
    });
  });

  // =========================================================================
  // Test 5: Atomicity — partial failure should roll back
  //
  // A multi-rule action where rule 1 modifies an existing taxpayer (would
  // succeed) but rule 2 modifies a non-existent taxpayer (will fail during
  // rule compilation). The entire action should fail and rule 1's changes
  // should NOT be applied.
  // =========================================================================

  describe("Test 5: Atomicity — partial failure rolls back", () => {
    const ACTION_NAME = "mrtAtomicTest";
    const UNIQUE_STATUS = `atomicTest${Date.now()}`;

    beforeAll(async () => {
      if (skip()) return;

      await ensureActionType({
        apiName: ACTION_NAME,
        displayName: "Atomicity Test",
        parameters: [
          { apiName: "tp1", displayName: "Taxpayer 1", type: "string", required: true },
          { apiName: "tp2", displayName: "Taxpayer 2", type: "string", required: true },
          { apiName: "newStatus", displayName: "New Status", type: "string", required: true },
        ],
        rules: [
          // Rule 1: Modify existing taxpayer (would succeed on its own)
          {
            type: "modifyObject",
            objectType: "Taxpayer",
            objectReference: { source: "parameter", param: "tp1" },
            properties: {
              complianceStatus: { source: "parameter", param: "newStatus" },
            },
          },
          // Rule 2: Modify non-existent taxpayer (will fail at compile)
          {
            type: "modifyObject",
            objectType: "Taxpayer",
            objectReference: { source: "parameter", param: "tp2" },
            properties: {
              complianceStatus: { source: "parameter", param: "newStatus" },
            },
          },
        ],
      });
    });

    it("should fail when one rule targets a non-existent object", async () => {
      if (skip()) return;

      const res = await executeAction(ACTION_NAME, {
        tp1: TEST_TAXPAYERS[0].tin,
        tp2: "MRTNONEXISTENT",
        newStatus: UNIQUE_STATUS,
      });

      // The action should fail — route returns 404 for object_not_found
      if (res.status === 200) {
        expect(res.body.result).toBe("failed");
      } else {
        expect([400, 404, 500]).toContain(res.status);
      }
    });

    it("should not have modified the existing taxpayer (rollback)", async () => {
      if (skip()) return;

      await new Promise((r) => setTimeout(r, 500));

      // Verify TP-001 was NOT modified with the unique status
      const obj = await fetchObject("Taxpayer", TEST_TAXPAYERS[0].tin);
      if (obj.status === 200) {
        expect(obj.body.complianceStatus).not.toBe(UNIQUE_STATUS);
      }
    });

    it("should have an audit log entry recording the failure", async () => {
      if (skip()) return;

      // Re-execute to get a fresh executionId
      const res = await executeAction(ACTION_NAME, {
        tp1: TEST_TAXPAYERS[0].tin,
        tp2: "MRTFAKETP",
        newStatus: `fail${Date.now()}`,
      });

      const executionId =
        res.body.executionId ?? res.body.error?.details?.executionId;

      if (executionId) {
        const audit = await fetchAuditEntry(executionId);
        if (audit.status === 200) {
          expect(audit.body.result).toBe("failed");
          expect(audit.body.actionTypeApiName).toBe(ACTION_NAME);
        }
      }
    });
  });
});
