// ---------------------------------------------------------------------------
// Gap D — integration setup/cleanup for the two-implementation fixture.
//
// Provisions the fixture against the LIVE backend through its real service
// APIs (routes): interface, two concrete object types with mapped shared
// properties + primary keys, the incompatible implementer (asserting the
// validator's TYPE_MISMATCH rejection), concrete link types (M2M, FK
// one-to-many, one-to-one), interface link constraints (interface-to-
// interface, interface-to-object, incompatible), and six surface-A
// webhook_definition rows pointed at the controlled webhook service.
//
// Function-registry rows (the five functions) are NOT provisioned here: the
// real publish pipeline (`src/services/functionsPublish`) requires a code
// repository + Jemma run + artifact and is exercised by Gap B/F; the
// function CONTRACTS are unit-proven in commercialEntityFixture-unit.test.ts.
//
// Cleanup is route DELETE in dependency order, each tolerating 404, mirroring
// the established Sunday pattern (tests/sunday/integration). Everything is
// scoped under the canonical singleton ontology by the per-run `suffix`.
// ---------------------------------------------------------------------------

import { api } from "../helpers/api";
import type { ApiResponse } from "../helpers/api";
import type { FixtureSpec } from "./commercialEntityFixture";

export interface FixtureHandles {
  spec: FixtureSpec;
  interfaceApiName: string;
  implementerApiNames: string[];
  linkApiNames: string[];
  constraintApiNames: string[];
  webhookNames: string[];
}

const ONT = "/api/v1/ontology/00000000-0000-0000-0000-000000000001";

async function ensure(res: ApiResponse, ok: number[], label: string): Promise<any> {
  if (!ok.includes(res.status)) {
    throw new Error(`[${label}] expected ${ok.join("|")} got ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  return res.body;
}

async function ignore(res: ApiResponse, label: string): Promise<void> {
  // tolerate 404 / 409 / conflict on cleanup / idempotent re-create
  if (![200, 201, 202, 204, 404, 409].includes(res.status)) {
    // eslint-disable-next-line no-console
    console.warn(`[${label}] ignoring status ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  }
}

export async function setupFixture(spec: FixtureSpec): Promise<FixtureHandles> {
  // Pre-clean leftovers from an interrupted prior run.
  await cleanupFixture(spec);

  // 1. Interface
  await ignore(await api("POST", `${ONT}/interfaces`, {
    apiName: spec.interface.apiName,
    displayName: spec.interface.displayName,
    description: spec.interface.description,
    properties: spec.interface.properties.map((p) => ({
      apiName: p.apiName,
      displayName: p.displayName,
      baseType: p.baseType,
      isRequired: p.isRequired,
      ...(p.structSchema ? { structSchema: p.structSchema } : {}),
    })),
  }), "create-interface");

  // 2. Object types + properties + PK
  for (const impl of spec.implementers.filter((i) => !i.incompatible)) {
    await ignore(await api("POST", `${ONT}/objectTypes`, {
      apiName: impl.apiName,
      displayName: impl.displayName,
      description: `${impl.displayName} (test fixture)`,
    }), `create-ot-${impl.apiName}`);
    // Add the FK property to SupplierAccount for the one-to-many link.
    const props = [...impl.properties];
    if (impl.apiName.includes("SupplierAccount")) {
      props.push({ apiName: `fkCustomer${spec.suffix}`, displayName: "FK Customer", baseType: "string", isRequired: false });
    }
    await ensure(
      await api("POST", `${ONT}/objectTypes/${impl.apiName}/properties/batch`, { properties: props.map((p) => ({
        apiName: p.apiName, displayName: p.displayName, baseType: p.baseType, isRequired: p.isRequired,
        ...(p.structSchema ? { structSchema: p.structSchema } : {}),
      })) }),
      [200, 201],
      `props-${impl.apiName}`,
    );
    await ignore(await api("POST", `${ONT}/objectTypes/${impl.apiName}/primaryKey`, { propertyApiName: impl.primaryKeyApiName }), `pk-${impl.apiName}`);

    // 3. Implement — expect 201 for compatible.
    await ensure(
      await api("POST", `${ONT}/objectTypes/${impl.apiName}/implements`, {
        interfaceApiName: spec.interface.apiName,
        propertyMapping: impl.propertyMapping,
      }),
      [200, 201],
      `implement-${impl.apiName}`,
    );
  }

  // 3b. The incompatible implementer: create the object type, add a property
  // whose base_type diverges (boolean status), then attempt the implement —
  // the validator MUST reject with TYPE_MISMATCH (422). The OT is left in place.
  const incompatible = spec.implementers.find((i) => i.incompatible)!;
  await ignore(await api("POST", `${ONT}/objectTypes`, {
    apiName: incompatible.apiName, displayName: incompatible.displayName, description: "incompatible",
  }), `create-ot-${incompatible.apiName}`);
  await ignore(await api("POST", `${ONT}/objectTypes/${incompatible.apiName}/properties/batch`, {
    properties: incompatible.properties.map((p) => ({
      apiName: p.apiName, displayName: p.displayName, baseType: p.baseType, isRequired: p.isRequired,
      ...(p.structSchema ? { structSchema: p.structSchema } : {}),
    })),
  }), `props-${incompatible.apiName}`);
  const implRes = await api("POST", `${ONT}/objectTypes/${incompatible.apiName}/implements`, {
    interfaceApiName: spec.interface.apiName,
    propertyMapping: { ...incompatible.propertyMapping },
  });
  if (implRes.status < 400) {
    throw new Error(`incompatible implementer was WRONGLY accepted (status ${implRes.status}); expected TYPE_MISMATCH rejection`);
  }

  // 4. Link types (the FK one-to-many references fkCustomer<suffix>).
  for (const link of spec.links) {
    const body: Record<string, unknown> = {
      apiName: link.apiName,
      displayName: link.displayName,
      cardinality: link.cardinality,
      sourceObjectTypeApiName: link.sourceObjectTypeApiName,
      targetObjectTypeApiName: link.targetObjectTypeApiName,
    };
    if (link.targetPropertyApiName) body.targetPropertyApiName = link.targetPropertyApiName;
    await ignore(await api("POST", `${ONT}/linkTypes/`, body), `link-${link.apiName ?? link.displayName}`);
  }

  // 5. Interface link constraints.
  for (const c of spec.interfaceLinkConstraints) {
    const body: Record<string, unknown> = {
      apiName: c.apiName,
      displayName: c.displayName,
      interfaceApiName: c.interfaceApiName,
      cardinality: c.cardinality,
      status: c.status,
    };
    if (c.targetInterfaceApiName) body.targetInterfaceApiName = c.targetInterfaceApiName;
    if (c.targetObjectTypeApiName) body.targetObjectTypeApiName = c.targetObjectTypeApiName;
    await ignore(await api("POST", `${ONT}/interfaceLinkConstraints/`, body), `ilc-${c.apiName}`);
  }

  // 6. Webhook definitions (surface A) pointed at the controlled service.
  for (const w of spec.webhooks) {
    await ignore(await api("POST", `${ONT}/webhooks`, {
      name: w.name,
      method: w.method,
      endpointConfig: w.endpointConfig,
      inputSchema: w.inputSchema,
      outputSchema: w.outputSchema,
      authenticationConfig: w.authenticationConfig,
      timeoutMs: w.timeoutMs,
      maxResponseBytes: w.maxResponseBytes,
      retryPolicy: null,
    }), `webhook-${w.name}`);
  }

  return {
    spec,
    interfaceApiName: spec.interface.apiName,
    implementerApiNames: spec.implementers.map((i) => i.apiName),
    linkApiNames: spec.links.map((l) => l.apiName ?? l.displayName),
    constraintApiNames: spec.interfaceLinkConstraints.map((c) => c.apiName),
    webhookNames: spec.webhooks.map((w) => w.name),
  };
}

export async function cleanupFixture(spec: FixtureSpec): Promise<void> {
  // Dependency order: webhooks → interface-link constraints → link types →
  // implementations → interface → object types.
  for (const w of spec.webhooks) {
    await ignore(await api("DELETE", `${ONT}/webhooks/${w.name}`), `del-webhook-${w.name}`);
  }
  for (const c of spec.interfaceLinkConstraints) {
    await ignore(await api("DELETE", `${ONT}/interfaceLinkConstraints/${c.apiName}`), `del-ilc-${c.apiName}`);
  }
  for (const l of spec.links) {
    const apiName = l.apiName ?? l.displayName;
    await ignore(await api("DELETE", `${ONT}/linkTypes/${apiName}`), `del-link-${apiName}`);
  }
  for (const impl of spec.implementers) {
    await ignore(await api("DELETE", `${ONT}/objectTypes/${impl.apiName}/implements/${spec.interface.apiName}`), `del-impl-${impl.apiName}`);
  }
  await ignore(await api("DELETE", `${ONT}/interfaces/${spec.interface.apiName}`), `del-iface-${spec.interface.apiName}`);
  for (const impl of spec.implementers) {
    await ignore(await api("DELETE", `${ONT}/objectTypes/${impl.apiName}`), `del-ot-${impl.apiName}`);
  }
}
