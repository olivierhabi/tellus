# TASK 21: Create a Constants File for Shared Values

**File to create:** `/src/utils/constants.js`

**Purpose:** All magic numbers, limits, and default values must be defined in one place. This prevents inconsistencies (one endpoint using 100 as default page size while another uses 50) and makes it easy to adjust limits later. Palantir's documented limits are the source of truth for these values.

**Constants to define (with Palantir documentation references):**

```javascript
module.exports = {
  // Pagination
  DEFAULT_PAGE_SIZE: 100,
  MIN_PAGE_SIZE: 1,
  MAX_PAGE_SIZE: 10000,
  
  // Search Around (from Palantir: "default Search Around limit is 100,000 objects")
  DEFAULT_SEARCH_AROUND_LIMIT: 100000,
  
  // Actions (from Palantir: default max affected objects is 10,000)
  MAX_AFFECTED_OBJECTS_PER_ACTION: 10000,
  
  // Properties (from Palantir: "Supports a maximum of 2000 properties per object type")
  MAX_PROPERTIES_PER_OBJECT_TYPE: 2000,
  
  // Filters
  MAX_IN_CLAUSE_VALUES: 10000,
  MAX_FILTER_NESTING_DEPTH: 10,
  MAX_COMPOUND_FILTER_CHILDREN: 100,
  MAX_ORDER_BY_FIELDS: 5,
  
  // Aggregations
  MAX_AGGREGATIONS_PER_REQUEST: 25,
  MAX_TERMS_BUCKET_SIZE: 1000,
  DEFAULT_TERMS_BUCKET_SIZE: 10,
  
  // Full-text search
  MAX_SEARCH_QUERY_LENGTH: 1000,
  
  // Timeouts
  OPENSEARCH_QUERY_TIMEOUT: '30s',
  OPENSEARCH_SLOW_QUERY_THRESHOLD_MS: 5000,
  
  // Cache
  PROPERTY_CACHE_TTL_MS: 60000,
  
  // Page token
  PAGE_TOKEN_MAX_AGE_MS: 86400000, // 24 hours
  
  // Indexing (from Palantir: "2 MB/s per object type into OSv2 object database")
  INDEXING_THROUGHPUT_LIMIT_BYTES_PER_SEC: 2 * 1024 * 1024,
  
  // OpenSearch retry
  OPENSEARCH_MAX_RETRIES: 3,
  OPENSEARCH_RETRY_INITIAL_DELAY_MS: 100,
  
  // System fields present on every object
  SYSTEM_FIELDS: ['__pk', '__objectType', '__lastModified', '__version'],
  
  // Supported base types
  SUPPORTED_BASE_TYPES: [
    'string', 'boolean', 'integer', 'long', 'double', 'float',
    'date', 'timestamp', 'byte', 'short', 'decimal',
    'geopoint', 'geoshape',
    'string_array', 'integer_array', 'double_array', 'boolean_array',
    'timestamp_array',
    'struct'
  ],
  
  // Filter types
  SUPPORTED_FILTER_TYPES: [
    'eq', 'gt', 'gte', 'lt', 'lte',
    'contains', 'startsWith',
    'isNull', 'isNotNull',
    'in',
    'and', 'or', 'not'
  ],
  
  // Aggregation types
  SUPPORTED_AGGREGATION_TYPES: [
    'count', 'avg', 'sum', 'min', 'max',
    'terms', 'date_histogram', 'range', 'cardinality'
  ],
  
  // Date histogram intervals
  SUPPORTED_HISTOGRAM_INTERVALS: ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute'],
};
```

Every service created in Tasks 1–20 and Tasks 22–30 must import and use these constants instead of hardcoded values.
