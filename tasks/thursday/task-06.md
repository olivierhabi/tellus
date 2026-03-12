# TASK 6: Create the DELETE `/api/v2/ontology/:ontologyId/linkTypes/:apiName` Endpoint

**Objective:** Build the REST API endpoint that deletes a link type definition from the Ontology. Deleting a link type removes the relationship definition but does NOT modify any objects on either side — the foreign key property values remain on the objects, they just no longer have a link type interpreting them as a relationship. In Palantir, deleting a link type is a destructive action that breaks any applications (Workshop modules, saved explorations, functions) that reference the link type.

**Why this exists in Palantir:** The Ontology Manager allows link type deletion as part of schema management. Palantir warns users about the impact before allowing deletion. The warning includes a list of applications and resources that reference the link type.

**Prerequisites:** Tasks 1 and 2 must be complete.

**HTTP method and path:** `DELETE /api/v2/ontology/:ontologyId/linkTypes/:apiName`

**Implementation:**

1. Verify the ontology exists: `SELECT 1 FROM ontology WHERE ontology_id = $1`. Return HTTP 404 with `{ "error": "Ontology not found" }` if not found.

2. Verify the link type exists: `SELECT * FROM link_type WHERE ontology_id = $1 AND api_name = $2`. Return HTTP 404 with `{ "error": "Link type '${apiName}' not found in this ontology." }` if not found.

3. Delete the row: `DELETE FROM link_type WHERE ontology_id = $1 AND api_name = $2`.

4. Return HTTP 200 with the deleted link type definition (so the caller knows what was deleted) and a timestamp:

```json
{
    "deleted": true,
    "linkType": {
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
    },
    "deletedAt": "2025-03-13T14:30:00.000Z"
}
```

**What is NOT deleted:**
- OpenSearch data: objects on both sides remain exactly as they are. FK property values are unchanged.
- Join table CSV files: for M2M link types, the join table file at `join_table_file_path` is NOT deleted. It remains on disk as an orphaned file. The implementer should log a warning about the orphaned file so the human operator can clean it up manually if desired.

**Error responses:**
- HTTP 404 — Ontology not found: `{ "error": "Ontology not found" }`.
- HTTP 404 — Link type not found: `{ "error": "Link type '${apiName}' not found in this ontology." }`.
- HTTP 500 — Internal error (catch and log, return `{ "error": "Internal server error" }`).

**Logging:**
- On successful deletion: `console.log(\`[LINK_TYPE_DELETED] ontology=${ontologyId} apiName=${apiName}\`)`.
- If the deleted link type was M2M with a join table file: `console.warn(\`[ORPHANED_JOIN_TABLE] File '${joinTableFilePath}' is no longer referenced by any link type.\`)`.

**File to modify:** `src/routes/linkTypes.js` — add the DELETE `/:apiName` handler.

**Testing:**
1. Create a link type, verify it exists via `GET /linkTypes/employeeCompany` (expect HTTP 200).
2. Delete it via `DELETE /linkTypes/employeeCompany` — verify HTTP 200 with the full deleted definition and `deleted: true`.
3. Verify `GET /linkTypes/employeeCompany` now returns HTTP 404.
4. Verify objects on both sides are unchanged (query OpenSearch directly to confirm Employee and Company objects still exist with their FK values intact).
5. Delete a non-existent link type — verify HTTP 404.
6. Delete a link type from a non-existent ontology — verify HTTP 404 with "Ontology not found".
