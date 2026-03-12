// ---------------------------------------------------------------------------
// Shared Constants (Task 21)
//
// All magic numbers, limits, and default values in one place.
// Palantir's documented limits are the source of truth.
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 100;
export const MIN_PAGE_SIZE = 1;
export const MAX_PAGE_SIZE = 10_000;

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
];

export const SUPPORTED_AGGREGATION_TYPES = [
  "count", "avg", "sum", "min", "max",
  "terms", "date_histogram", "range", "cardinality",
];

export const SUPPORTED_HISTOGRAM_INTERVALS = [
  "year", "quarter", "month", "week", "day", "hour", "minute",
];
