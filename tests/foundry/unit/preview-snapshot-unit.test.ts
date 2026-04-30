// ---------------------------------------------------------------------------
// PB-B6 — preview-snapshot helpers (unit).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  canonicalStringify,
  hashTransformChain,
  fingerprintSchema,
  chainHashFromNodeConfig,
} from "../../../src/services/pipelines/previewSnapshot";

describe("canonicalStringify", () => {
  it("sorts object keys", () => {
    const a = canonicalStringify({ b: 2, a: 1 });
    const b = canonicalStringify({ a: 1, b: 2 });
    expect(a).toBe(b);
  });
  it("preserves array order", () => {
    expect(canonicalStringify([1, 2, 3])).not.toBe(canonicalStringify([3, 2, 1]));
  });
  it("strips undefined", () => {
    expect(canonicalStringify({ a: undefined, b: 1 })).toBe(`{"b":1}`);
  });
});

describe("hashTransformChain", () => {
  it("is stable across key order", () => {
    const h1 = hashTransformChain([
      { function: "Cast", expression: "amount", targetType: "numeric" },
    ]);
    const h2 = hashTransformChain([
      { targetType: "numeric", function: "Cast", expression: "amount" },
    ]);
    expect(h1).toBe(h2);
  });

  it("is sensitive to any meaningful edit", () => {
    const base = hashTransformChain([
      { function: "Cast", expression: "amount", targetType: "numeric" },
    ]);
    const flippedOp = hashTransformChain([
      { function: "Cast", expression: "amount", targetType: "integer" },
    ]);
    const addedStep = hashTransformChain([
      { function: "Cast", expression: "amount", targetType: "numeric" },
      { function: "Drop", columns: ["unused"] },
    ]);
    const reorderedSteps = hashTransformChain([
      { function: "Drop", columns: ["unused"] },
      { function: "Cast", expression: "amount", targetType: "numeric" },
    ]);
    expect(flippedOp).not.toBe(base);
    expect(addedStep).not.toBe(base);
    expect(reorderedSteps).not.toBe(base);
  });

  it("emits a 64-hex SHA-256 digest", () => {
    const h = hashTransformChain([{ function: "Drop", columns: ["a"] }]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("fingerprintSchema", () => {
  it("is sensitive to column order", () => {
    const a = fingerprintSchema([
      { name: "order_id", type: "integer" },
      { name: "status", type: "string" },
    ]);
    const b = fingerprintSchema([
      { name: "status", type: "string" },
      { name: "order_id", type: "integer" },
    ]);
    expect(a).not.toBe(b);
  });
  it("is sensitive to type changes", () => {
    const a = fingerprintSchema([{ name: "order_id", type: "integer" }]);
    const b = fingerprintSchema([{ name: "order_id", type: "string" }]);
    expect(a).not.toBe(b);
  });
});

describe("chainHashFromNodeConfig", () => {
  it("returns the hash of config.transforms", () => {
    const h1 = chainHashFromNodeConfig({
      transforms: [{ function: "Drop", columns: ["a"] }],
    });
    const h2 = hashTransformChain([{ function: "Drop", columns: ["a"] }]);
    expect(h1).toBe(h2);
  });
  it("handles missing transforms array gracefully", () => {
    const h = chainHashFromNodeConfig({});
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
