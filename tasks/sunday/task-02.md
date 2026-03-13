# TASK 2: Create Interface API — POST Endpoint for Creating Interfaces

## Objective
Build the REST API endpoint that allows creating a new Interface definition in the Ontology. This endpoint must validate all inputs, create the Interface and its properties in a single atomic transaction, and return the complete Interface definition in the response.

## Exact Specification

Create a new route file at `/src/routes/interfaces.js` and register it in `server.js` under the path prefix `/api/v2/ontology/:ontologyId/interfaces`.

**Endpoint:** `POST /api/v2/ontology/:ontologyId/interfaces`

**Request Body (JSON):**
```json
{
  "apiName": "HasLocation",
  "displayName": "Has Geographic Location",
  "description": "Implement this interface for any Object Type that has a physical geographic location. Provides standardized latitude/longitude properties for mapping and geospatial queries.",
  "properties": [
    {
      "apiName": "latitude",
      "displayName": "Latitude",
      "baseType": "double",
      "isRequired": true
    },
    {
      "apiName": "longitude",
      "displayName": "Longitude",
      "baseType": "double",
      "isRequired": true
    },
    {
      "apiName": "locationName",
      "displayName": "Location Name",
      "baseType": "string",
      "isRequired": false
    }
  ]
}
```

**Validation Rules (enforce ALL of these before any database writes):**

1. `ontologyId` path parameter must be a valid UUID. If not, return HTTP 400 with error code "INVALID_PARAMETER" and message "ontologyId must be a valid UUID".

2. The ontology with this ID must exist in the `ontology` table. If not, return HTTP 404 with error code "NOT_FOUND" and message "Ontology with id '{ontologyId}' not found".

3. `apiName` is required and must be a non-empty string. If missing or empty, return HTTP 400 with error code "MISSING_REQUIRED_FIELD" and message "apiName is required".

4. `apiName` must match the pattern `^[A-Z][a-zA-Z0-9]*$` (PascalCase, starts with uppercase letter, alphanumeric only). If not, return HTTP 400 with error code "INVALID_FORMAT" and message "apiName must be PascalCase starting with an uppercase letter (e.g., 'HasLocation', 'Auditable')".

5. `apiName` must not already exist in the `interface` table (globally unique). If it does, return HTTP 409 with error code "ALREADY_EXISTS" and message "Interface with apiName '{apiName}' already exists".

6. `apiName` must also not conflict with any existing Object Type api_name in the same Ontology. Check the `object_type` table. If it conflicts, return HTTP 409 with error code "NAME_CONFLICT" and message "The name '{apiName}' is already used by an Object Type in this Ontology".

   Note: Rule 5 enforces global uniqueness for Interface apiNames (across all Ontologies), while rule 6 additionally prevents Interface names from conflicting with Object Type names within the same Ontology. These are intentionally different scopes.

7. `displayName` is required and must be a non-empty string with a maximum length of 500 characters.

8. `description` is optional. If provided, it must be a string with a maximum length of 10,000 characters.

9. `properties` is required and must be a non-empty array. An Interface with zero properties is not valid — it must define at least one property. If empty or missing, return HTTP 400 with error code "INVALID_PARAMETER" and message "An Interface must define at least one property".

10. `properties` must not exceed 100 entries. While Palantir allows up to 2,000 properties on Object Types, Interfaces are typically smaller. If exceeded, return HTTP 400 with error code "LIMIT_EXCEEDED" and message "An Interface cannot define more than 100 properties".

11. Each property in the `properties` array must have: `apiName` (required, non-empty string matching `^[a-z][a-zA-Z0-9]*$`), `displayName` (required, non-empty string), `baseType` (required, must be one of the valid base types listed in Task 1: string, boolean, integer, long, double, float, date, timestamp, byte, short, decimal, geopoint, geoshape, string_array, integer_array, long_array, double_array, boolean_array, timestamp_array, struct).

12. Property `apiName` values must be unique within the properties array. If duplicates exist, return HTTP 400 with error code "DUPLICATE_PROPERTY" and message "Duplicate property apiName '{name}' in Interface definition".

13. `isRequired` on each property defaults to `false` if not provided. If provided, it must be a boolean.

**Database Operations (must be in a single PostgreSQL transaction):**

```javascript
// Pseudocode for the transaction
const client = await pool.connect();
try {
  await client.query('BEGIN');
  
  // 1. Insert the Interface
  const interfaceId = uuid.v4();
  await client.query(
    'INSERT INTO interface (interface_id, ontology_id, api_name, display_name, description) VALUES ($1, $2, $3, $4, $5)',
    [interfaceId, ontologyId, apiName, displayName, description]
  );
  
  // 2. Insert all Interface Properties
  for (let i = 0; i < properties.length; i++) {
    const prop = properties[i];
    await client.query(
      'INSERT INTO interface_property (interface_property_id, interface_id, api_name, display_name, base_type, is_required, ordinal) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [uuid.v4(), interfaceId, prop.apiName, prop.displayName, prop.baseType, prop.isRequired || false, i]
    );
  }
  
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
}
```

The transaction is critical. If the Interface is inserted but one of the properties fails validation at the database level, the entire operation must roll back. The caller must never see a partially-created Interface.

**Success Response (HTTP 201 Created):**
```json
{
  "data": {
    "interfaceId": "a1b2c3d4-...",
    "apiName": "HasLocation",
    "displayName": "Has Geographic Location",
    "description": "Implement this interface for any Object Type...",
    "properties": [
      {
        "apiName": "latitude",
        "displayName": "Latitude",
        "baseType": "double",
        "isRequired": true,
        "ordinal": 0
      },
      {
        "apiName": "longitude",
        "displayName": "Longitude",
        "baseType": "double",
        "isRequired": true,
        "ordinal": 1
      },
      {
        "apiName": "locationName",
        "displayName": "Location Name",
        "baseType": "string",
        "isRequired": false,
        "ordinal": 2
      }
    ],
    "implementingObjectTypes": [],
    "createdAt": "2025-03-16T10:00:00.000Z",
    "updatedAt": "2025-03-16T10:00:00.000Z"
  }
}
```

The `implementingObjectTypes` field is an empty array because no Object Types have implemented this Interface yet. This field will be populated by a JOIN query in the GET endpoint (Task 3).

**Error Response Format (for ALL error cases):**
```json
{
  "error": {
    "code": "ALREADY_EXISTS",
    "message": "Interface with apiName 'HasLocation' already exists",
    "details": {
      "apiName": "HasLocation",
      "existingInterfaceId": "x1y2z3-..."
    }
  }
}
```

## Verification
1. POST a valid Interface with 3 properties → 201 with complete response
2. POST again with same apiName → 409 ALREADY_EXISTS
3. POST with invalid apiName "has-location" → 400 INVALID_FORMAT
4. POST with empty properties array → 400 INVALID_PARAMETER
5. POST with duplicate property names → 400 DUPLICATE_PROPERTY
6. POST with invalid baseType "varchar" → 400 INVALID_PARAMETER
7. POST with non-existent ontologyId → 404 NOT_FOUND
8. Verify both `interface` and `interface_property` tables have correct data
9. If the second property insert fails (simulate by temporarily adding a bad constraint), verify NEITHER the interface NOR the first property exists (transaction rollback)
