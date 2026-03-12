# TASK 25: Wire the POST /objects/:objectType/searchFullText Endpoint with All Services

**File to modify:** `/src/routes/objects.js`

**Dependencies:** Tasks 1, 2, 6, 7, 9, 15, 17, 18, 21.

**Purpose:** Write the route handler function for `POST /api/v2/objects/:objectType/searchFullText` that orchestrates the full-text search pipeline by calling existing services. This handler must be wrapped in `asyncHandler` (from Task 15).

**The handler must perform these steps in order:**

1. **Validate the object type exists** by calling `propertyResolver.resolveAllProperties(req.params.objectType)`. Throws `ObjectTypeNotFoundError` if not found.

2. **Build the OpenSearch query** via `opensearchQueryBuilder.buildFullTextQuery({ objectTypeApiName: req.params.objectType, queryString: req.body.query, where: req.body.where, pageSize: req.body.$pageSize || 100, pageToken: req.body.$pageToken, select: req.body.$select, propertyResolver })`. This is the only service call the handler makes for query construction. Internally, `buildFullTextQuery` performs all the following (the handler does NOT call these directly):
   - Validates `req.body.query` is a non-empty string with max 1000 characters (throws `QueryValidationError` if invalid)
   - Calls `fullTextSearchService.buildFullTextSearchQuery()` to build the `multi_match` query and `highlight` clause
   - If `where` is present: validates it via `queryValidator.validateSearchQuery()`, then translates it via `queryTranslator.translateFilter()`, then combines: `{ bool: { must: [multiMatchQuery], filter: [translatedWhere] } }`
   - If `$orderBy` is absent: defaults to `[{ "_score": { "order": "desc" } }, { "__pk": { "order": "asc" } }]` (relevance sorting). If `$orderBy` is present, uses `paginationService.buildSortClause()` instead.
   - Decodes `$pageToken` via `paginationService.decodePageToken()` if present
   Returns `{ index, body }` where `body` includes the `highlight` configuration.

3. **Execute the query** via `opensearchClient.searchObjects(query.index, query.body)`. Returns the raw OpenSearch response.

4. **Format the response** via `objectResponseFormatter.formatObjectList(opensearchResponse, req.params.objectType, allPropertyApiNames, req.body.$select, req.body.$pageToken, opensearchResponse.hits.total.value)` where `allPropertyApiNames` comes from step 1's `resolveAllProperties` call. The formatter extracts `hit.highlight` from each OpenSearch hit and includes it as `__highlights` (with `<mark>` tags around matched terms) on each response object (implemented in Task 7).

5. **Return HTTP 200** with `res.json(formattedResponse)`.

**Key differences from the search endpoint (Task 23):**
- Default sort is `_score` descending (relevance) instead of `__pk` ascending
- Response objects include `__highlights` field when highlights are present in OpenSearch response
- Requires a `query` string parameter (not just a `where` clause)
- Uses `multi_match` query instead of filter translation for the primary query

**The function body must not exceed 50 lines of code (excluding comments).**

**Error handling:** All errors are thrown by the services and caught by `asyncHandler`. The handler itself does NOT contain try/catch blocks.

**Logging:** Log a structured info line after successful response:
```json
{"level":"info","type":"search_fulltext","objectType":"Employee","query":"melissa chang","resultCount":3,"durationMs":67,"requestId":"..."}
```

**Acceptance criteria (from Task 14's test cases):**
1. `POST /objects/Employee/searchFullText` with `{ "query": "melissa chang" }` → 200, returns matching employees sorted by relevance
2. `POST /objects/Employee/searchFullText` with `{ "query": "engineering python" }` → 200, multi-term cross-field search works
3. `POST /objects/Employee/searchFullText` with `{ "query": "EMP-001" }` → 200, primary key search with boosted ranking (EMP-001 appears first)
4. `POST /objects/Employee/searchFullText` with `{ "query": "melisa" }` → 200, fuzzy match finds "Melissa" despite typo
5. `POST /objects/Employee/searchFullText` with `{ "query": "chang", "where": { "type": "eq", "field": "department", "value": "Engineering" } }` → 200, combined full-text + filter
6. `POST /objects/Employee/searchFullText` with `{ "query": "melissa", "$select": ["fullName"] }` → 200, response includes `fullName`, `__primaryKey`, `__objectType`, and `__highlights` with `<mark>` tags around matched terms (e.g., `"<mark>Melissa</mark>"`)
7. `POST /objects/Employee/searchFullText` with `{ "query": "" }` → 400 with `INVALID_QUERY` and message `"Search query must be a non-empty string."`
8. `POST /objects/Employee/searchFullText` with query > 1000 chars → 400 with `INVALID_QUERY`
9. `POST /objects/Employee/searchFullText` with `{ "query": "nonexistent term xyz" }` → 200, empty data array, totalCount 0
