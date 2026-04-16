# TASK 16: Create Bulk Link Count Endpoint

**Objective:** Build an endpoint that returns link counts for ALL link types associated with a given object in a single request. This is more efficient than calling Task 15's endpoint once per link type. Used by the Object Explorer sidebar to show all link type badges simultaneously.

**Prerequisites:** Tasks 1, 15 must be complete.

**HTTP method and path:** `GET /api/v1/objects/:objectType/:primaryKey/links`

**Implementation:**

1. Determine the ontology ID from the `objectType`: `SELECT ontology_id FROM object_type WHERE api_name = $1`. If not found, return HTTP 404 with `{ "error": "Object type '${objectType}' not found." }`.

2. Find all link types where the object type is either source or target:
```sql
SELECT * FROM link_type
WHERE ontology_id = $1
AND (source_object_type_api_name = $2 OR target_object_type_api_name = $2)
ORDER BY api_name ASC
```

3. For each link type, determine the direction relative to the caller's object type:
   - If `objectType === source_object_type_api_name`: direction is `"forward"`, `targetObjectType` is the link's target.
   - If `objectType === target_object_type_api_name` and `is_bidirectional`: direction is `"reverse"`, `targetObjectType` is the link's source.
   - If `objectType === target_object_type_api_name` and NOT `is_bidirectional`: skip this link type (don't include it in the response).
   - For self-referential links (`source === target`): include it once with direction `"forward"`.

4. Execute all count queries in parallel using `Promise.all()`. Use the same count logic as Task 15 for each link type.

5. If any individual count query fails, log the error and set that link type's count to `null` (partial failure — don't fail the entire request):
```javascript
const results = await Promise.allSettled(countPromises);
// For each result: if fulfilled, use value. If rejected, log error and set count: null.
```

**Response:**
```json
{
    "objectType": "Employee",
    "primaryKey": "EMP-001",
    "links": [
        {
            "linkTypeApiName": "employeeCompany",
            "displayName": "Employer",
            "targetObjectType": "Company",
            "direction": "forward",
            "count": 1
        },
        {
            "linkTypeApiName": "assignedTickets",
            "displayName": "Assigned Tickets",
            "targetObjectType": "Ticket",
            "direction": "forward",
            "count": 5
        },
        {
            "linkTypeApiName": "managedBy",
            "displayName": "Manager",
            "targetObjectType": "Employee",
            "direction": "reverse",
            "count": 1
        }
    ]
}
```

**Error responses:**
- HTTP 404 — Object type not found: `{ "error": "Object type '${objectType}' not found." }`.
- HTTP 500 — Internal error: `{ "error": "Internal server error" }`.

**Edge cases:**
- Object type has no link types: return `{ "links": [] }`.
- Individual count query fails: include the link type in the response with `"count": null` and an `"error"` field explaining the failure.

**File to modify:** `src/routes/linkTraversal.js` — add the GET `/:objectType/:primaryKey/links` handler. Register this route BEFORE the `/:objectType/:primaryKey/links/:linkType` route to prevent Express from matching `links` as a `linkType` parameter. Route registration order should be:
1. `GET /:objectType/:primaryKey/links` (this task — bulk count)
2. `GET /:objectType/:primaryKey/links/:linkType/count` (Task 15 — single count)
3. `GET /:objectType/:primaryKey/links/:linkType` (Task 12 — link traversal)

**Testing:**
1. Create an Employee with links to Company (MANY_TO_ONE), Tickets (ONE_TO_MANY, 3 tickets), and Courses (M2M, 2 courses).
2. Call `GET /api/v1/objects/Employee/EMP-001/links`.
3. Verify the response contains all link types with correct counts and directions.
4. Verify non-bidirectional link types where Employee is the target are NOT included.
5. Test with an object type that has no link types — verify `{ "links": [] }`.
