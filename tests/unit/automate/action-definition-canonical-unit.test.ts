import { describe, expect, it } from "vitest";

import {
  canonicalizeActionDefinition,
  canonicalJsonString,
  extractRuleSignature,
} from "../../../src/actions/actionDefinitionCanonical";
import { hashActionDefinition } from "../../../src/actions/actionDefinitionHash";

describe("action definition canonicalization (pin identity)", () => {
  it("is stable across object key order", () => {
    const a = { parameters: [{ apiName: "x", type: "string", required: true }], rules: [] };
    const b = { rules: [], parameters: [{ required: true, type: "string", apiName: "x" }] };
    expect(hashActionDefinition(a)).toBe(hashActionDefinition(b));
  });

  it("is stable across parameter array order (sorted by apiName)", () => {
    const paramZ = { apiName: "zebra", type: "integer", required: false };
    const paramA = { apiName: "alpha", type: "string", required: true };
    expect(hashActionDefinition({ parameters: [paramZ, paramA], rules: [] }))
      .toBe(hashActionDefinition({ parameters: [paramA, paramZ], rules: [] }));
  });

  it("excludes display metadata from the hash", () => {
    const base = {
      parameters: [{ apiName: "x", type: "string", required: true, displayName: "X" }],
      rules: [],
    };
    const withNoise = {
      parameters: [
        {
          apiName: "x",
          type: "string",
          required: true,
          displayName: "Order identifier",
          description: "cosmetic",
          rid: "ri.actions.main.parameter.abc",
        },
      ],
      rules: [],
    };
    expect(hashActionDefinition(base)).toBe(hashActionDefinition(withNoise));
  });

  it("normalizes dataType case + whitespace", () => {
    const lower = { parameters: [{ apiName: "x", type: "string", required: true }], rules: [] };
    const noisy = { parameters: [{ apiName: "x", type: "  STRING  ", required: true }], rules: [] };
    expect(hashActionDefinition(lower)).toBe(hashActionDefinition(noisy));
  });

  it("is deterministic: same input hashed twice gives the identical hex", () => {
    const def = {
      parameters: [{ apiName: "orderid", type: "string", required: true }],
      rules: [
        {
          ruleId: "r1",
          type: "createObject",
          objectType: "AckManualSrc",
          properties: { orderId: { param: "orderid", source: "parameter" } },
        },
      ],
      semanticsVersion: 2,
      executionMode: "transactional",
      deletePolicy: "strict",
    };
    expect(hashActionDefinition(def)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashActionDefinition(def)).toBe(hashActionDefinition(def));
  });

  it("differs when a semantic field changes", () => {
    const def = () => ({
      parameters: [{ apiName: "x", type: "string", required: true }],
      rules: [],
    });
    expect(hashActionDefinition(def())).not.toBe(
      hashActionDefinition({ ...def(), executionMode: "transactional" }),
    );
  });

  it("canonicalize() of its own output is idempotent", () => {
    const once = canonicalizeActionDefinition({
      parameters: [{ apiName: "x", type: "string", required: true }],
      rules: [{ ruleId: "r1", type: "createObject", objectType: "T" }],
    });
    const twice = canonicalizeActionDefinition(once);
    expect(twice).toEqual(once);
  });

  it("canonicalJsonString sorts keys recursively", () => {
    expect(canonicalJsonString({ b: { y: 1, a: 2 }, a: 0 })).toBe(
      '{"a":0,"b":{"a":2,"y":1}}',
    );
  });

  it("rule signatures exclude bindings but keep identity + targets", () => {
    const sig = extractRuleSignature({
      ruleId: "r1",
      type: "createObject",
      objectType: "AckManualSrc",
      schemaVersion: 1,
      properties: { orderId: { param: "orderid", source: "parameter" } },
    });
    expect(sig).toEqual({ ruleId: "r1", objectType: "AckManualSrc", type: "createObject" });
  });

  it("never throws on garbage input", () => {
    for (const input of [null, undefined, 42, "x", {}, { parameters: "not-array" }]) {
      expect(() => hashActionDefinition(input as never)).not.toThrow();
    }
  });
});
