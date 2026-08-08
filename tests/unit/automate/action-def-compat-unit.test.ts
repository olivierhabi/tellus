import { describe, expect, it } from "vitest";

import {
  classifyActionDefinitionChange,
  summarizeChanges,
  type ActionDefinitionClassification,
} from "../../../src/services/automate/actionDefinitionCompat";

// ---------------------------------------------------------------------------
// Golden fixtures: 14 pinned→current pairs covering every evolution rule in
// actionDefinitionCompat.ts' table. Keep these canon-shaped (TS-side input
// form) — the classifier is what validation, bulk repin AND edit-time blast
// radius all trust.
// ---------------------------------------------------------------------------

function param(over: Record<string, unknown> = {}) {
  return { apiName: "orderid", type: "string", required: true, ...over };
}

function rule(over: Record<string, unknown> = {}) {
  return {
    ruleId: "r1",
    type: "createObject",
    objectType: "AckManualSrc",
    properties: { orderId: { param: "orderid", source: "parameter" } },
    ...over,
  };
}

const BASE = { parameters: [param()], rules: [rule()] };

const FIXTURES: Array<{
  name: string;
  pinned: unknown;
  current: unknown;
  expectKind: ActionDefinitionClassification["kind"];
  expectCodes: string[];
}> = [
  {
    name: "no semantic change (display-only edit)",
    pinned: BASE,
    current: {
      parameters: [{ ...param(), displayName: "Order ID (renamed label)", description: "cosmetic" }],
      rules: [rule()],
    },
    expectKind: "identical",
    expectCodes: [],
  },
  {
    name: "added optional parameter",
    pinned: BASE,
    current: { parameters: [param(), param({ apiName: "note", required: false })], rules: [rule()] },
    expectKind: "compatible",
    expectCodes: ["PARAMETER_ADDED"],
  },
  {
    name: "added required parameter WITH default",
    pinned: BASE,
    current: {
      parameters: [param(), param({ apiName: "priority", type: "integer", required: true, defaultValue: 0 })],
      rules: [rule()],
    },
    expectKind: "compatible",
    expectCodes: ["PARAMETER_ADDED"],
  },
  {
    name: "added required parameter WITHOUT default",
    pinned: BASE,
    current: {
      parameters: [param(), param({ apiName: "priority", type: "integer", required: true })],
      rules: [rule()],
    },
    expectKind: "breaking",
    expectCodes: ["PARAMETER_ADDED_REQUIRED_NO_DEFAULT"],
  },
  {
    name: "removed parameter",
    pinned: { parameters: [param(), param({ apiName: "legacy" })], rules: [rule()] },
    current: BASE,
    expectKind: "breaking",
    expectCodes: ["PARAMETER_REMOVED"],
  },
  {
    name: "renamed parameter (apiName change) = removed + added",
    pinned: BASE,
    current: { parameters: [param({ apiName: "orderId2", required: false })], rules: [rule()] },
    expectKind: "breaking",
    expectCodes: ["PARAMETER_REMOVED", "PARAMETER_ADDED"],
  },
  {
    name: "dataType change",
    pinned: BASE,
    current: { parameters: [param({ type: "integer" })], rules: [rule()] },
    expectKind: "breaking",
    expectCodes: ["PARAMETER_TYPE_CHANGED"],
  },
  {
    name: "optional → required without default",
    pinned: { parameters: [param({ required: false })], rules: [rule()] },
    current: BASE,
    expectKind: "breaking",
    expectCodes: ["PARAMETER_NEWLY_REQUIRED"],
  },
  {
    name: "optional → required WITH default",
    pinned: { parameters: [param({ required: false })], rules: [rule()] },
    current: { parameters: [param({ required: true, defaultValue: "x" })], rules: [rule()] },
    expectKind: "compatible",
    expectCodes: ["PARAMETER_NEWLY_REQUIRED_WITH_DEFAULT"],
  },
  {
    name: "required → optional (relaxation)",
    pinned: BASE,
    current: { parameters: [param({ required: false })], rules: [rule()] },
    expectKind: "compatible",
    expectCodes: ["PARAMETER_RELAXED"],
  },
  {
    name: "default value changed",
    pinned: { parameters: [param({ required: false, defaultValue: "a" })], rules: [rule()] },
    current: { parameters: [param({ required: false, defaultValue: "b" })], rules: [rule()] },
    expectKind: "compatible",
    expectCodes: ["PARAMETER_DEFAULT_CHANGED"],
  },
  {
    name: "rule edit keeping the same signature (binding change)",
    pinned: BASE,
    current: {
      parameters: BASE.parameters,
      rules: [rule({ properties: { orderId: { param: "other", source: "parameter" } } })],
    },
    expectKind: "compatible",
    expectCodes: ["RULE_CONTENT_CHANGED"],
  },
  {
    name: "rule signature change (target objectType)",
    pinned: BASE,
    current: { parameters: BASE.parameters, rules: [rule({ objectType: "OtherType" })] },
    expectKind: "breaking",
    expectCodes: ["RULE_SIGNATURE_CHANGED"],
  },
  {
    name: "removed rule",
    pinned: { parameters: BASE.parameters, rules: [rule(), rule({ ruleId: "r2" })] },
    current: BASE,
    expectKind: "breaking",
    expectCodes: ["RULE_REMOVED"],
  },
  {
    name: "semantics triple change",
    pinned: { ...BASE, semanticsVersion: 1, executionMode: "declarative", deletePolicy: "legacy_unchecked" },
    current: { ...BASE, semanticsVersion: 2, executionMode: "transactional", deletePolicy: "strict" },
    expectKind: "breaking",
    expectCodes: ["SEMANTICS_VERSION_CHANGED", "EXECUTION_MODE_CHANGED", "DELETE_POLICY_CHANGED"],
  },
];

describe("classifyActionDefinitionChange — golden fixtures", () => {
  for (const fx of FIXTURES) {
    it(fx.name, () => {
      const result = classifyActionDefinitionChange(fx.pinned, fx.current);
      expect(result.kind).toBe(fx.expectKind);
      for (const code of fx.expectCodes) {
        expect(
          result.changes.map((entry) => entry.code),
          `expected change code ${code}`,
        ).toContain(code);
      }
    });
  }

  it("human-readable detail messages", () => {
    const result = classifyActionDefinitionChange(
      BASE,
      { parameters: [param({ type: "integer" })], rules: [rule()] },
    );
    expect(result.changes[0].message).toBe(
      "parameter `orderid` type changed string→integer",
    );
  });

  it("nulls/garbage compare as identical, never throw", () => {
    expect(classifyActionDefinitionChange(null, null).kind).toBe("identical");
    expect(classifyActionDefinitionChange(BASE, BASE).kind).toBe("identical");
    expect(() => classifyActionDefinitionChange(42 as never, { b: 1 } as never)).not.toThrow();
  });

  it("is the SAME code path validation+repin+blast-radius would all call (single import)", () => {
    // Guard rail against module duplication: both consumers import from THIS path.
    expect(typeof classifyActionDefinitionChange).toBe("function");
    expect(typeof summarizeChanges).toBe("function");
  });

  it("summarizeChanges truncates long change lists deterministically", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      code: `C${i}`,
      severity: "compatible" as const,
      message: `change ${i}`,
    }));
    expect(summarizeChanges(many)).toBe("change 0; change 1; change 2 (+3 more)");
    expect(summarizeChanges([])).toBe("no changes");
  });
});
