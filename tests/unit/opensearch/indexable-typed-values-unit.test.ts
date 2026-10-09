// Typed coercion for OpenSearch documents. Regression: a CSV-backed object
// type stored isfraud as "0"/"1"; the boolean mapper rejected every doc
// (6,353,307 of 6,353,307 failed) and the index stayed empty.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db", () => ({ query: vi.fn() }));

import {
  toIndexableProperties,
  toIndexablePropertyValue,
} from "../../../src/services/opensearch/syncFromInstances";

describe("toIndexablePropertyValue with a known base_type", () => {
  it("coerces boolean cells", () => {
    for (const v of ["1", "true", "TRUE", " yes ", "t", "Y", 1, true]) expect(toIndexablePropertyValue(v, "boolean")).toBe(true);
    for (const v of ["0", "false", "No", "f", "n", 0, false]) expect(toIndexablePropertyValue(v, "boolean")).toBe(false);
    expect(toIndexablePropertyValue("", "boolean")).toBeNull();
    expect(toIndexablePropertyValue("maybe", "boolean")).toBeNull();
    expect(toIndexablePropertyValue(null, "boolean")).toBeNull();
  });

  it("coerces numbers; unparseable cells become null instead of failing the doc", () => {
    expect(toIndexablePropertyValue("181.0", "double")).toBe(181);
    expect(toIndexablePropertyValue(" 2.5e3 ", "float")).toBe(2500);
    expect(toIndexablePropertyValue("9007199254740993", "long")).toBe("9007199254740993");
    expect(toIndexablePropertyValue("", "integer")).toBeNull();
    expect(toIndexablePropertyValue("N/A", "double")).toBeNull();
    expect(toIndexablePropertyValue(42, "long")).toBe(42);
  });

  it("coerces array elements", () => {
    expect(toIndexablePropertyValue(["1", "0", "x"], "boolean_array")).toEqual([true, false, null]);
    expect(toIndexablePropertyValue(["1.5", ""], "double_array")).toEqual([1.5, null]);
  });

  it("leaves strings and dates on the existing path", () => {
    expect(toIndexablePropertyValue("0", "string")).toBe("0");
    expect(toIndexablePropertyValue("2026-02-24 10:30:00", "timestamp")).toBe("2026-02-24T10:30:00.000Z");
    expect(toIndexablePropertyValue("2026-02-24 10:30:00")).toBe("2026-02-24T10:30:00.000Z");
  });
});

describe("toIndexableProperties", () => {
  it("uses the type map per key and keeps untyped keys unchanged", () => {
    const types = new Map([["isfraud", "boolean"], ["amount", "double"]]);
    expect(toIndexableProperties({ isfraud: "0", amount: "181.0", nameOrig: "C1", extra: "1" }, types)).toEqual({
      isfraud: false, amount: 181, nameOrig: "C1", extra: "1",
    });
    expect(toIndexableProperties({ isfraud: "0" })).toEqual({ isfraud: "0" });
  });
});
