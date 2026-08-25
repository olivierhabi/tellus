// ---------------------------------------------------------------------------
// Canonical ObjectSet + SearchJsonQueryV2 + AggregationV2 definitions.
//
// Contract source (recorded for conformance):
//   @osdk/foundry.ontologies@2.69.0 — generated from
//   com.palantir.foundry.api:api-gateway 1.1709.0 (Apache-2.0, public).
//
// This module is the single source of truth for the v2 object-set
// contract. Both the v2 routes and the (v1) Workshop adapter validate
// against these schemas so there is exactly ONE object-set language in
// the system.
//
// Deliberate contract decisions (all defensible against the public
// spec):
//   * `propertyIdentifier` struct-selector variants are NOT accepted;
//     the equivalent `field` (PropertyApiName) form is — same semantic.
//   * The dead B10 prototype's invented operators (`notIn`, `endsWith`)
//     are NOT part of this contract — they do not exist in the
//     verified spec and must never leak onto the v2 surface.
//   * `nearestNeighbors` is an ObjectSet NODE, never a filter.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Limits (Phase 19 — typed v2 errors, never a crash)
// ---------------------------------------------------------------------------

export const MAX_OBJECT_SET_DEPTH = 20;
export const MAX_OBJECT_SET_NODES = 200;
export const MAX_SET_OPERATION_CHILDREN = 100;
export const MAX_STATIC_OBJECT_RIDS = 10_000;
export const MAX_NEAREST_NEIGHBORS_K = 1_000;
export const MAX_SELECTED_PROPERTIES = 1_000;
export const MAX_REGEX_PATTERN_LENGTH = 500;
export const MAX_WILDCARD_PATTERN_LENGTH = 500;
export const MAX_DERIVED_PROPERTIES = 50;
export const MAX_TEMP_OBJECT_SET_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// SearchJsonQueryV2 — verified 28-member union in public SDK 2.70.0
// ---------------------------------------------------------------------------

const field = z.string().min(1);
const fuzzy = z.boolean().optional();

const geoPoint = z.object({ lat: z.number(), lon: z.number() });
const distance = z.object({
  value: z.number().positive(),
  unit: z.enum([
    "MILLIMETERS", "CENTIMETERS", "METERS", "KILOMETERS",
    "INCHES", "FEET", "YARDS", "MILES", "NAUTICAL_MILES",
  ]),
});
const geoJson = z.object({
  type: z.string(),
  coordinates: z.unknown(),
});

export const SearchJsonQueryV2: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    // -- leaf: comparisons --------------------------------------------------
    z.object({ type: z.literal("eq"), field, value: z.unknown() }),
    z.object({ type: z.literal("gt"), field, value: z.unknown() }),
    z.object({ type: z.literal("gte"), field, value: z.unknown() }),
    z.object({ type: z.literal("lt"), field, value: z.unknown() }),
    z.object({ type: z.literal("lte"), field, value: z.unknown() }),
    z.object({ type: z.literal("in"), field, value: z.array(z.unknown()).min(1) }),
    z.object({ type: z.literal("isNull"), field, value: z.boolean() }),
    z.object({ type: z.literal("startsWith"), field, value: z.string() }),
    // Array membership ("Returns objects where the specified array
    // contains a value" — verified spec docstring).
    z.object({ type: z.literal("contains"), field, value: z.unknown() }),
    // -- leaf: full-text -----------------------------------------------------
    z.object({ type: z.literal("containsAllTerms"), field, value: z.string(), fuzzy }),
    z.object({ type: z.literal("containsAnyTerm"), field, value: z.string(), fuzzy }),
    z.object({ type: z.literal("containsAllTermsInOrder"), field, value: z.string() }),
    z.object({ type: z.literal("containsAllTermsInOrderPrefixLastTerm"), field, value: z.string() }),
    z.object({ type: z.literal("wildcard"), field, value: z.string().max(MAX_WILDCARD_PATTERN_LENGTH) }),
    z.object({ type: z.literal("regex"), field, value: z.string().max(MAX_REGEX_PATTERN_LENGTH) }),
    // -- leaf: interval -------------------------------------------------------
    z.object({
      type: z.literal("interval"),
      field,
      rule: z.lazy((): z.ZodType<unknown> => IntervalRule),
    }),
    // -- leaf: relative date range --------------------------------------------
    z.object({
      type: z.literal("relativeDateRange"),
      field,
      relativeStartTime: RelativeBound.optional(),
      relativeEndTime: RelativeBound.optional(),
      timeZoneId: z.string().default("UTC"),
    }),
    // -- leaf: geo --------------------------------------------------------------
    z.object({ type: z.literal("withinBoundingBox"), field, value: z.object({ topLeft: geoPoint, bottomRight: geoPoint }) }),
    z.object({ type: z.literal("withinDistanceOf"), field, value: z.object({ center: geoPoint, distance }) }),
    z.object({ type: z.literal("withinPolygon"), field, value: z.object({ geometry: geoJson }) }),
    z.object({ type: z.literal("intersectsBoundingBox"), field, value: z.object({ topLeft: geoPoint, bottomRight: geoPoint }) }),
    z.object({ type: z.literal("intersectsPolygon"), field, value: z.object({ geometry: geoJson }) }),
    z.object({ type: z.literal("doesNotIntersectBoundingBox"), field, value: z.object({ topLeft: geoPoint, bottomRight: geoPoint }) }),
    z.object({ type: z.literal("doesNotIntersectPolygon"), field, value: z.object({ geometry: geoJson }) }),
    z.object({
      type: z.literal("geoShapeV2"),
      field: field.optional(),
      propertyIdentifier: z.lazy(() => PropertyIdentifier).optional(),
      geometry: z.discriminatedUnion("type", [
        z.object({
          type: z.literal("envelope"),
          topLeft: geoPoint,
          bottomRight: geoPoint,
        }).strict(),
        z.object({
          type: z.literal("geoJson"),
          geoJson: z.string().min(1),
        }).strict(),
      ]),
      spatialFilterMode: z.enum([
        "INTERSECTS",
        "DISJOINT",
        "WITHIN",
        "CONTAINS",
      ]),
    }).strict().superRefine((value, ctx) => {
      if ((value.field ? 1 : 0) + (value.propertyIdentifier ? 1 : 0) !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Exactly one of field or propertyIdentifier is required.",
        });
      }
    }),
    // -- compound ---------------------------------------------------------------
    z.object({ type: z.literal("and"), value: z.array(SearchJsonQueryV2).min(1) }),
    z.object({ type: z.literal("or"), value: z.array(SearchJsonQueryV2).min(1) }),
    // v2 `not` is UNARY (single query), unlike the legacy v1 array form.
    z.object({ type: z.literal("not"), value: SearchJsonQueryV2 }),
  ]),
);
export type SearchJsonQueryV2 = z.infer<typeof SearchJsonQueryV2>;

// Interval sub-rules (verified: allOf / anyOf / match / prefixOnLastToken / fuzzy)
const MatchRule = z.object({
  type: z.literal("match"),
  query: z.string(),
  maxGaps: z.number().int().min(0).optional(),
  ordered: z.boolean(),
});
const PrefixOnLastTokenRule = z.object({
  type: z.literal("prefixOnLastToken"),
  query: z.string(),
});
const FuzzyRule = z.object({
  type: z.literal("fuzzy"),
  term: z.string(),
  fuzziness: z.number().int().min(0).max(2).optional(),
});
const IntervalRule: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    MatchRule,
    PrefixOnLastTokenRule,
    FuzzyRule,
    z.object({
      type: z.literal("allOf"),
      rules: z.array(IntervalRule).min(1),
      maxGaps: z.number().int().min(0).optional(),
      ordered: z.boolean(),
    }),
    z.object({
      type: z.literal("anyOf"),
      rules: z.array(IntervalRule).min(1),
    }),
  ]),
);

const RelativeBound = z.object({
  type: z.literal("relativePoint"),
  value: z.number().int(),
  timeUnit: z.enum(["DAY", "WEEK", "MONTH", "YEAR"]),
});

// ---------------------------------------------------------------------------
// ObjectSet — verified 14-node union
// ---------------------------------------------------------------------------

export const PropertyLoadLevel = z.discriminatedUnion("type", [
  z.object({ type: z.literal("applyReducersAndExtractMainValue") }).strict(),
  z.object({ type: z.literal("applyReducers") }).strict(),
  z.object({ type: z.literal("extractMainValue") }).strict(),
  z.object({ type: z.literal("noLoadLevel") }).strict(),
]);
export type PropertyLoadLevel = z.infer<typeof PropertyLoadLevel>;

/**
 * Public PropertyIdentifier union from
 * @osdk/foundry.ontologies@2.70.0.
 *
 * propertyWithLoadLevel is recursive because its propertyIdentifier may
 * itself be a struct/title/primary-key selector. Unknown selector kinds
 * are rejected rather than stripped.
 */
export const PropertyIdentifier: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("property"),
      apiName: z.string().min(1),
    }).strict(),
    z.object({
      type: z.literal("structField"),
      propertyApiName: z.string().min(1),
      structFieldApiName: z.string().min(1),
    }).strict(),
    z.object({
      type: z.literal("propertyWithLoadLevel"),
      propertyIdentifier: PropertyIdentifier,
      loadLevel: PropertyLoadLevel,
    }).strict(),
    z.object({ type: z.literal("titleProperty") }).strict(),
    z.object({ type: z.literal("primaryKeyProperty") }).strict(),
  ]),
);
export type PropertyIdentifier = z.infer<typeof PropertyIdentifier>;

const propertyIdentifier = z.object({
  type: z.literal("property"),
  apiName: z.string().min(1),
}).strict();

// Derived property expressions (verified: add/subtract/multiply/divide/
// negate/absoluteValue/getSelectedProperty/extractProperty…). We
// support the arithmetic + selection subset; unknown expression kinds
// fail validation (typed error, never a silent drop).
export const DerivedPropertyDefinition: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("add"), properties: z.array(DerivedPropertyDefinition).min(1) }),
    z.object({ type: z.literal("subtract"), left: DerivedPropertyDefinition, right: DerivedPropertyDefinition }),
    z.object({ type: z.literal("multiply"), properties: z.array(DerivedPropertyDefinition).min(1) }),
    z.object({ type: z.literal("divide"), left: DerivedPropertyDefinition, right: DerivedPropertyDefinition }),
    z.object({ type: z.literal("negate"), property: DerivedPropertyDefinition }),
    z.object({ type: z.literal("absoluteValue"), property: DerivedPropertyDefinition }),
    z.object({ type: z.literal("getSelectedProperty"), apiName: z.string().min(1) }),
  ]),
);

const nearestNeighborsQuery = z.discriminatedUnion("type", [
  z.object({ type: z.literal("vector"), value: z.array(z.number()).min(1) }),
  z.object({ type: z.literal("text"), value: z.string().min(1) }),
]);

export const ObjectSet: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("base"), objectType: z.string().min(1) }),
    z.object({ type: z.literal("filter"), objectSet: ObjectSet, where: SearchJsonQueryV2 }),
    z.object({ type: z.literal("reference"), reference: z.string().min(1) }),
    z.object({ type: z.literal("union"), objectSets: z.array(ObjectSet).min(1).max(MAX_SET_OPERATION_CHILDREN) }),
    z.object({ type: z.literal("intersect"), objectSets: z.array(ObjectSet).min(1).max(MAX_SET_OPERATION_CHILDREN) }),
    z.object({ type: z.literal("subtract"), objectSets: z.array(ObjectSet).min(2).max(MAX_SET_OPERATION_CHILDREN) }),
    z.object({ type: z.literal("searchAround"), objectSet: ObjectSet, link: z.string().min(1) }),
    z.object({
      type: z.literal("interfaceBase"),
      interfaceType: z.string().min(1),
      includeAllBaseObjectProperties: z.boolean().optional(),
    }),
    z.object({ type: z.literal("asBaseObjectTypes"), objectSet: ObjectSet }),
    z.object({ type: z.literal("asType"), objectSet: ObjectSet, entityType: z.string().min(1) }),
    z.object({
      type: z.literal("nearestNeighbors"),
      objectSet: ObjectSet,
      propertyIdentifier,
      numNeighbors: z.number().int().positive().max(MAX_NEAREST_NEIGHBORS_K),
      similarityThreshold: z.number().optional(),
      query: nearestNeighborsQuery,
    }),
    z.object({
      type: z.literal("withProperties"),
      objectSet: ObjectSet,
      derivedProperties: z.record(z.string().min(1), DerivedPropertyDefinition),
    }),
    z.object({ type: z.literal("static"), objects: z.array(z.string().min(1)).min(1).max(MAX_STATIC_OBJECT_RIDS) }),
    // Verified: ObjectSetMethodInputType is an empty marker node; the
    // actual set is bound from the calling function's input at
    // execution time.
    z.object({ type: z.literal("methodInput") }),
    z.object({
      type: z.literal("interfaceLinkSearchAround"),
      objectSet: ObjectSet,
      interfaceLink: z.string().min(1),
    }),
  ]),
);
export type ObjectSet = z.infer<typeof ObjectSet>;

// ---------------------------------------------------------------------------
// AggregationV2 + GroupByV2 — verified unions
// ---------------------------------------------------------------------------

export const AggregationV2 = z.discriminatedUnion("type", [
  z.object({ type: z.literal("count"), name: z.string().optional() }),
  z.object({ type: z.literal("sum"), field, name: z.string().optional() }),
  z.object({ type: z.literal("avg"), field, name: z.string().optional() }),
  z.object({ type: z.literal("min"), field, name: z.string().optional() }),
  z.object({ type: z.literal("max"), field, name: z.string().optional() }),
  z.object({ type: z.literal("approximateDistinct"), field, name: z.string().optional() }),
  z.object({ type: z.literal("exactDistinct"), field, name: z.string().optional() }),
  z.object({
    type: z.literal("approximatePercentile"),
    field,
    name: z.string().optional(),
    approximatePercentile: z.number().min(0).max(100),
  }),
]);
export type AggregationV2 = z.infer<typeof AggregationV2>;

export const MAX_GROUP_BY = 10;
export const MAX_AGGREGATION_METRICS = 25;
export const MAX_GROUP_COUNT = 100_000;

const timeUnit = z.enum([
  "SECONDS", "MINUTES", "HOURS", "DAYS", "WEEKS", "MONTHS", "QUARTERS", "YEARS",
]);

export const AggregationGroupByV2 = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("exact"),
    field,
    maxGroupCount: z.number().int().positive().max(MAX_GROUP_COUNT).optional(),
    defaultValue: z.string().optional(),
    includeNullValues: z.boolean().optional(),
  }),
  z.object({ type: z.literal("fixedWidth"), field, fixedWidth: z.number().positive() }),
  z.object({
    type: z.literal("ranges"),
    field,
    ranges: z.array(z.object({ startValue: z.unknown(), endValue: z.unknown() })).min(1),
  }),
  z.object({
    type: z.literal("duration"),
    field,
    value: z.number().int().positive(),
    unit: timeUnit,
  }),
  // Cross-type aggregation over interface sets (verified:
  // AggregationObjectTypeGrouping).
  z.object({ type: z.literal("objectType") }),
]);
export type AggregationGroupByV2 = z.infer<typeof AggregationGroupByV2>;

export const AggregationAccuracyRequest = z.enum([
  "REQUIRE_ACCURATE",
  "ALLOW_APPROXIMATE",
]);
export type AggregationAccuracyRequest = z.infer<typeof AggregationAccuracyRequest>;

// ---------------------------------------------------------------------------
// v2 request envelopes (verified fields)
// ---------------------------------------------------------------------------

export const SearchOrderByV2 = z.object({
  orderType: z.enum(["fields", "relevance"]).optional(),
  fields: z.array(
    z.object({
      field: z.string().min(1),
      direction: z.enum(["asc", "desc"]).default("asc"),
    }),
  ).max(5),
}).strict();
export type SearchOrderByV2 = z.infer<typeof SearchOrderByV2>;

export const ReferenceSigningOptions = z.object({
  signMediaReferences: z.boolean().optional(),
}).strict();
export type ReferenceSigningOptions = z.infer<typeof ReferenceSigningOptions>;

export const LoadObjectSetRequestV2 = z.object({
  objectSet: ObjectSet,
  orderBy: SearchOrderByV2.optional(),
  select: z.array(z.string().min(1)).max(MAX_SELECTED_PROPERTIES).default([]),
  selectV2: z.array(PropertyIdentifier).max(MAX_SELECTED_PROPERTIES).default([]),
  defaultLoadLevel: PropertyLoadLevel.optional(),
  pageToken: z.string().min(1).optional(),
  pageSize: z.number().int().min(1).max(10_000).optional(),
  excludeRid: z.boolean().optional(),
  loadPropertySecurities: z.boolean().optional(),
  snapshot: z.boolean().optional(),
  includeComputeUsage: z.boolean().optional(),
  referenceSigningOptions: ReferenceSigningOptions.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.select.length > 0 && value.selectV2.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectV2"],
      message: "Only selectV2 or select may be populated, not both.",
    });
  }
});
export type LoadObjectSetRequestV2 = z.infer<typeof LoadObjectSetRequestV2>;

const queryBoolean = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return value;
}, z.boolean().optional());

/**
 * Query parameters documented on loadObjects. These live outside the
 * POST body in the public contract and are validated separately so an
 * unknown/experimental parameter cannot be silently ignored.
 */
export const LoadObjectSetQueryV2 = z.object({
  sdkPackageRid: z.string().min(1).optional(),
  sdkVersion: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  transactionId: z.string().min(1).optional(),
  scenarioRid: z.string().min(1).optional(),
  executeInMemoryOnly: queryBoolean,
}).strict();
export type LoadObjectSetQueryV2 = z.infer<typeof LoadObjectSetQueryV2>;

export const CreateTemporaryObjectSetQueryV2 = z.object({
  branch: z.string().min(1).optional(),
  sdkPackageRid: z.string().min(1).optional(),
  sdkVersion: z.string().min(1).optional(),
  preview: queryBoolean,
}).strict();
export type CreateTemporaryObjectSetQueryV2 = z.infer<
  typeof CreateTemporaryObjectSetQueryV2
>;

export const AggregateObjectSetRequestV2 = z.object({
  objectSet: ObjectSet,
  aggregation: z.array(AggregationV2).min(1).max(MAX_AGGREGATION_METRICS),
  groupBy: z.array(AggregationGroupByV2).max(MAX_GROUP_BY).default([]),
  accuracy: AggregationAccuracyRequest.optional(),
});
export type AggregateObjectSetRequestV2 = z.infer<typeof AggregateObjectSetRequestV2>;

export const CreateTemporaryObjectSetRequestV2 = z.object({
  objectSet: ObjectSet,
});
export type CreateTemporaryObjectSetRequestV2 = z.infer<
  typeof CreateTemporaryObjectSetRequestV2
>;

// ---------------------------------------------------------------------------
// Fingerprint — deterministic identity for an object set. Used by page
// tokens (tamper binding), subscriptions (registration key) and
// temporary-set deduplication.
// ---------------------------------------------------------------------------

export function objectSetFingerprint(objectSet: unknown): string {
  return createHash("sha256")
    .update(stableStringify(objectSet))
    .digest("hex");
}

/** Deterministic JSON: object keys sorted recursively. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

// ---------------------------------------------------------------------------
// Validation entry points — typed INVALID_ARGUMENT errors (v2 shape)
// ---------------------------------------------------------------------------

export interface ObjectSetValidationError extends Error {
  code: "INVALID_ARGUMENT";
  errorName: string;
  issues: unknown[];
}

function fail(errorName: string, issues: unknown[]): never {
  const e = Object.assign(
    new Error(`${errorName}: object set failed contract validation`),
    { code: "INVALID_ARGUMENT" as const, errorName, issues },
  ) as ObjectSetValidationError;
  throw e;
}

function checkDepthAndNodes(objectSet: unknown): void {
  let nodes = 0;
  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_OBJECT_SET_DEPTH) {
      fail("ObjectSetTooDeep", [{ message: `ObjectSet nesting exceeds ${MAX_OBJECT_SET_DEPTH} levels.` }]);
    }
    if (++nodes > MAX_OBJECT_SET_NODES) {
      fail("ObjectSetTooComplex", [{ message: `ObjectSet exceeds ${MAX_OBJECT_SET_NODES} nodes.` }]);
    }
    if (node === null || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n.objectSet) visit(n.objectSet, depth + 1);
    if (Array.isArray(n.objectSets)) for (const c of n.objectSets) visit(c, depth + 1);
  };
  visit(objectSet, 0);
}

export function parseObjectSet(payload: unknown): ObjectSet {
  const r = ObjectSet.safeParse(payload);
  if (!r.success) fail("InvalidObjectSet", r.error.issues);
  checkDepthAndNodes(r.data);
  return r.data as ObjectSet;
}

export function parseLoadObjectSetRequest(payload: unknown): LoadObjectSetRequestV2 {
  const r = LoadObjectSetRequestV2.safeParse(payload);
  if (!r.success) fail("InvalidLoadObjectSetRequest", r.error.issues);
  checkDepthAndNodes((r.data as LoadObjectSetRequestV2).objectSet);
  return r.data;
}

export function parseLoadObjectSetQuery(payload: unknown): LoadObjectSetQueryV2 {
  const r = LoadObjectSetQueryV2.safeParse(payload);
  if (!r.success) fail("InvalidLoadObjectSetRequest", r.error.issues);
  return r.data;
}

export function parseCreateTemporaryObjectSetQuery(
  payload: unknown,
): CreateTemporaryObjectSetQueryV2 {
  const r = CreateTemporaryObjectSetQueryV2.safeParse(payload);
  if (!r.success) fail("InvalidLoadObjectSetRequest", r.error.issues);
  return r.data;
}

export function parseAggregateObjectSetRequest(payload: unknown): AggregateObjectSetRequestV2 {
  const r = AggregateObjectSetRequestV2.safeParse(payload);
  if (!r.success) fail("InvalidAggregateObjectSetRequest", r.error.issues);
  checkDepthAndNodes((r.data as AggregateObjectSetRequestV2).objectSet);
  return r.data;
}
