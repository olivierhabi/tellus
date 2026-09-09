// ---------------------------------------------------------------------------
// Query Validator Service
//
// Validates all incoming query requests before they reach OpenSearch.
// Invalid queries are rejected with clear, actionable error messages.
//
// Exports:
//   validateSearchQuery(body, objectTypeApiName)  — POST /search body
//   validateListQuery(queryParams, objectTypeApiName) — GET list params
//   validateAggregateQuery(body, objectTypeApiName) — POST /aggregate (Task 16)
// ---------------------------------------------------------------------------

import {
  resolveProperty,
  resolveAllProperties,
  type PropertyMeta,
} from "./propertyResolver";
import { appError } from "../utils/appError";
import {
  MAX_EXPLORER_PAGE_SIZE,
  MAX_EXPLORER_PAGE_SIZE_OPT_IN,
  DEFAULT_PAGE_SIZE,
  MAX_ORDER_BY_FIELDS,
  MAX_IN_CLAUSE_VALUES,
  MAX_COMPOUND_FILTER_CHILDREN,
  MAX_FILTER_NESTING_DEPTH,
  SUPPORTED_FILTER_TYPES as FILTER_TYPES_ARRAY,
} from "../utils/constants";
import { incCounter, observeHistogram } from "./funnel/metrics";

// Re-export under the legacy name so existing consumers don't break;
// internally we use the new explorer-specific constant.
export const MAX_PAGE_SIZE = MAX_EXPLORER_PAGE_SIZE;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_TOP_LEVEL = new Set(["where", "$orderBy", "$pageSize", "$pageToken", "$select"]);

const SUPPORTED_FILTER_TYPES = new Set(FILTER_TYPES_ARRAY);

const LEAF_FILTER_TYPES = new Set([
  "eq", "gt", "gte", "lt", "lte",
  "contains", "startsWith",
  "isNull", "isNotNull",
  "in",
]);

// Phase 6 — SearchJsonQueryV2 leaf types. Validated here, translated
// by queryTranslator. Full-text types require string properties;
// geo types require geo properties (enforced in validateV2Leaf).
const V2_TEXT_FILTER_TYPES = new Set([
  "containsAllTerms", "containsAnyTerm",
  "containsAllTermsInOrder", "containsAllTermsInOrderPrefixLastTerm",
  "wildcard", "regex", "interval",
]);
const V2_GEO_FILTER_TYPES = new Set([
  "withinBoundingBox", "withinDistanceOf", "withinPolygon",
  "intersectsBoundingBox", "intersectsPolygon",
  "doesNotIntersectBoundingBox", "doesNotIntersectPolygon",
  "geoShapeV2",
]);
const V2_LEAF_FILTER_TYPES = new Set([
  ...V2_TEXT_FILTER_TYPES,
  ...V2_GEO_FILTER_TYPES,
]);

const COMPOUND_FILTER_TYPES = new Set(["and", "or", "not"]);

const UNARY_FILTERS = new Set(["isNull", "isNotNull"]);

const MAX_NESTING_DEPTH = MAX_FILTER_NESTING_DEPTH;
const MAX_IN_VALUES = MAX_IN_CLAUSE_VALUES;
const MAX_COMPOUND_ELEMENTS = MAX_COMPOUND_FILTER_CHILDREN;

const UNSORTABLE_TYPES = new Set(["geopoint", "geoshape", "struct"]);

const INTEGER_TYPES = new Set(["integer", "long", "byte", "short"]);
const FLOAT_TYPES = new Set(["double", "float", "decimal"]);

const SYSTEM_FIELDS = new Set(["__pk", "__objectType", "__lastModified", "__version"]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validationError(code: string, message: string, field?: string) {
  const err = appError("QUERY_VALIDATION_ERROR", message);
  (err as any).validationCode = code;
  (err as any).field = field;
  return err;
}

function getEffective(baseType: string): string {
  return baseType.endsWith("_array") ? baseType.replace("_array", "") : baseType;
}

// ---------------------------------------------------------------------------
// Type compatibility check
// ---------------------------------------------------------------------------

function checkTypeCompatibility(
  filterType: string,
  field: string,
  value: unknown,
  meta: PropertyMeta,
  filterRef?: Record<string, unknown>
): void {
  const effective = getEffective(meta.baseType);

  if (UNARY_FILTERS.has(filterType)) return; // no value to check

  // For 'in', check each element
  if (filterType === "in" && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      checkSingleValueCompat(filterType, field, value[i], effective, meta.baseType);
    }
    return;
  }

  checkSingleValueCompat(filterType, field, value, effective, meta.baseType, filterRef);
}

function checkSingleValueCompat(
  filterType: string,
  field: string,
  value: unknown,
  effective: string,
  baseType: string,
  filterRef?: Record<string, unknown>
): void {
  if (effective === "string") {
    if (typeof value !== "string") {
      throw validationError(
        "TYPE_MISMATCH",
        `Filter '${filterType}' on property '${field}' of type '${baseType}' requires a string value. Got ${typeof value}: '${value}'.`,
        field
      );
    }
    return;
  }

  if (INTEGER_TYPES.has(effective)) {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw validationError(
        "TYPE_MISMATCH",
        `Filter '${filterType}' on property '${field}' of type '${baseType}' requires an integer value. Got ${typeof value}: '${value}'.`,
        field
      );
    }
    return;
  }

  if (FLOAT_TYPES.has(effective)) {
    if (typeof value !== "number") {
      throw validationError(
        "TYPE_MISMATCH",
        `Filter '${filterType}' on property '${field}' of type '${baseType}' requires a numeric value. Got ${typeof value}: '${value}'.`,
        field
      );
    }
    return;
  }

  if (effective === "boolean") {
    if (typeof value !== "boolean") {
      throw validationError(
        "TYPE_MISMATCH",
        `Filter '${filterType}' on property '${field}' of type '${baseType}' requires a boolean value. Got ${typeof value}: '${value}'.`,
        field
      );
    }
    return;
  }

  if (effective === "date") {
    if (typeof value !== "string" || !DATE_RE.test(value)) {
      throw validationError(
        "TYPE_MISMATCH",
        `Filter '${filterType}' on property '${field}' of type 'date' requires a yyyy-MM-dd string. Got: '${value}'.`,
        field
      );
    }
    return;
  }

  if (effective === "timestamp") {
    // Foundry parity: date-granularity values ("yyyy-MM-dd") are accepted for
    // timestamp properties — Workshop date-range filters emit calendar days.
    // Coerce to the inclusive ISO bound: lower operators cover the start of
    // the day, upper operators the end of the day.
    if (typeof value === "string" && DATE_RE.test(value) && !ISO_RE.test(value)) {
      const isUpper = filterType === "lte" || filterType === "lt";
      const coerced = isUpper
        ? `${value}T23:59:59.999Z`
        : `${value}T00:00:00.000Z`;
      if (filterRef && typeof filterRef === "object") {
        (filterRef as Record<string, unknown>).value = coerced;
      }
      return;
    }
    if (typeof value !== "string" || !ISO_RE.test(value)) {
      throw validationError(
        "TYPE_MISMATCH",
        `Filter '${filterType}' on property '${field}' of type 'timestamp' requires an ISO 8601 string. Got: '${value}'.`,
        field
      );
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// Where clause validation (recursive)
// ---------------------------------------------------------------------------

async function validateWhereClause(
  filter: any,
  objectTypeApiName: string,
  depth: number
): Promise<void> {
  if (depth > MAX_NESTING_DEPTH) {
    throw validationError(
      "NESTING_TOO_DEEP",
      "Filter nesting depth exceeds maximum of 10 levels. Please simplify your query."
    );
  }

  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    throw validationError("INVALID_FILTER", "Filter must be an object.");
  }

  if (!filter.type || typeof filter.type !== "string") {
    throw validationError("INVALID_FILTER", "Filter must have a 'type' field.");
  }

  if (!SUPPORTED_FILTER_TYPES.has(filter.type)) {
    throw validationError(
      "INVALID_FILTER_TYPE",
      `Unknown filter type '${filter.type}'. Supported types are: eq, gt, gte, lt, lte, contains, startsWith, isNull, isNotNull, in, and, or, not.`
    );
  }

  // Compound filters
  if (COMPOUND_FILTER_TYPES.has(filter.type)) {
    if (!Array.isArray(filter.value)) {
      throw validationError(
        "INVALID_FILTER",
        `Compound filter '${filter.type}' must have a 'value' array of sub-filters.`
      );
    }

    if (filter.type === "not") {
      if (filter.value.length !== 1) {
        throw validationError(
          "INVALID_FILTER",
          "'not' filter must have exactly 1 sub-filter."
        );
      }
    } else {
      if (filter.value.length < 1) {
        throw validationError(
          "INVALID_FILTER",
          `'${filter.type}' filter must have at least 1 sub-filter.`
        );
      }
      if (filter.value.length > MAX_COMPOUND_ELEMENTS) {
        throw validationError(
          "INVALID_FILTER",
          `'${filter.type}' filter can have at most ${MAX_COMPOUND_ELEMENTS} sub-filters. Got: ${filter.value.length}.`
        );
      }
    }

    for (const sub of filter.value) {
      await validateWhereClause(sub, objectTypeApiName, depth + 1);
    }
    return;
  }

  // Phase 6 — v2 leaf filters (SearchJsonQueryV2 parity)
  if (V2_LEAF_FILTER_TYPES.has(filter.type)) {
    await validateV2Leaf(filter, objectTypeApiName);
    return;
  }

  // Leaf filters
  if (LEAF_FILTER_TYPES.has(filter.type)) {
    if (!filter.field || typeof filter.field !== "string") {
      throw validationError(
        "INVALID_FILTER",
        `Leaf filter '${filter.type}' must have a 'field' property (non-empty string).`
      );
    }

    // Validate property exists
    const meta = await resolveProperty(objectTypeApiName, filter.field);

    // Unary filters (isNull, isNotNull) — must NOT have value
    if (UNARY_FILTERS.has(filter.type)) {
      if (filter.value !== undefined) {
        throw validationError(
          "INVALID_FILTER",
          `'${filter.type}' filter must not have a 'value' property.`
        );
      }
      return;
    }

    // All other leaf filters MUST have value
    if (filter.value === undefined) {
      throw validationError(
        "INVALID_FILTER",
        `Filter '${filter.type}' on field '${filter.field}' requires a 'value' property.`
      );
    }

    // 'in' filter — value must be non-empty array
    if (filter.type === "in") {
      if (!Array.isArray(filter.value)) {
        throw validationError("INVALID_FILTER", "'in' filter value must be an array.");
      }
      if (filter.value.length === 0) {
        throw validationError("INVALID_FILTER", "'in' filter value must be a non-empty array.");
      }
      if (filter.value.length > MAX_IN_VALUES) {
        throw validationError(
          "INVALID_FILTER",
          `'in' filter value array exceeds maximum of ${MAX_IN_VALUES} elements. Got: ${filter.value.length}.`
        );
      }
    }

    // 'eq' — value must be primitive
    if (filter.type === "eq") {
      if (filter.value !== null && typeof filter.value === "object") {
        throw validationError(
          "INVALID_FILTER",
          "'eq' filter value must be a primitive (string, number, boolean, null)."
        );
      }
    }

    // 'contains', 'startsWith' — value must be string
    if (filter.type === "contains" || filter.type === "startsWith") {
      if (typeof filter.value !== "string") {
        throw validationError(
          "INVALID_FILTER",
          `'${filter.type}' filter value must be a string.`
        );
      }
    }

    // Type compatibility
    if (filter.value !== null) {
      checkTypeCompatibility(filter.type, filter.field, filter.value, meta, filter);
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 6 — v2 leaf validation
// ---------------------------------------------------------------------------

const GEO_BASE_TYPES = new Set(["geopoint", "geoshape"]);

async function validateV2Leaf(
  filter: any,
  objectTypeApiName: string,
): Promise<void> {
  if (!filter.field || typeof filter.field !== "string") {
    throw validationError(
      "INVALID_FILTER",
      `Filter '${filter.type}' must have a 'field' property (non-empty string).`,
    );
  }
  const meta = await resolveProperty(objectTypeApiName, filter.field);
  const effective = getEffective(meta.baseType);

  if (V2_TEXT_FILTER_TYPES.has(filter.type)) {
    if (effective !== "string") {
      throw validationError(
        "INCOMPATIBLE_FILTER",
        `Filter '${filter.type}' is only supported on string properties. ` +
          `Property '${filter.field}' has type '${meta.baseType}'.`,
        filter.field,
      );
    }
    if (filter.type === "interval") {
      if (!filter.rule || typeof filter.rule !== "object") {
        throw validationError(
          "INVALID_FILTER",
          `'interval' filter requires a 'rule' object.`,
          filter.field,
        );
      }
      return;
    }
    if (typeof filter.value !== "string") {
      throw validationError(
        "TYPE_MISMATCH",
        `Filter '${filter.type}' requires a string value. Got ${typeof filter.value}.`,
        filter.field,
      );
    }
    return;
  }

  // Geo filters
  if (!GEO_BASE_TYPES.has(effective)) {
    throw validationError(
      "INCOMPATIBLE_FILTER",
      `Filter '${filter.type}' is only supported on geo properties ` +
        `(geopoint/geoshape). Property '${filter.field}' has type '${meta.baseType}'.`,
      filter.field,
    );
  }
  if (filter.type === "geoShapeV2") {
    if (!filter.shape || typeof filter.shape !== "object") {
      throw validationError(
        "INVALID_FILTER",
        "'geoShapeV2' requires a compiled GeoJSON shape.",
        filter.field,
      );
    }
    if (
      !["INTERSECTS", "DISJOINT", "WITHIN", "CONTAINS"].includes(
        filter.spatialFilterMode,
      )
    ) {
      throw validationError(
        "INVALID_FILTER",
        "'geoShapeV2' has an invalid spatialFilterMode.",
        filter.field,
      );
    }
    return;
  }
  // Point-in-polygon is valid on geopoint OR geoshape; bbox/distance
  // are point-centric (geo_bounding_box / geo_distance on geo_point);
  // intersects/doesNotIntersect require shape semantics.
  const v = filter.value;
  if (!v || typeof v !== "object") {
    throw validationError(
      "INVALID_FILTER",
      `Filter '${filter.type}' requires a structured 'value' object.`,
      filter.field,
    );
  }
  if (
    (filter.type === "withinBoundingBox" || filter.type === "intersectsBoundingBox" ||
      filter.type === "doesNotIntersectBoundingBox") &&
    (!v.topLeft || !v.bottomRight)
  ) {
    throw validationError(
      "INVALID_FILTER",
      `'${filter.type}' requires value.topLeft and value.bottomRight.`,
      filter.field,
    );
  }
  if (filter.type === "withinDistanceOf" && (!v.center || !v.distance)) {
    throw validationError(
      "INVALID_FILTER",
      `'withinDistanceOf' requires value.center and value.distance.`,
      filter.field,
    );
  }
  if (
    (filter.type === "withinPolygon" || filter.type === "intersectsPolygon" ||
      filter.type === "doesNotIntersectPolygon") &&
    !v.geometry
  ) {
    throw validationError(
      "INVALID_FILTER",
      `'${filter.type}' requires value.geometry (GeoJSON).`,
      filter.field,
    );
  }
}

// ---------------------------------------------------------------------------
// validateSearchQuery
// ---------------------------------------------------------------------------

export async function validateSearchQuery(
  body: any,
  objectTypeApiName: string,
  largePage: boolean = false,
): Promise<any> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw validationError("INVALID_BODY", "Request body must be a JSON object.");
  }

  // Check for unexpected fields
  for (const key of Object.keys(body)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      throw validationError(
        "UNEXPECTED_FIELD",
        `Unexpected field '${key}'. Allowed fields are: where, $orderBy, $pageSize, $pageToken, $select.`,
        key
      );
    }
  }

  // Validate where clause
  if (body.where !== undefined) {
    await validateWhereClause(body.where, objectTypeApiName, 1);
  }

  // Validate $orderBy
  if (body.$orderBy !== undefined) {
    await validateOrderBy(body.$orderBy, objectTypeApiName);
  }

  // Validate $pageSize (T-09: cap clamped via the explorer constants;
  // opt-in path requires the `x-tellus-large-page: true` header to
  // raise the ceiling from MAX_EXPLORER_PAGE_SIZE to
  // MAX_EXPLORER_PAGE_SIZE_OPT_IN).
  const pageSize = validatePageSize(body.$pageSize, largePage);

  // Validate $pageToken
  if (body.$pageToken !== undefined) {
    if (typeof body.$pageToken !== "string" || body.$pageToken.length === 0) {
      throw validationError(
        "INVALID_PAGE_TOKEN",
        "$pageToken must be a non-empty string.",
        "$pageToken"
      );
    }
  }

  // Validate $select
  if (body.$select !== undefined) {
    await validateSelect(body.$select, objectTypeApiName);
  }

  // Return validated body with defaults
  return { ...body, $pageSize: pageSize };
}

// ---------------------------------------------------------------------------
// validateListQuery
// ---------------------------------------------------------------------------

export async function validateListQuery(
  queryParams: Record<string, any>,
  objectTypeApiName: string,
  largePage: boolean = false,
): Promise<{
  pageSize: number;
  pageToken: string | undefined;
  orderBy: Array<{ field: string; direction: string }>;
  select: string[] | undefined;
}> {
  const pageSize = validatePageSize(
    queryParams.$pageSize !== undefined
      ? Number(queryParams.$pageSize)
      : undefined,
    largePage,
  );

  const pageToken =
    queryParams.$pageToken && typeof queryParams.$pageToken === "string"
      ? queryParams.$pageToken
      : undefined;

  // Parse $orderBy from comma-separated string
  let orderBy: Array<{ field: string; direction: string }> = [];
  if (queryParams.$orderBy && typeof queryParams.$orderBy === "string") {
    const parts = queryParams.$orderBy.split(",").map((s: string) => s.trim()).filter(Boolean);
    for (const part of parts) {
      const [field, dir] = part.split(":");
      if (!field || !dir) {
        throw validationError(
          "INVALID_ORDER_BY",
          `Invalid $orderBy format: '${part}'. Expected 'field:asc' or 'field:desc'.`,
          "$orderBy"
        );
      }
      orderBy.push({ field, direction: dir });
    }
    await validateOrderBy(orderBy, objectTypeApiName);
  }

  // Parse $select from comma-separated string
  let select: string[] | undefined;
  if (queryParams.$select && typeof queryParams.$select === "string") {
    select = queryParams.$select.split(",").map((s: string) => s.trim()).filter(Boolean);
    if (select.length > 0) {
      await validateSelect(select, objectTypeApiName);
    }
  }

  return { pageSize, pageToken, orderBy, select };
}

// ---------------------------------------------------------------------------
// validateAggregateQuery (placeholder — implemented in Task 16)
// ---------------------------------------------------------------------------

export async function validateAggregateQuery(
  body: any,
  objectTypeApiName: string
): Promise<any> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw validationError("INVALID_BODY", "Request body must be a JSON object.");
  }

  // Validate where clause if present
  if (body.where !== undefined) {
    await validateWhereClause(body.where, objectTypeApiName, 1);
  }

  // Validate aggregations array
  if (!Array.isArray(body.aggregations) || body.aggregations.length === 0) {
    throw validationError(
      "INVALID_AGGREGATIONS",
      "aggregations must be a non-empty array."
    );
  }

  for (const agg of body.aggregations) {
    if (!agg.name || typeof agg.name !== "string") {
      throw validationError("INVALID_AGGREGATION", "Each aggregation must have a 'name' string.");
    }
    if (!agg.type || typeof agg.type !== "string") {
      throw validationError("INVALID_AGGREGATION", `Aggregation '${agg.name}' must have a 'type'.`);
    }
    const validAggTypes = ["count", "avg", "sum", "min", "max", "terms", "date_histogram", "range", "cardinality"];
    if (!validAggTypes.includes(agg.type)) {
      throw validationError(
        "INVALID_AGGREGATION",
        `Unknown aggregation type '${agg.type}'. Supported: ${validAggTypes.join(", ")}`
      );
    }
    // Field is required for all agg types except 'count'
    if (agg.type !== "count" && (!agg.field || typeof agg.field !== "string")) {
      throw validationError(
        "INVALID_AGGREGATION",
        `Aggregation '${agg.name}' of type '${agg.type}' requires a 'field' property.`
      );
    }
    if (agg.field) {
      const meta = await resolveProperty(objectTypeApiName, agg.field);
      // --- Type-compatibility checks for aggregation types ---
      const bt = meta.baseType.endsWith("_array")
        ? meta.baseType.replace("_array", "")
        : meta.baseType;

      const NUMERIC = new Set(["integer", "long", "double", "float", "byte", "short", "decimal"]);
      const DATE = new Set(["date", "timestamp"]);
      const GEO = new Set(["geopoint", "geoshape"]);

      if ((agg.type === "avg" || agg.type === "sum") && !NUMERIC.has(bt)) {
        throw validationError(
          "INCOMPATIBLE_FILTER",
          `Aggregation '${agg.name}': '${agg.type}' requires a numeric field, but '${agg.field}' is of type '${meta.baseType}'.`
        );
      }
      if (agg.type === "date_histogram" && !DATE.has(bt)) {
        throw validationError(
          "INCOMPATIBLE_FILTER",
          `Aggregation '${agg.name}': 'date_histogram' requires a date or timestamp field, but '${agg.field}' is of type '${meta.baseType}'.`
        );
      }
      if ((agg.type === "min" || agg.type === "max") && !NUMERIC.has(bt) && !DATE.has(bt)) {
        throw validationError(
          "INCOMPATIBLE_FILTER",
          `Aggregation '${agg.name}': '${agg.type}' requires a numeric or date field, but '${agg.field}' is of type '${meta.baseType}'.`
        );
      }
      if (agg.type === "range" && !NUMERIC.has(bt)) {
        throw validationError(
          "INCOMPATIBLE_FILTER",
          `Aggregation '${agg.name}': 'range' requires a numeric field, but '${agg.field}' is of type '${meta.baseType}'.`
        );
      }
      if ((agg.type === "terms" || agg.type === "cardinality") && (GEO.has(bt) || bt === "struct")) {
        throw validationError(
          "INCOMPATIBLE_FILTER",
          `Aggregation '${agg.name}': '${agg.type}' is not supported on '${meta.baseType}' fields.`
        );
      }
    }

    // --- Optional nested metric (Pie Chart aggregation method) ---
    // A bucketing aggregation may carry a metric sub-aggregation whose value
    // is computed per bucket. Only `terms` supports it today.
    if (agg.metric !== undefined && agg.metric !== null) {
      if (agg.type !== "terms") {
        throw validationError(
          "INVALID_AGGREGATION",
          `Aggregation '${agg.name}': a nested 'metric' is only supported on 'terms' aggregations.`
        );
      }
      const m = agg.metric;
      const validMetricTypes = ["count", "sum", "avg", "min", "max", "cardinality"];
      if (!m.type || typeof m.type !== "string" || !validMetricTypes.includes(m.type)) {
        throw validationError(
          "INVALID_AGGREGATION",
          `Aggregation '${agg.name}': metric.type must be one of ${validMetricTypes.join(", ")}.`
        );
      }
      // Every metric except `count` aggregates over a field.
      if (m.type !== "count") {
        if (!m.field || typeof m.field !== "string") {
          throw validationError(
            "INVALID_AGGREGATION",
            `Aggregation '${agg.name}': metric.type '${m.type}' requires a 'metric.field'.`
          );
        }
        const mMeta = await resolveProperty(objectTypeApiName, m.field);
        const mbt = mMeta.baseType.endsWith("_array")
          ? mMeta.baseType.replace("_array", "")
          : mMeta.baseType;
        const NUMERIC = new Set(["integer", "long", "double", "float", "byte", "short", "decimal"]);
        const DATE = new Set(["date", "timestamp"]);
        if ((m.type === "sum" || m.type === "avg") && !NUMERIC.has(mbt)) {
          throw validationError(
            "INCOMPATIBLE_FILTER",
            `Aggregation '${agg.name}': metric '${m.type}' requires a numeric field, but '${m.field}' is of type '${mMeta.baseType}'.`
          );
        }
        if ((m.type === "min" || m.type === "max") && !NUMERIC.has(mbt) && !DATE.has(mbt)) {
          throw validationError(
            "INCOMPATIBLE_FILTER",
            `Aggregation '${agg.name}': metric '${m.type}' requires a numeric or date field, but '${m.field}' is of type '${mMeta.baseType}'.`
          );
        }
      }
    }

    // --- Optional secondary group-by ("segment by"/series, Chart XY) ---
    if (agg.groupBy !== undefined && agg.groupBy !== null) {
      if (agg.type !== "terms") {
        throw validationError(
          "INVALID_AGGREGATION",
          `Aggregation '${agg.name}': a nested 'groupBy' is only supported on 'terms' aggregations.`
        );
      }
      if (!agg.groupBy.field || typeof agg.groupBy.field !== "string") {
        throw validationError(
          "INVALID_AGGREGATION",
          `Aggregation '${agg.name}': groupBy.field is required.`
        );
      }
      // Resolve to confirm the property exists (throws if unknown).
      await resolveProperty(objectTypeApiName, agg.groupBy.field);
    }
  }

  return body;
}

// ---------------------------------------------------------------------------
// Shared validation helpers
// ---------------------------------------------------------------------------

function validatePageSize(value: unknown, largePage: boolean = false): number {
  if (value === undefined || value === null) {
    observeHistogram("tellus_pagination_size", DEFAULT_PAGE_SIZE);
    return DEFAULT_PAGE_SIZE;
  }
  const ceiling = largePage ? MAX_EXPLORER_PAGE_SIZE_OPT_IN : MAX_EXPLORER_PAGE_SIZE;
  const num = Number(value);
  // `$pageSize: 0` is a valid "count-only" request — callers that only need
  // `totalCount` (e.g. the object-type overview's live-count reconciliation)
  // ask for zero rows. The executor still returns an accurate `totalCount`
  // (track_total_hits) and an empty `data` array.
  if (!Number.isInteger(num) || num < 0 || num > ceiling) {
    incCounter("tellus_pagination_rejected_total", {
      reason: !Number.isInteger(num) ? "non_integer" : num < 0 ? "underflow" : "overflow",
      large_page: largePage ? "true" : "false",
    });
    throw validationError(
      "PAGE_SIZE_OUT_OF_RANGE",
      `$pageSize must be an integer between 0 and ${ceiling}. Got: ${value}.`,
      "$pageSize"
    );
  }
  observeHistogram("tellus_pagination_size", num);
  return num;
}

/**
 * Read the explorer's `x-tellus-large-page` opt-in header. Anything
 * other than the literal lowercase string "true" is treated as false
 * (no silent toggling on stray values).
 */
export function readLargePageHeader(
  req: { get?: (n: string) => string | undefined; headers?: Record<string, unknown> } | undefined,
): boolean {
  if (!req) return false;
  const fromGet = typeof req.get === "function" ? req.get("x-tellus-large-page") : undefined;
  const fromHeaders = (req.headers as Record<string, unknown> | undefined)?.["x-tellus-large-page"];
  const raw = (fromGet ?? (fromHeaders as string | undefined)) ?? "";
  return String(raw).toLowerCase() === "true";
}

async function validateOrderBy(
  orderBy: any,
  objectTypeApiName: string
): Promise<void> {
  if (!Array.isArray(orderBy)) {
    throw validationError("INVALID_ORDER_BY", "$orderBy must be an array.", "$orderBy");
  }
  if (orderBy.length > MAX_ORDER_BY_FIELDS) {
    throw validationError(
      "INVALID_ORDER_BY",
      `$orderBy can have at most ${MAX_ORDER_BY_FIELDS} fields. Got: ${orderBy.length}.`,
      "$orderBy"
    );
  }
  for (const item of orderBy) {
    if (!item.field || typeof item.field !== "string") {
      throw validationError("INVALID_ORDER_BY", "$orderBy entries must have a 'field' string.", "$orderBy");
    }
    if (item.direction !== "asc" && item.direction !== "desc") {
      throw validationError(
        "INVALID_ORDER_BY",
        `$orderBy direction must be 'asc' or 'desc'. Got: '${item.direction}'.`,
        "$orderBy"
      );
    }
    const meta = await resolveProperty(objectTypeApiName, item.field);
    const effective = meta.baseType.endsWith("_array") ? meta.baseType.replace("_array", "") : meta.baseType;
    if (UNSORTABLE_TYPES.has(effective)) {
      throw validationError(
        "INVALID_ORDER_BY",
        `Cannot sort by property '${item.field}' of type '${meta.baseType}'. Sorting is supported for string, numeric, date, timestamp, and boolean properties.`,
        "$orderBy"
      );
    }
  }
}

async function validateSelect(
  select: any,
  objectTypeApiName: string
): Promise<void> {
  if (!Array.isArray(select)) {
    throw validationError("INVALID_SELECT", "$select must be an array of strings.", "$select");
  }
  if (select.length === 0) {
    throw validationError("INVALID_SELECT", "$select must contain at least one property.", "$select");
  }
  const allProps = await resolveAllProperties(objectTypeApiName);
  const validNames = [...allProps.keys()];

  for (const prop of select) {
    if (typeof prop !== "string") {
      throw validationError("INVALID_SELECT", `$select values must be strings. Got: ${typeof prop}.`, "$select");
    }
    if (!allProps.has(prop) && !SYSTEM_FIELDS.has(prop)) {
      throw validationError(
        "UNKNOWN_PROPERTY",
        `Unknown property '${prop}' in $select. Valid properties for object type '${objectTypeApiName}' are: ${validNames.join(", ")}.`,
        "$select"
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

export async function runSelfTests(): Promise<void> {
    let passed = 0;
    let failed = 0;

    function assert(condition: boolean, label: string) {
      if (condition) { passed++; console.log(`  PASS  ${label}`); }
      else { failed++; console.log(`  FAIL  ${label}`); }
    }

    async function expectThrow(fn: () => Promise<any>, label: string, containsMsg?: string) {
      try {
        await fn();
        failed++;
        console.log(`  FAIL  ${label} (did not throw)`);
      } catch (err: any) {
        if (containsMsg && !err.message.includes(containsMsg)) {
          failed++;
          console.log(`  FAIL  ${label} (threw but message missing '${containsMsg}': ${err.message})`);
        } else {
          passed++;
          console.log(`  PASS  ${label}`);
        }
      }
    }

    console.log("=== QueryValidator self-test ===");

    // 1. pageSize validation
    assert(validatePageSize(undefined) === 100, "Default pageSize is 100");
    assert(validatePageSize(50) === 50, "pageSize 50 accepted");
    assert(validatePageSize(0) === 0, "pageSize 0 accepted (count-only)");

    await expectThrow(
      () => Promise.resolve(validatePageSize(-1)),
      "pageSize -1 rejected",
      "$pageSize must be an integer"
    );

    await expectThrow(
      () => Promise.resolve(validatePageSize(10001)),
      "pageSize 10001 rejected",
      "$pageSize must be an integer"
    );

    // 2. Unexpected field
    await expectThrow(
      () => validateSearchQuery({ $pgeSize: 10 } as any, "TestType"),
      "Unexpected field '$pgeSize' rejected",
      "Unexpected field"
    );

    // 3. Invalid filter type
    await expectThrow(
      () => validateSearchQuery({ where: { type: "unknown" } } as any, "TestType"),
      "Unknown filter type rejected",
      "Unknown filter type"
    );

    // 4. Empty body is valid (no where, defaults to pageSize 100)
    try {
      const result = await validateSearchQuery({}, "TestType");
      assert(result.$pageSize === 100, "Empty body validates with default pageSize");
    } catch {
      assert(false, "Empty body validates with default pageSize");
    }

    // 5. Empty $select rejected
    await expectThrow(
      () => validateSearchQuery({ $select: [] }, "TestType"),
      "$select: [] rejected",
      "$select must contain at least one"
    );

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
