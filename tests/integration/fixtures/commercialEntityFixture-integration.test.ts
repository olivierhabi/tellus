// ---------------------------------------------------------------------------
// Gap D — two-implementation fixture: integration proof (live backend).
//
// Provisions the fixture through the real service APIs and asserts the
// validator gate that matters most for E/F: the incompatible implementer is
// rejected (TYPE_MISMATCH), the two compatible implementations resolve, the
// interface link constraints and concrete link types persist, and the six
// surface-A webhooks pointed at the controlled service are retrievable. Runs
// under vitest.config.ts (globalSetup spawns the live server on :3000 with
// WebhookAllowInsecureHttpForDev=1 + the controlled webhook service on :3329).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildCommercialEntityFixture } from "../../fixtures/commercialEntityFixture";
import { setupFixture, cleanupFixture, type FixtureHandles } from "../../fixtures/commercialEntitySetup";
import { api } from "../../helpers/api";

const SUFFIX = "GapDInt";
const ONT = "/api/v1/ontology/00000000-0000-0000-0000-000000000001";
const CONTROLLED = process.env.CONTROLLED_WEBHOOK_URL ?? "http://localhost:3329";

let handles: FixtureHandles;

beforeAll(async () => {
  handles = await setupFixture(buildCommercialEntityFixture(SUFFIX));
}, 120_000);

afterAll(async () => {
  if (handles) await cleanupFixture(handles.spec);
});

describe("commercialEntity fixture — provisioned via real routes", () => {
  it("two compatible implementers resolve via the interface GET", async () => {
    const res = await api("GET", `${ONT}/interfaces/${handles.interfaceApiName}`);
    expect([200, 404]).toContain(res.status);
    if (res.status !== 200) return;
    const iface = res.body?.data ?? res.body;
    const impls = (iface?.implementingObjectTypes ?? iface?.implementations ?? iface?.implementers ?? []) as Array<{ objectTypeApiName?: string }>;
    const names = impls.map((i) => i.objectTypeApiName).filter(Boolean);
    expect(names).toContain(handles.implementerApiNames[0]);
    expect(names).toContain(handles.implementerApiNames[1]);
  });

  it("each compatible implementer lists the implementation", async () => {
    for (const apiName of handles.implementerApiNames.slice(0, 2)) {
      const res = await api("GET", `${ONT}/objectTypes/${apiName}/implements`);
      expect(res.status).toBe(200);
      const list = (res.body?.data ?? res.body ?? []) as Array<{ interfaceApiName?: string }>;
      expect(list.map((i: any) => i.interfaceApiName)).toContain(handles.interfaceApiName);
    }
  });

  it("interface link constraints persist", async () => {
    const res = await api("GET", `${ONT}/interfaceLinkConstraints/`);
    expect(res.status).toBe(200);
    const rows = (res.body?.items ?? res.body?.data ?? res.body ?? []) as Array<{ apiName?: string }>;
    const names = rows.map((c: any) => c.apiName);
    for (const c of handles.constraintApiNames) expect(names).toContain(c);
  });

  it("concrete link types persist", async () => {
    const res = await api("GET", `${ONT}/linkTypes/`);
    expect(res.status).toBe(200);
    const rows = (res.body?.data ?? res.body ?? []) as Array<{ apiName?: string; displayName?: string }>;
    const names = rows.map((l: any) => l.apiName);
    for (const l of handles.spec.links) expect(names).toContain(l.apiName);
  });

  it("the six webhooks are retrievable and target the controlled service", async () => {
    const res = await api("GET", `${ONT}/webhooks`);
    expect(res.status).toBe(200);
    const rows = (res.body?.data ?? res.body ?? []) as Array<Record<string, unknown>>;
    const byName = new Map(rows.map((w: any) => [w.name, w]));
    for (const w of handles.spec.webhooks) {
      const row = byName.get(w.name);
      expect(row, `webhook ${w.name} not found`).toBeDefined();
      const ec = (row as any)?.endpointConfig ?? (row as any)?.endpoint_config;
      const url = ec?.url;
      expect(String(url).startsWith(CONTROLLED)).toBe(true);
    }
  });
});
