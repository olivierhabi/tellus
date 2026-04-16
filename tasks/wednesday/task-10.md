# TASK 10: Create the GET /objects/:objectType Endpoint (List Objects)

**File to create/modify:** `/src/routes/objects.js`

**Purpose:** This is the simplest query endpoint — it lists all objects of a given type with optional pagination and sorting. It's the equivalent of a `SELECT * FROM table LIMIT 100` in SQL. In Palantir's API, this is the entry point for browsing objects when you don't have a specific filter in mind.

**Endpoint specification:**

```
GET /api/v1/objects/:objectType
```

**Query parameters:**
- `$pageSize` (optional, integer, default: 100, min: 1, max: 10000) — Number of objects per page
- `$pageToken` (optional, string) — Cursor for pagination
- `$orderBy` (optional, string) — Sorting. Format: `"propertyName:asc"` or `"propertyName:desc"`. Multiple sorts separated by commas: `"salary:desc,fullName:asc"`. This is the query-parameter format (as opposed to the JSON body format used in POST endpoints).
- `$select` (optional, string) — Comma-separated list of property names to include: `"employeeId,fullName,salary"`. If not specified, all properties are returned.

**Implementation step by step:**

1. **Parse query parameters.** Extract `$pageSize`, `$pageToken`, `$orderBy`, and `$select` from `req.query`. Note: Express passes query parameters as strings, so `$pageSize` must be parsed to an integer with `parseInt()`.

2. **Validate the object type exists.** Query PostgreSQL: `SELECT * FROM object_type WHERE api_name = $1`. If not found, return 404 with: `{ "error": { "code": "OBJECT_TYPE_NOT_FOUND", "message": "Object type 'Employe' not found. Available object types: Employee, Company, Ticket." } }`. Include the list of available object types to help the user fix typos.

3. **Parse $orderBy string into structured format.** Split by comma, then split each part by colon. `"salary:desc,fullName:asc"` becomes `[{ "field": "salary", "direction": "desc" }, { "field": "fullName", "direction": "asc" }]`. Validate each field exists on the object type. Default direction is `"asc"` if not specified.

4. **Parse $select string into array.** Split by comma, trim whitespace. `"employeeId, fullName, salary"` becomes `["employeeId", "fullName", "salary"]`. Validate each property exists.

5. **Build OpenSearch query.** Since this endpoint has no `where` clause, the query is a `match_all`:
   ```json
   {
     "query": { "match_all": {} },
     "sort": [...from pagination service...],
     "size": pageSize + 1,
     "track_total_hits": true,
     "_source": selectProperties || true
   }
   ```

   If `$pageToken` is present, add `"search_after": [...]` from the decoded token.

   If `$select` is specified, set `"_source"` to the array of selected property names plus the system fields (`__pk`, `__objectType`, `__lastModified`, `__version`). This tells OpenSearch to only return the selected fields, reducing network transfer and response size.

6. **Execute the OpenSearch query.** Use the OpenSearch client (from `/src/opensearch.js`). The index name is `ontology-${objectType.toLowerCase()}`.

7. **Format the response.** Use the response formatter (Task 7) to transform the OpenSearch response into the API format. Use the pagination service (Task 6) to generate the `nextPageToken` if there are more results.

8. **Return the response.** HTTP 200 with the formatted response body. Set `Content-Type: application/json`.

**Error handling:**

- Object type not found → 404
- Invalid $pageSize → 400 with validation error
- Invalid $orderBy field → 400 with "Unknown property 'xyz'" error
- Invalid $select field → 400 with "Unknown property 'xyz'" error
- Invalid $pageToken (cannot decode) → 400 with "Invalid page token" error
- $pageToken for wrong object type → 400 with specific message
- OpenSearch connection error → 503 with "Object database unavailable"
- OpenSearch index not found (object type exists but hasn't been indexed yet) → 200 with empty data: `{ "data": [], "nextPageToken": null, "totalCount": 0 }`. This is NOT an error — it's valid for an object type to exist in the schema but have no indexed data yet.

**Performance considerations:**

- For the `match_all` query with no pagination token, OpenSearch returns the first page very quickly because it doesn't need to score documents.
- If `$select` is specified with a small number of properties, use `_source` filtering to reduce the response size. This is especially important for object types with many properties or large text fields.
- Set a reasonable timeout for the OpenSearch query (e.g., 30 seconds) to prevent long-running queries from tying up the server.

**Logging:** Log every request with: timestamp, HTTP method, path, query parameters, response status code, response time in milliseconds, and the number of objects returned. Use `console.log` with a structured format: `[2025-03-12T10:30:00Z] GET /api/v1/objects/Employee ?$pageSize=50&$orderBy=salary:desc → 200 (50 objects, 45ms)`. This is essential for debugging query performance issues.

**Test cases to verify:**
1. `GET /api/v1/objects/Employee` → Returns first 100 employees, sorted by __pk ascending
2. `GET /api/v1/objects/Employee?$pageSize=10` → Returns first 10
3. `GET /api/v1/objects/Employee?$pageSize=10` then `GET /api/v1/objects/Employee?$pageSize=10&$pageToken={token from previous}` → Returns next 10, no overlap
4. `GET /api/v1/objects/Employee?$orderBy=salary:desc` → Returns employees sorted by salary descending
5. `GET /api/v1/objects/Employee?$select=employeeId,fullName` → Returns only those two properties plus __primaryKey and __objectType
6. `GET /api/v1/objects/NonExistent` → 404 error
7. `GET /api/v1/objects/Employee?$pageSize=999999` → 400 error (exceeds 10000)
8. `GET /api/v1/objects/Employee?$orderBy=nonexistent:asc` → 400 error
