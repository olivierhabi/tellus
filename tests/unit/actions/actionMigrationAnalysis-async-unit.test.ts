// ---------------------------------------------------------------------------
// Action Migration Analysis (async, schema-aware) — unit tests.
//
// Pure, no DB: the schema lookup is mocked. Covers the proposed-definition
// generation, parameter migration shaping, mixed-usage detection, primary-key
// base type loading, wire compatibility, and classification.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { analyzeActionTypeMigration } from "../../../src/actions/actionMigrationAnalysis";
import { hashActionDefinition } from "../../../src/actions/actionDefinitionHash";
import type { ObjectTypeSchemaLookup } from "../../../src/actions/objectReferenceResolver";

// Mocked schema lookup: returns a fixed PK definition per object type api name.
function mockLookup(
  map: Record<string, { apiName: string; baseType: string } | null>,
): ObjectTypeSchemaLookup {
  return async (_ontologyId, objectTypeApiName) => {
    const entry = map[objectTypeApiName];
    if (!entry) return null;
    return {
      propertyId: `pk-${objectTypeApiName}`,
      apiName: entry.apiName,
      baseType: entry.baseType,
    };
  };
}

const ONTOLOGY_ID = "ont-1";

describe("analyzeActionTypeMigration — proposed definition", () => {
  it("converts a primitive string used exclusively as object reference into a typed object_reference parameter", async () => {
    const r = await analyzeActionTypeMigration(
      {
        parameters: [{ apiName: "orderId", type: "string", required: true, displayName: "Order Id" }],
        rules: [
          {
            type: "modifyOrCreateObject",
            objectType: "OlivierOrderJune",
            objectReference: { source: "parameter", param: "orderId" },
            properties: {},
          },
        ],
      },
      { schemaLookup: mockLookup({ OlivierOrderJune: { apiName: "orderId", baseType: "string" } }), ontologyId: ONTOLOGY_ID },
    );
    expect(r.parameterMigrations).toHaveLength(1);
    const m = r.parameterMigrations[0];
    expect(m.parameterApiName).toBe("orderId");
    expect(m.fromType).toBe("string");
    expect(m.toType).toBe("object_reference");
    expect(m.objectType).toBe("OlivierOrderJune");
    expect(m.primaryKeyProperty).toBe("orderId");
    expect(m.primaryKeyBaseType).toBe("string");
    expect(m.wireCompatibility).toBe("compatible");
    expect(r.proposedDefinition).toBeDefined();
    const proposed = r.proposedDefinition!;
    expect(proposed.parameters[0]).toMatchObject({
      apiName: "orderId",
      type: "object_reference",
      objectType: "OlivierOrderJune",
      required: true,
      displayName: "Order Id",
    });
    // The rule's objectReference is unchanged when no rename was proposed.
    expect(proposed.rules[0].objectReference).toEqual({ source: "parameter", param: "orderId" });
  });

  it("attaches the correct target object type when multiple rules reference the same param", async () => {
    const r = await analyzeActionTypeMigration(
      {
        parameters: [{ apiName: "ref", type: "string" }],
        rules: [
          { type: "modifyObject", objectType: "Customer", objectReference: { source: "parameter", param: "ref" }, properties: {} },
          { type: "deleteObject", objectType: "Customer", objectReference: { source: "parameter", param: "ref" } },
        ],
      },
      { schemaLookup: mockLookup({ Customer: { apiName: "customerId", baseType: "string" } }), ontologyId: ONTOLOGY_ID },
    );
    expect(r.parameterMigrations).toHaveLength(1);
    expect(r.parameterMigrations[0].objectType).toBe("Customer");
  });

  it("loads the exact primary-key base type from the schema (never infers)", async () => {
    const r = await analyzeActionTypeMigration(
      {
        parameters: [{ apiName: "ref", type: "string" }],
        rules: [{ type: "modifyObject", objectType: "Event", objectReference: { source: "parameter", param: "ref" }, properties: {} }],
      },
      { schemaLookup: mockLookup({ Event: { apiName: "eventId", baseType: "long" } }), ontologyId: ONTOLOGY_ID },
    );
    expect(r.parameterMigrations[0].primaryKeyBaseType).toBe("long");
    expect(r.parameterMigrations[0].primaryKeyProperty).toBe("eventId");
  });

  it("classifies incompatible when the primary-key base type is unsupported", async () => {
    const r = await analyzeActionTypeMigration(
      {
        parameters: [{ apiName: "ref", type: "string" }],
        rules: [{ type: "modifyObject", objectType: "Blob", objectReference: { source: "parameter", param: "ref" }, properties: {} }],
      },
      { schemaLookup: mockLookup({ Blob: { apiName: "sha2", baseType: "binary" } }), ontologyId: ONTOLOGY_ID },
    );
    expect(r.classification).toBe("incompatible");
    expect(r.findings.some((f) => f.severity === "blocker" && /unsupported base type/.test(f.message))).toBe(true);
    expect(r.proposedDefinition).toBeUndefined();
  });

  it("classifies incompatible when one parameter corresponds to ambiguous object types", async () => {
    const r = await analyzeActionTypeMigration(
      {
        parameters: [{ apiName: "ref", type: "string" }],
        rules: [
          { type: "modifyObject", objectType: "Customer", objectReference: { source: "parameter", param: "ref" }, properties: {} },
          { type: "deleteObject", objectType: "Order", objectReference: { source: "parameter", param: "ref" } },
        ],
      },
      {
        schemaLookup: mockLookup({
          Customer: { apiName: "customerId", baseType: "string" },
          Order: { apiName: "orderId", baseType: "string" },
        }),
        ontologyId: ONTOLOGY_ID,
      },
    );
    expect(r.classification).toBe("incompatible");
    expect(r.findings.some((f) => f.severity === "blocker" && /different object types/.test(f.message))).toBe(true);
  });

  it("does not auto-mutate a shared parameter with mixed object-reference and scalar usage; proposes a renamed typed parameter instead", async () => {
    // ref is used as objectReference.param AND as scalar property mapping source.
    const r = await analyzeActionTypeMigration(
      {
        parameters: [{ apiName: "ref", type: "string" }],
        rules: [
          {
            type: "modifyObject",
            objectType: "Customer",
            objectReference: { source: "parameter", param: "ref" },
            properties: { auditNote: { source: "parameter", param: "ref" } },
          },
        ],
      },
      { schemaLookup: mockLookup({ Customer: { apiName: "customerId", baseType: "string" } }), ontologyId: ONTOLOGY_ID },
    );
    expect(r.classification).toBe("requires_review");
    const m = r.parameterMigrations[0];
    expect(m.proposedApiName).toBeTruthy();
    expect(m.proposedApiName).not.toBe("ref");
    // Proposed definition is NOT emitted when a rename is required AND a mixed
    // rename requires review (it is still mechanically derivable, but the
    // operator must acknowledge). The proposedDefinition IS produced here so
    // the operator can review it.
    expect(r.proposedDefinition).toBeDefined();
    const proposedParams = r.proposedDefinition!.parameters;
    // The original scalar parameter is preserved.
    expect(proposedParams.some((p) => p.apiName === "ref" && p.type === "string")).toBe(true);
    // A new typed parameter is added.
    const typed = proposedParams.find((p) => p.type === "object_reference");
    expect(typed).toBeDefined();
    expect(typed!.objectType).toBe("Customer");
    // The rule's objectReference is repointed to the new typed parameter.
    expect(r.proposedDefinition!.rules[0].objectReference).toEqual({
      source: "parameter",
      param: typed!.apiName,
    });
    // The scalar property mapping keeps referencing 'ref'.
    expect((r.proposedDefinition!.rules[0] as any).properties.auditNote).toEqual({
      source: "parameter",
      param: "ref",
    });
    expect(r.findings.some((f) => f.code === "MIXED_PARAMETER_USAGE")).toBe(true);
    expect(r.findings.some((f) => f.code === "PARAMETER_RENAMED")).toBe(true);
  });

  it("classifies incompatible when the target object type is missing from the schema lookup", async () => {
    const r = await analyzeActionTypeMigration(
      {
        parameters: [{ apiName: "ref", type: "string" }],
        rules: [{ type: "modifyObject", objectType: "Ghost", objectReference: { source: "parameter", param: "ref" }, properties: {} }],
      },
      { schemaLookup: mockLookup({}), ontologyId: ONTOLOGY_ID },
    );
    expect(r.classification).toBe("incompatible");
    expect(r.schemaVerified).toBe(false);
    expect(r.findings.some((f) => /Cannot resolve target object type/.test(f.message))).toBe(true);
  });

  it("classifies incompatible when the primary-key property is missing (null pkDef)", async () => {
    const lookup: ObjectTypeSchemaLookup = async () => null;
    const r = await analyzeActionTypeMigration(
      {
        parameters: [{ apiName: "ref", type: "string" }],
        rules: [{ type: "modifyObject", objectType: "Customer", objectReference: { source: "parameter", param: "ref" }, properties: {} }],
      },
      { schemaLookup: lookup, ontologyId: ONTOLOGY_ID },
    );
    expect(r.classification).toBe("incompatible");
    expect(r.schemaVerified).toBe(false);
  });
});

describe("analyzeActionTypeMigration — classification & delete policy", () => {
  it("classify requires_review when delete policy changes from legacy_unchecked to restrict", async () => {
    const r = await analyzeActionTypeMigration(
      {
        parameters: [{ apiName: "ref", type: "object_reference", objectType: "Customer" }],
        rules: [{ type: "deleteObject", objectType: "Customer", objectReference: { source: "parameter", param: "ref" } }],
      },
      { schemaLookup: mockLookup({ Customer: { apiName: "customerId", baseType: "string" } }), ontologyId: ONTOLOGY_ID },
    );
    expect(r.classification).toBe("requires_review");
    expect(r.deletePolicyChange).toBe("legacy_unchecked_to_restrict");
    expect(r.findings.some((f) => f.code === "DELETE_POLICY_CHANGED_TO_RESTRICT")).toBe(true);
  });

  it("classify compatible (eligible) when no delete behaviour and all checks pass", async () => {
    const r = await analyzeActionTypeMigration(
      {
        parameters: [{ apiName: "ref", type: "object_reference", objectType: "Customer" }],
        rules: [{ type: "modifyObject", objectType: "Customer", objectReference: { source: "parameter", param: "ref" }, properties: {} }],
      },
      { schemaLookup: mockLookup({ Customer: { apiName: "customerId", baseType: "string" } }), ontologyId: ONTOLOGY_ID },
    );
    expect(r.classification).toBe("compatible");
    expect(r.deletePolicyChange).toBeUndefined();
    expect(r.findings).toEqual([]);
  });

  it("wire compatibility is 'adapter_required' for boolean PK from a string caller", async () => {
    const r = await analyzeActionTypeMigration(
      {
        parameters: [{ apiName: "ref", type: "string" }],
        rules: [{ type: "modifyObject", objectType: "Flag", objectReference: { source: "parameter", param: "ref" }, properties: {} }],
      },
      { schemaLookup: mockLookup({ Flag: { apiName: "flagId", baseType: "boolean" } }), ontologyId: ONTOLOGY_ID },
    );
    expect(r.parameterMigrations[0].wireCompatibility).toBe("adapter_required");
    expect(r.classification).toBe("requires_review");
    expect(r.findings.some((f) => f.code === "ADAPTER_REQUIRED")).toBe(true);
  });
});

describe("hashActionDefinition", () => {
  it("produces a stable sha256 hex hash for equivalent inputs", () => {
    const a = hashActionDefinition({
      parameters: [{ apiName: "ref", type: "string" }],
      rules: [],
      semanticsVersion: 1,
      executionMode: "declarative",
      deletePolicy: "legacy_unchecked",
    });
    const b = hashActionDefinition({
      parameters: [{ apiName: "ref", type: "string" }],
      rules: [],
      semanticsVersion: 1,
      executionMode: "declarative",
      deletePolicy: "legacy_unchecked",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when parameters change", () => {
    const a = hashActionDefinition({
      parameters: [{ apiName: "ref", type: "string" }],
      rules: [],
      semanticsVersion: 1,
    });
    const b = hashActionDefinition({
      parameters: [{ apiName: "ref", type: "object_reference", objectType: "Customer" }],
      rules: [],
      semanticsVersion: 1,
    });
    expect(a).not.toBe(b);
  });

  it("treats undefined and null semanticsVersion equivalently", () => {
    const a = hashActionDefinition({ parameters: [], rules: [], semanticsVersion: undefined });
    const b = hashActionDefinition({ parameters: [], rules: [], semanticsVersion: null });
    expect(a).toBe(b);
  });
});
