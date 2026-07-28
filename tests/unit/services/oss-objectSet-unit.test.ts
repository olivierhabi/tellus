// Unit tests: ObjectSet definition schema + compiler algebra.
import { describe, it, expect } from "vitest";
import {
  parseObjectSet,
  parseLoadObjectSetRequest,
  parseLoadObjectSetQuery,
  objectSetFingerprint,
  stableStringify,
} from "../../../src/services/oss/objectSetDefinition";
import { assertSupportedLoadObjectSetRequest } from "../../../src/services/oss/loadObjectSetContract";
import {
  compileObjectSet,
  searchJsonToWhere,
  compileRelativeDateRange,
  ObjectSetCompileError,
} from "../../../src/services/oss/objectSetCompiler";
import {
  createPageTokenV2,
  decodePageTokenV2,
  PageTokenError,
} from "../../../src/services/oss/pageTokenV2";
import {
  evaluateDerivedProperty,
} from "../../../src/services/oss/objectSetExecutor";
import {
  mintObjectRid,
  deterministicObjectRid,
  isObjectRid,
} from "../../../src/services/objectIdentity";

const NOW = new Date("2026-07-28T12:00:00Z");
const deps = { now: () => NOW };

describe("objectSetDefinition — schema", () => {
  it("accepts a base set", () => {
    const s = parseObjectSet({ type: "base", objectType: "Employee" });
    expect((s as { objectType: string }).objectType).toBe("Employee");
  });

  it("accepts all 15 verified node types", () => {
    const nodes = [
      { type: "base", objectType: "T" },
      { type: "filter", objectSet: { type: "base", objectType: "T" }, where: { type: "eq", field: "a", value: 1 } },
      { type: "reference", reference: "ri.object-set.main.versioned-object-set.x" },
      { type: "union", objectSets: [{ type: "base", objectType: "A" }, { type: "base", objectType: "B" }] },
      { type: "intersect", objectSets: [{ type: "base", objectType: "A" }, { type: "base", objectType: "A" }] },
      { type: "subtract", objectSets: [{ type: "base", objectType: "A" }, { type: "base", objectType: "A" }] },
      { type: "searchAround", objectSet: { type: "base", objectType: "A" }, link: "worksAt" },
      { type: "interfaceBase", interfaceType: "HasName" },
      { type: "asBaseObjectTypes", objectSet: { type: "interfaceBase", interfaceType: "I" } },
      { type: "asType", objectSet: { type: "interfaceBase", interfaceType: "I" }, entityType: "T" },
      { type: "nearestNeighbors", objectSet: { type: "base", objectType: "T" }, propertyIdentifier: { type: "property", apiName: "embedding" }, numNeighbors: 5, query: { type: "vector", value: [0.1, 0.2] } },
      { type: "withProperties", objectSet: { type: "base", objectType: "T" }, derivedProperties: { total: { type: "add", properties: [{ type: "getSelectedProperty", apiName: "a" }] } } },
      { type: "static", objects: ["ri.tellus.main.object.1"] },
      { type: "methodInput" },
      { type: "interfaceLinkSearchAround", objectSet: { type: "interfaceBase", interfaceType: "I" }, interfaceLink: "owns" },
    ];
    for (const n of nodes) {
      expect(() => parseObjectSet(n), n.type).not.toThrow();
    }
  });

  it("rejects invented operators (notIn/endsWith do not exist in v2)", () => {
    expect(() =>
      parseObjectSet({
        type: "filter",
        objectSet: { type: "base", objectType: "T" },
        where: { type: "notIn", field: "a", value: [1] },
      }),
    ).toThrow();
  });

  it("rejects excessive nesting depth", () => {
    let deep: unknown = { type: "base", objectType: "T" };
    for (let i = 0; i < 25; i++) {
      deep = { type: "filter", objectSet: deep, where: { type: "eq", field: "a", value: 1 } };
    }
    expect(() => parseObjectSet(deep)).toThrowError(/ObjectSetTooDeep/);
  });

  it("fingerprint is deterministic + order-insensitive for keys", () => {
    const a = objectSetFingerprint({ type: "base", objectType: "T" });
    expect(objectSetFingerprint({ type: "base", objectType: "T" })).toBe(a);
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it("validates v2 request envelopes", () => {
    const r = parseLoadObjectSetRequest({
      objectSet: { type: "base", objectType: "T" },
      pageSize: 50,
      excludeRid: true,
      snapshot: true,
    });
    expect(r.pageSize).toBe(50);
    expect(r.excludeRid).toBe(true);
  });

  it("validates every documented loadObjects query/body field", () => {
    const request = parseLoadObjectSetRequest({
      objectSet: { type: "base", objectType: "T" },
      orderBy: { orderType: "fields", fields: [{ field: "name", direction: "asc" }] },
      select: [],
      selectV2: [{ type: "property", apiName: "name" }],
      defaultLoadLevel: { type: "noLoadLevel" },
      pageToken: "token",
      pageSize: 20,
      excludeRid: true,
      loadPropertySecurities: false,
      snapshot: true,
      includeComputeUsage: true,
      referenceSigningOptions: { signMediaReferences: false },
    });
    const query = parseLoadObjectSetQuery({
      sdkPackageRid: "ri.foundry.main.sdk.a",
      sdkVersion: "1.0.0",
      branch: "dev",
      executeInMemoryOnly: "false",
    });
    expect(query.executeInMemoryOnly).toBe(false);
    expect(() => assertSupportedLoadObjectSetRequest(request, query)).not.toThrow();
  });

  it("rejects mutually populated select/selectV2 and unknown fields", () => {
    expect(() =>
      parseLoadObjectSetRequest({
        objectSet: { type: "base", objectType: "T" },
        select: ["name"],
        selectV2: [{ type: "property", apiName: "name" }],
      }),
    ).toThrowError(/InvalidLoadObjectSetRequest/);
    expect(() =>
      parseLoadObjectSetQuery({ branch: "dev", invented: true }),
    ).toThrowError(/InvalidLoadObjectSetRequest/);
  });

  it.each([
    ["transactionId", { transactionId: "tx-1" }],
    ["scenarioRid", { scenarioRid: "ri.ontology.main.scenario.x" }],
  ])("accepts implemented read-context query feature %s", (_feature, rawQuery) => {
    const request = parseLoadObjectSetRequest({
      objectSet: { type: "base", objectType: "T" },
      select: [],
    });
    expect(() =>
      assertSupportedLoadObjectSetRequest(
        request,
        parseLoadObjectSetQuery(rawQuery),
      ),
    ).not.toThrow();
  });

  it("continues to fail typed for executeInMemoryOnly", () => {
    const request = parseLoadObjectSetRequest({
      objectSet: { type: "base", objectType: "T" },
      select: [],
    });
    expect(() =>
      assertSupportedLoadObjectSetRequest(
        request,
        parseLoadObjectSetQuery({ executeInMemoryOnly: "true" }),
      ),
    ).toThrowError(
      expect.objectContaining({
        errorName: "UnsupportedObjectSetFeature",
        feature: "executeInMemoryOnly",
      }),
    );
  });

  it("accepts implemented load-level/security/signing features", () => {
    const supported = [
      {
        defaultLoadLevel: { type: "applyReducers" },
      },
      {
        loadPropertySecurities: true,
      },
      {
        referenceSigningOptions: { signMediaReferences: true },
      },
    ];
    for (const fields of supported) {
      const request = parseLoadObjectSetRequest({
        objectSet: { type: "base", objectType: "T" },
        select: [],
        ...fields,
      });
      expect(() =>
        assertSupportedLoadObjectSetRequest(
          request,
          parseLoadObjectSetQuery({}),
        ),
      ).not.toThrow();
    }
  });
});

describe("searchJsonToWhere — v2 → internal DSL", () => {
  it("maps v2 unary not to internal array form", () => {
    expect(
      searchJsonToWhere(
        { type: "not", value: { type: "eq", field: "a", value: 1 } },
        NOW,
      ),
    ).toEqual({ type: "not", value: [{ type: "eq", field: "a", value: 1 }] });
  });

  it("maps v2 contains (array membership) to eq", () => {
    expect(
      searchJsonToWhere({ type: "contains", field: "tags", value: "x" }, NOW),
    ).toEqual({ type: "eq", field: "tags", value: "x" });
  });

  it("maps isNull {value:false} to isNotNull", () => {
    expect(
      searchJsonToWhere({ type: "isNull", field: "a", value: false }, NOW),
    ).toEqual({ type: "isNotNull", field: "a" });
  });

  it("compiles relativeDateRange to ABSOLUTE bounds (page-token safety)", () => {
    const w = searchJsonToWhere(
      {
        type: "relativeDateRange",
        field: "createdAt",
        relativeStartTime: { type: "relativePoint", value: -7, timeUnit: "DAY" },
        relativeEndTime: { type: "relativePoint", value: 0, timeUnit: "DAY" },
        timeZoneId: "UTC",
      },
      NOW,
    ) as { type: string; value: Array<{ type: string; value: string }> };
    expect(w.type).toBe("and");
    expect(w.value[0].type).toBe("gte");
    expect(w.value[0].value).toBe("2026-07-21T00:00:00.000Z");
    expect(w.value[1].type).toBe("lt");
    expect(w.value[1].value).toBe("2026-07-28T00:00:00.000Z");
  });

  it("passes geo + text operators through 1:1", () => {
    expect(
      searchJsonToWhere(
        { type: "containsAllTerms", field: "n", value: "foo bar", fuzzy: true },
        NOW,
      ),
    ).toEqual({ type: "containsAllTerms", field: "n", value: "foo bar", fuzzy: true });
    expect(
      searchJsonToWhere(
        { type: "withinDistanceOf", field: "loc", value: { center: { lat: 1, lon: 2 }, distance: { value: 5, unit: "KILOMETERS" } } },
        NOW,
      ),
    ).toMatchObject({ type: "withinDistanceOf" });
  });

  it("accepts and compiles the SDK 2.70 geoShapeV2 operator", () => {
    const where = {
      type: "geoShapeV2",
      propertyIdentifier: { type: "property", apiName: "boundary" },
      geometry: {
        type: "envelope",
        topLeft: { lat: 2, lon: 29 },
        bottomRight: { lat: -2, lon: 31 },
      },
      spatialFilterMode: "INTERSECTS",
    };
    expect(() =>
      parseObjectSet({
        type: "filter",
        objectSet: { type: "base", objectType: "District" },
        where,
      }),
    ).not.toThrow();
    expect(searchJsonToWhere(where as never, NOW)).toEqual({
      type: "geoShapeV2",
      field: "boundary",
      shape: {
        type: "envelope",
        coordinates: [
          [29, 2],
          [31, -2],
        ],
      },
      spatialFilterMode: "INTERSECTS",
    });
  });
});

describe("compileObjectSet — set algebra", () => {
  const base = (t: string) => ({ type: "base", objectType: t });
  const filtered = (t: string, v: number) => ({
    type: "filter",
    objectSet: base(t),
    where: { type: "eq", field: "x", value: v },
  });

  it("union of same type folds into ONE plan with or", async () => {
    const c = await compileObjectSet(
      { type: "union", objectSets: [filtered("A", 1), filtered("A", 2)] } as never,
      deps,
    );
    expect(c.plans).toHaveLength(1);
    expect(c.crossType).toBe(false);
    expect((c.plans[0]!.where as { type: string }).type).toBe("or");
  });

  it("union of different types produces typed plans (cross-type)", async () => {
    const c = await compileObjectSet(
      { type: "union", objectSets: [base("A"), base("B")] } as never,
      deps,
    );
    expect(c.plans).toHaveLength(2);
    expect(c.crossType).toBe(true);
  });

  it("intersect across DIFFERENT types is empty (A ∩ B = ∅)", async () => {
    const c = await compileObjectSet(
      { type: "intersect", objectSets: [base("A"), base("B")] } as never,
      deps,
    );
    expect(c.plans).toHaveLength(0);
  });

  it("subtract wraps subtrahends in not(or(...))", async () => {
    const c = await compileObjectSet(
      { type: "subtract", objectSets: [filtered("A", 1), filtered("A", 2)] } as never,
      deps,
    );
    expect(c.plans).toHaveLength(1);
    const w = c.plans[0]!.where as { type: string; value: unknown[] };
    expect(w.type).toBe("and");
    expect((w.value[1] as { type: string }).type).toBe("not");
  });

  it("reference resolves recursively and detects cycles", async () => {
    const resolveReference = async (rid: string) =>
      rid === "self"
        ? ({ type: "reference", reference: "self" } as never)
        : null;
    await expect(
      compileObjectSet(
        { type: "reference", reference: "self" } as never,
        { ...deps, resolveReference },
      ),
    ).rejects.toThrowError(ObjectSetCompileError);
  });

  it("missing reference → ObjectSetNotFound", async () => {
    await expect(
      compileObjectSet(
        { type: "reference", reference: "nope" } as never,
        { ...deps, resolveReference: async () => null },
      ),
    ).rejects.toMatchObject({ errorName: "ObjectSetNotFound" });
  });

  it("searchAround compiles to a hop marker, never a filter", async () => {
    const c = await compileObjectSet(
      { type: "searchAround", objectSet: filtered("A", 1), link: "worksAt" } as never,
      deps,
    );
    expect(c.plans[0]!.searchAround).toEqual({
      link: "worksAt",
      fromObjectType: "A",
    });
    expect(c.plans[0]!.searchAroundSourceWhere).toMatchObject({ type: "eq" });
  });

  it("nearestNeighbors attaches knn to the plan (a node, not a filter)", async () => {
    const c = await compileObjectSet(
      {
        type: "nearestNeighbors",
        objectSet: base("A"),
        propertyIdentifier: { type: "property", apiName: "emb" },
        numNeighbors: 10,
        query: { type: "vector", value: [1, 2, 3] },
      } as never,
      deps,
    );
    expect(c.plans[0]!.knn).toMatchObject({ field: "emb", numNeighbors: 10 });
  });

  it("interfaceBase fans out over implementing types", async () => {
    const c = await compileObjectSet(
      { type: "interfaceBase", interfaceType: "Named" } as never,
      {
        ...deps,
        resolveInterfaceImplementations: async () => ["Employee", "Company"],
      },
    );
    expect(c.plans.map((p) => p.objectType).sort()).toEqual(["Company", "Employee"]);
    expect(c.crossType).toBe(true);
  });

  it("interface filters are translated per implementing object type", async () => {
    const translated: string[] = [];
    const compiled = await compileObjectSet(
      {
        type: "filter",
        objectSet: {
          type: "interfaceBase",
          interfaceType: "Named",
        },
        where: { type: "eq", field: "name", value: "Ada" },
      } as never,
      {
        ...deps,
        resolveInterfaceImplementations: async () => [
          "Employee",
          "Company",
        ],
        translateInterfaceWhere: async (_iface, objectType, where) => {
          translated.push(objectType);
          return {
            ...(where as Record<string, unknown>),
            field: objectType === "Employee" ? "fullName" : "legalName",
          };
        },
      },
    );
    expect(translated.sort()).toEqual(["Company", "Employee"]);
    expect(
      compiled.plans.map((plan) => (plan.where as { field: string }).field),
    ).toEqual(["fullName", "legalName"]);
  });

  it("asType drops non-matching plans (verified spec)", async () => {
    const c = await compileObjectSet(
      {
        type: "asType",
        objectSet: { type: "interfaceBase", interfaceType: "Named" },
        entityType: "Employee",
      } as never,
      {
        ...deps,
        // Realistic resolver: only interface names resolve;
        // object-type apiNames resolve to [].
        resolveInterfaceImplementations: async (i: string) =>
          i === "Named" ? ["Employee", "Company"] : [],
      },
    );
    expect(c.plans).toHaveLength(1);
    expect(c.plans[0]!.objectType).toBe("Employee");
  });

  it("methodInput requires a binding", async () => {
    await expect(
      compileObjectSet({ type: "methodInput" } as never, deps),
    ).rejects.toMatchObject({ errorName: "MethodInputUnbound" });
  });
});

describe("pageTokenV2", () => {
  const expected = { ontologyRid: "o1", branchRid: null, fingerprint: "abc" };

  it("round-trips", () => {
    const t = createPageTokenV2({ ...expected, orderBy: [], cursors: { T: [1] } });
    const d = decodePageTokenV2(t, expected);
    expect(d.cursors.T).toEqual([1]);
  });

  it("rejects tampered tokens", () => {
    const t = createPageTokenV2({ ...expected, orderBy: [], cursors: {} });
    const tampered = t.slice(0, -2) + "xx";
    expect(() => decodePageTokenV2(tampered, expected)).toThrowError(
      PageTokenError,
    );
  });

  it("rejects cross-fingerprint reuse", () => {
    const t = createPageTokenV2({ ...expected, orderBy: [], cursors: {} });
    expect(() =>
      decodePageTokenV2(t, { ...expected, fingerprint: "other" }),
    ).toThrowError(/different object set/);
  });

  it("rejects cross-ontology reuse", () => {
    const t = createPageTokenV2({ ...expected, orderBy: [], cursors: {} });
    expect(() =>
      decodePageTokenV2(t, { ...expected, ontologyRid: "o2" }),
    ).toThrowError(/different ontology/);
  });
});

describe("derived properties", () => {
  const obj = { salary: 100, bonus: 20, dept: "Eng" };
  it("add/subtract/multiply/divide/negate/absoluteValue", () => {
    const get = (a: string) => ({ type: "getSelectedProperty", apiName: a });
    expect(evaluateDerivedProperty({ type: "add", properties: [get("salary"), get("bonus")] }, obj)).toBe(120);
    expect(evaluateDerivedProperty({ type: "subtract", left: get("salary"), right: get("bonus") }, obj)).toBe(80);
    expect(evaluateDerivedProperty({ type: "multiply", properties: [get("salary"), get("bonus")] }, obj)).toBe(2000);
    expect(evaluateDerivedProperty({ type: "divide", left: get("salary"), right: get("bonus") }, obj)).toBe(5);
    expect(evaluateDerivedProperty({ type: "negate", property: get("salary") }, obj)).toBe(-100);
    expect(evaluateDerivedProperty({ type: "absoluteValue", property: { type: "negate", property: get("salary") } }, obj)).toBe(100);
  });
  it("null propagation: non-numeric → null, divide-by-zero → null", () => {
    const get = (a: string) => ({ type: "getSelectedProperty", apiName: a });
    expect(evaluateDerivedProperty({ type: "add", properties: [get("dept"), get("bonus")] }, obj)).toBeNull();
    expect(evaluateDerivedProperty({ type: "divide", left: get("salary"), right: { type: "getSelectedProperty", apiName: "zero" } }, { ...obj, zero: 0 })).toBeNull();
  });
});

describe("object identity", () => {
  it("minted rids have the Tellus namespace and are unique", () => {
    const a = mintObjectRid();
    const b = mintObjectRid();
    expect(isObjectRid(a)).toBe(true);
    expect(a).not.toBe(b);
  });
  it("deterministic rid is stable and input-sensitive", () => {
    const a = deterministicObjectRid("o", "Employee", "E-1");
    expect(a).toBe(deterministicObjectRid("o", "Employee", "E-1"));
    expect(a).not.toBe(deterministicObjectRid("o", "Employee", "E-2"));
    expect(isObjectRid(a)).toBe(true);
  });
});

describe("compileRelativeDateRange — timezone rounding", () => {
  it("rounds to midnight in the requested zone", () => {
    const b = compileRelativeDateRange(
      {
        relativeStartTime: { type: "relativePoint", value: 0, timeUnit: "DAY" },
        timeZoneId: "UTC",
      },
      NOW,
    );
    expect(b.gte).toBe("2026-07-28T00:00:00.000Z");
  });
  it("rejects unknown timezones with a typed error", () => {
    expect(() =>
      compileRelativeDateRange(
        { relativeStartTime: { type: "relativePoint", value: 0, timeUnit: "DAY" }, timeZoneId: "Not/AZone" },
        NOW,
      ),
    ).toThrowError(ObjectSetCompileError);
  });
});
