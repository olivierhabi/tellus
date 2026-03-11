# TASK 12: Create the POST /objects/:objectType/search Endpoint

**File to modify:** `/src/routes/objects.js`

**Purpose:** This is the primary search endpoint — the most important endpoint in the entire Object Set Service. Every application that displays filtered lists of objects uses this endpoint. In Palantir's Ontology, this powers: Object Table widgets in Workshop (with server-side filtering), Object Explorer search results, the OSDK's `client(Employee).where({ department: 'Engineering' }).fetchPage()` method, and the Function runtime's `Objects.search().employees().filter(...)` API. This endpoint must handle the complete query DSL including compound filters, support pagination, sorting, property selection, and return results in the exact Palantir response format.

**Endpoint specification:**

```
POST /api/v2/objects/:objectType/search
Content-Type: application/json
```

**Request body:**
```json
{
  "where": {
    "type": "and",
    "value": [
      { "type": "eq", "field": "department", "value": "Engineering" },
      { "type": "gt", "field": "salary", "value": 100000 },
      { "type": "not", "value": [
        { "type": "eq", "field": "status", "value": "terminated" }
      ]}
    ]
  },
  "$orderBy": [
    { "field": "salary", "direction": "desc" },
    { "field": "fullName", "direction": "asc" }
  ],
  "$pageSize": 50,
  "$pageToken": null,
  "$select": ["employeeId", "fullName", "salary", "department"]
}
```

**Implementation step by step:**

1. **Validate the object type exists.** Same pattern as Tasks 10 and 11.

2. **Validate the request body.** Call `queryValidator.validateSearchQuery(req.body, objectType)` from Task 2. If validation fails, return 400 with the validation error details.

3. **Translate the `where` clause.** Call `queryTranslator.translateFilter(req.body.where, objectType, propertyResolver)` from Tasks 3–5. If the `where` clause is not provided (meaning "no filter, return all objects"), use `{ "match_all": {} }` as the OpenSearch query.

4. **Build the sort clause.** Call `paginationService.buildSortClause(req.body.$orderBy, objectType, propertyResolver)` from Task 6. Remember: always append `__pk` as a tiebreaker.

5. **Handle pagination.** If `$pageToken` is provided, decode it and extract the `search_after` values. Validate that the token belongs to this object type and this query.

6. **Build the complete OpenSearch query:**
   ```javascript
   const opensearchQuery = {
     query: translatedFilter,        // from step 3
     sort: sortClause,                // from step 4
     size: (pageSize || 100) + 1,     // +1 for next-page detection
     track_total_hits: true,          // get exact total count
     _source: selectProperties ? [...selectProperties, '__pk', '__objectType', '__lastModified', '__version'] : true
   };
   
   if (searchAfter) {
     opensearchQuery.search_after = searchAfter;  // from step 5
   }
   ```

7. **Execute the query.** Call the OpenSearch `_search` API on the correct index.

8. **Process the response:**
   - Extract `hits.hits` (the matching documents)
   - Extract `hits.total.value` (the total count)
   - If we got `pageSize + 1` results, there are more pages — create a page token from the `pageSize`-th result
   - Take only the first `pageSize` results (discard the extra one used for detection)
   - Format using the response formatter (Task 7)

9. **Return the response.** HTTP 200 with:
   ```json
   {
     "data": [...formatted objects...],
     "nextPageToken": "eyJ..." | null,
     "totalCount": 1523
   }
   ```

**Edge cases to handle specifically:**

- **`where` is null/undefined:** This means "no filter." Use `{ "match_all": {} }`. Return all objects paginated.
- **`where` is an empty object `{}`:** Same as null — no filter.
- **`$orderBy` is not provided:** Default sort is `__pk` ascending.
- **`$pageSize` is not provided:** Default to 100.
- **`$select` is an empty array:** Should have been rejected by validator. But as a safety net, treat as "select all."
- **Query matches zero objects:** Return `{ "data": [], "nextPageToken": null, "totalCount": 0 }`. This is NOT an error — HTTP 200 with empty data.
- **Very complex nested query with 100+ conditions:** The query should execute normally. OpenSearch handles complex bool queries efficiently. But set a timeout of 30 seconds on the OpenSearch request to prevent indefinite hangs.

**Logging:** Log every search request with: the object type, a compact representation of the `where` clause (JSON stringify, truncated to 200 chars), the number of results, the total count, and the response time. Example: `[2025-03-12T14:30:00Z] POST /api/v2/objects/Employee/search where={"type":"and","value":[{"type":"eq"...]} → 200 (50/1523 objects, 89ms)`

**Test cases:**
1. Search with no filter → returns all objects paginated
2. Search with single `eq` filter → returns only matching objects
3. Search with compound `and` + `or` + `not` → returns correct subset
4. Search with `$orderBy` → results are correctly sorted
5. Search with `$select` → only selected properties in response
6. Search with `$pageSize=10` → exactly 10 results, `nextPageToken` present
7. Follow the `nextPageToken` → get next page, no duplicates
8. Paginate through ALL results → every object appears exactly once
9. Search with filter that matches nothing → empty data, totalCount 0
10. Search with invalid property name in filter → 400 error with helpful message
