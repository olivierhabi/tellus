# TASK 13: Create the POST /objects/:objectType/aggregate Endpoint

**File to modify:** `/src/routes/objects.js`

**Purpose:** The aggregate endpoint computes statistical summaries over a set of objects, optionally filtered by a `where` clause. This is what powers KPI cards ("Total revenue: $4.2M"), bar charts ("Orders by region"), and time series visualizations ("Monthly hires over the past 3 years") in Palantir's Workshop. Unlike the search endpoint which returns individual objects, the aggregate endpoint returns computed values — it doesn't return any objects themselves.

**Endpoint specification:**

```
POST /api/v1/objects/:objectType/aggregate
Content-Type: application/json
```

**Request body:**
```json
{
  "where": {
    "type": "eq",
    "field": "department",
    "value": "Engineering"
  },
  "aggregations": [
    { "type": "count", "name": "totalEmployees" },
    { "type": "avg", "field": "salary", "name": "avgSalary" },
    { "type": "max", "field": "salary", "name": "maxSalary" },
    { "type": "terms", "field": "skills", "name": "topSkills", "size": 10 },
    { "type": "date_histogram", "field": "startDate", "interval": "year", "name": "hiresByYear" }
  ]
}
```

**Implementation step by step:**

1. **Validate object type** — same as other endpoints.

2. **Validate aggregation definitions.** Call `aggregationBuilder.validateAggregationDefinitions(req.body.aggregations, objectType, propertyResolver)` which checks: each aggregation has a `type` and `name`, field references exist on the object type, field types are compatible with the aggregation type (e.g., `avg` only on numeric fields), no duplicate `name` values, and the aggregations array is not empty and has at most 25 aggregations per request.

3. **Translate the `where` clause** — same as the search endpoint. If not provided, aggregate over ALL objects.

4. **Build the aggregations** — call `aggregationBuilder.buildAggregations(req.body.aggregations, objectType, propertyResolver)` from Task 8.

5. **Build the complete OpenSearch query:**
   ```javascript
   const opensearchQuery = {
     query: translatedFilter || { match_all: {} },
     aggs: builtAggregations,
     size: 0,           // CRITICAL: we don't want any hits, only aggregation results
     track_total_hits: true
   };
   ```
   Setting `size: 0` is important — we only want the aggregation results, not the actual documents. This is significantly faster because OpenSearch doesn't need to sort, paginate, or fetch document sources.

6. **Execute the query** on OpenSearch.

7. **Format the response** using `objectResponseFormatter.formatAggregationResponse()` from Task 7. The formatted response must handle the `count` aggregation specially — it comes from `hits.total.value`, not from an OpenSearch aggregation bucket.

8. **Return the response.** HTTP 200 with:
   ```json
   {
     "data": {
       "totalEmployees": 450,
       "avgSalary": 142350.75,
       "maxSalary": 310000,
       "topSkills": [
         { "key": "Python", "count": 312 },
         { "key": "TypeScript", "count": 287 },
         { "key": "SQL", "count": 265 }
       ],
       "hiresByYear": [
         { "key": "2021", "count": 45 },
         { "key": "2022", "count": 120 },
         { "key": "2023", "count": 180 },
         { "key": "2024", "count": 105 }
       ]
     }
   }
   ```

**Handling missing/null values in aggregations:** OpenSearch automatically excludes null values from numeric aggregations (avg, sum, min, max). For `terms` aggregations, OpenSearch has a `missing` parameter that can create a bucket for null values. By default, we do NOT include a missing bucket — null values are simply excluded. If needed later, this can be made configurable.

**Handling the `count` aggregation alongside others:** The `count` type is special because it doesn't produce an OpenSearch aggregation — it comes from `hits.total.value`. The aggregation builder should flag `count` types so the response formatter knows to extract it from the total hits rather than from the `aggregations` section of the OpenSearch response.

**Empty result set:** If the `where` clause filters out ALL objects, all metric aggregations (`avg`, `sum`, `min`, `max`) return `null` (because you can't compute an average of zero numbers). `count` returns `0`. `terms` returns an empty array. `date_histogram` returns an empty array (unless `min_doc_count: 0` is set, in which case it returns buckets with count 0 for each interval in the range).

**Test cases:**
1. Aggregate with no filter → aggregates over all objects
2. Aggregate with filter → aggregates only over matching objects
3. Count aggregation → returns correct total
4. Avg on numeric field → returns correct average
5. Terms on string field → returns correct bucket counts
6. Date histogram on date field → returns correct time series
7. Multiple aggregations in one request → all return correct values
8. Aggregate on empty result set → metrics return null, count returns 0
9. Aggregate with avg on non-numeric field → 400 error
10. Aggregate with duplicate names → 400 error
