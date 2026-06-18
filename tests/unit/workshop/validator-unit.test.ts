// B02 — module schema validator + variable-graph compiler.
//
// Each test below cites the contract IDs from tasks/workshop/contracts.md.
// Per the brief, every contract must have a unit test that *fails when the
// contract is violated*, not a tautology that asserts presence.
//
// References:
//   - tasks/workshop/workshop-tasks.md §B02 acceptance.
//   - schemas/workshop-module-v4.json (single source of truth).

import { describe, expect, it } from "vitest";
import { validateModule } from "../../../src/services/workshop/validator";
import { WorkshopError } from "../../../src/services/workshop/errors";

// ---------------------------------------------------------------------------
// Fixture factory — produces a minimal valid module document. Each test
// mutates a copy to violate exactly one rule.
// ---------------------------------------------------------------------------
function baseModule(): Record<string, unknown> {
  return {
    schemaVersion: 4,
    displayName: "M",
    variables: [
      {
        id: "v_orderSet",
        type: "objectSet",
        definitionType: "objectSetDefinition",
        definition: {},
      },
    ],
    widgets: [
      {
        id: "w_table",
        type: "objectTable",
        config: {},
        inputs: { objectSet: "v_orderSet" },
        outputs: {},
      },
    ],
    sections: [
      {
        id: "s_root",
        layout: "rows",
        children: [{ kind: "widget", ref: "w_table" }],
      },
    ],
    layout: { rootSection: "s_root" },
  };
}

function expectThrowsWith(
  fn: () => void,
  errorName: string,
): WorkshopError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(WorkshopError);
    const err = e as WorkshopError;
    expect(err.errorName).toBe(errorName);
    return err;
  }
  throw new Error(`expected ${errorName} but no error was thrown`);
}

describe("B02 validateModule", () => {
  it("B02 C-02: minimal valid module passes and returns compiled artifact", () => {
    const result = validateModule(baseModule());
    expect(result.valid).toBe(true);
    expect(result.compiled.varGraph).toHaveLength(1);
    expect(result.compiled.varGraph[0].id).toBe("v_orderSet");
    expect(result.compiled.widgetTree).not.toBeNull();
  });

  it("B02: accepts layout.columnWidths (section column-width persistence)", () => {
    const m = baseModule();
    (m as { layout: Record<string, unknown> }).layout = {
      rootSection: "s_root",
      columnWidths: {
        "section-box": { mode: "flex", pxWidth: 300, flexValue: 1 },
        "section-page": { mode: "absolute", pxWidth: 333, flexValue: 1 },
      },
    };
    expect(validateModule(m).valid).toBe(true);
  });

  it("B02: accepts a partial columnWidths (single column)", () => {
    const m = baseModule();
    (m as { layout: Record<string, unknown> }).layout = {
      rootSection: "s_root",
      columnWidths: {
        "section-box": { mode: "absolute", pxWidth: 240, flexValue: 1 },
      },
    };
    expect(validateModule(m).valid).toBe(true);
  });

  it("B02: rejects a columnWidths entry with an invalid mode", () => {
    const m = baseModule();
    (m as { layout: Record<string, unknown> }).layout = {
      rootSection: "s_root",
      columnWidths: {
        "section-box": { mode: "bogus", pxWidth: 1, flexValue: 1 },
      },
    };
    expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:InvalidModuleSchema",
    );
  });

  it("B02: accepts columnWidths keyed by ARBITRARY section ids (tree sections, not just the two fixed columns)", () => {
    const m = baseModule();
    (m as { layout: Record<string, unknown> }).layout = {
      rootSection: "s_root",
      columnWidths: {
        "section-box": { mode: "absolute", pxWidth: 300, flexValue: 1 },
        s_top: { mode: "absolute", pxWidth: 240, flexValue: 1 },
        "section-1700000000000-1": { mode: "flex", pxWidth: 300, flexValue: 3 },
      },
    };
    expect(validateModule(m).valid).toBe(true);
  });

  it("B02: accepts the optional resizable flag on a width spec", () => {
    const m = baseModule();
    (m as { layout: Record<string, unknown> }).layout = {
      rootSection: "s_root",
      columnWidths: {
        s_top: { mode: "absolute", pxWidth: 200, flexValue: 1, resizable: true },
      },
    };
    expect(validateModule(m).valid).toBe(true);
  });

  it("B02: still strictly validates each spec's VALUE (unknown field rejected)", () => {
    const m = baseModule();
    (m as { layout: Record<string, unknown> }).layout = {
      rootSection: "s_root",
      columnWidths: {
        s_top: { mode: "flex", pxWidth: 1, flexValue: 1, bogusField: true },
      },
    };
    expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:InvalidModuleSchema",
    );
  });

  it("B02: rejects a non-boolean resizable", () => {
    const m = baseModule();
    (m as { layout: Record<string, unknown> }).layout = {
      rootSection: "s_root",
      columnWidths: {
        s_top: { mode: "flex", pxWidth: 1, flexValue: 1, resizable: "yes" },
      },
    };
    expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:InvalidModuleSchema",
    );
  });

  it("B02 C-01: malformed schema → InvalidModuleSchema", () => {
    const m = baseModule();
    delete (m as { schemaVersion?: unknown }).schemaVersion;
    expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:InvalidModuleSchema",
    );
  });

  it("B02 C-01: schemaVersion !== 4 rejected", () => {
    const m = { ...baseModule(), schemaVersion: 3 };
    expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:InvalidModuleSchema",
    );
  });

  it("B02 C-01: variable id violating regex rejected at schema layer", () => {
    const m = baseModule() as { variables: { id: string }[] };
    m.variables[0].id = "bad id";
    expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:InvalidModuleSchema",
    );
  });

  it("B02 C-04: duplicate variable IDs → DuplicateVariableId", () => {
    const m = baseModule() as { variables: unknown[] };
    m.variables.push({
      id: "v_orderSet",
      type: "objectSet",
      definitionType: "objectSetDefinition",
      definition: {},
    });
    const err = expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:DuplicateVariableId",
    );
    expect(err.parameters.duplicateId).toBe("v_orderSet");
  });

  it("B02 C-05: 2-node filter chain cycle → VariableGraphCycle with cyclePath", () => {
    // Phase-5 cycle: two filters reference each other via "Filter using a
    // variable" (D-11 allows objectSetFilter as constraint host).
    const m = baseModule() as Record<string, unknown>;
    m.variables = [
      {
        id: "v_filterA",
        type: "objectSetFilter",
        definitionType: "variableTransformation",
        definition: {},
        constraints: [
          { kind: "filterByVariable", filterVariableId: "v_filterB" },
        ],
      },
      {
        id: "v_filterB",
        type: "objectSetFilter",
        definitionType: "variableTransformation",
        definition: {},
        constraints: [
          { kind: "filterByVariable", filterVariableId: "v_filterA" },
        ],
      },
      {
        id: "v_set",
        type: "objectSet",
        definitionType: "objectSetDefinition",
        definition: {},
      },
    ];
    (m as { widgets: Record<string, unknown>[] }).widgets[0].inputs = {
      objectSet: "v_set",
    };
    const err = expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:VariableGraphCycle",
    );
    const path = err.parameters.cyclePath as string[];
    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path[0]).toBe(path[path.length - 1]);
    expect(path).toContain("v_filterA");
    expect(path).toContain("v_filterB");
  });

  it("B02 C-06: orphan widget reference → OrphanWidgetReference", () => {
    const m = baseModule() as { widgets: Record<string, unknown>[] };
    m.widgets.push({
      id: "w_orphan",
      type: "objectTable",
      config: {},
      inputs: { objectSet: "v_orderSet" },
      outputs: {},
    });
    const err = expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:OrphanWidgetReference",
    );
    expect(err.parameters.widgetId).toBe("w_orphan");
  });

  it("B02 C-07: dangling variable reference from widget input → DanglingVariableReference", () => {
    const m = baseModule() as { widgets: Record<string, unknown>[] };
    (m.widgets[0].inputs as Record<string, string>).objectSet = "v_does_not_exist";
    const err = expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:DanglingVariableReference",
    );
    expect(err.parameters.variableId).toBe("v_does_not_exist");
    expect(err.parameters.bindingPath).toBe(
      "widgets[w_table].inputs.objectSet",
    );
  });

  it("B02 C-07: dangling reference from filterByVariable constraint", () => {
    const m = baseModule() as { variables: Record<string, unknown>[] };
    (m.variables[0].constraints as unknown[]) = [
      { kind: "filterByVariable", filterVariableId: "v_missing" },
    ];
    expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:DanglingVariableReference",
    );
  });

  it("B02 C-07: dangling moduleInterface reference", () => {
    const m = baseModule() as Record<string, unknown>;
    m.moduleInterface = {
      variables: [
        { externalId: "in_set", variableId: "v_missing", required: true },
      ],
    };
    expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:DanglingVariableReference",
    );
  });

  it("B02 C-08: type mismatch — table input wired to objectSetFilter", () => {
    const m = baseModule() as {
      variables: Record<string, unknown>[];
      widgets: Record<string, unknown>[];
    };
    m.variables.push({
      id: "v_filter",
      type: "objectSetFilter",
      definitionType: "static",
      definition: {},
    });
    (m.widgets[0].inputs as Record<string, string>).objectSet = "v_filter";
    const err = expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:VariableTypeMismatch",
    );
    expect(err.parameters.expected).toBe("objectSet");
    expect(err.parameters.actual).toBe("objectSetFilter");
  });

  it("B02 C-08: filterByVariable kind requires objectSetFilter target", () => {
    const m = baseModule() as { variables: Record<string, unknown>[] };
    m.variables.push({
      id: "v_otherSet",
      type: "objectSet",
      definitionType: "objectSetDefinition",
      definition: {},
    });
    (m.variables[0].constraints as unknown[]) = [
      { kind: "filterByVariable", filterVariableId: "v_otherSet" },
    ];
    const err = expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:VariableTypeMismatch",
    );
    expect(err.parameters.expected).toBe("objectSetFilter");
    expect(err.parameters.actual).toBe("objectSet");
  });

  it("B02 C-09: duplicate external ID in moduleInterface → DuplicateExternalId", () => {
    const m = baseModule() as Record<string, unknown>;
    m.moduleInterface = {
      variables: [
        { externalId: "in_a", variableId: "v_orderSet", required: true },
        { externalId: "in_a", variableId: "v_orderSet", required: false },
      ],
    };
    const err = expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:DuplicateExternalId",
    );
    expect(err.parameters.externalId).toBe("in_a");
  });

  it("B02 C-09: external ID collides with promotedExternalIds", () => {
    const m = baseModule() as Record<string, unknown>;
    m.moduleInterface = {
      variables: [
        { externalId: "in_a", variableId: "v_orderSet", required: true },
      ],
    };
    m.routing = { promotedExternalIds: ["in_a"] };
    expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:DuplicateExternalId",
    );
  });

  it("B02 C-10: loop section with embeddedModuleRid but no interfaceMapping → EmbeddedModuleInterfaceUnsatisfied", () => {
    const m = baseModule() as { sections: Record<string, unknown>[] };
    m.sections.push({
      id: "s_loop",
      layout: "loop",
      loopConfig: { embeddedModuleRid: "ri.workshop.module:abc" },
      children: [],
    });
    (m.sections[0].children as Record<string, unknown>[]).push({
      kind: "section",
      ref: "s_loop",
    });
    expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:EmbeddedModuleInterfaceUnsatisfied",
    );
  });

  it("B02 C-11: active-object output bound to non-widgetOutput variable → VariableTypeMismatch on definitionType", () => {
    const m = baseModule() as {
      variables: Record<string, unknown>[];
      widgets: Record<string, unknown>[];
    };
    m.variables.push({
      id: "v_active",
      type: "object",
      definitionType: "static", // wrong — must be widgetOutput.
      definition: {},
    });
    (m.widgets[0].outputs as Record<string, string>).activeObject = "v_active";
    const err = expectThrowsWith(
      () => validateModule(m),
      "Tellus:Workshop:VariableTypeMismatch",
    );
    expect(err.parameters.expected).toBe("widgetOutput");
    expect(err.parameters.actual).toBe("static");
    expect(err.parameters.path).toContain("definitionType");
  });

  it("B02 C-12: events DO NOT participate in cycle detection (back-edges allowed)", () => {
    // Construct two variables linked by *events* (runtime back-edges) but
    // with no constraint cycle. The validator must accept this — the spec
    // §B02 acceptance is explicit: "events are allowed back-edges and
    // MUST NOT be treated as cycles."
    const m = baseModule() as { variables: Record<string, unknown>[] };
    m.variables.push({
      id: "v_filter",
      type: "objectSetFilter",
      definitionType: "static",
      definition: {},
      events: [{ source: "v_orderSet", action: "recompute" }],
    });
    m.variables[0].events = [
      { source: "v_filter", action: "recompute" },
    ];
    const result = validateModule(m);
    expect(result.valid).toBe(true);
  });

  it("B02 C-13: compiled varGraph is in topological order", () => {
    const m = baseModule() as { variables: Record<string, unknown>[] };
    // Chain: setC depends on filterB depends on setA depends on filterRoot.
    m.variables = [
      {
        id: "v_filterRoot",
        type: "objectSetFilter",
        definitionType: "static",
        definition: {},
      },
      {
        id: "v_setA",
        type: "objectSet",
        definitionType: "objectSetDefinition",
        definition: {},
        constraints: [
          { kind: "filterByVariable", filterVariableId: "v_filterRoot" },
        ],
      },
      {
        id: "v_filterB",
        type: "objectSetFilter",
        definitionType: "variableTransformation",
        definition: {},
      },
      {
        id: "v_setC",
        type: "objectSet",
        definitionType: "objectSetDefinition",
        definition: {},
        constraints: [
          { kind: "filterByVariable", filterVariableId: "v_filterB" },
        ],
      },
    ];
    (m as { widgets: Record<string, unknown>[] }).widgets[0].inputs = {
      objectSet: "v_setC",
    };

    const result = validateModule(m);
    const order = result.compiled.varGraph.map((n) => n.id);
    // Each node must appear before any node that depends on it.
    const indexOf = (id: string) => order.indexOf(id);
    for (const node of result.compiled.varGraph) {
      for (const dep of node.deps) {
        if (order.includes(dep)) {
          expect(indexOf(dep)).toBeLessThan(indexOf(node.id));
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Property-based cycle detection — per spec §E, F04 surfaces this risk most
// loudly, but the cycle detector lives in B02. Random DAGs must always
// topo-sort; random graphs with injected cycles must always be detected.
// ---------------------------------------------------------------------------

function randomDag(
  rng: () => number,
  nFilters: number,
  nSets: number,
): Record<string, unknown> {
  const variables: Record<string, unknown>[] = [];
  for (let i = 0; i < nFilters; i++) {
    variables.push({
      id: `v_f${i}`,
      type: "objectSetFilter",
      definitionType: i === 0 ? "static" : "variableTransformation",
      definition: {},
    });
  }
  for (let i = 0; i < nSets; i++) {
    // Each set may reference any *earlier* filter — strictly ascending
    // index dependency guarantees acyclicity.
    const refIdx = Math.floor(rng() * Math.max(1, nFilters));
    variables.push({
      id: `v_s${i}`,
      type: "objectSet",
      definitionType: "objectSetDefinition",
      definition: {},
      constraints: [
        { kind: "filterByVariable", filterVariableId: `v_f${refIdx}` },
      ],
    });
  }
  return {
    schemaVersion: 4,
    variables,
    widgets: [
      {
        id: "w_table",
        type: "objectTable",
        config: {},
        inputs: { objectSet: `v_s0` },
        outputs: {},
      },
    ],
    sections: [
      {
        id: "s_root",
        layout: "rows",
        children: [{ kind: "widget", ref: "w_table" }],
      },
    ],
    layout: { rootSection: "s_root" },
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("B02 property-based cycle detection", () => {
  it("B02 C-05: 200 random DAGs all topo-sort without false positives", () => {
    for (let seed = 0; seed < 200; seed++) {
      const rng = mulberry32(seed * 7919 + 1);
      const m = randomDag(rng, 5, 10);
      const r = validateModule(m);
      expect(r.valid).toBe(true);
      // Verify topological correctness.
      const order = r.compiled.varGraph.map((n) => n.id);
      for (const node of r.compiled.varGraph) {
        for (const dep of node.deps) {
          if (order.includes(dep)) {
            expect(order.indexOf(dep)).toBeLessThan(order.indexOf(node.id));
          }
        }
      }
    }
  });

  it("B02 C-05: injected filter cycles of varying length are always detected", () => {
    // For cycle lengths 2..8, build N filters in a ring (f0→f1→…→fk→f0) and
    // assert detection with a closed cyclePath. Per D-11 filterByVariable
    // host may be objectSetFilter, so this is type-valid yet cyclic.
    for (let cycleLen = 2; cycleLen <= 8; cycleLen++) {
      const filters: Record<string, unknown>[] = [];
      for (let i = 0; i < cycleLen; i++) {
        const next = (i + 1) % cycleLen;
        filters.push({
          id: `v_f${i}`,
          type: "objectSetFilter",
          definitionType: "variableTransformation",
          definition: {},
          constraints: [
            { kind: "filterByVariable", filterVariableId: `v_f${next}` },
          ],
        });
      }
      const m = baseModule() as Record<string, unknown>;
      (m as { variables: unknown[] }).variables = [
        ...filters,
        {
          id: "v_anchor",
          type: "objectSet",
          definitionType: "objectSetDefinition",
          definition: {},
        },
      ];
      (m as { widgets: Record<string, unknown>[] }).widgets[0].inputs = {
        objectSet: "v_anchor",
      };
      const err = expectThrowsWith(
        () => validateModule(m),
        "Tellus:Workshop:VariableGraphCycle",
      );
      const path = err.parameters.cyclePath as string[];
      expect(path.length).toBeGreaterThanOrEqual(2);
      expect(path[0]).toBe(path[path.length - 1]);
    }
  });
});
