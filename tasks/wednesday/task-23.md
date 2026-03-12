# TASK 23: Wire the POST /objects/:objectType/search Endpoint with All Services

**File to modify:** `/src/routes/objects.js`

**Dependencies:** Tasks 1, 2, 3-5, 6, 7, 15, 17, 18, 21.

**Relationship to Task 12:** Task 12 defines the endpoint specification (behavior, edge cases, test cases). This task (Task 23) implements the actual route handler by wiring together the services. Do not implement the endpoint directly from Task 12's inline implementation steps — those are superseded by the service call pipeline below.

**Purpose:** Write the route handler function for `POST /api/v2/objects/:objectType/search` that orchestrates the filtered-search pipeline by calling existing services. This handler must be wrapped in `asyncHandler` (from Task 15).

**The handler must perform these steps in order:**

1. **Validate the object type exists** by calling `propertyResolver.resolveAllProperties(req.params.objectType)`. If the object type does not exist, PropertyResolver throws `ObjectTypeNotFoundError`.

2. **Validate the request body** via `queryValidator.validateSearchQuery(req.body, req.params.objectType)`. Returns the validated body with `$pageSize` defaulted to 100 if absent.

3. **Build the OpenSearch query** via `opensearchQueryBuilder.buildSearchQuery({ objectTypeApiName: req.params.objectType, where: req.body.where, pageSize: validated.$pageSize, pageToken: req.body.$pageToken, orderBy: req.body.$orderBy, select: req.body.$select, propertyResolver })`. This internally calls:
   - `queryTranslator.translateFilter()` to translate the `where` clause (or uses `{ match_all: {} }` if no `where`)
   - `paginationService.buildSortClause()` for sorting
   - `paginationService.decodePageToken()` if a page token is present
   Returns `{ index, body }`.

4. **Execute the query** via `opensearchClient.searchObjects(query.index, query.body)`. Returns the raw OpenSearch response.

5. **Format the response** via `objectResponseFormatter.formatObjectList(opensearchResponse, req.params.objectType, allPropertyApiNames, req.body.$select, req.body.$pageToken, opensearchResponse.hits.total.value)` where `allPropertyApiNames` comes from step 1's `resolveAllProperties` call.

6. **Return HTTP 200** with `res.json(formattedResponse)`.

**The function body must not exceed 50 lines of code (excluding comments).**

**Error handling:** All errors are thrown by the services and caught by `asyncHandler`. The handler itself does NOT contain try/catch blocks.

**Logging:** Log a structured info line after successful response:
```json
{"level":"info","type":"search_objects","objectType":"Employee","hasFilter":true,"resultCount":42,"durationMs":89,"requestId":"..."}
```

**Acceptance criteria (from Task 12's test cases):**
1. `POST /objects/Employee/search` with empty body → 200, returns all employees (match_all)
2. `POST /objects/Employee/search` with `{ "where": { "type": "eq", "field": "department", "value": "Engineering" } }` → 200, returns only Engineering employees
3. `POST /objects/Employee/search` with compound `and`/`or` filters → 200, correct subset
4. `POST /objects/Employee/search` with `$orderBy`, `$pageSize`, `$select` → 200, sorted/paginated/filtered response
5. `POST /objects/Employee/search` with `$pageToken` → 200, returns next page continuing from cursor
6. Full pagination traversal (repeat with `$pageToken` until null) → all objects returned exactly once, no duplicates
7. `POST /objects/Employee/search` with filter matching 0 objects → 200, `{ "data": [], "nextPageToken": null, "totalCount": 0 }`
8. `POST /objects/Employee/search` with invalid filter type → 400 with `INVALID_QUERY`
9. `POST /objects/Employee/search` with unknown property in filter → 400 with `PROPERTY_NOT_FOUND`
10. `POST /objects/NonExistent/search` → 404 with `OBJECT_TYPE_NOT_FOUND`
