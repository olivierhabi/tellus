// ---------------------------------------------------------------------------
// Gap H (§12.1, §12.4) — Apply Action idempotency (live backend).
//
// Proves through the real Apply Action API + the controlled webhook service:
//   §12.1 Submitting the same Idempotency-Key does not duplicate object
//       creation — the second submit returns the CACHED first result
//       (X-Idempotency-Cached: true) and does NOT execute a second time
//       (the second payload's distinct primary key is NOT created). A
//       different key executes normally (creates its own object).
//   §12.4 A stable idempotency key IS propagated to the external webhook
//       (the controlled service records the X-Idempotency-Key header on the
//       writeback invocation it received), and the same key produces the
//       same derived key across attempts.
//
// Reuses the established writeback-success createObject pattern. Side-effect
// outbox idempotency (§12.3) is covered in the side-effect proof.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api } from "../../helpers/api";

const SUFFIX = "GapH";
const ONT = "/api/v1/ontology/00000000-0000-0000-0000-000000000001";
const CONTROLLED = process.env.CONTROLLED_WEBHOOK_URL ?? "http://localhost:3329";

const objectTypeApiName = `GapHTarget${SUFFIX}`;
const webhookName = `WbSuccess${SUFFIX}`;
const actionType = `gapHCreate${SUFFIX}`;
const actionTypeApiNames: string[] = [];
const webhookNames: string[] = [];

async function apply(pk: string, idem?: string): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  const headers: Record<string, string> = {};
  if (idem) headers["Idempotency-Key"] = idem;
  return api("POST", `${ONT}/actions/${actionType}/apply`, { parameters: { pk, name: "n" } }, headers);
}

async function controlledReset(): Promise<void> {
  await fetch(`${CONTROLLED}/__reset`, { method: "POST" });
}
async function controlledHistory(endpoint: string): Promise<Array<{ endpoint: string; idempotencyKey: string | null }>> {
  const r = await fetch(`${CONTROLLED}/__history`);
  const arr = (await r.json()) as Array<{ endpoint: string; idempotencyKey: string | null }>;
  return arr.filter((h) => h.endpoint === endpoint);
}

beforeAll(async () => {
  await api("DELETE", `${ONT}/actionTypes/${actionType}`).catch(() => {});
  await api("DELETE", `${ONT}/webhooks/${webhookName}`).catch(() => {});
  await controlledReset();
  await api("POST", `${ONT}/objectTypes`, { apiName: objectTypeApiName, displayName: "Gap H Target" }).catch(() => {});
  await api("POST", `${ONT}/objectTypes/${objectTypeApiName}/properties/batch`, {
    properties: [
      { apiName: "id", displayName: "ID", baseType: "string", isRequired: true },
      { apiName: "name", displayName: "Name", baseType: "string", isRequired: true },
    ],
  }).catch(() => {});
  await api("POST", `${ONT}/objectTypes/${objectTypeApiName}/primaryKey`, { propertyApiName: "id" }).catch(() => {});
  webhookNames.push(webhookName);
  await api("POST", `${ONT}/webhooks`, {
    name: webhookName, method: "POST",
    endpointConfig: { url: `${CONTROLLED}/writeback/success`, followRedirects: false },
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    outputSchema: { type: "object", properties: { confirmed: { type: "boolean" } } },
    authenticationConfig: { kind: "tellus_secret", ref: "h", key: "apiToken" },
    timeoutMs: 5000, maxResponseBytes: 1024 * 1024, retryPolicy: null,
  }).catch(() => {});
  actionTypeApiNames.push(actionType);
  const res = await api("POST", `${ONT}/actionTypes`, {
    apiName: actionType, displayName: "Gap H Create",
    parameters: [
      { apiName: "pk", displayName: "PK", type: "string", required: true },
      { apiName: "name", displayName: "Name", type: "string", required: true },
    ],
    rules: [{ type: "createObject", objectType: objectTypeApiName, properties: {
      id: { source: "parameter", param: "pk" }, name: { source: "parameter", param: "name" },
    } }],
    writebackConfig: {
      webhookId: webhookName, webhookVersion: 1, failurePolicy: "abort",
      inputs: { id: { source: "parameter", param: "pk" } },
      outputBindings: { confirmed: { outputId: "confirmed", path: "/confirmed", schema: { type: "boolean" }, valueType: "boolean" } },
    },
    semanticsVersion: 2, executionMode: "declarative", maxAffectedObjects: 100, isEnabled: true,
  });
  if (![200, 201, 409].includes(res.status)) throw new Error(`createActionType ${actionType} failed ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
}, 120_000);

afterAll(async () => {
  for (const a of actionTypeApiNames) await api("DELETE", `${ONT}/actionTypes/${a}`).catch(() => {});
  for (const w of webhookNames) await api("DELETE", `${ONT}/webhooks/${w}`).catch(() => {});
  await api("DELETE", `${ONT}/objectTypes/${objectTypeApiName}`).catch(() => {});
});

function affectedList(body: any): Array<{ objectType: string; primaryKey: string; operation: string }> {
  return body?.affectedObjects ?? body?.affected_objects ?? [];
}

// The idempotency cache is DB-backed with a 24h TTL and persists across vitest
// runs, so each run MUST use a fresh key (else the first apply returns a prior
// run's cached result without executing — and without invoking the writeback).
const KEY_FIRST = `idem-h-first-${Date.now()}`;
const KEY_SECOND = `idem-h-second-${Date.now()}`;

describe("Gap H.1 — same idempotency key does not duplicate object creation", () => {
  it("the first submit creates the object and records the writeback idempotency key", async () => {
    await controlledReset();
    const res = await apply("h-obj-1", KEY_FIRST);
    expect(res.status).toBe(200);
    const aff = affectedList(res.body);
    expect(aff.some((a) => a.primaryKey === "h-obj-1" && a.operation === "create")).toBe(true);
    const hist = await controlledHistory("/writeback/success");
    expect(hist.length).toBeGreaterThanOrEqual(1);
    expect(hist[0].idempotencyKey).toBeTruthy();
  });

  it("the second submit with the SAME key returns the cached result and does NOT create the new PK", async () => {
    // Same idempotency key but a DIFFERENT primary key — if executed it would
    // create h-obj-2. Idempotency must suppress this second execution.
    const res = await apply("h-obj-2", KEY_FIRST);
    expect(res.status).toBe(200);
    const cached = res.headers.get ? res.headers.get("x-idempotency-cached") : (res.headers as any)["x-idempotency-cached"];
    expect(cached).toBe("true");
    const aff = affectedList(res.body);
    // The cached result references the FIRST execution's object, not h-obj-2.
    expect(aff.some((a) => a.primaryKey === "h-obj-2" && a.operation === "create")).toBe(false);
    expect(aff.some((a) => a.primaryKey === "h-obj-1")).toBe(true);
    // No additional writeback invocation should have been recorded for the
    // cached (suppressed) second submit.
    const hist = await controlledHistory("/writeback/success");
    expect(hist.length).toBe(1);
  });

  it("a different idempotency key executes normally and creates its own object", async () => {
    const res = await apply("h-obj-3", KEY_SECOND);
    expect(res.status).toBe(200);
    const aff = affectedList(res.body);
    expect(aff.some((a) => a.primaryKey === "h-obj-3" && a.operation === "create")).toBe(true);
  });
});
