# TASK 9: Polymorphic Aggregation — Aggregate Across Implementing Object Types

## Objective
Build the API endpoint for aggregating data across all Object Types that implement a given Interface. This is the aggregation counterpart to the polymorphic search in Task 8. For example, "count all objects with a location" or "average latitude across all locatable entities."

## Exact Specification

**Endpoint:** `POST /api/v2/ontology/:ontologyId/interfaces/:interfaceApiName/aggregate`

**Request Body:**
```json
{
  "where": {
    "type": "gt",
    "field": "latitude",
    "value": -3.0
  },
  "aggregations": [
    { "type": "count", "name": "totalLocations" },
    { "type": "avg", "field": "latitude", "name": "avgLatitude" },
    { "type": "terms", "field": "__objectType", "name": "byType", "size": 20 }
  ]
}
```

Note the special `__objectType` field in the terms aggregation — this is a system field present on every indexed document that stores the Object Type api_name. It allows grouping by Object Type even in a cross-type aggregation.

**Implementation Algorithm:**

This follows the same pattern as Task 8 but for aggregations:

Implement the aggregation merge logic in a new exported function `mergeAggregationResults(perTypeResults, aggregationSpec)` in `/src/services/queryTranslator.js`. The route handler in `/src/routes/interfaces.js` calls this function after collecting per-Object-Type results from OpenSearch.

Step 1: Look up Interface, get all implementing Object Types with property mappings (same as Task 8).

Step 2: For each implementing Object Type, translate the `where` filter and the aggregation field names using the property mapping. The `__objectType` field does NOT need translation — it exists on every document with the same name.

Step 3: Execute the translated aggregation queries against each Object Type's OpenSearch index using `_msearch`.

Step 4: Merge the aggregation results across all Object Types. The merge strategy depends on the aggregation type:
- `count`: Sum the counts from all Object Types
- `avg`: Compute a weighted average: `(sum_of_all_values) / (total_count)`. You need to request both `sum` and `count` from OpenSearch to compute this correctly. Do NOT simply average the averages — that gives incorrect results when the Object Types have different numbers of objects.
- `sum`: Sum the sums from all Object Types
- `min`: Take the minimum across all Object Types
- `max`: Take the maximum across all Object Types
- `terms`: Merge term buckets from all Object Types. If the same term appears in multiple Object Types (unlikely for most fields, but possible), sum their counts. For the `__objectType` terms aggregation, each Object Type naturally contributes one bucket.
- `date_histogram`: Merge buckets by date key (ISO 8601 date strings), summing counts for matching dates. The caller specifies `interval` (e.g., `day`, `week`, `month`) in the aggregation definition — pass this through to OpenSearch's `calendar_interval` parameter.

The weighted average calculation is critical and easy to get wrong. Here's the correct approach:

```javascript
// WRONG: Simple average of averages
const avgLatitude = (airportAvg + warehouseAvg) / 2; // WRONG if counts differ

// CORRECT: Weighted average
const airportResult = { sum: 15.5, count: 5 }; // from OpenSearch sum_and_count agg
const warehouseResult = { sum: 8.2, count: 3 };
const avgLatitude = (airportResult.sum + warehouseResult.sum) / (airportResult.count + warehouseResult.count);
// = 23.7 / 8 = 2.9625
```

For the OpenSearch query, when the caller requests `avg`, you must actually request a `stats` aggregation from OpenSearch (which returns count, min, max, avg, and sum) so you have the `sum` and `count` values needed for correct cross-index weighted averaging.

Step 5: If the `where` filter references an unmapped optional property, exclude that Object Type from the aggregation (same rule as Task 8).

**Response (HTTP 200):**
```json
{
  "data": {
    "totalLocations": 10,
    "avgLatitude": -1.8532,
    "byType": [
      { "key": "Airport", "count": 5 },
      { "key": "Warehouse", "count": 3 },
      { "key": "StoreFront", "count": 2 }
    ]
  }
}
```

**Edge cases:**
1. If no implementing Object Types exist → return all aggregations as 0 or empty arrays
2. If all implementing Object Types are excluded by unmapped filter fields → same as above
3. If count is 0, avg should return `null` (not 0, not NaN) — division by zero must be handled
4. terms aggregation with `size` parameter → the size applies to the MERGED result, not per-index. So you may need to request more than `size` terms from each index, merge, sort by count descending, and truncate to `size`. A safe approach: request `size * 2` from each index, merge, then truncate.
   Note: The `size * 2` request is a heuristic. If the merged result has fewer unique terms than `size`, return all of them. The truncation to `size` only applies after merging and sorting by count descending.

## Verification
1. Create HasLocation Interface, implement with Airport (5 objects), Warehouse (3 objects)
2. Aggregate count → verify returns 8
3. Aggregate avg(latitude) → verify weighted average (not simple average of averages)
4. Aggregate terms(__objectType) → verify two buckets: Airport=5, Warehouse=3
5. Aggregate with a where filter that excludes some objects → verify filtered counts
6. Aggregate with 0 matching objects → verify null avg, count=0
