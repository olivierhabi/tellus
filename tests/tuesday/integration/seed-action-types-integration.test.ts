// ---------------------------------------------------------------------------
// Seed Action Types Integration Tests (Task 28)
//
// Verifies that the seed action types were created correctly and can be
// executed against the live system. Requires the seed script to have been
// run first (npx tsx src/seeds/actionTypes.seed.ts).
//
// Tests cover:
//
//   1.  registerTaxpayer exists with correct parameters and rules
//   2.  fileTaxReturn exists with correct parameters and rules
//   3.  flagForAudit exists as a multi-rule action (2 rules)
//   4.  updateTaxpayerRiskScore exists with constraints on riskScore
//   5.  closeTaxReturn exists with correct parameters
//   6.  registerBusiness exists with addLink rule
//   7.  registerTaxpayer can be executed successfully
//   8.  fileTaxReturn can be executed successfully
//   9.  flagForAudit can be executed (multi-rule: TaxReturn + Taxpayer)
//  10.  updateTaxpayerRiskScore can be executed successfully
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
  return `/api/v2/ontologies/${ontologyId}/actionTypes${suffix}`;
}

function actionsPath(actionApiName: string, suffix = "") {
  return `/api/v2/ontologies/${ontologyId}/actions/${actionApiName}${suffix}`;
}

async function getActionType(apiName: string) {
  return request("GET", actionTypesPath(`/${apiName}`));
}

async function executeAction(
  actionApiName: string,
  parameters: Record<string, unknown>
) {
  return request("POST", actionsPath(actionApiName, "/apply"), { parameters });
}

async function fetchObject(objectType: string, primaryKey: string) {
  return request("GET", `/api/v2/objects/${objectType}/${encodeURIComponent(primaryKey)}`);
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
      "Server not reachable at http://localhost:3000 — skipping seed tests"
    );
    return;
  }

  const ont = await request("GET", "/api/v2/ontologies");
  if (ont.status === 200 && ont.body?.data?.length > 0) {
    const seedOnt = ont.body.data.find((o: any) => o.displayName === "RRA Tax Ontology" || o.displayName === "Rwanda Revenue Authority") || ont.body.data[0];
    ontologyId = seedOnt.ontologyId;
  } else {
    console.warn("No ontologies found — skipping seed tests");
    serverReachable = false;
  }
});

function skip(): boolean {
  return !serverReachable || !ontologyId;
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe("Seed Action Types (Task 28)", () => {
  // =========================================================================
  // Test 1: registerTaxpayer exists with correct parameters
  // =========================================================================
  it("1. registerTaxpayer exists with 4 parameters and 1 rule", async () => {
    if (skip()) return;

    const res = await getActionType("registerTaxpayer");
    expect(res.status).toBe(200);

    const data = res.body.data ?? res.body;
    expect(data.apiName).toBe("registerTaxpayer");
    expect(data.displayName).toBe("Register New Taxpayer");
    expect(data.parameters).toHaveLength(4);
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0].type).toBe("createObject");
    expect(data.rules[0].objectType).toBe("Taxpayer");
    expect(data.isEnabled).toBe(true);

    // Check parameter names
    const paramNames = data.parameters.map((p: any) => p.apiName);
    expect(paramNames).toContain("tin");
    expect(paramNames).toContain("fullName");
    expect(paramNames).toContain("taxpayerType");
    expect(paramNames).toContain("province");
  });

  // =========================================================================
  // Test 2: fileTaxReturn exists with correct parameters
  // =========================================================================
  it("2. fileTaxReturn exists with 5 parameters and 1 rule", async () => {
    if (skip()) return;

    const res = await getActionType("fileTaxReturn");
    expect(res.status).toBe(200);

    const data = res.body.data ?? res.body;
    expect(data.apiName).toBe("fileTaxReturn");
    expect(data.parameters).toHaveLength(5);
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0].type).toBe("createObject");
    expect(data.rules[0].objectType).toBe("TaxReturn");

    const paramNames = data.parameters.map((p: any) => p.apiName);
    expect(paramNames).toContain("returnId");
    expect(paramNames).toContain("taxType");
    expect(paramNames).toContain("declaredRevenue");
    expect(paramNames).toContain("declaredTax");
  });

  // =========================================================================
  // Test 3: flagForAudit exists as a multi-rule action
  // =========================================================================
  it("3. flagForAudit is a multi-rule action with 2 rules", async () => {
    if (skip()) return;

    const res = await getActionType("flagForAudit");
    expect(res.status).toBe(200);

    const data = res.body.data ?? res.body;
    expect(data.apiName).toBe("flagForAudit");
    expect(data.parameters).toHaveLength(3);
    expect(data.rules).toHaveLength(2);

    // Rule 1: modifyObject on TaxReturn
    expect(data.rules[0].type).toBe("modifyObject");
    expect(data.rules[0].objectType).toBe("TaxReturn");

    // Rule 2: modifyObject on Taxpayer
    expect(data.rules[1].type).toBe("modifyObject");
    expect(data.rules[1].objectType).toBe("Taxpayer");

    // Has object_reference parameters
    const returnRef = data.parameters.find((p: any) => p.apiName === "returnRef");
    expect(returnRef).toBeDefined();
    expect(returnRef.type).toBe("object_reference");
    expect(returnRef.objectType).toBe("TaxReturn");
  });

  // =========================================================================
  // Test 4: updateTaxpayerRiskScore has constraints
  // =========================================================================
  it("4. updateTaxpayerRiskScore has min/max constraints on riskScore", async () => {
    if (skip()) return;

    const res = await getActionType("updateTaxpayerRiskScore");
    expect(res.status).toBe(200);

    const data = res.body.data ?? res.body;
    expect(data.apiName).toBe("updateTaxpayerRiskScore");
    expect(data.parameters).toHaveLength(2);
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0].type).toBe("modifyObject");

    const riskParam = data.parameters.find(
      (p: any) => p.apiName === "riskScore"
    );
    expect(riskParam).toBeDefined();
    expect(riskParam.type).toBe("double");
    expect(riskParam.constraints).toBeDefined();
    expect(riskParam.constraints.min).toBe(0);
    expect(riskParam.constraints.max).toBe(100);
  });

  // =========================================================================
  // Test 5: closeTaxReturn exists
  // =========================================================================
  it("5. closeTaxReturn exists with 1 parameter and 1 rule", async () => {
    if (skip()) return;

    const res = await getActionType("closeTaxReturn");
    expect(res.status).toBe(200);

    const data = res.body.data ?? res.body;
    expect(data.apiName).toBe("closeTaxReturn");
    expect(data.parameters).toHaveLength(1);
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0].type).toBe("modifyObject");
    expect(data.rules[0].objectType).toBe("TaxReturn");
    expect(data.rules[0].properties.status.value).toBe("closed");
  });

  // =========================================================================
  // Test 6: registerBusiness has addLink rule
  // =========================================================================
  it("6. registerBusiness has createObject + addLink rules", async () => {
    if (skip()) return;

    const res = await getActionType("registerBusiness");
    expect(res.status).toBe(200);

    const data = res.body.data ?? res.body;
    expect(data.apiName).toBe("registerBusiness");
    expect(data.parameters).toHaveLength(4);
    expect(data.rules).toHaveLength(2);

    // Rule 1: createObject for Business
    expect(data.rules[0].type).toBe("createObject");
    expect(data.rules[0].objectType).toBe("Business");

    // Rule 2: addLink for taxpayerBusiness
    expect(data.rules[1].type).toBe("addLink");
    expect(data.rules[1].linkType).toBe("taxpayerBusiness");
  });

  // =========================================================================
  // Test 7: registerTaxpayer can be executed
  // =========================================================================
  it("7. registerTaxpayer can create a new Taxpayer object", async () => {
    if (skip()) return;

    // TIN must be exactly 9 digits (regex constraint: ^[0-9]{9}$)
    const tinSuffix = String(Date.now()).slice(-6);
    const tin = `900${tinSuffix}`;
    const res = await executeAction("registerTaxpayer", {
      tin,
      fullName: "Jean Seed Test",
      taxpayerType: "Individual",
      province: "Kigali",
    });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe("success");
    expect(res.body.affectedObjects).toBeDefined();
    expect(res.body.affectedObjects.length).toBeGreaterThanOrEqual(1);
    expect(res.body.affectedObjects[0].objectType).toBe("Taxpayer");
    expect(res.body.affectedObjects[0].operation).toBe("create");
  });

  // =========================================================================
  // Test 8: fileTaxReturn can be executed
  // =========================================================================
  it("8. fileTaxReturn can create a new TaxReturn object", async () => {
    if (skip()) return;

    const returnId = `RTN-${RUN_ID}`;
    const res = await executeAction("fileTaxReturn", {
      returnId,
      taxType: "VAT",
      period: "2026-Q1",
      declaredRevenue: 50000000,
      declaredTax: 9000000,
    });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe("success");
    expect(res.body.affectedObjects[0].objectType).toBe("TaxReturn");
    expect(res.body.affectedObjects[0].operation).toBe("create");
  });

  // =========================================================================
  // Test 9: flagForAudit multi-rule execution
  // =========================================================================
  it("9. flagForAudit modifies both TaxReturn and Taxpayer", async () => {
    if (skip()) return;

    // First create a taxpayer and a return for this test
    // TIN must be exactly 9 digits
    const tinSuffix = String(Date.now()).slice(-6);
    const tin = `901${tinSuffix}`;
    const returnId = `RTN9-${RUN_ID}`;

    await executeAction("registerTaxpayer", {
      tin,
      fullName: "Audit Target",
      taxpayerType: "Individual",
    });

    await executeAction("fileTaxReturn", {
      returnId,
      taxType: "CIT",
      period: "2026-Q1",
      declaredRevenue: 100000000,
      declaredTax: 1000000,
    });

    // Wait for indexing
    await new Promise((r) => setTimeout(r, 1500));

    const res = await executeAction("flagForAudit", {
      returnRef: returnId,
      taxpayerRef: tin,
      auditReason: "Revenue vs. tax mismatch",
    });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe("success");
    // Should affect 2 objects: TaxReturn + Taxpayer
    expect(res.body.affectedObjects.length).toBe(2);
  }, 15000);

  // =========================================================================
  // Test 10: updateTaxpayerRiskScore execution
  // =========================================================================
  it("10. updateTaxpayerRiskScore can update a Taxpayer's risk score", async () => {
    if (skip()) return;

    // Create a fresh taxpayer for this test
    const tinSuffix = String(Date.now()).slice(-6);
    const tin = `902${tinSuffix}`;
    await executeAction("registerTaxpayer", {
      tin,
      fullName: "Risk Score Target",
      taxpayerType: "Individual",
    });

    // Wait for indexing
    await new Promise((r) => setTimeout(r, 1500));

    const res = await executeAction("updateTaxpayerRiskScore", {
      taxpayerRef: tin,
      riskScore: 85.5,
    });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe("success");
    expect(res.body.affectedObjects[0].objectType).toBe("Taxpayer");
    expect(res.body.affectedObjects[0].operation).toBe("update");
  }, 15000);
});
