# TASK 26: Create Link Type Import from JSON

**Objective:** Build the reverse of Task 25 — import link type definitions from a JSON file. This supports: (1) Restoring from backup, (2) Copying ontology structure between environments, (3) Bootstrapping from templates.

**Prerequisites:** Tasks 1, 2, and 25 must be complete (link_type table, POST endpoint, and export endpoint).

**HTTP method and path:** `POST /api/v2/ontology/:ontologyId/linkTypes/import`

**Request body:** Same format as the export from Task 25 (the `linkTypes` array portion):

```json
{
    "linkTypes": [
        {
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
            "isBidirectional": true
        }
    ]
}
```

**Note:** The `linkTypeId`, `createdAt`, `updatedAt`, and `exportMetadata` fields from the export are ignored during import. New UUIDs are generated and timestamps are set to `now()`.

**Implementation:**

1. Verify the ontology exists. If not, return HTTP 404 with `{ "error": "Ontology not found" }`.

2. Validate the request body: `linkTypes` must be a non-empty array. If missing or empty, return HTTP 400 with `{ "error": "Request body must contain a non-empty 'linkTypes' array." }`.

3. Limit: maximum 100 link types per import request. If `linkTypes.length > 100`, return HTTP 400 with `{ "error": "Maximum 100 link types per import. Received ${count}." }`.

4. For each link type in the array, attempt to create it using the same validation logic as Task 2's POST endpoint (validate apiName format, verify source/target object types exist, validate FK property existence, validate M2M join table fields). Process each link type independently — if one fails validation, skip it and continue with the next.

5. For each link type:
   - If validation passes: insert into `link_type` table with a new UUID and current timestamp.
   - If validation fails: record the error and continue.
   - If a link type with the same `apiName` already exists in the ontology (unique constraint violation, PG error code `23505`): skip it and record the conflict in the `skipped` array.

**Response:** HTTP 200 OK (even if some imports fail, since this is best-effort):

```json
{
    "imported": 4,
    "skipped": 1,
    "failed": 1,
    "results": [
        { "apiName": "employeeCompany", "status": "imported", "linkTypeId": "new-uuid" },
        { "apiName": "existingLink", "status": "skipped", "reason": "Link type 'existingLink' already exists in this ontology." },
        { "apiName": "badLink", "status": "failed", "reason": "Source object type 'NonExistent' does not exist in this ontology." }
    ]
}
```

**Error responses:**
- HTTP 400 — Invalid request body (missing/empty `linkTypes` array, exceeds 100 limit).
- HTTP 404 — Ontology not found.
- HTTP 500 — Internal error.

**Edge cases:**
- Duplicate `apiName` within the import array itself: process the first occurrence, skip subsequent duplicates with status `"skipped"` and reason `"Duplicate apiName in import request."`.
- Link types that reference each other (e.g., link A references object type B which is the target of link B): import order doesn't matter because link types only reference object types, not other link types.

**File to modify:** `src/routes/linkTypes.js` — add the POST `/import` handler. Register this route BEFORE the `POST /` route to prevent Express from treating it as a regular POST with apiName "import".

**Testing:**
1. Create an ontology with 2 object types (Company, Employee).
2. Create 3 valid link types via POST.
3. Export them via `GET .../linkTypes/export`.
4. Create a new empty ontology with the same object types.
5. Import the exported JSON into the new ontology via `POST .../linkTypes/import`.
6. Verify `imported: 3`, `skipped: 0`, `failed: 0`.
7. Verify all 3 link types exist in the new ontology via `GET .../linkTypes`.
8. Import the same JSON again — verify all 3 are skipped with reason "already exists".
9. Import with one valid and one invalid link type (references non-existent object type) — verify `imported: 1, failed: 1` with the correct error message.
10. Import with more than 100 link types — verify HTTP 400.
