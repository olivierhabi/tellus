// =============================================================================
// B07 — Workshop Filter Compiler unit tests
//
// Per spec §B07 + §E (top-five risk: missing one combination breaks a widget
// silently): the COMPAT matrix between uiKind and property type is the
// single-source-of-truth fixture. Both compiler and these tests load from it
// — there is no chance of one drifting from the other.
//
// Contract IDs covered (per tasks/workshop/contracts.md §B07):
//   B07 C-01: All 11 uiKinds compile to expected predicate shape
//   B07 C-02: COMPAT matrix is exhaustive and enforced
//   B07 C-03: Empty filter list → matchAll
//   B07 C-04: Unknown property → Tellus:Workshop:UnknownFilterProperty 400
//   B07 C-05: type mismatch → Tellus:Workshop:UnsupportedFilterPropertyType 400
//   B07 C-06: Invalid value shape → Tellus:Workshop:InvalidFilterValue 400
//   B07 C-07: Cycle detection — Tellus:Workshop:CircularFilterReference 400
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  ALL_UI_KINDS,
  COMPAT,
  type CompileContext,
  compileFilter,
  compileFilters,
  type FilterUiKind,
  findFilterCycle,
  type FilterValueIn,
  assertNoFilterCycle,
  type PropertyType,
} from "../../../src/services/workshop/filterCompiler.js";
import { WorkshopError } from "../../../src/services/workshop/errors.js";

const SCHEMA: Record<string, PropertyType> = {
  itemName: "string",
  assignee: "string",
  customerId: "id",
  customerName: "string",
  daysUntilDue: "integer",
  customerNumeric: "long",
  orderDueDate: "date",
  orderId: "id",
  quantity: "integer",
  status: "string",
  unitPrice: "double",
  createdAt: "timestamp",
  isVip: "boolean",
};

const ctx: CompileContext = { properties: SCHEMA };

describe("B07 C-02: COMPAT matrix exhaustive", () => {
  it("declares every uiKind in ALL_UI_KINDS", () => {
    for (const k of ALL_UI_KINDS) {
      expect(COMPAT[k], `COMPAT missing ${k}`).toBeDefined();
      expect(COMPAT[k]!.length).toBeGreaterThan(0);
    }
    // No extra keys
    expect(Object.keys(COMPAT).sort()).toEqual([...ALL_UI_KINDS].sort());
  });
});

describe("B07 C-01: uiKind → predicate shape", () => {
  it("CONTAIN compiles to prefix predicates and never substring wildcards", () => {
    expect(compileFilter({
      uiKind: "id-multi",
      property: "orderId",
      operator: "contain",
      value: ["id0001"],
    }, ctx)).toEqual({ type: "prefix", field: "orderId", value: "id0001" });
  });

  it("supports NULL and negated NULL", () => {
    expect(compileFilter({
      uiKind: "string-multi",
      property: "assignee",
      operator: "null",
      value: [],
    }, ctx)).toEqual({ type: "isNull", field: "assignee" });
    expect(compileFilter({
      uiKind: "string-multi",
      property: "assignee",
      operator: "null",
      negated: true,
      value: [],
    }, ctx)).toEqual({ type: "not", clause: { type: "isNull", field: "assignee" } });
  });

  it("supports boolean filters and general negation", () => {
    expect(compileFilter({
      uiKind: "boolean-single",
      property: "isVip",
      negated: true,
      value: true,
    }, ctx)).toEqual({
      type: "not",
      clause: { type: "term", field: "isVip", value: true },
    });
  });
  it("string-eq with values → terms", () => {
    const p = compileFilter(
      { uiKind: "string-eq", property: "itemName", value: ["a", "b"] },
      ctx,
    );
    expect(p).toEqual({ type: "terms", field: "itemName", values: ["a", "b"] });
  });

  it("string-eq with empty array → matchAll", () => {
    const p = compileFilter(
      { uiKind: "string-eq", property: "itemName", value: [] },
      ctx,
    );
    expect(p).toEqual({ type: "matchAll" });
  });

  it("string-default with text → wildcard contains", () => {
    const p = compileFilter(
      { uiKind: "string-default", property: "customerName", value: "Acme" },
      ctx,
    );
    expect(p).toEqual({
      type: "wildcard",
      field: "customerName",
      value: "*Acme*",
    });
  });

  it("string-default with empty string → matchAll", () => {
    const p = compileFilter(
      { uiKind: "string-default", property: "customerName", value: "" },
      ctx,
    );
    expect(p).toEqual({ type: "matchAll" });
  });

  it("number-multi → terms with numbers", () => {
    const p = compileFilter(
      { uiKind: "number-multi", property: "customerNumeric", value: [1, 2, 3] },
      ctx,
    );
    expect(p).toEqual({
      type: "terms",
      field: "customerNumeric",
      values: [1, 2, 3],
    });
  });

  it("number-histogram → range", () => {
    const p = compileFilter(
      {
        uiKind: "number-histogram",
        property: "daysUntilDue",
        value: { gte: 0, lte: 90 },
      },
      ctx,
    );
    expect(p).toEqual({
      type: "range",
      field: "daysUntilDue",
      gte: 0,
      lte: 90,
    });
  });

  it("number-range with gt/lt", () => {
    const p = compileFilter(
      {
        uiKind: "number-range",
        property: "unitPrice",
        value: { gt: 9.99, lt: 100 },
      },
      ctx,
    );
    expect(p).toEqual({
      type: "range",
      field: "unitPrice",
      gt: 9.99,
      lt: 100,
    });
  });

  it("date-timeline { from, to } → range", () => {
    const p = compileFilter(
      {
        uiKind: "date-timeline",
        property: "orderDueDate",
        value: { from: "2026-01-01", to: "2026-12-31" },
      },
      ctx,
    );
    expect(p).toEqual({
      type: "range",
      field: "orderDueDate",
      gte: "2026-01-01",
      lte: "2026-12-31",
    });
  });

  it("date-timeline {} → matchAll", () => {
    const p = compileFilter(
      { uiKind: "date-timeline", property: "orderDueDate", value: {} },
      ctx,
    );
    expect(p).toEqual({ type: "matchAll" });
  });

  it("id-multi → terms", () => {
    const p = compileFilter(
      { uiKind: "id-multi", property: "orderId", value: ["o1", "o2"] },
      ctx,
    );
    expect(p).toEqual({
      type: "terms",
      field: "orderId",
      values: ["o1", "o2"],
    });
  });

  it("enum-multi over status → terms", () => {
    const p = compileFilter(
      { uiKind: "enum-multi", property: "status", value: ["new", "assigned"] },
      ctx,
    );
    expect(p).toEqual({
      type: "terms",
      field: "status",
      values: ["new", "assigned"],
    });
  });
});

describe("B07 C-03: empty filter list → matchAll", () => {
  it("compileFilters([]) is matchAll", () => {
    expect(compileFilters([], ctx)).toEqual({ type: "matchAll" });
  });
  it("compileFilters of all-empty → matchAll", () => {
    const filters: FilterValueIn[] = [
      { uiKind: "string-eq", property: "itemName", value: [] },
      { uiKind: "string-default", property: "customerName", value: "" },
    ];
    expect(compileFilters(filters, ctx)).toEqual({ type: "matchAll" });
  });
  it("two real filters → AND", () => {
    const filters: FilterValueIn[] = [
      { uiKind: "string-eq", property: "itemName", value: ["x"] },
      { uiKind: "enum-multi", property: "status", value: ["new"] },
    ];
    const p = compileFilters(filters, ctx);
    expect(p.type).toBe("and");
    if (p.type === "and") expect(p.clauses).toHaveLength(2);
  });
});

describe("B07 C-04: unknown property → 400", () => {
  it("throws UnknownFilterProperty", () => {
    expect(() =>
      compileFilter(
        { uiKind: "string-eq", property: "doesNotExist", value: ["x"] },
        ctx,
      ),
    ).toThrow(
      expect.objectContaining({
        errorName: "Tellus:Workshop:UnknownFilterProperty",
      }) as unknown as Error,
    );
  });
});

describe("B07 C-05: type mismatch → 400", () => {
  it.each([
    ["number-histogram", "itemName"], // numeric over string
    ["string-default", "daysUntilDue"], // string over numeric
    ["date-timeline", "itemName"], // date over string
    ["enum-multi", "daysUntilDue"], // enum over numeric
  ])(
    "%s on %s rejects with UnsupportedFilterPropertyType",
    (uiKind, prop) => {
      try {
        compileFilter(
          {
            uiKind: uiKind as FilterUiKind,
            property: prop,
            value: uiKind === "string-default" ? "x" : ["x"],
          },
          ctx,
        );
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(WorkshopError);
        expect((err as WorkshopError).errorName).toBe(
          "Tellus:Workshop:UnsupportedFilterPropertyType",
        );
        expect((err as WorkshopError).httpStatus).toBe(400);
      }
    },
  );
});

describe("B07 C-06: invalid value shape → 400", () => {
  it("string-eq with string value (not array)", () => {
    expect(() =>
      compileFilter(
        { uiKind: "string-eq", property: "itemName", value: "nope" },
        ctx,
      ),
    ).toThrow(
      expect.objectContaining({
        errorName: "Tellus:Workshop:InvalidFilterValue",
      }) as unknown as Error,
    );
  });
  it("number-multi with string elements", () => {
    expect(() =>
      compileFilter(
        { uiKind: "number-multi", property: "quantity", value: ["a", "b"] },
        ctx,
      ),
    ).toThrow(
      expect.objectContaining({
        errorName: "Tellus:Workshop:InvalidFilterValue",
      }) as unknown as Error,
    );
  });
  it("number-range with no bounds", () => {
    expect(() =>
      compileFilter(
        { uiKind: "number-range", property: "unitPrice", value: {} },
        ctx,
      ),
    ).toThrow(
      expect.objectContaining({
        errorName: "Tellus:Workshop:InvalidFilterValue",
      }) as unknown as Error,
    );
  });
});

describe("B07 C-07: cycle detection in filterByVariable graph", () => {
  it("self-loop → cycle path", () => {
    const graph = { edges: new Map<string, string[]>([["a", ["a"]]]) };
    expect(findFilterCycle("a", graph)).toEqual(["a", "a"]);
  });
  it("two-cycle a → b → a", () => {
    const graph = {
      edges: new Map<string, string[]>([
        ["a", ["b"]],
        ["b", ["a"]],
      ]),
    };
    expect(findFilterCycle("a", graph)).toEqual(["a", "b", "a"]);
  });
  it("acyclic → null", () => {
    const graph = {
      edges: new Map<string, string[]>([
        ["a", ["b"]],
        ["b", ["c"]],
        ["c", []],
      ]),
    };
    expect(findFilterCycle("a", graph)).toBeNull();
  });
  it("assertNoFilterCycle throws CircularFilterReference", () => {
    const graph = {
      edges: new Map<string, string[]>([
        ["a", ["b"]],
        ["b", ["a"]],
      ]),
    };
    try {
      assertNoFilterCycle("a", graph);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkshopError);
      expect((err as WorkshopError).errorName).toBe(
        "Tellus:Workshop:CircularFilterReference",
      );
      expect((err as WorkshopError).parameters["cycle"]).toEqual(["a", "b", "a"]);
    }
  });
  it("property-based: random rings always detected", () => {
    // Build random rings of length 2..8, each one must produce a cycle.
    for (let trial = 0; trial < 50; trial++) {
      const len = 2 + Math.floor(Math.random() * 7);
      const nodes = Array.from({ length: len }, (_, i) => `n${i}`);
      const edges = new Map<string, string[]>();
      for (let i = 0; i < len; i++) {
        edges.set(nodes[i]!, [nodes[(i + 1) % len]!]);
      }
      const cycle = findFilterCycle(nodes[0]!, { edges });
      expect(cycle).not.toBeNull();
      expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
    }
  });
});
