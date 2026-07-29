// ---------------------------------------------------------------------------
// Track 2 item #6 (structural signature compatibility) and item #10
// (shared isPreview predicate) — pure unit tests, no database.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  canonicalizeTypeText,
  compareSignaturesStructural,
  compareTypeTexts,
  normalizeSignature,
} from "../../../src/services/functionsPublish/signatureCompat";
import { isPreviewRelease, parseSemver } from "../../../src/services/functionsRegistry/semver";

const sig = (
  parameters: Array<{ name: string; type: string; optional: boolean }>,
  output: string,
) => ({ parameters, output });

describe("canonicalizeTypeText — formatting is not semantic", () => {
  it("whitespace-only generic change is compatible", () => {
    expect(canonicalizeTypeText("Osdk.Instance<Order>"))
      .toBe(canonicalizeTypeText("Osdk.Instance < Order >"));
    expect(compareTypeTexts("Osdk.Instance<Order>", "Osdk.Instance < Order >").kind)
      .toBe("equivalent");
  });

  it("parentheses-only change is compatible", () => {
    expect(compareTypeTexts("string | number", "(string | number)").kind).toBe("equivalent");
    expect(compareTypeTexts("((string))", "string").kind).toBe("equivalent");
  });

  it("comment-only change is compatible", () => {
    expect(compareTypeTexts("string /* primary id */", "string").kind).toBe("equivalent");
    expect(compareTypeTexts(
      "Array<Order> // the orders",
      "Array<Order>",
    ).kind).toBe("equivalent");
  });

  it("equivalent qualified type syntax is compatible", () => {
    expect(compareTypeTexts("Osdk.Instance<Ontology.Order>", "Osdk.Instance< Ontology.Order >").kind)
      .toBe("equivalent");
  });

  it("Array<T> and T[] canonicalize identically", () => {
    expect(compareTypeTexts("Array<string>", "string[]").kind).toBe("equivalent");
    expect(compareTypeTexts("ReadonlyArray<number>", "readonly number[]").kind).toBe("equivalent");
  });

  it("union formatting and member-order differences are compatible", () => {
    expect(compareTypeTexts("string | number", "number|string").kind).toBe("equivalent");
    expect(compareTypeTexts("A | B | C", "( C|A | B )").kind).toBe("equivalent");
  });

  it("string literal quote style is compatible", () => {
    expect(compareTypeTexts(`"a" | "b"`, `'a' | 'b'`).kind).toBe("equivalent");
  });

  it("object member order is compatible", () => {
    expect(compareTypeTexts("{ a: string; b: number }", "{ b: number; a: string }").kind)
      .toBe("equivalent");
  });
});

describe("compareTypeTexts — union variance", () => {
  it("genuine union-member addition is a widening", () => {
    const cmp = compareTypeTexts("string | number", "string | number | boolean");
    expect(cmp.kind).toBe("widened");
    expect((cmp as { added: string[] }).added).toEqual(["boolean"]);
  });

  it("genuine union-member removal is a narrowing", () => {
    const cmp = compareTypeTexts("string | number | boolean", "number | string");
    expect(cmp.kind).toBe("narrowed");
    expect((cmp as { removed: string[] }).removed).toEqual(["boolean"]);
  });

  it("collapsing a union to one member is a narrowing", () => {
    expect(compareTypeTexts("string | number", "string").kind).toBe("narrowed");
  });

  it("expanding to a union is a widening", () => {
    expect(compareTypeTexts("string", "string | number").kind).toBe("widened");
  });

  it("member swap is a change, not variance", () => {
    expect(compareTypeTexts("string | number", "string | boolean").kind).toBe("changed");
  });

  it("unresolvable/unparseable types fail conservatively with details", () => {
    const cmp = compareTypeTexts("Map<string,", "string");
    expect(cmp.kind).toBe("unparseable");
    expect((cmp as { side: string }).side).toBe("old");
    expect((cmp as { detail: string }).detail).toContain("parse");
  });

  it("different generic instantiations are changed", () => {
    expect(compareTypeTexts("Osdk.Instance<Order>", "Osdk.Instance<Customer>").kind).toBe("changed");
  });
});

describe("compareSignaturesStructural — documented rules", () => {
  it("identical signature is compatible", () => {
    expect(compareSignaturesStructural(
      sig([{ name: "input", type: "string", optional: false }], "string"),
      sig([{ name: "input", type: "string", optional: false }], "string"),
    )).toEqual([]);
  });

  it("formatting-only signature change is compatible (no burned version)", () => {
    expect(compareSignaturesStructural(
      sig([{ name: "input", type: "Osdk.Instance<Order>", optional: false }], "Array<string>"),
      sig([{ name: "input", type: "Osdk.Instance < Order >", optional: false }], "string[]"),
    )).toEqual([]);
  });

  it("parameter removal is breaking", () => {
    expect(compareSignaturesStructural(
      sig([{ name: "a", type: "string", optional: false }, { name: "b", type: "number", optional: true }], "string"),
      sig([{ name: "a", type: "string", optional: false }], "string"),
    )).toEqual(["dropped input b"]);
  });

  it("required parameter addition is breaking", () => {
    expect(compareSignaturesStructural(
      sig([{ name: "a", type: "string", optional: false }], "string"),
      sig([{ name: "a", type: "string", optional: false }, { name: "b", type: "number", optional: false }], "string"),
    )).toEqual(["added required input b"]);
  });

  it("optional parameter addition is compatible", () => {
    expect(compareSignaturesStructural(
      sig([{ name: "a", type: "string", optional: false }], "string"),
      sig([{ name: "a", type: "string", optional: false }, { name: "b", type: "number", optional: true }], "string"),
    )).toEqual([]);
  });

  it("parameter reordering is breaking (positional API)", () => {
    expect(compareSignaturesStructural(
      sig([{ name: "a", type: "string", optional: false }, { name: "b", type: "number", optional: false }], "string"),
      sig([{ name: "b", type: "number", optional: false }, { name: "a", type: "string", optional: false }], "string"),
    )[0]).toBe("reordered or changed input a");
  });

  it("input type narrowing is breaking", () => {
    expect(compareSignaturesStructural(
      sig([{ name: "input", type: "string | number", optional: false }], "string"),
      sig([{ name: "input", type: "string", optional: false }], "string"),
    )).toEqual(["reordered or changed input input"]);
  });

  it("input type widening is compatible (contravariant)", () => {
    expect(compareSignaturesStructural(
      sig([{ name: "input", type: "string", optional: false }], "string"),
      sig([{ name: "input", type: "string | number", optional: false }], "string"),
    )).toEqual([]);
  });

  it("return type widening/incompatibility is breaking", () => {
    expect(compareSignaturesStructural(
      sig([], "string"),
      sig([], "string | number"),
    )).toEqual(["output changed"]);
    expect(compareSignaturesStructural(sig([], "string"), sig([], "number")))
      .toEqual(["output changed"]);
  });

  it("return type narrowing is compatible (covariant)", () => {
    expect(compareSignaturesStructural(
      sig([], "string | number"),
      sig([], "string"),
    )).toEqual([]);
  });

  it("optional → required parameter is breaking", () => {
    expect(compareSignaturesStructural(
      sig([{ name: "a", type: "string", optional: true }], "string"),
      sig([{ name: "a", type: "string", optional: false }], "string"),
    )).toEqual(["input a became required"]);
  });

  it("required → optional parameter is compatible", () => {
    expect(compareSignaturesStructural(
      sig([{ name: "a", type: "string", optional: false }], "string"),
      sig([{ name: "a", type: "string", optional: true }], "string"),
    )).toEqual([]);
  });

  it("unparseable old type is breaking with actionable detail", () => {
    const lines = compareSignaturesStructural(
      sig([{ name: "a", type: "Map<string,", optional: false }], "string"),
      sig([{ name: "a", type: "string", optional: false }], "string"),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("could not be compared structurally");
    expect(lines[0]).toContain("input a");
  });
});

describe("normalizeSignature — persistence shape", () => {
  it("produces canonical types while preserving names and optionality", () => {
    expect(normalizeSignature(
      sig([{ name: "input", type: "Osdk.Instance < Order >", optional: true }], "( string | number )"),
    )).toEqual({
      parameters: [{ name: "input", type: "Osdk.Instance<Order>", optional: true }],
      output: "number | string",
    });
  });

  it("falls back to the raw text when a type does not parse", () => {
    const normalized = normalizeSignature(sig([], "Map<string,"));
    expect(normalized.output).toBe("Map<string,");
  });
});

describe("isPreviewRelease — single shared predicate (item #10)", () => {
  it("default branch with stable semver is not preview", () => {
    expect(isPreviewRelease("main", "main", "1.2.3")).toBe(false);
  });

  it("non-default branch is preview", () => {
    expect(isPreviewRelease("feature", "main", "1.2.3")).toBe(true);
  });

  it("prerelease on default branch is preview", () => {
    expect(isPreviewRelease("main", "main", "1.2.3-rc1")).toBe(true);
  });

  it("prerelease on non-default branch is preview", () => {
    expect(isPreviewRelease("feature", "main", "1.2.3-rc1")).toBe(true);
  });

  it("invalid semver preserves parseSemver error behavior", () => {
    expect(() => isPreviewRelease("main", "main", "not-a-version")).toThrow();
    expect(() => parseSemver("not-a-version")).toThrow();
  });
});
