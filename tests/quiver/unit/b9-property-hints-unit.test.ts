// B9 — Property-value hint cardinality bounds (B9 C-08).

import { describe, it, expect } from "vitest";
import {
  PROPERTY_HINT_NUMERIC_SAMPLE_CAP,
  PROPERTY_HINT_TOP_N_CAP,
  summarizeNumericProperty,
  summarizeStringProperty,
} from "../../../src/services/quiver/aip/propertyHints";

describe("B9 — property-value hints", () => {
  it("B9 C-08: top-N capped at 50 distinct values", () => {
    const values: string[] = [];
    for (let i = 0; i < 200; i++) values.push(`v-${i}`);
    const hint = summarizeStringProperty(values);
    expect(hint.kind).toBe("string");
    expect(hint.topValues.length).toBeLessThanOrEqual(PROPERTY_HINT_TOP_N_CAP);
    expect(hint.topValues.length).toBe(50);
    expect(hint.truncated).toBe(true);
  });

  it("B9 C-08: numeric sample capped at 1000", () => {
    const values = Array.from({ length: 5000 }, (_, i) => i);
    const hint = summarizeNumericProperty(values);
    expect(hint.kind).toBe("numeric");
    expect(hint.sampleSize).toBe(PROPERTY_HINT_NUMERIC_SAMPLE_CAP);
  });

  it("B9 C-08: small inputs not over-sampled (no PII leak via padding)", () => {
    const hint = summarizeStringProperty(["a", "b", "a", "c"]);
    expect(hint.topValues.length).toBe(3);
    expect(hint.truncated).toBe(false);
    expect(hint.topValues[0]).toEqual({ value: "a", count: 2 });
  });

  it("B9 C-08: numeric quantiles sorted", () => {
    const hint = summarizeNumericProperty([1, 5, 9, 2, 6, 4, 8, 3, 7]);
    expect(hint.min).toBe(1);
    expect(hint.max).toBe(9);
    expect(hint.q25 <= hint.q50).toBe(true);
    expect(hint.q50 <= hint.q75).toBe(true);
  });

  it("B9 C-08: empty numeric input throws", () => {
    expect(() => summarizeNumericProperty([])).toThrowError(/empty/);
  });
});
