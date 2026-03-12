# TASK 11: Create the GET /objects/:objectType/:primaryKey Endpoint (Single Object)

**File to modify:** `/src/routes/objects.js`

**Purpose:** This endpoint retrieves a single object by its primary key. It's the most direct way to access an object when you already know its identifier. In Palantir's Ontology, this is used when a user clicks on a specific object in Object Explorer, when an application loads an object's detail view, when a link traversal resolves a foreign key to the target object, and when the Action engine verifies that a target object exists before applying an edit. This endpoint must be extremely fast because it's called constantly — every object detail view, every link resolution, every action validation triggers this endpoint.

**Endpoint specification:**

```
GET /api/v2/objects/:objectType/:primaryKey
```

**URL parameters:**
- `:objectType` — The API name of the object type (e.g., `Employee`, `Company`, `Ticket`). This is case-sensitive and must match exactly.
- `:primaryKey` — The primary key value of the specific object (e.g., `EMP-001`, `COMP-042`). This can contain any URL-safe characters. If the primary key contains special characters (slashes, spaces, etc.), it must be URL-encoded by the client.

**Optional query parameters:**
- `$select` (optional, string) — Comma-separated list of property names to include. Same format as the list endpoint (Task 10).

**Implementation step by step:**

1. **Validate the object type exists.** Same as Task 10 — query PostgreSQL `object_type` table. Return 404 if not found with the same error format.

2. **Build the OpenSearch GET request.** Unlike the search endpoints which use OpenSearch's `_search` API, single-object retrieval should use the `_doc` API (get by ID), which is a direct lookup and much faster than a search query. In our indexing (built Tuesday), each document's `_id` is set to the primary key value. So the request is:

   ```javascript
   const response = await opensearchClient.get({
     index: `ontology-${objectType.toLowerCase()}`,
     id: primaryKey
   });
   ```

   This is an O(1) lookup — OpenSearch goes directly to the document by its `_id` without running a search.

3. **Handle "not found" case.** If OpenSearch returns a 404 (document not found), this means the primary key doesn't exist in the index. Return an HTTP 404 with:
   ```json
   {
     "error": {
       "code": "OBJECT_NOT_FOUND",
       "message": "Object with primary key 'EMP-999' not found in object type 'Employee'.",
       "details": {
         "objectType": "Employee",
         "primaryKey": "EMP-999"
       }
     }
   }
   ```

4. **Format the response.** Use the response formatter's `formatSingleObject` function (Task 7). The response is a single object, NOT wrapped in a `data` array:
   ```json
   {
     "__primaryKey": "EMP-001",
     "__objectType": "Employee",
     "employeeId": "EMP-001",
     "fullName": "Melissa Chang",
     "email": "melissa.chang@acme.com",
     "salary": 145000,
     "department": "Engineering",
     "startDate": "2021-03-15",
     "isActive": true,
     "skills": ["Python", "TypeScript", "SQL"]
   }
   ```

5. **Apply `$select` filtering.** If `$select` is provided, filter the response to only include the specified properties plus `__primaryKey` and `__objectType`. Use the `_source_includes` parameter on the OpenSearch GET request for efficiency (so OpenSearch doesn't even return the fields you don't need):
   ```javascript
   const response = await opensearchClient.get({
     index: `ontology-${objectType.toLowerCase()}`,
     id: primaryKey,
     _source_includes: ['__pk', '__objectType', ...selectProperties]
   });
   ```

6. **URL-decode the primary key.** Express automatically URL-decodes path parameters, but be aware that if a primary key contains characters like `%20` (space) or `%2F` (slash), they will be decoded. The decoded value is what should be used for the OpenSearch lookup. If the primary key is purely numeric (like `12345`), Express will still pass it as a string — do NOT convert it to a number.

**Performance optimization:** This endpoint should respond in under 10 milliseconds for a single object lookup. The OpenSearch `_doc` API is designed for this. Do NOT use a `_search` query with a `term` filter on `__pk` — that's slower because it goes through the query parsing and scoring pipeline. Use the direct `get` API.

**Error handling:**
- Object type not found → 404 with available types
- Primary key not found → 404 with specific message
- Invalid `$select` property → 400 with valid properties list
- OpenSearch connection error → 503
- OpenSearch index not found → 404 with message "Object type 'Employee' has not been indexed yet. Please index the backing datasource first."

**Test cases:**
1. `GET /api/v2/objects/Employee/EMP-001` → Returns the full Employee object
2. `GET /api/v2/objects/Employee/EMP-001?$select=fullName,salary` → Returns only fullName and salary (plus __primaryKey and __objectType)
3. `GET /api/v2/objects/Employee/NONEXISTENT` → 404
4. `GET /api/v2/objects/NonExistentType/EMP-001` → 404 with type not found message
5. `GET /api/v2/objects/Employee/EMP-001` with no indexed data → 404
