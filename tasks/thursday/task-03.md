# TASK 3: Create the GET `/api/v2/ontology/:ontologyId/linkTypes` Endpoint

**Objective:** Build the REST API endpoint that retrieves all link type definitions within an ontology. This endpoint is used by the Ontology Manager UI (when it's built later), by the Object Set Service (to know how to resolve links when performing Search Around queries), and by the OSDK code generator (to generate typed link traversal methods in the SDK). The response must include the full definition of each link type, including cardinality, foreign key configuration, and join table configuration.

**Why this exists in Palantir:** In Palantir Foundry, the Ontology Manager's home page lists all object types and link types. The Object Explorer uses link type definitions to display the "Links" section on each object's detail page, showing which other object types are connected and the count of linked objects. The OSDK generates `.pivotTo()` methods for each link type so developers can write `client(Employee).where(...).pivotTo("employeeCompany")` to traverse links in code.

**HTTP method and path:** `GET /api/v2/ontology/:ontologyId/linkTypes`

**Path parameters:**
- `ontologyId` (UUID): The ID of the ontology. Must reference an existing ontology. If not found, return HTTP 404 with `{ "error": "Ontology not found", "ontologyId": "${ontologyId}" }`.

**Query parameters (all optional):**
- `sourceObjectType` (string): Filter link types by source object type api_name. If provided, only return link types where `source_object_type_api_name = $1`. This is useful when showing the links available from a specific object type.
- `targetObjectType` (string): Filter link types by target object type api_name. Same logic as above but for the target side.
- `cardinality` (string): Filter by cardinality. Must be one of the four allowed values if provided.
- `$pageSize` (integer, default 100, max 1000): Number of link types to return per page.
- `$pageToken` (string, optional): Opaque cursor for pagination. Implemented as a base64-encoded `link_type_id` — return link types with `link_type_id > decoded($pageToken)` ordered by `link_type_id`. If not provided, return from the beginning.

**Database query:** Build the SQL query dynamically based on which query parameters are provided. Start with: `SELECT * FROM link_type WHERE ontology_id = $1`. Append `AND source_object_type_api_name = $2` if `sourceObjectType` is provided. Append `AND target_object_type_api_name = $3` if `targetObjectType` is provided. Append `AND cardinality = $4` if `cardinality` is provided. Append `AND link_type_id > $N` if `$pageToken` is provided (decode the token first). Always append `ORDER BY link_type_id ASC LIMIT $pageSize + 1` (fetch one extra row to determine if there's a next page).

**Response shaping:** For each row returned from the database, construct a JSON object in the response with the following shape:

```json
{
    "linkTypeId": "uuid",
    "apiName": "employeeCompany",
    "displayName": "Employee → Employer",
    "description": "...",
    "sourceObjectType": "Employee",
    "targetObjectType": "Company",
    "cardinality": "MANY_TO_ONE",
    "foreignKey": {
        "propertyApiName": "companyId",
        "side": "source"
    },
    "joinTable": null,
    "isBidirectional": true,
    "createdAt": "2025-03-11T10:00:00.000Z"
}
```

For link types where cardinality is NOT `MANY_TO_MANY`, set `foreignKey` to the object with `propertyApiName` and `side`, and set `joinTable` to `null`. For `MANY_TO_MANY` link types, set `foreignKey` to `null` and set `joinTable` to the object with `filePath`, `sourceColumn`, and `targetColumn`.

**Pagination:** If the query returned more rows than `$pageSize`, there is a next page. Set `nextPageToken` to the base64-encoded `link_type_id` of the last row in the current page (not the extra row). If there is no next page, set `nextPageToken` to `null`.

**Success response:** HTTP 200 OK

```json
{
    "data": [
        { "linkTypeId": "...", "apiName": "employeeCompany", ... },
        { "linkTypeId": "...", "apiName": "employeeTickets", ... }
    ],
    "nextPageToken": null,
    "totalCount": 2
}
```

The `totalCount` field should be the total number of link types matching the filters (without pagination). To get this, run a separate `SELECT COUNT(*) FROM link_type WHERE ...` query with the same filters but without the `LIMIT` and `link_type_id >` clauses. This is important for the Ontology Manager UI to display "Showing 1–100 of 250 link types."

**File to modify:** `src/routes/linkTypes.js` — add a new GET handler before or after the POST handler.

**Error responses:**
- HTTP 404 — Ontology not found: `{ "error": "Ontology not found", "ontologyId": "${ontologyId}" }`.
- HTTP 400 — Invalid cardinality filter value: `{ "error": "Invalid cardinality filter '${value}'. Must be one of: ONE_TO_ONE, ONE_TO_MANY, MANY_TO_ONE, MANY_TO_MANY." }`.
- HTTP 500 — Internal error: `{ "error": "Internal server error" }`.

**Prerequisites:** Tasks 1 and 2 must be complete.

**File to modify:** `src/routes/linkTypes.js` — add a new GET handler before or after the POST handler.

**Testing:**
1. Create 3 link types (employeeCompany, employeeTickets, companyIndustry).
2. Call `GET /api/v2/ontology/{id}/linkTypes` — verify all 3 are returned in the `data` array, `totalCount` is 3, `nextPageToken` is null.
3. Call `GET /linkTypes?sourceObjectType=Employee` — verify only the 2 Employee-related links are returned, `totalCount` is 2.
4. Test pagination: set `$pageSize=1`, follow `nextPageToken` through 3 pages, verify all 3 link types received across pages with no duplicates.
5. Call with non-existent `ontologyId` — verify HTTP 404.
