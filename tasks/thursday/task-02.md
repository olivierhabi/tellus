# TASK 2: Create the POST `/api/v1/ontology/:ontologyId/linkTypes` Endpoint

**Objective:** Build the REST API endpoint that allows users to create a new link type definition in the Ontology. This endpoint receives a JSON body describing the relationship between two object types, validates all inputs, inserts a row into the `link_type` table, and returns the created link type definition.

**Why this exists in Palantir:** In Palantir Foundry, link types are created through the Ontology Manager UI or programmatically via the API. The creation process validates that the referenced object types exist, that the foreign key property exists on the correct side, and that the cardinality is valid. The API response includes the full link type definition so the caller can confirm what was created.

**HTTP method and path:** `POST /api/v1/ontology/:ontologyId/linkTypes`

**Request headers:**
- `Content-Type: application/json`

**Path parameters:**
- `ontologyId` (UUID): The ID of the ontology in which to create the link type. Must reference an existing ontology in the `ontology` table. If not found, return HTTP 404 with `{ "error": "Ontology not found", "ontologyId": "${ontologyId}" }`.

**Request body schema:**

```json
{
    "apiName": "string, required — unique identifier for this link type, must match pattern ^[a-zA-Z][a-zA-Z0-9_]*$ (starts with letter, alphanumeric + underscore only), max 256 characters",
    "displayName": "string, required — human-readable name, max 512 characters",
    "description": "string, optional — free-text description of what this relationship represents",
    "sourceObjectType": "string, required — api_name of the source object type",
    "targetObjectType": "string, required — api_name of the target object type",
    "cardinality": "string, required — one of: ONE_TO_ONE, ONE_TO_MANY, MANY_TO_ONE, MANY_TO_MANY",
    "foreignKey": {
        "propertyApiName": "string, required for non-M2M — the property that holds the FK value",
        "side": "string, required for non-M2M — 'source' or 'target', which object type has the FK property"
    },
    "joinTable": {
        "filePath": "string, required for M2M — path to the join table CSV file",
        "sourceColumn": "string, required for M2M — column name in the CSV that maps to source PK",
        "targetColumn": "string, required for M2M — column name in the CSV that maps to target PK"
    }
}
```

**Validation rules (implement ALL of these in order):**

1. Validate that `apiName` is present, is a string, matches the regex `^[a-zA-Z][a-zA-Z0-9_]*$`, and is at most 256 characters. If invalid, return HTTP 400 with `{ "error": "Invalid apiName. Must start with a letter and contain only alphanumeric characters and underscores.", "apiName": "${apiName}" }`.

2. Validate that `displayName` is present and is a non-empty string of at most 512 characters. If missing or empty, return HTTP 400 with `{ "error": "displayName is required." }`.

3. Validate that `sourceObjectType` is present and references an existing object type in this ontology. Query: `SELECT object_type_id, api_name FROM object_type WHERE ontology_id = $1 AND api_name = $2`. If not found, return HTTP 400 with `{ "error": "Source object type '${sourceObjectType}' does not exist in this ontology." }`.

4. Validate that `targetObjectType` is present and references an existing object type in this ontology. Same query pattern. If not found, return HTTP 400 with `{ "error": "Target object type '${targetObjectType}' does not exist in this ontology." }`.

5. Validate that `cardinality` is one of the four allowed values (case-sensitive): `ONE_TO_ONE`, `ONE_TO_MANY`, `MANY_TO_ONE`, `MANY_TO_MANY`. If invalid, return HTTP 400 with `{ "error": "Invalid cardinality '${cardinality}'. Must be one of: ONE_TO_ONE, ONE_TO_MANY, MANY_TO_ONE, MANY_TO_MANY." }`.

6. If cardinality is NOT `MANY_TO_MANY`: validate that `foreignKey` is present and contains `propertyApiName` (string) and `side` (either `'source'` or `'target'`). If `foreignKey` is missing or incomplete, return HTTP 400 with `{ "error": "Non-many-to-many link types require a foreignKey with propertyApiName and side." }`.

7. If cardinality is NOT `MANY_TO_MANY` and `foreignKey` is provided: validate that the property referenced by `foreignKey.propertyApiName` exists on the object type indicated by `foreignKey.side`. If `side` is `'source'`, check that the property exists on the source object type. If `side` is `'target'`, check that the property exists on the target object type. Query: `SELECT 1 FROM property p JOIN object_type ot ON p.object_type_id = ot.object_type_id WHERE ot.ontology_id = $1 AND ot.api_name = $2 AND p.api_name = $3`. If not found, return HTTP 400 with `{ "error": "Foreign key property '${propertyApiName}' does not exist on ${side} object type '${objectType}'." }`.

8. If cardinality IS `MANY_TO_MANY`: validate that `joinTable` is present and contains `filePath` (string), `sourceColumn` (string), and `targetColumn` (string). If missing or incomplete, return HTTP 400 with `{ "error": "Many-to-many link types require a joinTable with filePath, sourceColumn, and targetColumn." }`.

9. If cardinality IS `MANY_TO_MANY` and `foreignKey` is also provided: return HTTP 400 with `{ "error": "Many-to-many link types use joinTables, not foreignKeys. Provide joinTable only." }`.

10. Check for uniqueness of `apiName` within the ontology. This is enforced by the database UNIQUE constraint, but catch the PostgreSQL error code `23505` and return HTTP 409 with `{ "error": "A link type with apiName '${apiName}' already exists in this ontology." }`.

**Database insert:** After all validations pass, insert a row into the `link_type` table with all the provided values. Generate a UUID for `link_type_id`. Set `created_at` and `updated_at` to `now()`. Set `is_bidirectional` to `true` (default).

**Success response:** HTTP 201 Created

```json
{
    "linkType": {
        "linkTypeId": "uuid-here",
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
        "createdAt": "2025-03-11T10:00:00.000Z"
    }
}
```

**Error responses:** As described in each validation rule above. All errors should follow the shape `{ "error": "message string", ...additionalContext }`.

**Error response format:** All error responses must follow this shape: `{ "error": "message string" }`. The `error` field is always a string. Additional context fields are optional (e.g., `apiName`, `ontologyId`).

**File to create or modify:** Create a new route file `src/routes/linkTypes.js` and register it in the main Express app at `/api/v1/ontology/:ontologyId/linkTypes`. The route handler should import the database pool (`db` from `src/db/pool.js`) and perform all queries within a single database transaction (using `BEGIN`/`COMMIT`/`ROLLBACK`) to ensure atomicity — if any validation query fails or the insert fails, no partial state is left.

**Logging:** Log every successful link type creation with: `console.log(\`[LINK_TYPE_CREATED] ontology=${ontologyId} apiName=${apiName} source=${sourceObjectType} target=${targetObjectType} cardinality=${cardinality}\`)`.

**Testing instructions for the human:** After implementation, test with these curl commands:

```bash
# Create a MANY_TO_ONE link (Employee → Company via Employee.companyId)
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/linkTypes \
  -H "Content-Type: application/json" \
  -d '{
    "apiName": "employeeCompany",
    "displayName": "Employee → Employer",
    "sourceObjectType": "Employee",
    "targetObjectType": "Company",
    "cardinality": "MANY_TO_ONE",
    "foreignKey": { "propertyApiName": "companyId", "side": "source" }
  }'

# Should return 201 with full link type definition

# Test validation: invalid source object type
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/linkTypes \
  -H "Content-Type: application/json" \
  -d '{
    "apiName": "badLink",
    "displayName": "Bad Link",
    "sourceObjectType": "NonExistent",
    "targetObjectType": "Company",
    "cardinality": "ONE_TO_MANY",
    "foreignKey": { "propertyApiName": "x", "side": "source" }
  }'

# Should return 400 with "Source object type 'NonExistent' does not exist"
```
