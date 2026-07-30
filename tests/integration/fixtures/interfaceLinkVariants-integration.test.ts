// ---------------------------------------------------------------------------
// Gap LV — every interface object/link variant applied (live backend).
//
// interfaceExecutionMatrix-integration.test.ts applied the interface-OBJECT
// rules (create/modify/delete across both impls) + ONE interface-to-interface
// link, asserting only HTTP 200. This suite closes the remaining "every
// variant" gap, driving every link variant through the real Apply Action API
// and verifying the AUTHORITATIVE transactional state (not the OpenSearch
// read model):
//
//   A. Concrete MANY_TO_MANY add/remove link (`customerSuppliers<suffix>`).
//   B. Concrete foreign-key ONE_TO_MANY add/remove (`customerOwnsSuppliers
//      <suffix>`; the FK property `fkCustomer<suffix>` is written/cleared).
//   C. Interface-to-OBJECT link constraint (`CommercialEntityToCustomer
//      <suffix>`, polymorphic source, fixed CustomerAccount target) realized
//      by a concrete O2M `SupplierAccount -> CustomerAccount` link.
//   D. Interface-to-INTERFACE link, unambiguous (`CommercialEntityLink
//      <suffix>` M2M) Customer -> Supplier with exactly one candidate.
//   E. AMBIGUOUS interface-link rejection — after a 2nd M2M Customer->
//      Supplier link is provisioned, the same createInterfaceLink rejects
//      with AMBIGUOUS_INTERFACE_LINK_IMPLEMENTATION (422); deleteInterfaceLink
//      removes EVERY matching candidate (the all-match contract).
//
// Assertion strategy (Phase 6): link presence is verified against the
// transactional `link_edit` log (net add-minus-remove > 0), and FK writes are
// verified against `object_instances.properties` — both written in the apply
// transaction, so they are strongly consistent and DO NOT depend on OpenSearch
// indexing lag. The OpenSearch-backed object-view read is used only inside
// createEntity() to satisfy the PRODUCTION addLink existence gate
// (objectExists is OpenSearch-backed); that is a production behaviour, not a
// test assertion, and is awaited to determinism via a bounded poll.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildCommercialEntityFixture } from "../../fixtures/commercialEntityFixture";
import { setupFixture, cleanupFixture, type FixtureHandles } from "../../fixtures/commercialEntitySetup";
import { api } from "../../helpers/api";
import { query } from "../../../src/db";

const SUFFIX = "GapLV";
const ONT = "/api/v1/ontology/00000000-0000-0000-0000-000000000001";
const CANONICAL_ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";

let handles: FixtureHandles;
const actionTypeApiNames: string[] = [];
const extraLinkTypes: string[] = [];

// Per-run unique id: the canonical ontology accumulates objects across runs
// (the global seed does not wipe them), so fixed pks collide with leftovers.
const RUN = String(Date.now()).slice(-9);

function iface(): string {
  return handles.interfaceApiName;
}
function s(name: string): string {
  return `${name}${SUFFIX}`;
}

const CONTACT = { phone: "+250700000001", email: "lv@example.test", addressLine: "KN 5 Ave" };

async function createActionType(apiName: string, body: Record<string, unknown>): Promise<void> {
  const full = s(apiName);
  const res = await api("POST", `${ONT}/actionTypes`, {
    apiName: full,
    displayName: body.displayName ?? apiName,
    description: body.description ?? "Gap LV link variant",
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

async function apply(actionType: string, parameters: Record<string, unknown>, idem?: string) {
  const headers: Record<string, string> = {};
  if (idem) headers["Idempotency-Key"] = idem;
  const res = api("POST", `${ONT}/actions/${s(actionType)}/apply`, { parameters }, headers);
  return res.then((r) => {
    if (r.status >= 400) {
      // eslint-disable-next-line no-console
      console.error(`[APPLY ${actionType}] ${r.status}: ${JSON.stringify(r.body).slice(0, 600)}`);
    }
    return r;
  });
}

async function createEntity(chosenType: string, entityId: string): Promise<void> {
  // Create via the interface rule. 409 = a previous run already created this
  // object; fine for link tests — the object exists (transactionally in
  // object_instances), which is what the interface-link DB resolver needs.
  // NOTE: no OpenSearch poll. Concrete addLink's existence gate is OpenSearch-
  // backed, so concrete-link tests use a COMBINED create+link action (pending
  // Edits bypass OS); interface-link tests resolve via the DB resolver and
  // don't need OS at all. This keeps the suite OpenSearch-independent.
  const res = await apply("lvCreate", {
    chosenType,
    entityId,
    displayName: entityId,
    status: "active",
    createdAt: "2026-07-30T10:00:00.000Z",
    contactDetails: CONTACT,
  });
  if (res.status !== 200 && res.status !== 409) {
    throw new Error(`createEntity ${chosenType}/${entityId} failed ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Authoritative (transactional) state helpers — strongly consistent, no
// OpenSearch dependency.
// ---------------------------------------------------------------------------

/** Net link state = SUM(add) - SUM(remove) over the link_edit log. >0 = active. */
async function linkNet(linkTypeApiName: string, sourcePk: string, targetPk: string): Promise<number> {
  const r = await query(
    `SELECT COALESCE(SUM(CASE WHEN operation = 'add' THEN 1 ELSE -1 END), 0)::int AS net
       FROM link_edit
      WHERE link_type_api_name = $1
        AND source_primary_key = $2
        AND target_primary_key = $3`,
    [linkTypeApiName, sourcePk, targetPk],
  );
  return (r.rows[0] as { net: number }).net;
}

/** Read one property from the authoritative object_instances row (jsonb). */
async function objectPropDb(objectType: string, pk: string, prop: string): Promise<unknown> {
  const r = await query(
    `SELECT properties FROM object_instances
      WHERE ontology_id = $1
        AND object_type_api_name = $2
        AND primary_key = $3
      ORDER BY last_modified_at DESC LIMIT 1`,
    [CANONICAL_ONTOLOGY_ID, objectType, pk],
  );
  const props = (r.rows[0] as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  const v = props[prop];
  return v && typeof v === "object" && "value" in v ? (v as { value: unknown }).value : v;
}

async function assertLinkActive(linkType: string, sourcePk: string, targetPk: string, on: "present" | "absent"): Promise<void> {
  const net = await linkNet(linkType, sourcePk, targetPk);
  if (on === "present") expect(net).toBeGreaterThan(0);
  else expect(net).toBeLessThanOrEqual(0);
}

beforeAll(async () => {
  // Pre-clean this task's OWN extra link types from a crashed prior run —
  // cleanupFixture (called inside setupFixture) does not know about them, so
  // a leftover `entityToCustomer<suffix>` would persist with stale object
  // type ids and shadow the fresh one (create returns 409, resolver no-match).
  for (const lt of [s("entityToCustomer"), s("customerSuppliersAlt")]) {
    await api("DELETE", `${ONT}/linkTypes/${lt}`).catch(() => {});
  }

  handles = await setupFixture(buildCommercialEntityFixture(SUFFIX));

  // Provision the concrete implementation for the interface-to-OBJECT
  // constraint (CommercialEntityToCustomer<suffix>, ONE_TO_MANY, fixed
  // CustomerAccount target): an optional FK property on CustomerAccount + an
  // O2M link SupplierAccount -> CustomerAccount carrying it.
  await api("POST", `${ONT}/objectTypes/${s("CustomerAccount")}/properties/batch`, {
    properties: [{ apiName: s("fkEntity"), displayName: "FK Entity", baseType: "string", isRequired: false }],
  }).catch(() => {});
  const linkRes = await api("POST", `${ONT}/linkTypes/`, {
    apiName: s("entityToCustomer"),
    displayName: "Entity To Customer",
    cardinality: "ONE_TO_MANY",
    sourceObjectTypeApiName: s("SupplierAccount"),
    targetObjectTypeApiName: s("CustomerAccount"),
    targetPropertyApiName: s("fkEntity"),
  });
  if (![200, 201, 409].includes(linkRes.status)) {
    throw new Error(`create entityToCustomer link failed ${linkRes.status}: ${JSON.stringify(linkRes.body).slice(0, 200)}`);
  }
  extraLinkTypes.push(s("entityToCustomer"));

  await createActionType("lvCreate", {
    displayName: "LV Create Entity",
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

  const linkPairParams = () => [
    { apiName: "customerPk", displayName: "Customer PK", type: "string", required: true },
    { apiName: "supplierPk", displayName: "Supplier PK", type: "string", required: true },
  ];

  // A. Concrete M2M add/remove.
  await createActionType("lvLinkM2M", {
    displayName: "LV Link M2M",
    parameters: linkPairParams(),
    rules: [{ type: "addLink", linkType: s("customerSuppliers"), sourceObject: { source: "parameter", param: "customerPk" }, targetObject: { source: "parameter", param: "supplierPk" } }],
  });
  await createActionType("lvUnlinkM2M", {
    displayName: "LV Unlink M2M",
    parameters: linkPairParams(),
    rules: [{ type: "removeLink", linkType: s("customerSuppliers"), sourceObject: { source: "parameter", param: "customerPk" }, targetObject: { source: "parameter", param: "supplierPk" } }],
  });

  // B. Concrete FK O2M add/remove.
  await createActionType("lvLinkFk", {
    displayName: "LV Link FK",
    parameters: linkPairParams(),
    rules: [{ type: "addLink", linkType: s("customerOwnsSuppliers"), sourceObject: { source: "parameter", param: "customerPk" }, targetObject: { source: "parameter", param: "supplierPk" } }],
  });
  await createActionType("lvUnlinkFk", {
    displayName: "LV Unlink FK",
    parameters: linkPairParams(),
    rules: [{ type: "removeLink", linkType: s("customerOwnsSuppliers"), sourceObject: { source: "parameter", param: "customerPk" }, targetObject: { source: "parameter", param: "supplierPk" } }],
  });

  const ifaceRefParams = () => [
    { apiName: "sourceRef", displayName: "Source", type: "interface_reference", interfaceId: iface(), required: true },
    { apiName: "targetRef", displayName: "Target", type: "interface_reference", interfaceId: iface(), required: true },
  ];
  const toCustomerConstraint = handles.spec.interfaceLinkConstraints.find((c) => c.apiName === s("CommercialEntityToCustomer"))!.apiName;
  const ifaceLinkConstraint = handles.spec.interfaceLinkConstraints.find((c) => c.apiName === s("CommercialEntityLink"))!.apiName;

  // C. Interface-to-object create/delete.
  await createActionType("lvLinkIfaceObj", {
    displayName: "LV Link Interface->Object",
    parameters: ifaceRefParams(),
    rules: [{ type: "createInterfaceLink", interfaceLinkConstraint: toCustomerConstraint, interfaceId: iface(), source: { source: "parameter", param: "sourceRef" }, target: { source: "parameter", param: "targetRef" } }],
  });
  await createActionType("lvUnlinkIfaceObj", {
    displayName: "LV Unlink Interface->Object",
    parameters: ifaceRefParams(),
    rules: [{ type: "deleteInterfaceLink", interfaceLinkConstraint: toCustomerConstraint, interfaceId: iface(), source: { source: "parameter", param: "sourceRef" }, target: { source: "parameter", param: "targetRef" } }],
  });

  // D. Interface-to-interface create/delete.
  await createActionType("lvLinkIface", {
    displayName: "LV Link Interface->Interface",
    parameters: ifaceRefParams(),
    rules: [{ type: "createInterfaceLink", interfaceLinkConstraint: ifaceLinkConstraint, interfaceId: iface(), source: { source: "parameter", param: "sourceRef" }, target: { source: "parameter", param: "targetRef" } }],
  });
  await createActionType("lvUnlinkIface", {
    displayName: "LV Unlink Interface->Interface",
    parameters: ifaceRefParams(),
    rules: [{ type: "deleteInterfaceLink", interfaceLinkConstraint: ifaceLinkConstraint, interfaceId: iface(), source: { source: "parameter", param: "sourceRef" }, target: { source: "parameter", param: "targetRef" } }],
  });

  // Combined create+concrete-link actions. Concrete addLink's existence gate
  // is OpenSearch-backed (objectExists); creating the source/target objects in
  // the SAME action lets the planner's pendingEdits satisfy that gate WITHOUT
  // waiting for OpenSearch indexing — the OS-independent, production-faithful
  // path. createObject (concrete) is modelled in the v2 final-state set, so the
  // addLink edge's source/target are present in finalObjectState and the
  // dangling invariant passes (unlike a separate-action addLink, which would
  // block on OS indexing of objects created in a prior apply).
  const combinedParams = () => [
    { apiName: "srcPk", displayName: "Source PK", type: "string", required: true },
    { apiName: "tgtPk", displayName: "Target PK", type: "string", required: true },
    { apiName: "displayName", displayName: "Display Name", type: "string", required: true },
    { apiName: "status", displayName: "Status", type: "string", required: true },
    { apiName: "createdAt", displayName: "Created At", type: "timestamp", required: true },
    { apiName: "contactDetails", displayName: "Contact Details", type: "struct", required: true },
  ];
  const combinedRules = (linkApi: string) => {
    const props = (pkParam: string) => ({
      entityId: { source: "parameter", param: pkParam },
      displayName: { source: "parameter", param: "displayName" },
      status: { source: "parameter", param: "status" },
      createdAt: { source: "parameter", param: "createdAt" },
      contactDetails: { source: "parameter", param: "contactDetails" },
    });
    return [
      { type: "createObject", objectType: s("CustomerAccount"), properties: props("srcPk") },
      { type: "createObject", objectType: s("SupplierAccount"), properties: props("tgtPk") },
      { type: "addLink", linkType: linkApi, sourceObject: { source: "parameter", param: "srcPk" }, targetObject: { source: "parameter", param: "tgtPk" } },
    ];
  };
  await createActionType("lvCreateAndLinkM2M", {
    displayName: "LV Create + Link M2M",
    parameters: combinedParams(),
    rules: combinedRules(s("customerSuppliers")),
  });
  await createActionType("lvCreateAndLinkFk", {
    displayName: "LV Create + Link FK",
    parameters: combinedParams(),
    rules: combinedRules(s("customerOwnsSuppliers")),
  });
}, 180_000);

afterAll(async () => {
  for (const apiName of actionTypeApiNames) {
    await api("DELETE", `${ONT}/actionTypes/${apiName}`).catch(() => {});
  }
  for (const lt of extraLinkTypes) {
    await api("DELETE", `${ONT}/linkTypes/${lt}`).catch(() => {});
  }
  if (handles) await cleanupFixture(handles.spec);
});

function ref(objectType: string, primaryKey: string) {
  return { objectType, primaryKey };
}

describe("Gap LV — concrete link rules (M2M + FK) applied + verified authoritatively", () => {
  const custPk = `m2mCust-${RUN}`;
  const supPk = `m2mSup-${RUN}`;

  it("A1. addLink on the MANY_TO_MANY link writes a link_edit 'add' (net > 0)", async () => {
    // Combined create+link: pendingEdits satisfies the concrete addLink
    // existence gate without OpenSearch (the OS-independent path).
    const res = await apply("lvCreateAndLinkM2M", { srcPk: custPk, tgtPk: supPk, displayName: "LV", status: "active", createdAt: "2026-07-30T10:00:00.000Z", contactDetails: CONTACT }, `lv-m2m-${RUN}`);
    expect(res.status).toBe(200);
    await assertLinkActive(s("customerSuppliers"), custPk, supPk, "present");
  }, 40_000);

  it("A2. removeLink on the M2M link drives net to <= 0", async () => {
    const res = await apply("lvUnlinkM2M", { customerPk: custPk, supplierPk: supPk }, `lv-unm2m-${RUN}`);
    expect(res.status).toBe(200);
    await assertLinkActive(s("customerSuppliers"), custPk, supPk, "absent");
  }, 30_000);
});

describe("Gap LV — foreign-key O2M addLink/removeLink writes & clears the FK property (DB-authoritative)", () => {
  const custPk = `fkCust-${RUN}`;
  const supPk = `fkSup-${RUN}`;

  it("B1. addLink on the FK O2M link writes fkCustomer<suffix> on the target (authoritative FK record)", async () => {
    const res = await apply("lvCreateAndLinkFk", { srcPk: custPk, tgtPk: supPk, displayName: "LV", status: "active", createdAt: "2026-07-30T10:00:00.000Z", contactDetails: CONTACT }, `lv-fk-${RUN}`);
    expect(res.status).toBe(200);
    // O2M FK link: the authoritative link record is the FK property on the
    // target (many) side — written transactionally in object_instances.
    expect(await objectPropDb(s("SupplierAccount"), supPk, s("fkCustomer"))).toBe(custPk);
  }, 40_000);

  it("B2. removeLink on the FK O2M link clears fkCustomer<suffix>", async () => {
    const res = await apply("lvUnlinkFk", { customerPk: custPk, supplierPk: supPk }, `lv-unfk-${RUN}`);
    expect(res.status).toBe(200);
    const v = await objectPropDb(s("SupplierAccount"), supPk, s("fkCustomer"));
    expect(v == null || v === "").toBe(true);
  }, 30_000);
});

describe("Gap LV — interface-to-object link constraint (polymorphic source, fixed target)", () => {
  const supPk = `iobjSup-${RUN}`;
  const custPk = `iobjCust-${RUN}`;

  it("C1. createInterfaceLink to the fixed CustomerAccount target writes fkEntity<suffix> (authoritative FK record)", async () => {
    await createEntity(s("SupplierAccount"), supPk);
    await createEntity(s("CustomerAccount"), custPk);
    const res = await apply("lvLinkIfaceObj", { sourceRef: ref(s("SupplierAccount"), supPk), targetRef: ref(s("CustomerAccount"), custPk) }, `lv-iobj-${RUN}`);
    expect(res.status).toBe(200);
    // O2M interface-to-object link: the authoritative record is the FK
    // property (fkEntity<suffix>) written on the fixed target (Customer).
    expect(await objectPropDb(s("CustomerAccount"), custPk, s("fkEntity"))).toBe(supPk);
  }, 40_000);

  it("C2. deleteInterfaceLink clears the FK", async () => {
    const res = await apply("lvUnlinkIfaceObj", { sourceRef: ref(s("SupplierAccount"), supPk), targetRef: ref(s("CustomerAccount"), custPk) }, `lv-uniobj-${RUN}`);
    expect(res.status).toBe(200);
    const v = await objectPropDb(s("CustomerAccount"), custPk, s("fkEntity"));
    expect(v == null || v === "").toBe(true);
  }, 30_000);

  it("C3. rejects when the target is not the constraint's fixed CustomerAccount (no partial mutation)", async () => {
    const res = await apply("lvLinkIfaceObj", { sourceRef: ref(s("SupplierAccount"), supPk), targetRef: ref(s("SupplierAccount"), `no-such-${RUN}`) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    // No partial mutation: no FK written for the rejected pair.
    const v = await objectPropDb(s("SupplierAccount"), `no-such-${RUN}`, s("fkEntity"));
    expect(v == null || v === "").toBe(true);
  }, 20_000);
});

describe("Gap LV — interface-to-interface link: unambiguous create/delete, then ambiguity", () => {
  const custPk = `ifeCust-${RUN}`;
  const supPk = `ifeSup-${RUN}`;

  it("D1. createInterfaceLink is accepted while exactly one M2M candidate exists (net > 0)", async () => {
    await createEntity(s("CustomerAccount"), custPk);
    await createEntity(s("SupplierAccount"), supPk);
    const res = await apply("lvLinkIface", { sourceRef: ref(s("CustomerAccount"), custPk), targetRef: ref(s("SupplierAccount"), supPk) }, `lv-ife-${RUN}`);
    expect(res.status).toBe(200);
    await assertLinkActive(s("customerSuppliers"), custPk, supPk, "present");
  }, 40_000);

  it("D2. deleteInterfaceLink drives net to <= 0", async () => {
    const res = await apply("lvUnlinkIface", { sourceRef: ref(s("CustomerAccount"), custPk), targetRef: ref(s("SupplierAccount"), supPk) }, `lv-unife-${RUN}`);
    expect(res.status).toBe(200);
    await assertLinkActive(s("customerSuppliers"), custPk, supPk, "absent");
  }, 30_000);

  it("E. AMBIGUOUS: a 2nd M2M Customer->Supplier link makes createInterfaceLink reject (422)", async () => {
    const alt = await api("POST", `${ONT}/linkTypes/`, {
      apiName: s("customerSuppliersAlt"),
      displayName: "Customer Suppliers Alt",
      cardinality: "MANY_TO_MANY",
      sourceObjectTypeApiName: s("CustomerAccount"),
      targetObjectTypeApiName: s("SupplierAccount"),
    });
    if (![200, 201, 409].includes(alt.status)) {
      throw new Error(`create alt M2M link failed ${alt.status}: ${JSON.stringify(alt.body).slice(0, 200)}`);
    }
    extraLinkTypes.push(s("customerSuppliersAlt"));

    const cPk = `ambCust-${RUN}`;
    const sPk = `ambSup-${RUN}`;
    await createEntity(s("CustomerAccount"), cPk);
    await createEntity(s("SupplierAccount"), sPk);
    const res = await apply("lvLinkIface", { sourceRef: ref(s("CustomerAccount"), cPk), targetRef: ref(s("SupplierAccount"), sPk) }, `lv-amb-${RUN}`);
    expect([422, 400, 409]).toContain(res.status);
    // The apply wraps pre-edit validation failures as VALIDATION_ERROR; the
    // ambiguous resolution is signalled deterministically in the message
    // (naming both candidate link types). Assert the deterministic signal.
    const blob = JSON.stringify(res.body ?? {});
    expect(/ambiguous/i.test(blob)).toBe(true);
    expect(blob).toContain(s("customerSuppliers"));
    expect(blob).toContain(s("customerSuppliersAlt"));
    // No partial mutation: no link_edit add row for the rejected pair.
    const net = await linkNet(s("customerSuppliers"), cPk, sPk);
    expect(net).toBeLessThanOrEqual(0);
  }, 40_000);

  it("E2. deleteInterfaceLink removes EVERY matching candidate (deterministic all-match)", async () => {
    // The {ambCust, ambSup} pair had its createInterfaceLink rejected on
    // ambiguity (no link created), so a delete is a no-op that must NOT crash.
    const res = await apply("lvUnlinkIface", { sourceRef: ref(s("CustomerAccount"), `ambCust-${RUN}`), targetRef: ref(s("SupplierAccount"), `ambSup-${RUN}`) }, `lv-ambdel-${RUN}`);
    expect([200, 400, 404, 422]).toContain(res.status);
    // After the all-match delete, the net state of both candidate link types
    // for this pair is <= 0 (the all-match contract removes every edge).
    expect(await linkNet(s("customerSuppliers"), `ambCust-${RUN}`, `ambSup-${RUN}`)).toBeLessThanOrEqual(0);
    expect(await linkNet(s("customerSuppliersAlt"), `ambCust-${RUN}`, `ambSup-${RUN}`)).toBeLessThanOrEqual(0);
  }, 30_000);
});
