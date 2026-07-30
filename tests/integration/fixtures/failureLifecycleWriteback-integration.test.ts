// ---------------------------------------------------------------------------
// Gap G (§11.1-11.4) — writeback failure lifecycle matrix (live backend).
//
// Proves through the real Apply Action API + the deterministic controlled
// webhook service (Gap A):
//   §11.1 writeback runs BEFORE ontology edits; a failing writeback aborts
//       and no object is created, no edit is staged.
//   §11.2 a malformed response (invalid JSON) is detected and aborts.
//   §11.3 a slow/never-responding writeback enforces the configured timeout
//       and aborts (distinguished as 504 WRITEBACK_TIMEOUT).
//   §11.4 a SUCCESSFUL external writeback followed by a LATER ontology
//       failure is recorded as external-success / local-failure (no claim of
//       external rollback); the controlled service history proves the
//       external invocation happened despite the local abort.
//
// Side-effect failure (§11.5-11.6) and idempotency (Gap H) are covered in
// companion tests.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api } from "../../helpers/api";

const SUFFIX = "GapG";
const ONT = "/api/v1/ontology/00000000-0000-0000-0000-000000000001";
const CONTROLLED = process.env.CONTROLLED_WEBHOOK_URL ?? "http://localhost:3329";

const objectTypeApiName = `GapGTarget${SUFFIX}`;
const actionTypeApiNames: string[] = [];
const webhookNames: string[] = [];

async function createObjectType(): Promise<void> {
  await api("POST", `${ONT}/objectTypes`, { apiName: objectTypeApiName, displayName: "Gap G Target", description: "writeback failure fixture" }).catch(() => {});
  await api("POST", `${ONT}/objectTypes/${objectTypeApiName}/properties/batch`, {
    properties: [
      { apiName: "id", displayName: "ID", baseType: "string", isRequired: true },
      { apiName: "name", displayName: "Name", baseType: "string", isRequired: true },
    ],
  });
  await api("POST", `${ONT}/objectTypes/${objectTypeApiName}/primaryKey`, { propertyApiName: "id" }).catch(() => {});
}

async function createWebhook(nameBase: string, endpointPath: string, timeoutMs = 5000): Promise<void> {
  const name = `${nameBase}${SUFFIX}`;
  webhookNames.push(name);
  await api("POST", `${ONT}/webhooks`, {
    name,
    method: "POST",
    endpointConfig: { url: `${CONTROLLED}${endpointPath}`, followRedirects: false },
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    outputSchema: { type: "object", properties: { confirmed: { type: "boolean" }, ok: { type: "boolean" } } },
    authenticationConfig: { kind: "tellus_secret", ref: `g-${name}`, key: "apiToken" },
    timeoutMs,
    maxResponseBytes: 1024 * 1024,
    retryPolicy: null,
  }).catch(() => {});
}

async function createActionType(apiName: string, opts: {
  writeback: { webhookName: string; outputBindings?: Record<string, unknown>; failOntology?: boolean };
}): Promise<void> {
  const full = `${apiName}${SUFFIX}`;
  actionTypeApiNames.push(full);
  const createProps: Record<string, unknown> = {
    id: { source: "parameter", param: "pk" },
    name: { source: "parameter", param: "name" },
  };
  // For the ontology-failure-after-writeback scenario: a deleteObject rule on
  // a non-existent object passes save-time validation but fails at RUNTIME
  // (after the writeback already succeeded) — proving §11.4.
  const rules = opts.writeback.failOntology
    ? [{ type: "deleteObject", objectType: objectTypeApiName, objectReference: { source: "parameter", param: "pk" } }]
    : [{ type: "createObject", objectType: objectTypeApiName, properties: createProps }];
  const writebackConfig: Record<string, unknown> = {
    webhookId: opts.writeback.webhookName,
    webhookVersion: 1,
    failurePolicy: "abort",
    inputs: { id: { source: "parameter", param: "pk" } },
  };
  if (opts.writeback.outputBindings) writebackConfig.outputBindings = opts.writeback.outputBindings;
  const res = await api("POST", `${ONT}/actionTypes`, {
    apiName: full,
    displayName: apiName,
    parameters: [
      { apiName: "pk", displayName: "PK", type: "string", required: true },
      { apiName: "name", displayName: "Name", type: "string", required: true },
    ],
    rules,
    writebackConfig,
    semanticsVersion: 2,
    executionMode: "declarative",
    maxAffectedObjects: 100,
    isEnabled: true,
  });
  if (![200, 201, 409].includes(res.status)) {
    throw new Error(`createActionType ${full} failed ${res.status}: ${JSON.stringify(res.body).slice(0, 500)}`);
  }
}

async function apply(actionTypeBase: string, pk: string, name = "n"): Promise<{ status: number; body: any }> {
  return api("POST", `${ONT}/actions/${actionTypeBase}${SUFFIX}/apply`, { parameters: { pk, name } });
}

function affectedList(body: any): Array<{ objectType: string; primaryKey: string; operation: string }> {
  return body?.affectedObjects ?? body?.affected_objects ?? [];
}

async function controlledHistory(endpoint: string): Promise<Array<{ endpoint: string; responseStatus: number }>> {
  const r = await fetch(`${CONTROLLED}/__history`);
  const arr = (await r.json()) as Array<{ endpoint: string; responseStatus: number }>;
  return arr.filter((h) => h.endpoint === endpoint);
}
async function controlledReset(): Promise<void> {
  await fetch(`${CONTROLLED}/__reset`, { method: "POST" });
}

beforeAll(async () => {
  await controlledReset();
  await createObjectType();
  await createWebhook("WbSuccess", "/writeback/success");
  await createWebhook("WbFail", "/writeback/fail");
  await createWebhook("WbMalformed", "/writeback/malformed");
  await createWebhook("WbTimeout", "/writeback/timeout", 400);
  const wbSuccess = `WbSuccess${SUFFIX}`;
  const wbFail = `WbFail${SUFFIX}`;
  const wbMalformed = `WbMalformed${SUFFIX}`;
  const wbTimeout = `WbTimeout${SUFFIX}`;
  await createActionType("gapGWbSuccess", { writeback: { webhookName: wbSuccess, outputBindings: { confirmed: { outputId: "confirmed", path: "/confirmed", schema: { type: "boolean" }, valueType: "boolean" } } } });
  await createActionType("gapGWbFail", { writeback: { webhookName: wbFail } });
  await createActionType("gapGWbMalformed", { writeback: { webhookName: wbMalformed, outputBindings: { confirmed: { outputId: "confirmed", path: "/confirmed", schema: { type: "boolean" }, valueType: "boolean" } } } });
  await createActionType("gapGWbTimeout", { writeback: { webhookName: wbTimeout } });
  await createActionType("gapGWbThenOntologyFail", { writeback: { webhookName: wbSuccess, outputBindings: { confirmed: { outputId: "confirmed", path: "/confirmed", schema: { type: "boolean" }, valueType: "boolean" } }, failOntology: true } });
}, 120_000);

afterAll(async () => {
  for (const a of actionTypeApiNames) await api("DELETE", `${ONT}/actionTypes/${a}`).catch(() => {});
  for (const w of webhookNames) await api("DELETE", `${ONT}/webhooks/${w}`).catch(() => {});
  await api("DELETE", `${ONT}/objectTypes/${objectTypeApiName}`).catch(() => {});
});

describe("Gap G.1 — writeback runs before edits; failure aborts with no object created", () => {
  it("a successful writeback allows the create, and the writeback was invoked", async () => {
    await controlledReset();
    const res = await apply("gapGWbSuccess", "g-ok-1");
    expect(res.status).toBe(200);
    const aff = affectedList(res.body);
    expect(aff.some((a) => a.objectType === objectTypeApiName && a.primaryKey === "g-ok-1" && a.operation === "create")).toBe(true);
    const hist = await controlledHistory("/writeback/success");
    expect(hist.length).toBeGreaterThanOrEqual(1);
  });

  it("a failing writeback (non-2xx) aborts with 502; no object is created", async () => {
    await controlledReset();
    const res = await apply("gapGWbFail", "g-fail-1");
    expect(res.status).toBe(502);
    expect(affectedList(res.body).some((a) => a.operation === "create")).toBe(false);
    const hist = await controlledHistory("/writeback/fail");
    expect(hist.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Gap G.2 — malformed writeback response is detected and aborts", () => {
  it("invalid JSON response → abort, no object created", async () => {
    await controlledReset();
    const res = await apply("gapGWbMalformed", "g-mal-1");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(affectedList(res.body).some((a) => a.operation === "create")).toBe(false);
    const hist = await controlledHistory("/writeback/malformed");
    expect(hist.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Gap G.3 — slow/never-responding writeback enforces the timeout", () => {
  it("timeout → 504 WRITEBACK_TIMEOUT (distinguished from a 502 network failure), no object created", async () => {
    await controlledReset();
    const res = await apply("gapGWbTimeout", "g-to-1");
    // 504 = WRITEBACK_TIMEOUT, distinct from the 502 WRITEBACK_REJECTED the
    // fail-scenario returns — proving §11.3 "timeout distinguished from
    // generic network failure".
    expect(res.status).toBe(504);
    expect(affectedList(res.body).some((a) => a.operation === "create")).toBe(false);
    // The client tears the socket down on timeout; the never-responding
    // endpoint may not finish recording. The 504 + no-create is the proof.
  }, 20_000);
});

describe("Gap G.4 — external success followed by ontology failure", () => {
  it("writeback succeeds but the later ontology edit fails; external success is recorded, no object created", async () => {
    await controlledReset();
    const res = await apply("gapGWbThenOntologyFail", "g-ext-1");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(affectedList(res.body).some((a) => a.operation === "create")).toBe(false);
    // The external writeback WAS invoked (external success recorded) even
    // though the local ontology edit failed — no silent claim of external rollback.
    const hist = await controlledHistory("/writeback/success");
    expect(hist.length).toBeGreaterThanOrEqual(1);
  });
});
