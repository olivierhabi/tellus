# TASK 8: Create the Aggregation Builder Service

**File to create:** `/src/services/aggregationBuilder.js`

**Purpose:** The aggregation endpoint allows consumers to compute statistical summaries over object sets — counts, averages, sums, minimums, maximums, and grouped distributions (terms buckets, date histograms). In Palantir's Ontology, aggregations are computed by the Object Set Service by translating aggregation requests into OpenSearch aggregation queries. This is how dashboards show KPI cards ("Average salary: $125K"), bar charts ("Employees by department"), and time series ("Hires per month").

**Palantir's aggregation API (from their documentation):**

The aggregate endpoint accepts a `where` clause (same as the search endpoint) to filter which objects are aggregated, plus an `aggregations` array that specifies what to compute.

**Supported aggregation types (copy Palantir exactly):**

1. **`count`** — Total number of matching objects. Does not require a `field` parameter. Translates to OpenSearch's track_total_hits.

2. **`avg`** — Average value of a numeric property. Requires `field` (must be numeric: integer, long, double, float, decimal). Translates to OpenSearch `avg` aggregation.

3. **`sum`** — Sum of values of a numeric property. Requires `field` (must be numeric). Translates to OpenSearch `sum` aggregation.

4. **`min`** — Minimum value. Requires `field` (numeric or date/timestamp). Translates to OpenSearch `min` aggregation.

5. **`max`** — Maximum value. Requires `field` (numeric or date/timestamp). Translates to OpenSearch `max` aggregation.

6. **`terms`** — Group by a property and count per group. Requires `field` (must be a keyword-able field: string, boolean, integer — NOT text-analyzed fields). Optional `size` parameter (default: 10, max: 1000) for the number of buckets to return. Translates to OpenSearch `terms` aggregation.

7. **`date_histogram`** — Group by time intervals. Requires `field` (must be date or timestamp) and `interval` (one of: `"year"`, `"quarter"`, `"month"`, `"week"`, `"day"`, `"hour"`, `"minute"`). Translates to OpenSearch `date_histogram` aggregation with the `calendar_interval` parameter.

8. **`range`** — Group by custom numeric ranges. Requires `field` (numeric) and `ranges` (array of `{ "from": number, "to": number }` objects). Translates to OpenSearch `range` aggregation.

9. **`cardinality`** — Count of distinct values. Requires `field`. Translates to OpenSearch `cardinality` aggregation (uses HyperLogLog, so it's an approximation for large datasets).

**Implementation details:**

Create a function `buildAggregations(aggregationDefinitions, objectTypeApiName, propertyResolver)` that takes the array of aggregation definitions from the request body and produces the OpenSearch `aggs` clause.

For each aggregation definition:

The definition has: `type` (required), `name` (required — used as the key in the response), `field` (required for most types), and type-specific parameters (`size`, `interval`, `ranges`).

**For `count`:**
```javascript
// Input: { "type": "count", "name": "totalEmployees" }
// This doesn't need an OpenSearch aggregation — we get the count from hits.total.value
// But we still track it so the response formatter knows to include it
// No OpenSearch aggs clause needed for this type
```

**For `avg`:**
```javascript
// Input: { "type": "avg", "field": "salary", "name": "avgSalary" }
// Resolve field: salary → OpenSearch field "salary" (numeric, no sub-field needed)
// Output:
{ "avgSalary": { "avg": { "field": "salary" } } }
```

**For `sum`:**
```javascript
// Input: { "type": "sum", "field": "salary", "name": "totalPayroll" }
{ "totalPayroll": { "sum": { "field": "salary" } } }
```

**For `min`:**
```javascript
// Input: { "type": "min", "field": "startDate", "name": "earliestHire" }
{ "earliestHire": { "min": { "field": "startDate" } } }
```

**For `max`:**
```javascript
// Input: { "type": "max", "field": "salary", "name": "highestSalary" }
{ "highestSalary": { "max": { "field": "salary" } } }
```

**For `terms`:**
```javascript
// Input: { "type": "terms", "field": "department", "name": "byDepartment", "size": 20 }
// CRITICAL: For string properties, use the .keyword sub-field
// Terms aggregation on analyzed text fields produces meaningless token-level buckets
{ "byDepartment": { "terms": { "field": "department.keyword", "size": 20 } } }

// For non-string properties (integer, boolean), use field directly:
// Input: { "type": "terms", "field": "isActive", "name": "byStatus" }
{ "byStatus": { "terms": { "field": "isActive", "size": 10 } } }
```

**For `date_histogram`:**
```javascript
// Input: { "type": "date_histogram", "field": "startDate", "interval": "month", "name": "hiresByMonth" }
// Use calendar_interval (not fixed_interval) for human-readable intervals
{ 
  "hiresByMonth": { 
    "date_histogram": { 
      "field": "startDate", 
      "calendar_interval": "month",
      "format": "yyyy-MM",        // human-readable key format
      "min_doc_count": 0           // include empty buckets
    } 
  } 
}

// Interval mapping:
// "year" → "year", format: "yyyy"
// "quarter" → "quarter", format: "yyyy-QQQ"
// "month" → "month", format: "yyyy-MM"
// "week" → "week", format: "yyyy-'W'ww"
// "day" → "day", format: "yyyy-MM-dd"
// "hour" → "hour", format: "yyyy-MM-dd'T'HH"
// "minute" → "minute", format: "yyyy-MM-dd'T'HH:mm"
```

**For `range`:**
```javascript
// Input: { "type": "range", "field": "salary", "name": "salaryBands", 
//          "ranges": [{"to": 50000}, {"from": 50000, "to": 100000}, {"from": 100000, "to": 200000}, {"from": 200000}] }
{ 
  "salaryBands": { 
    "range": { 
      "field": "salary",
      "ranges": [
        { "to": 50000 },
        { "from": 50000, "to": 100000 },
        { "from": 100000, "to": 200000 },
        { "from": 200000 }
      ]
    } 
  } 
}
```

**For `cardinality`:**
```javascript
// Input: { "type": "cardinality", "field": "department", "name": "uniqueDepartments" }
// For string fields, use .keyword
{ "uniqueDepartments": { "cardinality": { "field": "department.keyword" } } }
```

**Validation within this service:**

Even though the query validator (Task 2) handles basic structure validation, the aggregation builder must also validate type compatibility:
- `avg`, `sum` only work on numeric types (integer, long, double, float, decimal). If the field is a string or date, throw: `"Aggregation type 'avg' requires a numeric property. Property '${field}' is of type '${baseType}'."`.
- `min`, `max` work on numeric types AND date/timestamp types.
- `terms` works on all types EXCEPT `geopoint`, `geoshape`, and `struct`. For string types, MUST use `.keyword` sub-field.
- `date_histogram` only works on `date` and `timestamp` types.
- `range` only works on numeric types.
- `cardinality` works on all types except `struct`.

**Multiple aggregations in one request:** The consumer can request multiple aggregations in a single request. The function must combine all of them into a single `aggs` clause:

```javascript
// Multiple aggregations combined:
{
  "aggs": {
    "avgSalary": { "avg": { "field": "salary" } },
    "maxSalary": { "max": { "field": "salary" } },
    "byDepartment": { "terms": { "field": "department.keyword", "size": 20 } },
    "hiresByYear": { "date_histogram": { "field": "startDate", "calendar_interval": "year", "format": "yyyy", "min_doc_count": 0 } }
  }
}
```

**Aggregation names must be unique.** If two aggregations in the request have the same `name`, throw an error: `"Duplicate aggregation name '${name}'. Each aggregation must have a unique name."`.

**Export:** `{ buildAggregations, validateAggregationDefinitions }`
