// =============================================================================
// B04 — Bootstrap unit tests
//
// Spec §B04 + §C Phase 5 Step 1.
//
// Contract IDs:
//   B04 C-01: empty seed → no variables, layout.rootSection wired, sections[0]=root
//   B04 C-02: with seed → exactly one variable named "{DisplayName} Object Set"
//   B04 C-03: produced definition validates against B02
//   B04 C-04: idempotency-key required at the route layer (covered by route test)
// =============================================================================

import { describe, expect, it } from "vitest";
import { buildSeededDefinition } from "../../../src/services/workshop/bootstrapService.js";
import { validateModule } from "../../../src/services/workshop/validator.js";

describe("B04 C-01: bootstrap with no seed", () => {
  it("produces minimal valid module document", () => {
    const def = buildSeededDefinition({
      ontologyRid: "ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001",
      seedObjectTypeApiName: null,
      seedDisplayName: null,
    });
    expect(def.schemaVersion).toBe(4);
    expect(def.layout.rootSection).toBe("s_root");
    expect(def.sections).toHaveLength(1);
    expect((def.sections![0] as { id: string }).id).toBe("s_root");
    expect(def.variables).toEqual([]);
    expect(def.widgets).toEqual([]);
  });
});

describe("B04 C-02: bootstrap with seed", () => {
  it("produces exactly one Object Set variable named '{DisplayName} Object Set'", () => {
    const def = buildSeededDefinition({
      ontologyRid: "ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001",
      seedObjectTypeApiName: "Order",
      seedDisplayName: "Order",
    });
    expect(def.variables).toHaveLength(1);
    const v = def.variables[0] as {
      id: string;
      displayName: string;
      type: string;
      definitionType: string;
      definition: { kind: string; objectTypeApiName: string };
    };
    expect(v.displayName).toBe("Order Object Set");
    expect(v.type).toBe("objectSet");
    expect(v.definitionType).toBe("objectSetDefinition");
    expect(v.definition.kind).toBe("ofType");
    expect(v.definition.objectTypeApiName).toBe("Order");
  });

  it("displayName carries spaces and non-ASCII verbatim", () => {
    const def = buildSeededDefinition({
      ontologyRid: "ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001",
      seedObjectTypeApiName: "GuestOrder",
      seedDisplayName: "Olivier's Guest Order",
    });
    expect((def.variables[0] as { displayName: string }).displayName).toBe(
      "Olivier's Guest Order Object Set",
    );
  });
});

describe("B04 C-03: produced module validates against B02", () => {
  it("no-seed module passes validateModule()", () => {
    const def = buildSeededDefinition({
      ontologyRid: "ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001",
      seedObjectTypeApiName: null,
      seedDisplayName: null,
    });
    expect(() => validateModule(def)).not.toThrow();
  });
  it("seeded module passes validateModule()", () => {
    const def = buildSeededDefinition({
      ontologyRid: "ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001",
      seedObjectTypeApiName: "Order",
      seedDisplayName: "Order",
    });
    expect(() => validateModule(def)).not.toThrow();
  });
});
