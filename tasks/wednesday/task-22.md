# TASK 22: Wire the GET /objects/:objectType Endpoint with All Services

**File to modify:** `/src/routes/objects.js`

**Dependencies:** Tasks 1, 2, 6, 7, 15, 17, 18, 21.

**Relationship to Task 10:** Task 10 defines the endpoint specification (behavior, error cases, test cases). This task (Task 22) implements the actual route handler by wiring together the services. Do not implement the endpoint directly from Task 10's inline implementation steps — those were written before the service decomposition and are superseded by the service call pipeline below.

**Purpose:** Write the route handler function for `GET /api/v2/objects/:objectType` that orchestrates the list-objects pipeline by calling existing services. This handler must be wrapped in `asyncHandler` (from Task 15).

**The handler must perform these steps in order, with each step being a single service call:**

1. **Parse query parameters** from `req.query`:
   - `$pageSize`: `parseInt(req.query.$pageSize)` or undefined if absent
   - `$pageToken`: `req.query.$pageToken` or undefined
   - `$orderBy`: `req.query.$orderBy` (raw string, e.g., `"salary:desc,fullName:asc"`) or undefined
   - `$select`: `req.query.$select` (raw string, e.g., `"fullName,salary"`) or undefined

2. **Validate parameters** via `queryValidator.validateListQuery(req.query, req.params.objectType)`. This returns `{ pageSize, pageToken, orderBy: [{field, direction}], select: [string] }` with defaults applied (pageSize defaults to 100).

3. **Build the OpenSearch query** via `opensearchQueryBuilder.buildListQuery({ objectTypeApiName: req.params.objectType, pageSize: validated.pageSize, pageToken: validated.pageToken, orderBy: validated.orderBy, select: validated.select, propertyResolver })`. Returns `{ index, body }`.

4. **Execute the query** via `opensearchClient.searchObjects(query.index, query.body)`. Returns the raw OpenSearch response.

5. **Format the response** via `objectResponseFormatter.formatObjectList(opensearchResponse, req.params.objectType, allPropertyApiNames, validated.select, validated.pageToken, opensearchResponse.hits.total.value)` where `allPropertyApiNames` is the list of all property API names from step 2's `resolveAllProperties` call. Returns the Palantir-shaped response object.

6. **Return HTTP 200** with `res.json(formattedResponse)`.

**The function body must not exceed 50 lines of code (excluding comments).** If it exceeds this, logic is leaking out of services.

**Error handling:** All errors are thrown by the services and caught by `asyncHandler`, which forwards them to the error middleware (Task 15). The handler itself does NOT contain try/catch blocks.

**Logging:** Log a structured info line after successful response:
```json
{"level":"info","type":"list_objects","objectType":"Employee","resultCount":100,"durationMs":45,"requestId":"..."}
```

**Acceptance criteria (from Task 10's test cases):**
1. `GET /objects/Employee` → 200, returns up to 100 objects with `nextPageToken` if more exist
2. `GET /objects/Employee?$pageSize=10` → 200, returns exactly 10 objects
3. `GET /objects/Employee?$select=fullName,salary` → 200, each object has only `__primaryKey`, `__objectType`, `fullName`, `salary`
4. `GET /objects/Employee?$orderBy=salary:desc` → 200, objects sorted by salary descending
5. `GET /objects/Employee?$pageSize=10&$pageToken=<token>` → 200, returns next page
6. `GET /objects/NonExistent` → 404 with `OBJECT_TYPE_NOT_FOUND`
7. `GET /objects/Employee?$pageSize=0` → 400 with `INVALID_QUERY`
8. `GET /objects/Employee?$select=nonExistent` → 400 with `PROPERTY_NOT_FOUND`
