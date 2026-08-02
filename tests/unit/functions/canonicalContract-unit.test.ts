// ---------------------------------------------------------------------------
// canonicalSignature — canonical published contract unit tests.
//
// Covers: canonical type derivation (text + publish-time AST), legacy
// signature upgrade-on-read (position from array index), signature hashing,
// and upgrade-compatibility rules.
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import {
  canonicalTypeFromText,
  computeSignatureHash,
  isSignatureUpgradeCompatible,
  positionalParameters,
  readCanonicalSignature,
  runtimeParametersFromCanonical,
  TYPESCRIPT_V2_POSITIONAL_V2,
  LEGACY_OBJECT_ENVELOPE_V1,
  type CanonicalSignature,
} from "../../../src/services/functions/canonicalSignature";

describe("canonicalTypeFromText", () => {
  it.each([
    ["string", { kind: "string" }],
    ["boolean", { kind: "boolean" }],
    ["number", { kind: "double" }],
    ["Date", { kind: "date" }],
    ["Timestamp", { kind: "timestamp" }],
    ["Integer", { kind: "integer" }],
    ["Long", { kind: "long" }],
    ["Float", { kind: "float" }],
    ["Double", { kind: "double" }],
    ["string[]", { kind: "list", element: { kind: "string" } }],
    ["Array<boolean>", { kind: "list", element: { kind: "boolean" } }],
    [
      "Record<string, number>",
      { kind: "map", key: { kind: "string" }, value: { kind: "double" } },
    ],
    ["Client", { kind: "client" }],
  ])("maps %s", (text, expected) => {
    expect(canonicalTypeFromText(text)).toEqual(expected);
  });

  it("maps inline struct types recursively", () => {
    expect(canonicalTypeFromText("{ input: string; count?: number }")).toEqual({
      kind: "struct",
      fields: [
        { name: "input", type: { kind: "string" } },
        {
          name: "count",
          type: { kind: "optional", value: { kind: "double" }, allowsNull: false },
        },
      ],
    });
  });

  it("maps T | null to an optional wrapper that explicitly permits null", () => {
    expect(canonicalTypeFromText("string | null")).toEqual({
      kind: "optional",
      value: { kind: "string" },
      allowsNull: true,
    });
  });

  it("maps Osdk.Instance<T> to an ontology object reference", () => {
    expect(canonicalTypeFromText("Osdk.Instance<Employee>")).toEqual({
      kind: "ontologyObject",
      objectTypeApiName: "Employee",
    });
  });

  it("marks unmappable types unsupported (pass-through, never coerced)", () => {
    expect(canonicalTypeFromText("Mediaset")).toEqual({
      kind: "unsupported",
      typeText: "Mediaset",
    });
    expect(canonicalTypeFromText("string | number")).toMatchObject({
      kind: "unsupported",
    });
  });
});

describe("readCanonicalSignature — legacy upgrade-on-read", () => {
  it("upgrades pre-contract rows: position comes from the immutable array order", () => {
    const signature = readCanonicalSignature({
      parameters: [
        { name: "first", type: "string", optional: false },
        { name: "second", type: "number", optional: true },
      ],
      output: "string",
    });
    expect(signature).not.toBeNull();
    expect(positionalParameters(signature!).map((p) => [p.name, p.position])).toEqual([
      ["first", 0],
      ["second", 1],
    ]);
    expect(signature!.parameters[0].type).toEqual({ kind: "string" });
    expect(signature!.parameters[1].type).toEqual({ kind: "double" });
  });

  it("honours explicitly published positions over array order", () => {
    const signature = readCanonicalSignature({
      parameters: [
        {
          name: "b",
          position: 1,
          type: "string",
          optional: false,
          hasDefault: false,
          typeModel: { kind: "string" },
        },
        {
          name: "a",
          position: 0,
          type: "boolean",
          optional: false,
          hasDefault: false,
          typeModel: { kind: "boolean" },
        },
      ],
      output: "string",
    });
    expect(positionalParameters(signature!).map((p) => p.name)).toEqual(["a", "b"]);
  });

  it("accepts a zero-parameter signature", () => {
    const signature = readCanonicalSignature({ parameters: [], output: "string" });
    expect(signature).not.toBeNull();
    expect(signature!.parameters).toEqual([]);
  });

  it("returns null for absent/malformed metadata", () => {
    expect(readCanonicalSignature(null)).toBeNull();
    expect(readCanonicalSignature({})).toBeNull();
    expect(readCanonicalSignature({ parameters: "nope" })).toBeNull();
    expect(readCanonicalSignature({ parameters: [{ type: "string" }] })).toBeNull();
  });
});

describe("runtimeParametersFromCanonical", () => {
  it("marks only parameters whose PUBLISHED TYPE is Client as injected", () => {
    const signature = readCanonicalSignature({
      parameters: [
        { name: "client", type: "Client", optional: false },
        { name: "name", type: "string", optional: false },
      ],
      output: "string",
    });
    expect(runtimeParametersFromCanonical(signature)).toEqual([
      { name: "client", position: 0, optional: false, injected: "client" },
      { name: "name", position: 1, optional: false, injected: undefined },
    ]);
  });
});

describe("computeSignatureHash", () => {
  it("is deterministic and contract-sensitive", () => {
    const signature = readCanonicalSignature({
      parameters: [{ name: "name", type: "string", optional: false }],
      output: "string",
    })!;
    const a = computeSignatureHash(TYPESCRIPT_V2_POSITIONAL_V2, signature);
    const b = computeSignatureHash(TYPESCRIPT_V2_POSITIONAL_V2, signature);
    const c = computeSignatureHash(LEGACY_OBJECT_ENVELOPE_V1, signature);
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a).not.toBe(c);
  });
});

describe("isSignatureUpgradeCompatible", () => {
  const sig = (parameters: Array<Record<string, unknown>>, output = "string") =>
    readCanonicalSignature({ parameters, output })!;

  it("accepts identical signatures", () => {
    const v1 = sig([{ name: "name", type: "string", optional: false }]);
    expect(isSignatureUpgradeCompatible(v1, v1)).toBe(true);
  });

  it("accepts appending an OPTIONAL parameter", () => {
    const v1 = sig([{ name: "name", type: "string", optional: false }]);
    const v2 = sig([
      { name: "name", type: "string", optional: false },
      { name: "punctuation", type: "string", optional: true },
    ]);
    expect(isSignatureUpgradeCompatible(v1, v2)).toBe(true);
  });

  it("accepts appending a parameter with a default (hasDefault)", () => {
    const v1 = sig([{ name: "name", type: "string", optional: false }]);
    const v2 = sig([
      { name: "name", type: "string", optional: false },
      {
        name: "punctuation",
        position: 1,
        type: "string",
        optional: true,
        hasDefault: true,
      },
    ]);
    expect(isSignatureUpgradeCompatible(v1, v2)).toBe(true);
  });

  it("accepts required → optional relaxation of the same type", () => {
    const v1 = sig([{ name: "name", type: "string", optional: false }]);
    const v2 = sig([{ name: "name", type: "string", optional: true }]);
    expect(isSignatureUpgradeCompatible(v1, v2)).toBe(true);
  });

  it("rejects appending a REQUIRED parameter", () => {
    const v1 = sig([{ name: "name", type: "string", optional: false }]);
    const v2 = sig([
      { name: "name", type: "string", optional: false },
      { name: "punctuation", type: "string", optional: false },
    ]);
    expect(isSignatureUpgradeCompatible(v1, v2)).toBe(false);
  });

  it("rejects renaming a configured parameter", () => {
    const v1 = sig([{ name: "input", type: "string", optional: false }]);
    const v3 = sig([{ name: "marker", type: "string", optional: false }]);
    expect(isSignatureUpgradeCompatible(v1, v3)).toBe(false);
  });

  it("rejects removing a parameter", () => {
    const v1 = sig([
      { name: "a", type: "string", optional: false },
      { name: "b", type: "string", optional: false },
    ]);
    const v2 = sig([{ name: "a", type: "string", optional: false }]);
    expect(isSignatureUpgradeCompatible(v1, v2)).toBe(false);
  });

  it("rejects incompatible type changes", () => {
    const v1 = sig([{ name: "count", type: "number", optional: false }]);
    const v2 = sig([{ name: "count", type: "string", optional: false }]);
    expect(isSignatureUpgradeCompatible(v1, v2)).toBe(false);
  });

  it("rejects optional → required hardening", () => {
    const v1 = sig([{ name: "name", type: "string", optional: true }]);
    const v2 = sig([{ name: "name", type: "string", optional: false }]);
    expect(isSignatureUpgradeCompatible(v1, v2)).toBe(false);
  });

  it("rejects reordering (position mismatch)", () => {
    const v1 = sig([
      { name: "a", position: 0, type: "string", optional: false },
      { name: "b", position: 1, type: "string", optional: false },
    ]);
    const swapped: CanonicalSignature = {
      contractVersion: 2,
      parameters: [
        {
          name: "b",
          position: 0,
          type: { kind: "string" },
          typeText: "string",
          optional: false,
          hasDefault: false,
        },
        {
          name: "a",
          position: 1,
          type: { kind: "string" },
          typeText: "string",
          optional: false,
          hasDefault: false,
        },
      ],
      output: "string",
    };
    expect(isSignatureUpgradeCompatible(v1, swapped)).toBe(false);
  });
});
