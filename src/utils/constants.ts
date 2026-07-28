// ---------------------------------------------------------------------------
// Shared Constants (Task 21)
//
// All magic numbers, limits, and default values in one place.
// Palantir's documented limits are the source of truth.
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 100;
export const MIN_PAGE_SIZE = 1;
export const MAX_PAGE_SIZE = 10_000;

// T-09 — explorer-specific page-size caps. The legacy MAX_PAGE_SIZE
// remains 10_000 for non-explorer callers (datasets, edits, reindex
// status — which all have their own cap regimes). The explorer surface
// (`queryValidator.validatePageSize`) uses these tighter bounds:
//   - MAX_EXPLORER_PAGE_SIZE       = 1000  — Foundry default per §7
//   - MAX_EXPLORER_PAGE_SIZE_OPT_IN= 2000  — opt-in via header
//                                     `x-tellus-large-page: true`
// See decisions/object-explorer/D-2026-04-30-004-page-size-cap.md.
export const MAX_EXPLORER_PAGE_SIZE = 1_000;
export const MAX_EXPLORER_PAGE_SIZE_OPT_IN = 2_000;

export const DEFAULT_SEARCH_AROUND_LIMIT = 100_000;
export const MAX_AFFECTED_OBJECTS_PER_ACTION = 10_000;
export const MAX_PROPERTIES_PER_OBJECT_TYPE = 2_000;

export const MAX_IN_CLAUSE_VALUES = 10_000;
export const MAX_FILTER_NESTING_DEPTH = 10;
export const MAX_COMPOUND_FILTER_CHILDREN = 100;
export const MAX_ORDER_BY_FIELDS = 5;

export const MAX_AGGREGATIONS_PER_REQUEST = 25;
export const MAX_TERMS_BUCKET_SIZE = 1_000;
export const DEFAULT_TERMS_BUCKET_SIZE = 10;

export const MAX_SEARCH_QUERY_LENGTH = 1_000;

export const OPENSEARCH_QUERY_TIMEOUT = "30s";
export const OPENSEARCH_SLOW_QUERY_THRESHOLD_MS = 5_000;

export const PROPERTY_CACHE_TTL_MS = 60_000;
export const PAGE_TOKEN_MAX_AGE_MS = 86_400_000; // 24 hours

export const OPENSEARCH_MAX_RETRIES = 3;
export const OPENSEARCH_RETRY_INITIAL_DELAY_MS = 100;

export const SYSTEM_FIELDS = ["__pk", "__objectType", "__lastModified", "__version"];

export const SUPPORTED_FILTER_TYPES = [
  "eq", "gt", "gte", "lt", "lte",
  "contains", "startsWith",
  "isNull", "isNotNull",
  "in",
  "and", "or", "not",
  // Phase 6 — SearchJsonQueryV2 parity (verified against
  // @osdk/foundry.ontologies@2.69.0). These are additions to the
  // ONE internal filter language; both v1 and v2 compile to them.
  "containsAllTerms", "containsAnyTerm",
  "containsAllTermsInOrder", "containsAllTermsInOrderPrefixLastTerm",
  "wildcard", "regex", "interval",
  "withinBoundingBox", "withinDistanceOf", "withinPolygon",
  "intersectsBoundingBox", "intersectsPolygon",
  "doesNotIntersectBoundingBox", "doesNotIntersectPolygon",
  "geoShapeV2",
];

export const SUPPORTED_AGGREGATION_TYPES = [
  "count", "avg", "sum", "min", "max",
  "terms", "date_histogram", "range", "cardinality",
];

export const SUPPORTED_HISTOGRAM_INTERVALS = [
  "year", "quarter", "month", "week", "day", "hour", "minute",
];
