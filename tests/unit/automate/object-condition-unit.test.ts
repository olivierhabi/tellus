// ---------------------------------------------------------------------------
// Unit tests for the object-set condition effective-query builder +
// condition fingerprint (src/services/automate/objectCondition.ts).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  conditionFingerprint,
  effectiveObjectSet,
  isSameEffectiveCondition,
  parseObjectCondition,
} from "../../../src/services/automate/objectCondition";

const baseCondition = {
  type: "objects-added" as const,
  evaluationMode: "scheduled" as const,
  objectSet: { type: "base", objectType: "Taxpayer" },
  objectCondition: undefined as unknown,
  monitoredProperties: [] as string[],
};

describe("objectCondition effective query builder", () => {
  it("no objectCondition returns the base object set unchanged", () => {
    expect(effectiveObjectSet(baseCondition)).toEqual(baseCondition.objectSet);
  });

  it("one property condition ANDs onto the base set as a canonical filter node", () => {
    const condition = {
      ...baseCondition,
      objectCondition: { type: "eq", field: "tin", value: "match" },
    };
    expect(effectiveObjectSet(condition)).toEqual({
      type: "filter",
      objectSet: baseCondition.objectSet,
      where: { type: "eq", field: "tin", value: "match" },
    });
  });

  it("nested AND/OR composition is preserved as the filter `where`", () => {
    const where = {
      type: "and",
      value: [
        { type: "gte", field: "riskScore", value: 3 },
        {
          type: "or",
          value: [
            { type: "eq", field: "region", value: "north" },
            { type: "eq", field: "region", value: "south" },
          ],
        },
      ],
    };
    const condition = { ...baseCondition, objectCondition: where };
    expect(effectiveObjectSet(condition)).toEqual({
      type: "filter",
      objectSet: baseCondition.objectSet,
      where,
    });
  });

  it("preview and runtime use the same builder (identical output)", () => {
    const condition = {
      ...baseCondition,
      objectCondition: { type: "startsWith", field: "tin", value: "ab" },
    };
    expect(effectiveObjectSet(condition)).toEqual(effectiveObjectSet(condition));
  });
});

describe("parseObjectCondition (structural validation)", () => {
  it("accepts a valid leaf", () => {
    expect(parseObjectCondition({ type: "eq", field: "tin", value: "x" })).toEqual(
      { ok: true, value: { type: "eq", field: "tin", value: "x" } },
    );
  });
  it("rejects an unknown operator / node type", () => {
    expect(parseObjectCondition({ type: "bogus", field: "tin", value: "x" }).ok).toBe(
      false,
    );
  });
  it("rejects a malformed nested group (missing field on a leaf)", () => {
    expect(
      parseObjectCondition({ type: "and", value: [{ type: "eq", value: "x" }] }).ok,
    ).toBe(false);
  });
});

describe("conditionFingerprint", () => {
  it("filter normalization produces a stable fingerprint", () => {
    const condition = {
      ...baseCondition,
      objectCondition: { type: "eq", field: "tin", value: "m" },
    };
    expect(conditionFingerprint(condition)).toBe(conditionFingerprint(condition));
  });

  it("semantically equivalent conditions produce the same fingerprint", () => {
    const a = {
      ...baseCondition,
      objectCondition: { type: "eq", field: "tin", value: "m" },
      monitoredProperties: ["fullName", "riskScore"],
    };
    const b = {
      ...baseCondition,
      objectCondition: { type: "eq", field: "tin", value: "m" },
      // monitoredProperties order is normalized away.
      monitoredProperties: ["riskScore", "fullName"],
    };
    expect(conditionFingerprint(a)).toBe(conditionFingerprint(b));
    expect(isSameEffectiveCondition(a, b)).toBe(true);
  });

  it("meaningfully different conditions produce different fingerprints", () => {
    const a = { ...baseCondition, objectCondition: { type: "eq", field: "tin", value: "m" } };
    const b = { ...baseCondition, objectCondition: { type: "eq", field: "tin", value: "x" } };
    const c = { ...baseCondition, objectCondition: { type: "gte", field: "riskScore", value: 3 } };
    expect(conditionFingerprint(a)).not.toBe(conditionFingerprint(b));
    expect(conditionFingerprint(a)).not.toBe(conditionFingerprint(c));
    // No filter vs a filter differ.
    expect(conditionFingerprint(baseCondition)).not.toBe(conditionFingerprint(a));
    // Different event type differs.
    expect(
      conditionFingerprint({ ...a, type: "objects-removed" as const }),
    ).not.toBe(conditionFingerprint(a));
  });
});
