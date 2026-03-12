# TASK 25: Create Link Type Export to JSON

**Objective:** Build an endpoint that exports all link type definitions for an ontology as a JSON file download. This supports: (1) OSDK code generation (needs all link types to generate `.pivotTo()` methods), (2) Backup/restore, (3) Ontology documentation generation.

**Prerequisites:** Tasks 1-3 must be complete (link_type table and list endpoint).

**HTTP method and path:** `GET /api/v2/ontology/:ontologyId/linkTypes/export`

**Implementation:**

1. Verify the ontology exists. If not, return HTTP 404 with `{ "error": "Ontology not found" }`.

2. Fetch all link types for the ontology: `SELECT * FROM link_type WHERE ontology_id = $1 ORDER BY api_name ASC`.

3. Transform each row into the standard JSON shape (same as Task 3's list response format):

```json
{
    "linkTypeId": "uuid",
    "apiName": "employeeCompany",
    "displayName": "Employee → Employer",
    "description": "Links an employee to their employing company",
    "sourceObjectType": "Employee",
    "targetObjectType": "Company",
    "cardinality": "MANY_TO_ONE",
    "foreignKey": {
        "propertyApiName": "companyId",
        "side": "source"
    },
    "joinTable": null,
    "isBidirectional": true,
    "createdAt": "2025-03-11T10:00:00.000Z",
    "updatedAt": "2025-03-11T10:00:00.000Z"
}
```

4. Return the full export with metadata:

**Response format:**
```json
{
    "exportMetadata": {
        "ontologyId": "uuid",
        "exportedAt": "2025-03-13T14:30:00.000Z",
        "totalLinkTypes": 5,
        "version": "1.0"
    },
    "linkTypes": [
        { ...link type 1... },
        { ...link type 2... }
    ]
}
```

5. Set response headers:
   - `Content-Type: application/json`
   - `Content-Disposition: attachment; filename="link_types_export.json"`

**Error responses:**
- HTTP 404 — Ontology not found: `{ "error": "Ontology not found" }`.
- HTTP 500 — Internal error: `{ "error": "Internal server error" }`.

**Edge cases:**
- Empty ontology (no link types): return a valid export with `"linkTypes": []` and `"totalLinkTypes": 0`. Do NOT return an error.

**File to modify:** `src/routes/linkTypes.js` — add the GET `/export` handler. Register this route BEFORE the `GET /:apiName` route to prevent Express from treating "export" as an apiName parameter.

**Testing:**
1. Create 5 link types in an ontology (mix of FK-based and M2M cardinalities).
2. Call `GET /api/v2/ontology/{ontologyId}/linkTypes/export`.
3. Verify the response has `Content-Disposition: attachment` header.
4. Verify `exportMetadata.totalLinkTypes` is 5.
5. Verify the JSON file contains all 5 link types with correct definitions matching what was created.
6. Verify each link type has all required fields (`linkTypeId`, `apiName`, `displayName`, `sourceObjectType`, `targetObjectType`, `cardinality`, `foreignKey`, `joinTable`, `isBidirectional`, `createdAt`, `updatedAt`).
7. Test with an empty ontology — verify valid export with empty `linkTypes` array.
