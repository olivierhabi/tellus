// ---------------------------------------------------------------------------
// Action Type Cloning Integration Tests (Task 23)
//
// Verifies the POST /:actionApiName/clone endpoint that creates a deep
// copy of an existing action type with a new API name. Tests cover:
//
//   1. Successful clone with newDisplayName
//   2. Successful clone with default display name ("Copy of ...")
//   3. Cloned action type has different ID but same parameters/rules
//   4. Clone of a disabled action type is also disabled
//   5. Clone with duplicate newApiName returns 409
//   6. Clone with invalid newApiName returns 400
//   7. Clone of non-existent source returns 404
//   8. Cloned action type is fully independent (modify original, clone unchanged)
//   9. Cloned action type can be executed
//  10. Clone with missing newApiName returns 400
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

async function ensureActionType(def: Record<string, unknown>): Promise<void> {
  const res = await request("POST", actionTypesPath(), def);
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(
      `Failed to create action type '${def.apiName}': ${res.status} ${JSON.stringify(res.body).substring(0, 300)}`
    );
  }
}

async function getActionType(apiName: string) {
  return request("GET", actionTypesPath(`/${apiName}`));
}

async function cloneActionType(
  sourceApiName: string,
  body: Record<string, unknown>
) {
  return request("POST", actionTypesPath(`/${sourceApiName}/clone`), body);
}

async function deleteActionType(apiName: string) {
  return request("DELETE", actionTypesPath(`/${apiName}`));
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
      "Server not reachable at http://localhost:3000 — skipping clone tests"
    );
    return;
  }

  const ont = await request("GET", "/api/v2/ontologies");
  if (ont.status === 200 && ont.body?.data?.length > 0) {
    const seedOnt = ont.body.data.find((o: any) => o.displayName === "RRA Tax Ontology") || ont.body.data[0];
    ontologyId = seedOnt.ontologyId;
  } else {
    console.warn("No ontologies found — skipping clone tests");
    serverReachable = false;
  }
});

function skip(): boolean {
  return !serverReachable || !ontologyId;
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe("Action Type Cloning (Task 23)", () => {
  const SOURCE_ACTION = `cloneSrc${RUN_ID}`;
  const SOURCE_DISPLAY = "Clone Source Action";

  beforeAll(async () => {
    if (skip()) return;

    // Create a source action type to clone from
    await ensureActionType({
      apiName: SOURCE_ACTION,
      displayName: SOURCE_DISPLAY,
      description: "Source action type for clone tests",
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
      maxAffectedObjects: 5000,
    });
  });

  // -------------------------------------------------------------------------
  // Test 1: Successful clone with newDisplayName
  // -------------------------------------------------------------------------

  it("clones an action type with a new apiName and displayName", async () => {
    if (skip()) return;

    const newName = `cloneT1${RUN_ID}`;
    const res = await cloneActionType(SOURCE_ACTION, {
      newApiName: newName,
      newDisplayName: "Cloned Action T1",
    });

    expect(res.status).toBe(201);
    expect(res.body.apiName).toBe(newName);
    expect(res.body.displayName).toBe("Cloned Action T1");
    expect(res.body.actionTypeId).toBeTruthy();

    // Clean up
    await deleteActionType(newName);
  });

  // -------------------------------------------------------------------------
  // Test 2: Default display name ("Copy of ...")
  // -------------------------------------------------------------------------

  it("uses 'Copy of ...' when newDisplayName is not provided", async () => {
    if (skip()) return;

    const newName = `cloneT2${RUN_ID}`;
    const res = await cloneActionType(SOURCE_ACTION, {
      newApiName: newName,
    });

    expect(res.status).toBe(201);
    expect(res.body.displayName).toBe(`Copy of ${SOURCE_DISPLAY}`);

    await deleteActionType(newName);
  });

  // -------------------------------------------------------------------------
  // Test 3: Cloned action has different ID but same parameters/rules
  // -------------------------------------------------------------------------

  it("has different actionTypeId but identical parameters and rules", async () => {
    if (skip()) return;

    const newName = `cloneT3${RUN_ID}`;
    const cloneRes = await cloneActionType(SOURCE_ACTION, {
      newApiName: newName,
      newDisplayName: "Clone T3",
    });
    expect(cloneRes.status).toBe(201);

    // Fetch the original
    const origRes = await getActionType(SOURCE_ACTION);
    expect(origRes.status).toBe(200);

    // IDs must be different
    expect(cloneRes.body.actionTypeId).not.toBe(origRes.body.actionTypeId);

    // Parameters and rules must be identical
    expect(JSON.stringify(cloneRes.body.parameters)).toBe(
      JSON.stringify(origRes.body.parameters)
    );
    expect(JSON.stringify(cloneRes.body.rules)).toBe(
      JSON.stringify(origRes.body.rules)
    );

    // maxAffectedObjects should be copied
    expect(cloneRes.body.maxAffectedObjects).toBe(
      origRes.body.maxAffectedObjects
    );

    // description should be copied
    expect(cloneRes.body.description).toBe(origRes.body.description);

    await deleteActionType(newName);
  });

  // -------------------------------------------------------------------------
  // Test 4: Clone of disabled action type is also disabled
  // -------------------------------------------------------------------------

  it("preserves isEnabled=false from the source", async () => {
    if (skip()) return;

    // Create a disabled source
    const disabledSrc = `cloneDisSrc${RUN_ID}`;
    await ensureActionType({
      apiName: disabledSrc,
      displayName: "Disabled Source",
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
      isEnabled: false,
    });

    const newName = `cloneT4${RUN_ID}`;
    const res = await cloneActionType(disabledSrc, {
      newApiName: newName,
      newDisplayName: "Disabled Clone",
    });

    expect(res.status).toBe(201);
    expect(res.body.isEnabled).toBe(false);

    await deleteActionType(newName);
    await deleteActionType(disabledSrc);
  });

  // -------------------------------------------------------------------------
  // Test 5: Clone with duplicate newApiName returns 409
  // -------------------------------------------------------------------------

  it("returns 409 when newApiName already exists", async () => {
    if (skip()) return;

    // Try to clone with the SAME name as the source
    const res = await cloneActionType(SOURCE_ACTION, {
      newApiName: SOURCE_ACTION,
      newDisplayName: "Duplicate Clone",
    });

    expect(res.status).toBe(409);
  });

  // -------------------------------------------------------------------------
  // Test 6: Clone with invalid newApiName returns 400
  // -------------------------------------------------------------------------

  it("returns 400 for invalid newApiName", async () => {
    if (skip()) return;

    // Name starting with a number
    const res1 = await cloneActionType(SOURCE_ACTION, {
      newApiName: "123invalid",
    });
    expect(res1.status).toBe(400);

    // Name with special characters
    const res2 = await cloneActionType(SOURCE_ACTION, {
      newApiName: "has-hyphens",
    });
    expect(res2.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Test 7: Clone of non-existent source returns 404
  // -------------------------------------------------------------------------

  it("returns 404 when source action type does not exist", async () => {
    if (skip()) return;

    const res = await cloneActionType("nonExistentAction", {
      newApiName: `cloneT7${RUN_ID}`,
    });

    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe("ACTION_TYPE_NOT_FOUND");
  });

  // -------------------------------------------------------------------------
  // Test 8: Cloned action type is fully independent
  // -------------------------------------------------------------------------

  it("clone is independent: modifying the original does not affect the clone", async () => {
    if (skip()) return;

    const newName = `cloneT8${RUN_ID}`;
    const cloneRes = await cloneActionType(SOURCE_ACTION, {
      newApiName: newName,
      newDisplayName: "Independent Clone",
    });
    expect(cloneRes.status).toBe(201);

    // Modify the original's description
    await request("PUT", actionTypesPath(`/${SOURCE_ACTION}`), {
      description: "MODIFIED description",
    });

    // Fetch the clone — its description should NOT be "MODIFIED description"
    const cloneFetch = await getActionType(newName);
    expect(cloneFetch.status).toBe(200);
    expect(cloneFetch.body.description).not.toBe("MODIFIED description");
    expect(cloneFetch.body.description).toBe(
      "Source action type for clone tests"
    );

    // Restore original description
    await request("PUT", actionTypesPath(`/${SOURCE_ACTION}`), {
      description: "Source action type for clone tests",
    });

    await deleteActionType(newName);
  });

  // -------------------------------------------------------------------------
  // Test 9: Cloned action type can be executed
  // -------------------------------------------------------------------------

  it("cloned action type can be executed successfully", async () => {
    if (skip()) return;

    const newName = `cloneT9${RUN_ID}`;
    await cloneActionType(SOURCE_ACTION, {
      newApiName: newName,
      newDisplayName: "Executable Clone",
    });

    // Execute the cloned action
    const tin = `CLONE-EXEC-${RUN_ID}`;
    const execRes = await request(
      "POST",
      `/api/v2/ontologies/${ontologyId}/actions/${newName}/apply`,
      {
        parameters: { tin, fullName: "Clone Execution Test" },
      }
    );

    expect(execRes.status).toBe(200);
    expect(execRes.body.result).toBe("success");
    expect(execRes.body.executionId).toBeTruthy();

    await deleteActionType(newName);
  });

  // -------------------------------------------------------------------------
  // Test 10: Clone with missing newApiName returns 400
  // -------------------------------------------------------------------------

  it("returns 400 when newApiName is missing", async () => {
    if (skip()) return;

    const res = await cloneActionType(SOURCE_ACTION, {
      newDisplayName: "No Api Name",
    });

    expect(res.status).toBe(400);
  });
});
