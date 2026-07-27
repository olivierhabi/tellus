// ---------------------------------------------------------------------------
// Object Reference Resolver — pure unit tests for canonicalization,
// existence-policy checks, and primary-key coercion. No DB, no IO.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import {
  canonicalizeObjectReference,
  coercePrimaryKey,
  validateObjectExistence,
  assertObjectTypeMatch,
  PK_CAPABLE_BASE_TYPES,
  type ObjectTypeSchemaLookup,
  type ObjectStateReader,
  type ObjectIdentity,
  type PrimaryKeyValue,
} from "../../../src/actions/objectReferenceResolver";

// A schema lookup that returns a fixed PK definition per object type.
function mockLookup(
  map: Record<string, { apiName: string; baseType: string }>,
): ObjectTypeSchemaLookup {
  return async (_ontologyId, objectTypeApiName) => {
    const entry = map[objectTypeApiName];
    if (!entry) return null;
    return {
      propertyId: `pk-${objectTypeApiName}`,
      apiName: entry.apiName,
      baseType: entry.baseType,
    };
  };
}

const CTX = { ontologyId: "ont-1", branchId: "branch-1" };

describe("coercePrimaryKey — string/date/timestamp", () => {
  it("accepts a string raw value", () => {
    expect(coercePrimaryKey("string", "abc")).toEqual({ ok: true, value: "abc" });
  });
  it("coerces a finite number to string losslessly", () => {
    expect(coercePrimaryKey("string", 42)).toEqual({ ok: true, value: "42" });
  });
  it("coerces a boolean to string", () => {
    expect(coercePrimaryKey("string", true)).toEqual({ ok: true, value: "true" });
  });
  it("rejects objects/arrays", () => {
    expect(coercePrimaryKey("string", { a: 1 }).ok).toBe(false);
    expect(coercePrimaryKey("string", [1]).ok).toBe(false);
  });
  it("rejects null/undefined", () => {
    expect(coercePrimaryKey("string", null).ok).toBe(false);
    expect(coercePrimaryKey("string", undefined).ok).toBe(false);
  });
});

describe("coercePrimaryKey — integer/byte/short", () => {
  it("accepts a numeric raw value", () => {
    expect(coercePrimaryKey("integer", 42)).toEqual({ ok: true, value: 42 });
    expect(coercePrimaryKey("short", -7)).toEqual({ ok: true, value: -7 });
  });
  it("accepts a clean integer string", () => {
    expect(coercePrimaryKey("integer", "12")).toEqual({ ok: true, value: 12 });
  });
  it("rejects an ambiguous integer string (decimal, alpha)", () => {
    expect(coercePrimaryKey("integer", "12.5").ok).toBe(false);
    expect(coercePrimaryKey("integer", "12x").ok).toBe(false);
  });
  it("rejects non-integer numbers", () => {
    expect(coercePrimaryKey("integer", 12.5).ok).toBe(false);
  });
  it("rejects unsafe integers", () => {
    expect(coercePrimaryKey("integer", Number.MAX_SAFE_INTEGER + 1).ok).toBe(false);
  });
});

describe("coercePrimaryKey — long", () => {
  it("accepts an integer number in range", () => {
    expect(coercePrimaryKey("long", 42)).toEqual({ ok: true, value: 42 });
  });
  it("accepts a long integer string", () => {
    expect(coercePrimaryKey("long", "9223372036854775807")).toEqual({
      ok: true,
      value: "9223372036854775807", // preserved as string above MAX_SAFE_INTEGER
    });
  });
  it("rejects decimal long strings", () => {
    expect(coercePrimaryKey("long", "12.5").ok).toBe(false);
  });
  it("rejects out-of-range long", () => {
    const out = "9223372036854775808";
    expect(coercePrimaryKey("long", out).ok).toBe(false);
  });
});

describe("coercePrimaryKey — double/float/decimal", () => {
  it("accepts finite numbers", () => {
    expect(coercePrimaryKey("double", 1.5)).toEqual({ ok: true, value: 1.5 });
    expect(coercePrimaryKey("decimal", "3.14")).toEqual({ ok: true, value: 3.14 });
  });
  it("rejects non-finite (NaN/Infinity)", () => {
    expect(coercePrimaryKey("float", NaN).ok).toBe(false);
    expect(coercePrimaryKey("float", Infinity).ok).toBe(false);
    expect(coercePrimaryKey("double", "abc").ok).toBe(false);
  });
});

describe("coercePrimaryKey — boolean", () => {
  it("accepts a boolean raw value", () => {
    expect(coercePrimaryKey("boolean", true)).toEqual({ ok: true, value: true });
    expect(coercePrimaryKey("boolean", false)).toEqual({ ok: true, value: false });
  });
  it("accepts 'true'/'false'/0/1 string/number forms", () => {
    expect(coercePrimaryKey("boolean", "true")).toEqual({ ok: true, value: true });
    expect(coercePrimaryKey("boolean", 0)).toEqual({ ok: true, value: false });
  });
  it("rejects ambiguous strings", () => {
    expect(coercePrimaryKey("boolean", "yes").ok).toBe(false);
    expect(coercePrimaryKey("boolean", 2).ok).toBe(false);
  });
});

describe("coercePrimaryKey — non-PK base types rejected", () => {
  it("rejects struct/array/geo/marking", () => {
    expect(coercePrimaryKey("struct", "x").ok).toBe(false);
    expect(coercePrimaryKey("string_array", "x").ok).toBe(false);
    expect(coercePrimaryKey("geopoint", { lat: 1 }).ok).toBe(false);
    expect(coercePrimaryKey("marking", "mk").ok).toBe(false);
  });
  it("PK_CAPABLE_BASE_TYPES excludes composite types", () => {
    expect(PK_CAPABLE_BASE_TYPES.has("string")).toBe(true);
    expect(PK_CAPABLE_BASE_TYPES.has("long")).toBe(true);
    expect(PK_CAPABLE_BASE_TYPES.has("boolean")).toBe(true);
    expect(PK_CAPABLE_BASE_TYPES.has("struct")).toBe(false);
    expect(PK_CAPABLE_BASE_TYPES.has("string_array")).toBe(false);
  });
});

describe("canonicalizeObjectReference", () => {
  const lookup = mockLookup({
    Customer: { apiName: "customerId", baseType: "string" },
    Invoice: { apiName: "invoiceId", baseType: "long" },
  });

  it("returns a canonical identity for a valid string-PK reference", async () => {
    const r = await canonicalizeObjectReference(
      { apiName: "customerRef", type: "object_reference", objectType: "Customer" },
      "cust-1",
      CTX,
      { schemaLookup: lookup },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toEqual({
        ontologyId: "ont-1",
        branchId: "branch-1",
        objectType: "Customer",
        primaryKey: "cust-1" as unknown as PrimaryKeyValue, // string
      } as unknown as ObjectIdentity);
    }
  });

  it("coerces a long PK value losslessly", async () => {
    const r = await canonicalizeObjectReference(
      { apiName: "invoiceRef", type: "object_reference", objectType: "Invoice" },
      "9223372036854775807",
      CTX,
      { schemaLookup: lookup },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(typeof r.identity.primaryKey).toBe("string"); // preserved as string
  });

  it("rejects when the parameter has no objectType", async () => {
    const r = await canonicalizeObjectReference(
      { apiName: "ref", type: "object_reference" },
      "x",
      CTX,
      { schemaLookup: lookup },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_OBJECT_REFERENCE");
  });

  it("rejects when the object type does not exist in the ontology", async () => {
    const r = await canonicalizeObjectReference(
      { apiName: "ref", type: "object_reference", objectType: "Unknown" },
      "x",
      CTX,
      { schemaLookup: lookup },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_OBJECT_REFERENCE");
  });

  it("rejects lossy primary-key coercion with INVALID_PRIMARY_KEY", async () => {
    const r = await canonicalizeObjectReference(
      { apiName: "invoiceRef", type: "object_reference", objectType: "Invoice" },
      "12.5",
      CTX,
      { schemaLookup: lookup },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PRIMARY_KEY");
  });
});

describe("validateObjectExistence — policy matrix", () => {
  // A reader whose `exists` returns a fixed boolean per identity.
  function mockReader(present: Set<string>): ObjectStateReader {
    return {
      exists: async (identity: ObjectIdentity) => {
        return present.has(`${identity.objectType}:${identity.primaryKey}`);
      },
    };
  }

  const id = (objectType: string, pk: PrimaryKeyValue): ObjectIdentity => ({
    ontologyId: "ont-1",
    branchId: "branch-1",
    objectType,
    primaryKey: pk,
  });

  it("must_exist passes when present", async () => {
    const r = await validateObjectExistence(id("A", 1), "must_exist", mockReader(new Set(["A:1"])));
    expect(r.ok).toBe(true);
    expect(r.exists).toBe(true);
  });
  it("must_exist fails (OBJECT_NOT_FOUND) when absent", async () => {
    const r = await validateObjectExistence(id("A", 1), "must_exist", mockReader(new Set()));
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("OBJECT_NOT_FOUND");
  });
  it("must_not_exist passes when absent", async () => {
    const r = await validateObjectExistence(id("A", 1), "must_not_exist", mockReader(new Set()));
    expect(r.ok).toBe(true);
    expect(r.exists).toBe(false);
  });
  it("must_not_exist fails (OBJECT_ALREADY_EXISTS) when present", async () => {
    const r = await validateObjectExistence(id("A", 1), "must_not_exist", mockReader(new Set(["A:1"])));
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("OBJECT_ALREADY_EXISTS");
  });
  it("may_exist always passes (missing is NOT a failure)", async () => {
    const present = await validateObjectExistence(id("A", 1), "may_exist", mockReader(new Set(["A:1"])));
    const absent = await validateObjectExistence(id("A", 1), "may_exist", mockReader(new Set()));
    expect(present.ok).toBe(true);
    expect(absent.ok).toBe(true);
    expect(absent.exists).toBe(false);
  });
});

describe("assertObjectTypeMatch", () => {
  it("returns null when types match", () => {
    expect(assertObjectTypeMatch({ objectType: "A" }, "A", "rules[0]")).toBeNull();
  });
  it("returns OBJECT_TYPE_MISMATCH when types differ", () => {
    const e = assertObjectTypeMatch({ objectType: "B" }, "A", "rules[0]");
    expect(e).not.toBeNull();
    expect(e!.code).toBe("OBJECT_TYPE_MISMATCH");
  });
});
