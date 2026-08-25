// ---------------------------------------------------------------------------
// Action Validation Endpoint Integration Tests (Task 19)
//
// Verifies that POST /api/v1/actions/:actionTypeApiName/validate performs
// a dry-run validation without applying edits. The endpoint runs Stages 1,
// 2, and 4 of the execution pipeline and returns a preview of what the
// action would do, or a list of validation errors.
//
// These tests hit the live server at http://localhost:3000 and require
// PostgreSQL + OpenSearch to be running. All tests are gracefully skipped
// if the server is unreachable.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll } from "vitest";

const BASE = (process.env.TEST_BASE_URL ?? "http://localhost:3000");

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
// Helper: validate an action (uses the ontology-less /api/v1/actions path)
// ---------------------------------------------------------------------------

async function validateAction(
  actionTypeApiName: string,
  parameters: Record<string, unknown>
) {
  return request(
    "POST",
    `/api/v1/actions/${actionTypeApiName}/validate`,
    { parameters }
  );
}

// ---------------------------------------------------------------------------
// Helper: validate via the ontologyId-based path
// ---------------------------------------------------------------------------

async function validateActionWithOntology(
  actionTypeApiName: string,
  parameters: Record<string, unknown>
) {
  return request(
    "POST",
    `/api/v1/ontology/${ontologyId}/actions/${actionTypeApiName}/validate`,
    { parameters }
  );
}

// ---------------------------------------------------------------------------
// Helper: execute an action (for seeding and dry-run verification)
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
// Helper: fetch an object from OpenSearch
// ---------------------------------------------------------------------------

async function fetchObject(objectType: string, primaryKey: string) {
  return request(
    "GET",
    `/api/v1/objects/${objectType}/${encodeURIComponent(primaryKey)}`
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
      "Server not reachable at http://localhost:3000 — skipping action validation tests"
    );
    return;
  }

  // Discover the first ontology (seed ontology)
  const ont = await request("GET", "/api/v1/ontology");
  if (ont.status === 200 && ont.body?.data?.length > 0) {
    const seedOnt = ont.body.data.find((o: any) => o.displayName === "RRA Tax Ontology" || o.displayName === "Rwanda Revenue Authority") || ont.body.data[0];
    ontologyId = seedOnt.ontologyId;
  } else {
    console.warn("No ontologies found — skipping action validation tests");
    serverReachable = false;
  }
});

function skip(): boolean {
  return !serverReachable || !ontologyId;
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe("Action Validation Endpoint (Task 19)", () => {
  // =========================================================================
  // Setup: Create test action types and seed test objects
  // =========================================================================

  const VALIDATE_TAXPAYER_TIN = "AVT-TP-001";

  beforeAll(async () => {
    if (skip()) return;

    // --- Action type: modify a taxpayer's risk score (single rule) ---
    await ensureActionType({
      apiName: "avtUpdateRiskScore",
      displayName: "Validate Test: Update Risk Score",
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

    // --- Action type: create a taxpayer (for preview test) ---
    await ensureActionType({
      apiName: "avtCreateTaxpayer",
      displayName: "Validate Test: Create Taxpayer",
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

    // --- Action type with scale limit = 1 (for limit check) ---
    await ensureActionType({
      apiName: "avtLimitedModify",
      displayName: "Validate Test: Limited Modify",
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
          apiName: "newRiskScore",
          displayName: "Risk Score",
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
            riskScore: { source: "parameter", param: "newRiskScore" },
          },
        },
        {
          type: "modifyObject",
          objectType: "Taxpayer",
          objectReference: { source: "parameter", param: "tin2" },
          properties: {
            riskScore: { source: "parameter", param: "newRiskScore" },
          },
        },
      ],
    });

    // --- Seed a taxpayer for modify tests ---
    await ensureActionType({
      apiName: "avtSeedTaxpayer",
      displayName: "Validate Test: Seed Taxpayer",
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

    // Create the test taxpayer
    const seedRes = await executeAction("avtSeedTaxpayer", {
      tin: VALIDATE_TAXPAYER_TIN,
      fullName: "Validation Test Taxpayer",
      riskScore: 42,
    });

    // Allow 200 (created) or error if already exists (409-like from executor)
    if (seedRes.status !== 200) {
      // Might already exist from a previous run — check
      const existing = await fetchObject("Taxpayer", VALIDATE_TAXPAYER_TIN);
      if (existing.status !== 200) {
        console.warn(
          `Could not seed test taxpayer: ${seedRes.status} ${JSON.stringify(seedRes.body).substring(0, 200)}`
        );
      }
    }

    // Give OpenSearch a moment to index
    await new Promise((r) => setTimeout(r, 500));
  });

  // =========================================================================
  // Test 1: Valid action preview (modify existing object)
  // =========================================================================

  describe("Test 1: Valid action preview", () => {
    it("should return valid=true with preview for a valid modify action", async () => {
      if (skip()) return;

      const res = await validateAction("avtUpdateRiskScore", {
        taxpayerRef: VALIDATE_TAXPAYER_TIN,
        newRiskScore: 99,
      });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.preview).toBeDefined();
      expect(res.body.preview.affectedObjectCount).toBe(1);
      expect(res.body.preview.edits).toHaveLength(1);

      const edit = res.body.preview.edits[0];
      expect(edit.objectType).toBe("Taxpayer");
      expect(edit.primaryKey).toBe(VALIDATE_TAXPAYER_TIN);
      expect(edit.operation).toBe("update");
      expect(edit.properties).toContain("riskScore");
    });

    it("should also work via the ontologyId-based path", async () => {
      if (skip()) return;

      const res = await validateActionWithOntology("avtUpdateRiskScore", {
        taxpayerRef: VALIDATE_TAXPAYER_TIN,
        newRiskScore: 77,
      });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.preview.affectedObjectCount).toBe(1);
    });
  });

  // =========================================================================
  // Test 2: Invalid parameters
  // =========================================================================

  describe("Test 2: Invalid parameters", () => {
    it("should return valid=false with errors for missing required parameters", async () => {
      if (skip()) return;

      const res = await validateAction("avtUpdateRiskScore", {});

      expect(res.status).toBe(400);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    it("should return valid=false when only some parameters are provided", async () => {
      if (skip()) return;

      // Missing newRiskScore (required)
      const res = await validateAction("avtUpdateRiskScore", {
        taxpayerRef: VALIDATE_TAXPAYER_TIN,
      });

      expect(res.status).toBe(400);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Test 3: CRITICAL — Verify no edits were applied (dry run)
  // =========================================================================

  describe("Test 3: Dry run — no edits applied", () => {
    it("should NOT modify the object after a successful validate call", async () => {
      if (skip()) return;

      // First, record the current state of the taxpayer
      const before = await fetchObject("Taxpayer", VALIDATE_TAXPAYER_TIN);
      expect(before.status).toBe(200);
      const originalRiskScore = before.body.riskScore;

      // Validate an action that would change riskScore to 999999
      const valRes = await validateAction("avtUpdateRiskScore", {
        taxpayerRef: VALIDATE_TAXPAYER_TIN,
        newRiskScore: 999999,
      });
      expect(valRes.status).toBe(200);
      expect(valRes.body.valid).toBe(true);

      // Give OpenSearch a moment (in case something DID get written)
      await new Promise((r) => setTimeout(r, 500));

      // Verify the object was NOT modified
      const after = await fetchObject("Taxpayer", VALIDATE_TAXPAYER_TIN);
      expect(after.status).toBe(200);
      expect(after.body.riskScore).toBe(originalRiskScore);
      expect(after.body.riskScore).not.toBe(999999);
    });
  });

  // =========================================================================
  // Test 4: Action type not found — returns 404
  // =========================================================================

  describe("Test 4: Action type not found", () => {
    it("should return 404 for a non-existent action type", async () => {
      if (skip()) return;

      const res = await validateAction("nonExistentActionType", {
        someParam: "value",
      });

      expect(res.status).toBe(404);
      // Task 20: standardized error format for 404
      expect(res.body.errorCode).toBe("ACTION_TYPE_NOT_FOUND");
      expect(res.body.errorName).toBe("ActionTypeNotFoundError");
      expect(res.body.errorInstanceId).toBeDefined();
    });
  });

  // =========================================================================
  // Test 5: Rule compilation errors — object not found
  // =========================================================================

  describe("Test 5: Rule compilation errors", () => {
    it("should return valid=false when modify targets a non-existent object", async () => {
      if (skip()) return;

      const res = await validateAction("avtUpdateRiskScore", {
        taxpayerRef: "DOES-NOT-EXIST-999",
        newRiskScore: 50,
      });

      expect(res.status).toBe(400);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
      expect(res.body.errors[0]).toContain("does not exist");
    });
  });

  // =========================================================================
  // Test 6: Scale limit exceeded in validation
  // =========================================================================

  describe("Test 6: Scale limit exceeded in validation", () => {
    let secondTaxpayerSeeded = false;
    const SECOND_TIN = "AVT-TP-002";

    beforeAll(async () => {
      if (skip()) return;

      // Seed a second taxpayer
      const seedRes = await executeAction("avtSeedTaxpayer", {
        tin: SECOND_TIN,
        fullName: "Validation Test Taxpayer 2",
        riskScore: 10,
      });
      if (seedRes.status === 200) {
        secondTaxpayerSeeded = true;
      } else {
        // Might already exist from a previous run
        const existing = await fetchObject("Taxpayer", SECOND_TIN);
        secondTaxpayerSeeded = existing.status === 200;
      }

      await new Promise((r) => setTimeout(r, 500));
    });

    it("should return valid=false when affected objects exceed max", async () => {
      if (skip() || !secondTaxpayerSeeded) return;

      const res = await validateAction("avtLimitedModify", {
        tin1: VALIDATE_TAXPAYER_TIN,
        tin2: SECOND_TIN,
        newRiskScore: 77,
      });

      expect(res.status).toBe(400);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
      expect(res.body.errors[0]).toContain("Would affect");
      expect(res.body.errors[0]).toContain("limit:");
    });
  });

  // =========================================================================
  // Test 7: Create action preview (properties listed)
  // =========================================================================

  describe("Test 7: Create action preview", () => {
    it("should return a preview with create operation and property names", async () => {
      if (skip()) return;

      const res = await validateAction("avtCreateTaxpayer", {
        tin: "AVT-PREVIEW-NEW",
        fullName: "Preview Test Taxpayer",
        riskScore: 55,
      });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.preview.affectedObjectCount).toBe(1);
      expect(res.body.preview.edits).toHaveLength(1);

      const edit = res.body.preview.edits[0];
      expect(edit.objectType).toBe("Taxpayer");
      expect(edit.primaryKey).toBe("AVT-PREVIEW-NEW");
      expect(edit.operation).toBe("create");
      expect(edit.properties).toContain("tin");
      expect(edit.properties).toContain("fullName");
      expect(edit.properties).toContain("riskScore");
    });

    it("should NOT have actually created the object (dry run)", async () => {
      if (skip()) return;

      // Give OpenSearch a moment
      await new Promise((r) => setTimeout(r, 500));

      const check = await fetchObject("Taxpayer", "AVT-PREVIEW-NEW");
      expect(check.status).not.toBe(200);
    });
  });

  // =========================================================================
  // Test 8: Request body edge cases
  // =========================================================================

  describe("Test 8: Request body edge cases", () => {
    it("should handle empty body gracefully (missing parameters key)", async () => {
      if (skip()) return;

      const res = await request(
        "POST",
        "/api/v1/actions/avtUpdateRiskScore/validate",
        {}
      );

      // Should fail with parameter validation errors (required params missing)
      expect(res.status).toBe(400);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });
  });
});
