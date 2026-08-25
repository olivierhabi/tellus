// ---------------------------------------------------------------------------
// Gap E — complete interface execution matrix (live backend).
//
// Proves create/modify/delete interface-object action rules execute through
// the real Apply Action API against BOTH concrete implementations of the
// CommercialEntity fixture, plus the negative matrix (incompatible
// implementer rejection, primary-key modification rejection, delete of a
// missing object). Uses the deterministic two-implementation fixture
// (Gap D) provisioned through the real service APIs.
//
// Migration 149 made createInterfaceObject/modifyInterfaceObject/
// deleteInterfaceObject persistable; this is the first integration test that
// creates an action type with those discriminators and actually executes it.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildCommercialEntityFixture } from "../../fixtures/commercialEntityFixture";
import { setupFixture, cleanupFixture, type FixtureHandles } from "../../fixtures/commercialEntitySetup";
import { api } from "../../helpers/api";

const SUFFIX = "GapE";
const ONT = "/api/v1/ontology/00000000-0000-0000-0000-000000000001";

let handles: FixtureHandles;
const actionTypeApiNames: string[] = [];
const createdKeys: Record<string, string> = {};

function iface(): string {
  return handles.interfaceApiName;
}
function ot(name: string): string {
  return `${name}${SUFFIX}`;
}

async function createActionType(apiName: string, body: Record<string, unknown>): Promise<void> {
  const full = `${apiName}${SUFFIX}`;
  const res = await api("POST", `${ONT}/actionTypes`, {
    apiName: full,
    displayName: body.displayName ?? apiName,
    description: body.description ?? "Gap E interface execution",
    parameters: body.parameters,
    rules: body.rules,
    semanticsVersion: 2,
    executionMode: "declarative",
    maxAffectedObjects: 100,
    isEnabled: true,
  });
  if (![200, 201, 409].includes(res.status)) {
    throw new Error(`createActionType ${full} failed ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
  }
  actionTypeApiNames.push(full);
}

async function apply(actionType: string, parameters: Record<string, unknown>, idem?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (idem) headers["Idempotency-Key"] = idem;
  return api("POST", `${ONT}/actions/${actionType}/apply`, { parameters }, headers);
}

async function readObject(objectType: string, pk: string): Promise<{ status: number; body: any }> {
  // The object view reads from OpenSearch, which is eventually consistent
  // (index lag) after a create and can transiently 503 under shared-server
  // load. The object IS persisted (the apply's affectedObjects confirmed the
  // create); poll the read until it is consistent — a bounded wait on the
  // known condition, not a fixed sleep or a hidden retry of the assertion.
  const deadline = Date.now() + 15_000;
  let res = await api("GET", `${ONT}/objectTypes/${objectType}/objects/${encodeURIComponent(pk)}/view`);
  while (res.status !== 200 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    res = await api("GET", `${ONT}/objectTypes/${objectType}/objects/${encodeURIComponent(pk)}/view`);
  }
  return res;
}

beforeAll(async () => {
  handles = await setupFixture(buildCommercialEntityFixture(SUFFIX));

  await createActionType("createCommercialEntity", {
    displayName: "Create Commercial Entity",
    parameters: [
      { apiName: "chosenType", displayName: "Concrete type", type: "object_type_reference", interfaceId: iface(), required: true },
      { apiName: "entityId", displayName: "Entity ID", type: "string", required: true },
      { apiName: "displayName", displayName: "Display Name", type: "string", required: true },
      { apiName: "status", displayName: "Status", type: "string", required: true },
      { apiName: "createdAt", displayName: "Created At", type: "timestamp", required: true },
      { apiName: "contactDetails", displayName: "Contact Details", type: "struct", required: true },
    ],
    rules: [
      {
        type: "createInterfaceObject",
        interfaceId: iface(),
        objectTypeParameter: "chosenType",
        properties: {
          entityId: { source: "parameter", param: "entityId" },
          displayName: { source: "parameter", param: "displayName" },
          status: { source: "parameter", param: "status" },
          createdAt: { source: "parameter", param: "createdAt" },
          contactDetails: { source: "parameter", param: "contactDetails" },
        },
      },
    ],
  });

  await createActionType("modifyCommercialEntity", {
    displayName: "Modify Commercial Entity",
    parameters: [
      { apiName: "entityRef", displayName: "Entity", type: "interface_reference", interfaceId: iface(), required: true },
      { apiName: "newStatus", displayName: "New Status", type: "string", required: true },
    ],
    rules: [
      {
        type: "modifyInterfaceObject",
        interfaceId: iface(),
        interfaceReference: { source: "parameter", param: "entityRef" },
        properties: { status: { source: "parameter", param: "newStatus" } },
      },
    ],
  });

  await createActionType("deleteCommercialEntity", {
    displayName: "Delete Commercial Entity",
    parameters: [
      { apiName: "entityRef", displayName: "Entity", type: "interface_reference", interfaceId: iface(), required: true },
    ],
    rules: [
      {
        type: "deleteInterfaceObject",
        interfaceId: iface(),
        interfaceReference: { source: "parameter", param: "entityRef" },
      },
    ],
  });

  const linkConstraint = handles.spec.interfaceLinkConstraints.find(
    (c) => c.targetInterfaceApiName === iface(),
  )!.apiName;
  await createActionType("createCommercialEntityLink", {
    displayName: "Create Commercial Entity Link",
    parameters: [
      { apiName: "sourceRef", displayName: "Source", type: "interface_reference", interfaceId: iface(), required: true },
      { apiName: "targetRef", displayName: "Target", type: "interface_reference", interfaceId: iface(), required: true },
    ],
    rules: [
      {
        type: "createInterfaceLink",
        interfaceLinkConstraint: linkConstraint,
        interfaceId: iface(),
        source: { source: "parameter", param: "sourceRef" },
        target: { source: "parameter", param: "targetRef" },
      },
    ],
  });
  await createActionType("deleteCommercialEntityLink", {
    displayName: "Delete Commercial Entity Link",
    parameters: [
      { apiName: "sourceRef", displayName: "Source", type: "interface_reference", interfaceId: iface(), required: true },
      { apiName: "targetRef", displayName: "Target", type: "interface_reference", interfaceId: iface(), required: true },
    ],
    rules: [
      {
        type: "deleteInterfaceLink",
        interfaceLinkConstraint: linkConstraint,
        interfaceId: iface(),
        source: { source: "parameter", param: "sourceRef" },
        target: { source: "parameter", param: "targetRef" },
      },
    ],
  });
}, 120_000);

afterAll(async () => {
  for (const apiName of actionTypeApiNames) {
    await api("DELETE", `${ONT}/actionTypes/${apiName}`).catch(() => {});
  }
  if (handles) await cleanupFixture(handles.spec);
});

const CONTACT = { phone: "+250700000001", email: "cust@example.test", addressLine: "KN 5 Ave" };

function affectedList(body: any): Array<{ objectType: string; primaryKey: string; operation: string }> {
  return body?.affectedObjects ?? body?.affected_objects ?? [];
}

// The object-view `properties` field is an enriched ARRAY
// ({apiName, value, displayName, ...} per property) — not a record keyed by
// property name. Fall back to the raw record shape for non-enriched reads.
function propValue(viewBody: any, name: string): unknown {
  const props = viewBody?.properties ?? viewBody?.data?.properties ?? {};
  if (Array.isArray(props)) {
    const entry = props.find((p: any) => p.apiName === name || p.name === name);
    return entry?.value;
  }
  const v = props[name];
  return v && typeof v === "object" && "value" in v ? (v as any).value : v;
}

describe("Gap E.1 — createInterfaceObject across both implementations", () => {
  it("creates a CustomerAccount via the interface rule", async () => {
    const res = await apply(`createCommercialEntity${SUFFIX}`, {
      chosenType: ot("CustomerAccount"),
      entityId: "cust-gapE-1",
      displayName: "Customer One",
      status: "active",
      createdAt: "2026-07-30T10:00:00.000Z",
      contactDetails: CONTACT,
    });
    expect(res.status).toBe(200);
    const aff = affectedList(res.body);
    expect(aff.some((a) => a.objectType === ot("CustomerAccount") && a.primaryKey === "cust-gapE-1" && a.operation === "create")).toBe(true);
    createdKeys.customer = "cust-gapE-1";
  });

  it("creates a SupplierAccount via the same interface rule", async () => {
    const res = await apply(`createCommercialEntity${SUFFIX}`, {
      chosenType: ot("SupplierAccount"),
      entityId: "sup-gapE-1",
      displayName: "Supplier One",
      status: "active",
      createdAt: "2026-07-30T10:00:00.000Z",
      contactDetails: CONTACT,
    });
    expect(res.status).toBe(200);
    const aff = affectedList(res.body);
    expect(aff.some((a) => a.objectType === ot("SupplierAccount") && a.primaryKey === "sup-gapE-1" && a.operation === "create")).toBe(true);
    createdKeys.supplier = "sup-gapE-1";
  });

  it("verified shared properties persist on the concrete objects", async () => {
    const cust = await readObject(ot("CustomerAccount"), createdKeys.customer);
    expect(cust.status).toBe(200);
    expect(propValue(cust.body, "displayName")).toBe("Customer One");
    expect(propValue(cust.body, "status")).toBe("active");
    expect(propValue(cust.body, "entityId")).toBe("cust-gapE-1");

    const sup = await readObject(ot("SupplierAccount"), createdKeys.supplier);
    expect(sup.status).toBe(200);
    expect(propValue(sup.body, "entityId")).toBe("sup-gapE-1");
  });

  it("rejects an object_type_reference to a non-implementing concrete type", async () => {
    const res = await apply(`createCommercialEntity${SUFFIX}`, {
      chosenType: ot("IncompatibleAccount"), // not an implementer of CommercialEntity
      entityId: "bad-1",
      displayName: "Bad",
      status: "x",
      createdAt: "2026-07-30T10:00:00.000Z",
      contactDetails: CONTACT,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("Gap E.2 — modifyInterfaceObject", () => {
  it("modifies the shared status property on CustomerAccount via an interface reference", async () => {
    const res = await apply(`modifyCommercialEntity${SUFFIX}`, {
      entityRef: { objectType: ot("CustomerAccount"), primaryKey: createdKeys.customer },
      newStatus: "suspended",
    });
    expect(res.status).toBe(200);
    const aff = affectedList(res.body);
    expect(aff.some((a) => a.objectType === ot("CustomerAccount") && a.primaryKey === createdKeys.customer && a.operation === "update")).toBe(true);
    const view = await readObject(ot("CustomerAccount"), createdKeys.customer);
    expect(propValue(view.body, "status")).toBe("suspended");
  });

  it("rejects primary-key modification via the interface rule", async () => {
    // A second modify action type that attempts to set entityId.
    await createActionType("modifyCommercialEntityPk", {
      displayName: "Modify Commercial Entity PK",
      parameters: [
        { apiName: "entityRef", displayName: "Entity", type: "interface_reference", interfaceId: iface(), required: true },
        { apiName: "newPk", displayName: "New PK", type: "string", required: true },
      ],
      rules: [
        {
          type: "modifyInterfaceObject",
          interfaceId: iface(),
          interfaceReference: { source: "parameter", param: "entityRef" },
          properties: { entityId: { source: "parameter", param: "newPk" } },
        },
      ],
    });
    const res = await apply(`modifyCommercialEntityPk${SUFFIX}`, {
      entityRef: { objectType: ot("CustomerAccount"), primaryKey: createdKeys.customer },
      newPk: "attempted-new-pk",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("Gap E.3 — deleteInterfaceObject", () => {
  it("deletes the SupplierAccount via an interface reference", async () => {
    const res = await apply(`deleteCommercialEntity${SUFFIX}`, {
      entityRef: { objectType: ot("SupplierAccount"), primaryKey: createdKeys.supplier },
    });
    expect(res.status).toBe(200);
    const aff = affectedList(res.body);
    expect(aff.some((a) => a.objectType === ot("SupplierAccount") && a.primaryKey === createdKeys.supplier && a.operation === "delete")).toBe(true);
    const view = await readObject(ot("SupplierAccount"), createdKeys.supplier);
    expect(view.status).toBe(404);
  });

  it("rejects delete of a missing object (delete-before-create)", async () => {
    const res = await apply(`deleteCommercialEntity${SUFFIX}`, {
      entityRef: { objectType: ot("SupplierAccount"), primaryKey: "never-existed-gapE" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("Gap E.4 — interface links", () => {
  it("creates an interface-to-interface link between two CommercialEntity objects", async () => {
    // Two objects to link (Customer source, Supplier target).
    await apply(`createCommercialEntity${SUFFIX}`, {
      chosenType: ot("CustomerAccount"),
      entityId: "cust-link-1",
      displayName: "Link Cust",
      status: "active",
      createdAt: "2026-07-30T10:00:00.000Z",
      contactDetails: CONTACT,
    });
    await apply(`createCommercialEntity${SUFFIX}`, {
      chosenType: ot("SupplierAccount"),
      entityId: "sup-link-1",
      displayName: "Link Sup",
      status: "active",
      createdAt: "2026-07-30T10:00:00.000Z",
      contactDetails: CONTACT,
    });
    const res = await apply(`createCommercialEntityLink${SUFFIX}`, {
      sourceRef: { objectType: ot("CustomerAccount"), primaryKey: "cust-link-1" },
      targetRef: { objectType: ot("SupplierAccount"), primaryKey: "sup-link-1" },
    });
    expect(res.status).toBe(200);
  });

  it("a duplicate create is handled per canonical semantics (rejected or deduplicated)", async () => {
    const dup = await apply(`createCommercialEntityLink${SUFFIX}`, {
      sourceRef: { objectType: ot("CustomerAccount"), primaryKey: "cust-link-1" },
      targetRef: { objectType: ot("SupplierAccount"), primaryKey: "sup-link-1" },
    });
    // §9.4: duplicate link creation is rejected OR deduplicated — both are
    // valid canonical behaviour. The runtime deduplicates silently (200).
    expect([200, 400, 409, 422]).toContain(dup.status);
  });

  it("deletes the interface link", async () => {
    const res = await apply(`deleteCommercialEntityLink${SUFFIX}`, {
      sourceRef: { objectType: ot("CustomerAccount"), primaryKey: "cust-link-1" },
      targetRef: { objectType: ot("SupplierAccount"), primaryKey: "sup-link-1" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects linking to a non-existent target object", async () => {
    const res = await apply(`createCommercialEntityLink${SUFFIX}`, {
      sourceRef: { objectType: ot("CustomerAccount"), primaryKey: "cust-link-1" },
      targetRef: { objectType: ot("SupplierAccount"), primaryKey: "never-existed-link" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
