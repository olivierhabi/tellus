# TASK 4: Create the GET `/api/v2/ontology/:ontologyId/linkTypes/:apiName` Endpoint

**Objective:** Build the REST API endpoint that retrieves a single link type definition by its api_name. This endpoint is used when a caller needs the full details of a specific link type — for example, when the Object Set Service needs to resolve a Search Around query and must know the cardinality and foreign key configuration of the link being traversed, or when the Object Explorer renders the link section on an object's detail page and needs the display name and description of each link type.

**Why this exists in Palantir:** Every Ontology entity in Palantir (object types, link types, action types, interfaces) is individually addressable by its api_name. The OSDK code generator fetches each link type by api_name to generate the correct TypeScript/Python type for the link traversal result (e.g., whether the result is a single object or an array of objects, based on cardinality). The Ontology Manager UI uses this endpoint to populate the link type editor when a user clicks on a specific link type.

**Prerequisites:** Tasks 1 and 2 must be complete.

**HTTP method and path:** `GET /api/v2/ontology/:ontologyId/linkTypes/:apiName`

**Path parameters:**
- `ontologyId` (UUID): Must reference an existing ontology. If not found, return HTTP 404 with `{ "error": "Ontology not found" }`.
- `apiName` (string): The api_name of the link type. If no link type with this api_name exists in this ontology, return HTTP 404 with `{ "error": "Link type '${apiName}' not found in this ontology." }`.

**Database query:** `SELECT * FROM link_type WHERE ontology_id = $1 AND api_name = $2`.

**Success response:** HTTP 200 OK

```json
{
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
    "sourceObjectTypeDetails": {
        "apiName": "Employee",
        "displayName": "Employee",
        "primaryKey": "employeeId",
        "propertyCount": 8
    },
    "targetObjectTypeDetails": {
        "apiName": "Company",
        "displayName": "Company",
        "primaryKey": "companyId",
        "propertyCount": 5
    },
    "estimatedLinkCount": 4523
}
```

**Enriched metadata fields (included in GET single, NOT in GET list):**

1. `sourceObjectTypeDetails`: Query the `object_type` table to get the source object type's display_name and api_name. Query the `property` table to find the primary key property (the property marked as PK during Day 1 object type creation — use `SELECT api_name FROM property WHERE object_type_id = $1 AND is_primary_key = true`). Count total properties for this object type: `SELECT COUNT(*) FROM property WHERE object_type_id = $1`.

2. `targetObjectTypeDetails`: Same queries as above but for the target object type.

3. `estimatedLinkCount`:
   - For non-M2M links (ONE_TO_ONE, ONE_TO_MANY, MANY_TO_ONE): Query OpenSearch to count how many objects have a non-null value for the foreign key property. Use the OpenSearch count API: `POST /ontology-{fkSideObjectType}/_count` with body `{ "query": { "exists": { "field": "${fkProperty}" } } }`. The `fkSideObjectType` is the object type indicated by `foreign_key_side` (source or target).
   - For M2M links: If `join_table_file_path` exists as a file on disk, read the file and count lines minus 1 (for the header row). If the file doesn't exist yet, return `0`.

**Error responses:**
- HTTP 404 — Ontology not found: `{ "error": "Ontology not found" }`.
- HTTP 404 — Link type not found: `{ "error": "Link type '${apiName}' not found in this ontology." }`.
- HTTP 500 — Internal error (catch and log, return `{ "error": "Internal server error" }`).

**File to modify:** `src/routes/linkTypes.js` — add the GET `/:apiName` handler. Register this route AFTER the `GET /export` route (Task 25) to prevent "export" from being captured as an apiName.

**Testing:**
1. Create a MANY_TO_ONE link type (Employee → Company via Employee.companyId).
2. Fetch it via `GET /api/v2/ontology/{ontologyId}/linkTypes/employeeCompany`.
3. Verify the `linkType` object has all fields including `createdAt` and `updatedAt`.
4. Verify `sourceObjectTypeDetails.apiName` is "Employee" and `targetObjectTypeDetails.apiName` is "Company".
5. Verify `estimatedLinkCount` matches the number of Employee objects with non-null `companyId`.
6. Test with a non-existent apiName — verify HTTP 404 with `{ "error": "Link type 'badName' not found in this ontology." }`.
7. Test with a non-existent ontologyId — verify HTTP 404 with `{ "error": "Ontology not found" }`.
