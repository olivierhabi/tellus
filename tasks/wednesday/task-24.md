# TASK 24: Wire the POST /objects/:objectType/aggregate Endpoint with All Services

**File to modify:** `/src/routes/objects.js`

**Dependencies:** Tasks 1, 2, 7, 8, 15, 16, 17, 18, 21.

**Purpose:** Write the route handler function for `POST /api/v1/objects/:objectType/aggregate` that orchestrates the aggregation pipeline by calling existing services. This handler must be wrapped in `asyncHandler` (from Task 15).

**The handler must perform these steps in order:**

1. **Validate the object type exists** by calling `propertyResolver.resolveAllProperties(req.params.objectType)`. Throws `ObjectTypeNotFoundError` if not found.

2. **Validate the request body** via `const validatedBody = queryValidator.validateAggregateQuery(req.body, req.params.objectType)`. This is the canonical validation function for aggregate requests (Task 16 implements it in `queryValidator.js`). It validates: `aggregations` is a non-empty array with at most 25 elements, each aggregation has required fields (`type`, `name`), type-specific parameters are valid, field/type compatibility is checked, and aggregation names are unique. Returns the normalized body with defaults applied (e.g., `terms.size` defaults to 10).

3. **Build the OpenSearch query** via `opensearchQueryBuilder.buildAggregateQuery({ objectTypeApiName: req.params.objectType, where: validatedBody.where, aggregations: validatedBody.aggregations, propertyResolver })`. This internally calls:
   - `queryTranslator.translateFilter()` for the optional `where` clause (or `{ match_all: {} }` if absent)
   - `aggregationBuilder.buildAggregations()` to build the `aggs` clause
   Returns `{ index, body }` where `body.size` is `0` (no document hits returned).

4. **Execute the query** via `opensearchClient.searchObjects(query.index, query.body)`. Returns the raw OpenSearch response.

5. **Format the response** via `objectResponseFormatter.formatAggregationResponse(opensearchResponse, validatedBody.aggregations)`.

6. **Return HTTP 200** with `res.json(formattedResponse)`.

**Key difference from search:** `size: 0` (no document hits returned), no pagination, no `$orderBy`, no `$select`, no `$pageToken`.

**The function body must not exceed 30 lines of code (excluding comments).**

**Error handling:** All errors are thrown by the services and caught by `asyncHandler`. The handler itself does NOT contain try/catch blocks.

**Logging:** Log a structured info line after successful response:
```json
{"level":"info","type":"aggregate_objects","objectType":"Employee","aggregationCount":3,"hasFilter":false,"durationMs":120,"requestId":"..."}
```

**Acceptance criteria (from Task 13's test cases):**
1. `POST /objects/Employee/aggregate` with `{ "aggregations": [{ "type": "count", "name": "total" }] }` → 200, returns `{ "data": { "total": 100 } }`
2. `POST /objects/Employee/aggregate` with `{ "aggregations": [{ "type": "avg", "field": "salary", "name": "avgSalary" }] }` → 200, returns correct average
3. `POST /objects/Employee/aggregate` with `terms` on department → 200, returns department buckets with counts
4. `POST /objects/Employee/aggregate` with `date_histogram` on startDate → 200, returns date buckets
5. `POST /objects/Employee/aggregate` with `where` clause filtering to Engineering + `count` → 200, returns count of Engineering employees only
6. `POST /objects/Employee/aggregate` with 5 aggregations in one call → 200, returns all 5 results
7. `POST /objects/Employee/aggregate` with `{ "aggregations": [{ "type": "avg", "field": "department", "name": "avgDept" }] }` (avg on a string field) → 400 with `INVALID_AGGREGATION`
8. `POST /objects/Employee/aggregate` with duplicate aggregation names → 400 with `INVALID_AGGREGATION`
9. `POST /objects/Employee/aggregate` with empty `aggregations` array → 400 with `INVALID_QUERY`
10. `POST /objects/NonExistent/aggregate` → 404 with `OBJECT_TYPE_NOT_FOUND`
