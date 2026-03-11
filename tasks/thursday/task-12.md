# TASK 12: Create the GET `/api/v2/objects/:objectType/:primaryKey/links/:linkType` Endpoint

**Objective:** Build the REST API endpoint that resolves a link from a specific object. This is the primary endpoint for link traversal in the API. Given an object (identified by type + PK) and a link type, return the linked objects.

**Palantir equivalent:** This maps to the Ontology API's linked objects endpoint. In the OSDK, this is what powers `client(Employee).where(...).pivotTo("employeeCompany")`.

**Prerequisites:** Tasks 1-11 must be complete (link_type table, CRUD endpoints, all resolvers, dispatcher).

**HTTP method and path:** `GET /api/v2/objects/:objectType/:primaryKey/links/:linkType`

**Path parameters:**
- `objectType` (string): api_name of the starting object's type
- `primaryKey` (string): primary key of the starting object
- `linkType` (string): api_name of the link type to traverse

**Query parameters (all optional):**
- `$pageSize` (integer, default 100, max 10000) — silently capped at 10000, no error if exceeded
- `$pageToken` (string) — opaque pagination cursor
- `$orderBy` (string, comma-separated, e.g., `fullName:asc,salary:desc`)
- `$select` (string, comma-separated property names to include in response)
- `$direction` (string, `'forward'` or `'reverse'`) — explicit traversal direction. Required for reverse traversal on self-referential links (Task 21). If invalid value provided, return HTTP 400 with `{ "error": "Invalid $direction. Must be 'forward' or 'reverse'." }`.

**Implementation:**

1. Parse query parameters. Parse `$orderBy` from string to array of objects: `"fullName:asc,salary:desc"` → `[{ field: "fullName", direction: "asc" }, { field: "salary", direction: "desc" }]`. Parse `$pageSize` to integer (default 100). Validate `$direction` if present.

2. Determine the ontology ID. Query the `object_type` table for the given `objectType` api_name to get the `ontology_id`: `SELECT ontology_id FROM object_type WHERE api_name = $1`. If not found, return HTTP 404 with `{ "error": "Object type '${objectType}' not found." }`.

3. Verify the starting object exists in OpenSearch: `POST /ontology-${objectType.toLowerCase()}/_count` with body `{ "query": { "term": { "__pk": "${primaryKey}" } } }`. If count is 0, return HTTP 404 with `{ "error": "Object '${primaryKey}' of type '${objectType}' not found." }`.

4. Call `resolveLink({ objectTypeApiName: objectType, primaryKey, linkTypeApiName: linkType, ontologyId, direction, targetFilter, orderBy, pageSize, pageToken })`.

5. Format the response based on the result shape.

**Error handling — mapping resolver errors to HTTP status codes:**

The `resolveLink` dispatcher throws typed errors with `statusCode` properties (from `src/errors.js`):
- `NotFoundError` (statusCode 404): link type not found → return HTTP 404 with `{ "error": err.message }`.
- `BadRequestError` (statusCode 400): object type not part of link, non-bidirectional reverse traversal, invalid direction → return HTTP 400 with `{ "error": err.message }`.

Catch these errors in a try/catch block:
```javascript
try {
    const result = await resolveLink({ ... });
    // ... format response
} catch (err) {
    if (err.statusCode) {
        return res.status(err.statusCode).json({ error: err.message });
    }
    console.error('[LINK_TRAVERSAL_ERROR]', err);
    return res.status(500).json({ error: 'Internal server error' });
}
```

**Response format for single result (ONE_TO_ONE, MANY_TO_ONE — when `result.data` is not an array):**
```json
{
    "data": {
        "__primaryKey": "COMP-001",
        "__objectType": "Company",
        "companyName": "Acme Inc",
        "industry": "Technology"
    }
}
```
If no linked object exists (`result.data` is null):
```json
{
    "data": null
}
```

**Response format for multiple results (ONE_TO_MANY, MANY_TO_MANY — when `result.data` is an array):**
```json
{
    "data": [
        { "__primaryKey": "EMP-001", "__objectType": "Employee", "fullName": "Melissa Chang" },
        { "__primaryKey": "EMP-002", "__objectType": "Employee", "fullName": "Diego Rodriguez" }
    ],
    "nextPageToken": "eyJ...",
    "totalCount": 450
}
```

**How to distinguish single vs. multiple result:** Check `Array.isArray(result.data)`. If true, format as multi-result response. If false (object or null), format as single-result response.

**File to create:** `src/routes/linkTraversal.js` — register as a sub-route under the objects router. The route pattern is:
```javascript
router.get('/:objectType/:primaryKey/links/:linkType', handler);
```

**Testing:**
1. Create Employee with companyId=COMP-001. Create Company COMP-001. Create MANY_TO_ONE link (Employee → Company).
2. `GET /api/v2/objects/Employee/EMP-001/links/employeeCompany` — expect `{ "data": { "__primaryKey": "COMP-001", ... } }`.
3. `GET /api/v2/objects/Company/COMP-001/links/employeeCompany` — reverse traversal, expect `{ "data": [...employees...], "totalCount": N }`.
4. `GET /api/v2/objects/Employee/EMP-001/links/nonExistent` — expect HTTP 404.
5. `GET /api/v2/objects/Ticket/TKT-001/links/employeeCompany` — expect HTTP 400 (Ticket not part of link).
6. `GET /api/v2/objects/Employee/NONEXISTENT/links/employeeCompany` — expect HTTP 404 (starting object not found).
7. `GET /api/v2/objects/Employee/EMP-001/links/manages?$direction=reverse` — self-referential reverse, expect manager returned.
