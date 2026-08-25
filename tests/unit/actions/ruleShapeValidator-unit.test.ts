// ---------------------------------------------------------------------------
// Rule shape validator — pure canonical-rule validators.
//
// Pure unit (no DB): exercises `ruleShapeValidator.ts` — the canonical
// shape check for addLink/removeLink rules (incl. legacy `linkTypeApiName`
// alias) and the interface-link gate rules. Mirrors the canonical rule
// domain types in `actionRules.types.ts`.
//
// Run via: `pnpm vitest run --config vitest.unit.config.ts tests/unit/actions/ruleShapeValidator-unit.test.ts`
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import {
  validateConcreteLinkRuleShape,
  validateInterfaceLinkRuleShape,
  validateValueSourceShape,
  CANONICAL_VALUE_SOURCE_KINDS,
  isCanonicalActionRule,
  isConcreteLinkRule,
  isInterfaceLinkRule,
} from "../../../src/actions/ruleShapeValidator";

describe("validateConcreteLinkRuleShape — canonical addLink / removeLink", () => {
  it("accepts a canonical addLink rule", () => {
    expect(validateConcreteLinkRuleShape({
      type: "addLink",
      linkType: "taxpayerBusiness",
      sourceObject: { source: "parameter", param: "source", objectType: "Business" },
      targetObject: { source: "parameter", param: "target", objectType: "Taxpayer" },
    })).toEqual([]);
  });

  it("accepts a canonical removeLink rule", () => {
    expect(validateConcreteLinkRuleShape({
      type: "removeLink",
      linkType: "taxpayerBusiness",
      sourceObject: { source: "parameter", param: "source", objectType: "Business" },
      targetObject: { source: "parameter", param: "target", objectType: "Taxpayer" },
    })).toEqual([]);
  });

  it("accepts the legacy linkTypeApiName alias when linkType is absent", () => {
    // The 24 seeded addLink action types carry linkTypeApiName alongside
    // (or instead of) the canonical linkType. Both must still validate.
    expect(validateConcreteLinkRuleShape({
      type: "addLink",
      linkTypeApiName: "taxpayerBusiness",
      sourceObject: { source: "parameter", param: "source" },
      targetObject: { source: "parameter", param: "target" },
    })).toEqual([]);
  });

  it("rejects when neither linkType nor the legacy alias is set", () => {
    const errs = validateConcreteLinkRuleShape({
      type: "addLink",
      sourceObject: { source: "parameter", param: "source" },
      targetObject: { source: "parameter", param: "target" },
    });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes("linkType is required"))).toBe(true);
  });

  it("rejects an empty-string linkType", () => {
    const errs = validateConcreteLinkRuleShape({
      type: "addLink",
      linkType: "",
      sourceObject: { source: "parameter", param: "source" },
      targetObject: { source: "parameter", param: "target" },
    });
    expect(errs.some((e) => e.includes("linkType is required"))).toBe(true);
  });

  it("rejects a missing sourceObject", () => {
    const errs = validateConcreteLinkRuleShape({
      type: "addLink",
      linkType: "taxpayerBusiness",
      targetObject: { source: "parameter", param: "target" },
    });
    expect(errs.some((e) => e.includes("sourceObject is required"))).toBe(true);
  });

  it("rejects a missing targetObject", () => {
    const errs = validateConcreteLinkRuleShape({
      type: "addLink",
      linkType: "taxpayerBusiness",
      sourceObject: { source: "parameter", param: "source" },
    });
    expect(errs.some((e) => e.includes("targetObject is required"))).toBe(true);
  });

  it("rejects an array-shaped sourceObject", () => {
    const errs = validateConcreteLinkRuleShape({
      type: "addLink",
      linkType: "taxpayerBusiness",
      sourceObject: [{ source: "parameter", param: "source" }],
      targetObject: { source: "parameter", param: "target" },
    });
    expect(errs.some((e) => e.includes("sourceObject is required"))).toBe(true);
  });

  it("rejects with a structured 'must be an object' message when the rule itself is not an object", () => {
    const errs = validateConcreteLinkRuleShape("not an object");
    expect(errs).toEqual(["addLink/removeLink rule must be an object."]);
  });

  it("rejects with a 'type must be' message when the rule type is neither addLink nor removeLink", () => {
    const errs = validateConcreteLinkRuleShape({ type: "createObject" });
    expect(errs).toEqual(["type must be 'addLink' or 'removeLink'."]);
  });
});

describe("validateInterfaceLinkRuleShape — Phase 2 gate rules", () => {
  it("accepts a canonical createInterfaceLink rule", () => {
    expect(validateInterfaceLinkRuleShape({
      type: "createInterfaceLink",
      interfaceLinkConstraint: "BuyerSellerContract",
      interfaceId: "Buyer",
      source: { source: "parameter", param: "buyer" },
      target: { source: "parameter", param: "seller" },
    })).toEqual([]);
  });

  it("accepts a canonical deleteInterfaceLink rule", () => {
    expect(validateInterfaceLinkRuleShape({
      type: "deleteInterfaceLink",
      interfaceLinkConstraint: "BuyerSellerContract",
      interfaceId: "Buyer",
      source: { source: "parameter", param: "buyer" },
      target: { source: "parameter", param: "seller" },
    })).toEqual([]);
  });

  it("rejects when interfaceLinkConstraint is missing", () => {
    const errs = validateInterfaceLinkRuleShape({
      type: "createInterfaceLink",
      interfaceId: "Buyer",
      source: { source: "parameter", param: "buyer" },
      target: { source: "parameter", param: "seller" },
    });
    expect(errs.some((e) => e.includes("interfaceLinkConstraint is required"))).toBe(true);
  });

  it("rejects when interfaceId is missing", () => {
    const errs = validateInterfaceLinkRuleShape({
      type: "createInterfaceLink",
      interfaceLinkConstraint: "BuyerSellerContract",
      source: { source: "parameter", param: "buyer" },
      target: { source: "parameter", param: "seller" },
    });
    expect(errs.some((e) => e.includes("interfaceId is required"))).toBe(true);
  });

  it("rejects when source/target are not ValueSource objects", () => {
    const errs = validateInterfaceLinkRuleShape({
      type: "createInterfaceLink",
      interfaceLinkConstraint: "BuyerSellerContract",
      interfaceId: "Buyer",
      source: "not an object",
      target: null,
    });
    expect(errs.some((e) => e.includes("source is required"))).toBe(true);
    expect(errs.some((e) => e.includes("target is required"))).toBe(true);
  });

  it("rejects with a 'must be an object' message when the rule itself is not an object", () => {
    const errs = validateInterfaceLinkRuleShape(42);
    expect(errs).toEqual(["createInterfaceLink/deleteInterfaceLink rule must be an object."]);
  });
});

describe("validateValueSourceShape — the canonical ValueSource union", () => {
  it("accepts parameter / static / currentTimestamp / currentUser / writebackResponse", () => {
    for (const source of CANONICAL_VALUE_SOURCE_KINDS) {
      const v =
        source === "parameter" ? { source, param: "p" } :
        source === "static" ? { source, value: "v" } :
        source === "writebackResponse" ? { source, outputId: "o" } :
        { source };
      expect(validateValueSourceShape(v, "p")).toEqual([]);
    }
  });

  it("rejects an unknown 'source' discriminant", () => {
    const errs = validateValueSourceShape({ source: "unknown", param: "p" }, "p");
    expect(errs[0]).toMatch(/source must be one of:/);
  });

  it("rejects parameter with missing/empty param", () => {
    expect(validateValueSourceShape({ source: "parameter" }, "p")[0]).toMatch(/requires a non-empty 'param' field/);
    expect(validateValueSourceShape({ source: "parameter", param: "" }, "p")[0]).toMatch(/requires a non-empty 'param' field/);
  });

  it("rejects writebackResponse with missing outputId", () => {
    expect(validateValueSourceShape({ source: "writebackResponse" }, "p")[0]).toMatch(/requires an 'outputId' field/);
  });

  it("rejects a non-object value source", () => {
    expect(validateValueSourceShape(null, "p")).toEqual(["p must be a value source object."]);
    expect(validateValueSourceShape(42, "p")).toEqual(["p must be a value source object."]);
    expect(validateValueSourceShape([], "p")).toEqual(["p must be a value source object."]);
  });
});

describe("Type-guard predicates", () => {
  it("isConcreteLinkRule recognises addLink/removeLink", () => {
    expect(isConcreteLinkRule({ type: "addLink", linkType: "x" })).toBe(true);
    expect(isConcreteLinkRule({ type: "removeLink", linkType: "x" })).toBe(true);
    expect(isConcreteLinkRule({ type: "createObject" })).toBe(false);
    expect(isConcreteLinkRule(null)).toBe(false);
  });

  it("isInterfaceLinkRule recognises createInterfaceLink/deleteInterfaceLink", () => {
    expect(isInterfaceLinkRule({ type: "createInterfaceLink" })).toBe(true);
    expect(isInterfaceLinkRule({ type: "deleteInterfaceLink" })).toBe(true);
    expect(isInterfaceLinkRule({ type: "addLink" })).toBe(false);
    expect(isInterfaceLinkRule(null)).toBe(false);
  });

  it("isCanonicalActionRule covers all 8 discriminators", () => {
    for (const t of ["createObject", "modifyObject", "modifyOrCreateObject", "deleteObject", "addLink", "removeLink", "createInterfaceLink", "deleteInterfaceLink"]) {
      expect(isCanonicalActionRule({ type: t })).toBe(true);
    }
    expect(isCanonicalActionRule({ type: "unknownRule" })).toBe(false);
    expect(isCanonicalActionRule(null)).toBe(false);
  });
});
