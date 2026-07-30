// ---------------------------------------------------------------------------
// Gap D — Deterministic two-implementation interface fixture
//
// A test-only ontology fixture, scoped under the canonical singleton
// ontology (00000000-0000-0000-0000-000000000001) by a per-run `suffix`,
// that provides:
//
//   * One shared interface `CommercialEntity<suffix>` with shared properties
//     spanning the locally-represented canonical type system (primitive,
//     list, nested record/struct, optional/nullable, timestamp).
//   * Two concrete implementers `CustomerAccount<suffix>` and
//     `SupplierAccount<suffix>` with explicitly mapped shared properties
//     (strict base_type equality, per interfaceValidator).
//   * One intentionally incompatible implementation (negative test): a
//     concrete type whose mapped property base_type differs from the
//     interface property → validatePropertyMapping rejects TYPE_MISMATCH.
//   * One ambiguous interface-link scenario (two concrete link_types both
//     satisfy an interface_link_constraint → runtime creation rejects on
//     ambiguity).
//   * Relationships: a concrete many-to-many link, a foreign-key one-to-many
//     link, a one-to-one link, an interface-to-object link constraint, an
//     interface-to-interface link constraint, and an intentionally
//     incompatible link constraint.
//   * Five published-function rows (compatible single payload, compatible
//     list payload for side-effect fan-out, optional/null-suppressing,
//     incompatible, stale-version) with `function_kind='query'` and known
//     `signature.output` TS source-text the functionWebhookContract parser
//     accepts/rejects exactly as the directive enumerates.
//   * Six webhook_definition rows (one writeback + side-effects, with
//     nested/list/nullable/attachment inputs and nested typed output),
//     pointed at the deterministic controlled webhook service
//     (http://localhost:<CONTROLLED_WEBHOOK_PORT>, default 3329) so live
//     writeback/side-effect execution is exercised over the wire.
//
// Honest capability notes (from the BE map — do not fabricate):
//   * Interface shared properties CANNOT be `attachment` / `marking` /
//     `media_reference` / `timeseries` — the `interface_property.base_type`
//     CHECK excludes them. The directive's "shared attachment field where
//     supported" is therefore satisfied on the CONCRETE object types only
//     (each impl owns an `attachmentRef`) and as a WEBHOOK INPUT type
//     (attachment is a valid WebhookParameterType + function-return alias).
//   * `object_reference` is NOT a datatype — cross-object references go
//     through link_type only. The "object reference" / "interface reference"
//     / "object-type reference" are ACTION PARAMETER types, not property
//     base_types.
//   * Concrete link_type.apiName is camelCase-derived; interface_link_
//     constraint.apiName is UpperCamel. Both are globally unique per ontology.
//
// Isolation: every apiName carries `suffix` (a short stable tag, e.g. a test
// file basename hash). Creation is idempotent-ish (route returns 409 for
// collisions; the integration glue tolerates 409). Cleanup is route DELETE
// in dependency order (see IntegrationGlue.cleanup). No transaction-rollback
// hook exists; the route layer commits its own tx.
// ---------------------------------------------------------------------------

import { parsePublishedFunctionType, validateFunctionWebhookContract } from "../../src/actions/functionWebhookContract";
import type { WebhookParameterType } from "../../src/services/connectivity/webhooks/contracts";
import { CONNECTIVITY_WEBHOOK_RID_PREFIX } from "../../src/actions/writebackExecutor";

export const CANONICAL_ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";

export interface FixtureSpec {
  suffix: string;
  ontologyId: string;
  controlledBaseUrl: string;
  interface: {
    apiName: string;
    displayName: string;
    description: string;
    properties: Array<{
      apiName: string;
      displayName: string;
      baseType: string;
      isRequired: boolean;
      structSchema?: Record<string, unknown>;
    }>;
  };
  implementers: Array<{
    apiName: string;
    displayName: string;
    primaryKeyApiName: string;
    properties: Array<{
      apiName: string;
      displayName: string;
      baseType: string;
      isRequired: boolean;
      structSchema?: Record<string, unknown>;
    }>;
    propertyMapping: Record<string, string>;
    incompatible?: boolean;
  }>;
  links: Array<{
    apiName: string;
    displayName: string;
    cardinality: "ONE_TO_ONE" | "ONE_TO_MANY" | "MANY_TO_MANY";
    sourceObjectTypeApiName: string;
    targetObjectTypeApiName: string;
    targetPropertyApiName?: string;
    incompatible?: boolean;
  }>;
  interfaceLinkConstraints: Array<{
    apiName: string;
    displayName: string;
    interfaceApiName: string;
    targetInterfaceApiName?: string | null;
    targetObjectTypeApiName?: string | null;
    cardinality: "ONE_TO_ONE" | "ONE_TO_MANY" | "MANY_TO_MANY";
    status: "draft" | "active";
    incompatible?: boolean;
  }>;
  functions: Array<{
    rid: string;
    repositoryRid: string;
    apiName: string;
    branch: string;
    semver: string;
    functionKind: "query" | "edit";
    // TS source-text the functionWebhookContract parser evaluates.
    signatureOutput: string;
    signatureParameters: Array<{ name: string; type: string; optional?: boolean }>;
    available: boolean; // function_version.state = 'AVAILABLE' vs 'YANKED' (stale fixture)
    label: "compatible-single" | "compatible-list" | "nullable" | "incompatible" | "stale-version";
  }>;
  webhooks: Array<{
    name: string;
    method: "POST" | "PUT";
    endpointConfig: { url: string; followRedirects: boolean };
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown> | null;
    authenticationConfig: Record<string, unknown>;
    timeoutMs: number;
    maxResponseBytes: number;
    kind: "writeback" | "side-effect";
    label: string;
  }>;
}

// ---------------------------------------------------------------------------
// Build the spec.
// ---------------------------------------------------------------------------

export function buildCommercialEntityFixture(suffix: string, opts?: { controlledPort?: number }): FixtureSpec {
  const port = opts?.controlledPort ?? Number(process.env.CONTROLLED_WEBHOOK_PORT ?? 3329);
  const controlledBaseUrl = `http://localhost:${port}`;
  const s = (base: string) => `${base}${suffix}`;

  // The struct_schema is stored as an ARRAY of {id, required, fieldType}
  // (see src/utils/structValidator.validateStructSchema). Nested structs use
  // a nested array as the fieldType up to depth 3.
  const contactDetailsStruct = [
    { fieldName: "phone", required: true, fieldType: "string" },
    { fieldName: "email", required: true, fieldType: "string" },
    { fieldName: "addressLine", required: false, fieldType: "string" },
  ];

  const interfaceApiName = s("CommercialEntity");

  const interfaceProperties = [
    { apiName: "entityId", displayName: "Entity ID", baseType: "string", isRequired: true },
    { apiName: "displayName", displayName: "Display Name", baseType: "string", isRequired: true },
    { apiName: "status", displayName: "Status", baseType: "string", isRequired: true },
    { apiName: "createdAt", displayName: "Created At", baseType: "timestamp", isRequired: true },
    { apiName: "tags", displayName: "Tags", baseType: "string_array", isRequired: false },
    { apiName: "contactDetails", displayName: "Contact Details", baseType: "struct", isRequired: true, structSchema: contactDetailsStruct },
    { apiName: "notes", displayName: "Notes", baseType: "string", isRequired: false },
    { apiName: "rating", displayName: "Rating", baseType: "integer", isRequired: false },
  ];

  // Concrete implementers — shared props mapped 1:1 with EXACT base_type
  // equality (interfaceValidator uses strict equality, not widening).
  const sharedConcreteProps = (pkName: string, extra: Array<{ apiName: string; displayName: string; baseType: string; isRequired: boolean; structSchema?: Record<string, unknown> }>) => [
    { apiName: pkName, displayName: "Entity ID", baseType: "string", isRequired: true },
    { apiName: "displayName", displayName: "Display Name", baseType: "string", isRequired: true },
    { apiName: "status", displayName: "Status", baseType: "string", isRequired: true },
    { apiName: "createdAt", displayName: "Created At", baseType: "timestamp", isRequired: true },
    { apiName: "tags", displayName: "Tags", baseType: "string_array", isRequired: false },
    { apiName: "contactDetails", displayName: "Contact Details", baseType: "struct", isRequired: true, structSchema: contactDetailsStruct },
    { apiName: "notes", displayName: "Notes", baseType: "string", isRequired: false },
    { apiName: "rating", displayName: "Rating", baseType: "integer", isRequired: false },
    ...extra,
  ];

  const fullMapping: Record<string, string> = {
    entityId: "entityId",
    displayName: "displayName",
    status: "status",
    createdAt: "createdAt",
    tags: "tags",
    contactDetails: "contactDetails",
    notes: "notes",
    rating: "rating",
  };

  const implementers = [
    {
      apiName: s("CustomerAccount"),
      displayName: "Customer Account",
      primaryKeyApiName: "entityId",
      properties: sharedConcreteProps("entityId", [
        { apiName: "attachmentRef", displayName: "Attachment Ref", baseType: "attachment", isRequired: false },
        { apiName: "loyaltyPoints", displayName: "Loyalty Points", baseType: "integer", isRequired: false },
      ]),
      propertyMapping: fullMapping,
    },
    {
      apiName: s("SupplierAccount"),
      displayName: "Supplier Account",
      primaryKeyApiName: "entityId",
      properties: sharedConcreteProps("entityId", [
        { apiName: "attachmentRef", displayName: "Attachment Ref", baseType: "attachment", isRequired: false },
        { apiName: "creditLimit", displayName: "Credit Limit", baseType: "double", isRequired: false },
      ]),
      propertyMapping: fullMapping,
    },
    // Intentionally incompatible implementer: `status` (interface base_type
    // string) is mapped to a `boolean` concrete property → the validator's
    // strict base_type equality check rejects this with TYPE_MISMATCH.
    {
      apiName: s("IncompatibleAccount"),
      displayName: "Incompatible Account",
      primaryKeyApiName: "entityId",
      properties: sharedConcreteProps("entityId", []).map((p) =>
        p.apiName === "status" ? { ...p, baseType: "boolean" } : p,
      ),
      propertyMapping: { ...fullMapping },
      incompatible: true,
    },
  ];

  const links = [
    // Concrete many-to-many: CustomerAccount <-> SupplierAccount
    {
      apiName: s("customerSuppliers"),
      displayName: "Customer Suppliers",
      cardinality: "MANY_TO_MANY" as const,
      sourceObjectTypeApiName: s("CustomerAccount"),
      targetObjectTypeApiName: s("SupplierAccount"),
    },
    // Foreign-key one-to-many: CustomerAccount (one) -> SupplierAccount (many)
    // via a FK property on the target (SupplierAccount.fkCustomer).
    {
      apiName: s("customerOwnsSuppliers"),
      displayName: "Customer Owns Suppliers",
      cardinality: "ONE_TO_MANY" as const,
      sourceObjectTypeApiName: s("CustomerAccount"),
      targetObjectTypeApiName: s("SupplierAccount"),
      targetPropertyApiName: s("fkCustomer"),
    },
    // One-to-one: CustomerAccount - SupplierAccount principal linkage
    {
      apiName: s("customerPrimarySupplier"),
      displayName: "Customer Primary Supplier",
      cardinality: "ONE_TO_ONE" as const,
      sourceObjectTypeApiName: s("CustomerAccount"),
      targetObjectTypeApiName: s("SupplierAccount"),
    },
  ];

  const interfaceLinkConstraints = [
    // Interface-to-interface link constraint (both sides polymorphic).
    {
      apiName: s("CommercialEntityLink"),
      displayName: "Commercial Entity Link",
      interfaceApiName: interfaceApiName,
      targetInterfaceApiName: interfaceApiName,
      targetObjectTypeApiName: null,
      cardinality: "MANY_TO_MANY" as const,
      status: "active" as const,
    },
    // Interface-to-object link constraint (self polymorphic, target fixed).
    {
      apiName: s("CommercialEntityToCustomer"),
      displayName: "Commercial Entity To Customer",
      interfaceApiName: interfaceApiName,
      targetInterfaceApiName: null,
      targetObjectTypeApiName: s("CustomerAccount"),
      cardinality: "ONE_TO_MANY" as const,
      status: "active" as const,
    },
    // Intentionally incompatible link constraint: target object type does
    // not implement the interface → runtime resolution rejects endpoint pairs.
    {
      apiName: s("CommercialEntityIncompatibleLink"),
      displayName: "Commercial Entity Incompatible Link",
      interfaceApiName: interfaceApiName,
      targetInterfaceApiName: null,
      targetObjectTypeApiName: s("SupplierAccount"),
      cardinality: "ONE_TO_ONE" as const,
      status: "active" as const,
      incompatible: true,
    },
  ];

  // Functions — five, all function_kind='query' for inputFunction binding.
  // Signature output is TS source-text parsed by parsePublishedFunctionType.
  const functions: FixtureSpec["functions"] = [
    {
      rid: `ri.function-registry.main.function.test-single-${suffix}`,
      repositoryRid: `ri.repository.main.test-${suffix}`,
      apiName: s("CompatibleSingleFunction"),
      branch: "main",
      semver: "1.0.0",
      functionKind: "query",
      signatureOutput: "{ receiptCode: string; totalAmount: number; confirmed: boolean }",
      signatureParameters: [{ name: "entityIdParam", type: "string" }],
      available: true,
      label: "compatible-single",
    },
    {
      rid: `ri.function-registry.main.function.test-list-${suffix}`,
      repositoryRid: `ri.repository.main.test-${suffix}`,
      apiName: s("CompatibleListFunction"),
      branch: "main",
      semver: "1.0.0",
      functionKind: "query",
      signatureOutput: "Array<{ itemCode: string; quantity: integer }>",
      signatureParameters: [{ name: "entityIdParam", type: "string" }],
      available: true,
      label: "compatible-list",
    },
    {
      rid: `ri.function-registry.main.function.test-nullable-${suffix}`,
      repositoryRid: `ri.repository.main.test-${suffix}`,
      apiName: s("NullableFunction"),
      branch: "main",
      semver: "1.0.0",
      functionKind: "query",
      // The function-return parser strips `undefined` (not `null`) and marks the
      // return nullable → this models the optional/null-suppressing function.
      signatureOutput: "{ value: string } | undefined",
      signatureParameters: [{ name: "entityIdParam", type: "string" }],
      available: true,
      label: "nullable",
    },
    {
      rid: `ri.function-registry.main.function.test-incompatible-${suffix}`,
      repositoryRid: `ri.repository.main.test-${suffix}`,
      apiName: s("IncompatibleFunction"),
      branch: "main",
      semver: "1.0.0",
      functionKind: "query",
      // A named reference the parser rejects (returns null) → contract invalid.
      signatureOutput: "SomeNamedThing",
      signatureParameters: [{ name: "entityIdParam", type: "string" }],
      available: true,
      label: "incompatible",
    },
    {
      rid: `ri.function-registry.main.function.test-stale-${suffix}`,
      repositoryRid: `ri.repository.main.test-${suffix}`,
      apiName: s("StaleVersionFunction"),
      branch: "main",
      semver: "0.9.0",
      functionKind: "query",
      signatureOutput: "{ receiptCode: string; totalAmount: number; confirmed: boolean }",
      signatureParameters: [{ name: "entityIdParam", type: "string" }],
      available: false, // function_version.state = 'YANKED' → stale-version fixture
      label: "stale-version",
    },
  ];

  const webhooks: FixtureSpec["webhooks"] = [
    // Writeback webhook — nested typed output, nested input.
    {
      name: s("CommercialWriteback"),
      method: "POST",
      endpointConfig: { url: `${controlledBaseUrl}/writeback/nested`, followRedirects: false },
      inputSchema: {
        type: "object",
        properties: {
          entityId: { type: "string" },
          contactDetails: { type: "object", properties: { phone: { type: "string" }, email: { type: "string" } } },
        },
        required: ["entityId"],
      },
      outputSchema: {
        type: "object",
        properties: { result: { type: "object", properties: { record: { type: "object", properties: { code: { type: "string" } } } } } },
      },
      authenticationConfig: { kind: "tellus_secret", ref: `test-writeback-${suffix}`, key: "apiToken" },
      timeoutMs: 5000,
      maxResponseBytes: 1024 * 1024,
      kind: "writeback",
      label: "writeback-nested",
    },
    // Side-effect webhook with list input (function fan-out).
    {
      name: s("CommercialSideEffectFanout"),
      method: "POST",
      endpointConfig: { url: `${controlledBaseUrl}/sideeffect/repeat?count=3`, followRedirects: false },
      inputSchema: { type: "object", properties: { itemCode: { type: "string" }, quantity: { type: "integer" } } },
      outputSchema: null,
      authenticationConfig: { kind: "tellus_secret", ref: `test-se-fanout-${suffix}`, key: "apiToken" },
      timeoutMs: 5000,
      maxResponseBytes: 1024 * 1024,
      kind: "side-effect",
      label: "side-effect-list",
    },
    // Side-effect webhook with nullable input.
    {
      name: s("CommercialSideEffectNullable"),
      method: "POST",
      endpointConfig: { url: `${controlledBaseUrl}/sideeffect/success`, followRedirects: false },
      inputSchema: { type: "object", properties: { value: { type: ["string", "null"] } } },
      outputSchema: null,
      authenticationConfig: { kind: "tellus_secret", ref: `test-se-nullable-${suffix}`, key: "apiToken" },
      timeoutMs: 5000,
      maxResponseBytes: 1024 * 1024,
      kind: "side-effect",
      label: "side-effect-nullable",
    },
    // Side-effect webhook with attachment input.
    {
      name: s("CommercialSideEffectAttachment"),
      method: "POST",
      endpointConfig: { url: `${controlledBaseUrl}/sideeffect/success`, followRedirects: false },
      inputSchema: {
        type: "object",
        properties: { attachment: { type: "object", properties: { filename: { type: "string" }, size: { type: "integer" } } } },
      },
      outputSchema: null,
      authenticationConfig: { kind: "tellus_secret", ref: `test-se-attachment-${suffix}`, key: "apiToken" },
      timeoutMs: 5000,
      maxResponseBytes: 1024 * 1024,
      kind: "side-effect",
      label: "side-effect-attachment",
    },
    // Side-effect webhook with plain success (second of the two required).
    {
      name: s("CommercialSideEffectSuccess"),
      method: "POST",
      endpointConfig: { url: `${controlledBaseUrl}/sideeffect/success`, followRedirects: false },
      inputSchema: { type: "object", properties: { entityId: { type: "string" } } },
      outputSchema: null,
      authenticationConfig: { kind: "tellus_secret", ref: `test-se-success-${suffix}`, key: "apiToken" },
      timeoutMs: 5000,
      maxResponseBytes: 1024 * 1024,
      kind: "side-effect",
      label: "side-effect-success",
    },
    // Writeback webhook with nullable + list + attachment inputs (covers the
    // directive's webhooks-with-nested/list/nullable/attachment-input variants).
    {
      name: s("CommercialWritebackRich"),
      method: "POST",
      endpointConfig: { url: `${controlledBaseUrl}/writeback/success`, followRedirects: false },
      inputSchema: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
          value: { type: ["string", "null"] },
          attachment: { type: "object", properties: { filename: { type: "string" }, size: { type: "integer" } } },
          nested: { type: "object", properties: { code: { type: "string" }, amount: { type: "number" }, flags: { type: "array", items: { type: "string" } } } },
        },
        required: ["nested"],
      },
      outputSchema: { type: "object", properties: { confirmed: { type: "boolean" }, ok: { type: "boolean" } } },
      authenticationConfig: { kind: "tellus_secret", ref: `test-writeback-2-${suffix}`, key: "apiToken" },
      timeoutMs: 5000,
      maxResponseBytes: 1024 * 1024,
      kind: "writeback",
      label: "writeback-rich",
    },
  ];

  return {
    suffix,
    ontologyId: CANONICAL_ONTOLOGY_ID,
    controlledBaseUrl,
    interface: { apiName: interfaceApiName, displayName: "Commercial Entity", description: "Two-implementation test interface", properties: interfaceProperties },
    implementers,
    links,
    interfaceLinkConstraints,
    functions,
    webhooks,
  };
}

// ---------------------------------------------------------------------------
// Pure validators — offline-provable correctness of the fixture contract:
// the function signatures parse the way the directive requires (compatible
// accepted; incompatible + stale rejected), and the webhook I/O surfaces
// carry the typed shapes the integration glue will bind.
// ---------------------------------------------------------------------------

export interface ParseVerdict {
  label: string;
  parsed: boolean;
  repeated: boolean;
  nullable: boolean;
}

/**
 * Classify each function's TS return signature the way functionWebhookContract
 * would. Compatible functions must parse; the incompatible named-type return
 * must NOT parse; the stale-version fixture parses structurally but is
 * rejected downstream by version-pin/availability (signalled by `available=false`).
 */
export function classifyFunctionSignatures(spec: FixtureSpec): ParseVerdict[] {
  return spec.functions.map((f) => {
    const parsed = parsePublishedFunctionType(f.signatureOutput);
    const kind = parsed?.type?.kind;
    return {
      label: f.label,
      parsed: parsed != null,
      repeated: kind === "list",
      // The parser sets `nullable` on the whole return when an `undefined`
      // union is stripped (the optional/null-suppressing function shape).
      nullable: (parsed as any)?.nullable === true,
    };
  });
}

/**
 * The single-payload function must parse as a non-list record; the list
 * function must parse as a list (repeated=true); the nullable function must
 * parse as a record with a nullable field; the incompatible function must NOT
 * parse at all. The stale-version function parses structurally (its rejection
 * is the YANKED version-pin, not the contract).
 */
export function assertFunctionContractsValid(spec: FixtureSpec): void {
  const byLabel = Object.fromEntries(classifyFunctionSignatures(spec).map((v) => [v.label, v]));
  if (!byLabel["compatible-single"]?.parsed) throw new Error("compatible-single function return did not parse");
  if (byLabel["compatible-single"]?.repeated) throw new Error("compatible-single must NOT be a list");
  if (!byLabel["compatible-list"]?.parsed || !byLabel["compatible-list"]?.repeated) throw new Error("compatible-list must parse as a list");
  if (!byLabel["nullable"]?.parsed) throw new Error("nullable function return did not parse");
  if (byLabel["incompatible"]?.parsed) throw new Error("incompatible function return MUST NOT parse (named type rejected)");
  if (!byLabel["stale-version"]?.parsed) throw new Error("stale-version function return must parse structurally (rejection is via YANKED version, not the contract)");
}

/**
 * Surface-A webhook_definition rows must each carry an endpoint_config.url
 * that targets the controlled service over HTTP to localhost (the
 * SSRF-safe dev-egress host), a JSON-Schema input_schema, and an
 * output_schema only for writeback webhooks (side-effects have null output).
 */
export function assertWebhookShapesValid(spec: FixtureSpec): void {
  for (const w of spec.webhooks) {
    if (!w.endpointConfig.url.startsWith(spec.controlledBaseUrl)) {
      throw new Error(`webhook ${w.name} endpoint must target the controlled service at ${spec.controlledBaseUrl}`);
    }
    if (!w.endpointConfig.url.startsWith("http://localhost")) {
      throw new Error(`webhook ${w.name} must use http://localhost (SSRF-safe dev host), got ${w.endpointConfig.url}`);
    }
    if (w.inputSchema.type !== "object") throw new Error(`webhook ${w.name} input_schema must be a JSON object schema`);
    if (w.kind === "writeback" && (w.outputSchema == null || w.outputSchema.type !== "object")) {
      throw new Error(`writeback webhook ${w.name} must carry a JSON object output_schema`);
    }
    if (w.kind === "side-effect" && w.outputSchema != null) {
      throw new Error(`side-effect webhook ${w.name} must have a null output_schema (response ignored)`);
    }
  }
}

/**
 * The five required functions cover every label the directive enumerates.
 */
export function assertFunctionsCovered(spec: FixtureSpec): void {
  const labels = new Set(spec.functions.map((f) => f.label));
  for (const required of ["compatible-single", "compatible-list", "nullable", "incompatible", "stale-version"]) {
    if (!labels.has(required as any)) throw new Error(`missing required function fixture: ${required}`);
  }
}

/**
 * The two concrete implementers must both map every required interface property
 * (the interfaceValidator's MISSING_REQUIRED_MAPPING gate), and the
 * incompatible implementer must diverge on a base_type (its TYPE_MISMATCH gate).
 */
export function assertImplementerMappingsValid(spec: FixtureSpec): void {
  const requiredInterfaceProps = spec.interface.properties.filter((p) => p.isRequired).map((p) => p.apiName);
  const compatibleImpls = spec.implementers.filter((i) => !i.incompatible);
  if (compatibleImpls.length < 2) throw new Error("fixture must have at least two compatible implementers");
  for (const impl of compatibleImpls) {
    for (const req of requiredInterfaceProps) {
      if (!(req in impl.propertyMapping)) throw new Error(`implementer ${impl.apiName} missing required mapping for ${req}`);
    }
  }
  const incompatible = spec.implementers.find((i) => i.incompatible);
  if (incompatible) {
    // status maps to a boolean-typed concrete prop (the divergence).
    const statusProp = incompatible.properties.find((p) => p.apiName === "status");
    const interfaceStatus = spec.interface.properties.find((p) => p.apiName === "status");
    if (!statusProp || !interfaceStatus || statusProp.baseType === interfaceStatus.baseType) {
      throw new Error("incompatible implementer must diverge on a base_type for a shared property");
    }
  }
}

export { parsePublishedFunctionType, validateFunctionWebhookContract, CONNECTIVITY_WEBHOOK_RID_PREFIX };
export type { WebhookParameterType };
