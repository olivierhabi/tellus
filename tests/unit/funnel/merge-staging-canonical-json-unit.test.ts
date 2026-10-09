// Regression: verifyStagedSample compared staged jsonb properties to the
// merged parquet with a raw JSON.stringify. Postgres jsonb re-orders object
// keys (shortest-first), so every CSV whose header was not already in jsonb
// key order (e.g. `id,name,qty` -> `id,qty,name`) failed the merge with
// "properties differ". canonicalJson must be key-order independent.
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/services/funnel/mergeStage";

describe("canonicalJson (merge staging sample comparison)", () => {
  it("is independent of object key order, including nested objects", () => {
    const parquet = { id: "1", name: "alpha", qty: "10", meta: { b: 1, a: [{ y: 2, x: 1 }] } };
    const jsonb = { id: "1", qty: "10", meta: { a: [{ x: 1, y: 2 }], b: 1 }, name: "alpha" };
    expect(JSON.stringify(parquet)).not.toBe(JSON.stringify(jsonb));
    expect(canonicalJson(parquet)).toBe(canonicalJson(jsonb));
  });

  it("still detects real value differences and array order differences", () => {
    expect(canonicalJson({ id: "1", qty: "10" })).not.toBe(canonicalJson({ id: "1", qty: "11" }));
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 1, b: null }));
  });

  it("handles scalars, null and undefined", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson("x")).toBe('"x"');
  });
});
