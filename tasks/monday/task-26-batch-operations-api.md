# TASK 26 OF 30: Batch Operations API

**Objective:** Add two batch endpoints: one for creating an object type with all its properties atomically (single request), and one for adding multiple properties to an existing object type atomically. These mirror Palantir's Ontology Manager creation wizard where users define everything in one step.

**Step-by-step instructions:**

**Endpoint 1: POST /api/v1/ontologies/:ontologyId/objectTypes/batch**

Create a single object type WITH all its properties, primary key, and title in one atomic request. Add this route to src/routes/objectTypes.js.

Request body:
```json
{
  "apiName": "Employee",
  "displayName": "Employee",
  "description": "Employee records",
  "icon": "person",
  "iconColor": "#1565C0",
  "properties": [
    {"apiName": "employeeId", "displayName": "Employee ID", "baseType": "string", "isRequired": true},
    {"apiName": "fullName", "displayName": "Full Name", "baseType": "string", "isRequired": true},
    {"apiName": "salary", "displayName": "Salary", "baseType": "double"}
  ],
  "primaryKeyProperty": "employeeId",
  "titleProperty": "fullName"
}
```

Validation:
- `apiName`, `displayName`, and `properties` (non-empty array) are required. If missing, return 400 with `REQUIRED_FIELD_MISSING`.
- `primaryKeyProperty` is required: the primary key must be set during batch creation. If missing, return 400 with `PRIMARY_KEY_NOT_SET`.
- `titleProperty` is optional.
- `primaryKeyProperty` and `titleProperty` values must match an `apiName` in the `properties` array. If not, return 400 with `VALIDATION_FAILED` and message "primaryKeyProperty '{name}' does not match any property apiName."

Implementation: Add a `batchCreate` method to src/services/objectTypeService.js. Use a database transaction:
1. `BEGIN`
2. Create object type via `objectTypeService.create`.
3. Create all properties via `propertyService.create` (loop).
4. `propertyService.setPrimaryKey` with the property matching `primaryKeyProperty`.
5. If `titleProperty` is provided, `propertyService.setTitleProperty`.
6. `COMMIT` — if any step fails, `ROLLBACK` and return the error.

Return HTTP 201 with the full object type (formatted via `formatObjectType` with all created properties, null datasource, and the created funnelState). This ensures atomicity — if any property creation fails (e.g., invalid baseType), the entire object type creation is rolled back.

**Endpoint 2: POST /api/v1/ontologies/:ontologyId/objectTypes/:apiName/properties/batch**

Add multiple properties to an existing object type in a single atomic request. Add this route to src/routes/properties.js.

Request body:
```json
{
  "properties": [
    {"apiName": "department", "displayName": "Department", "baseType": "string"},
    {"apiName": "startDate", "displayName": "Start Date", "baseType": "date"}
  ]
}
```

Validation:
- `properties` must be a non-empty array. If missing or empty, return 400 with `REQUIRED_FIELD_MISSING`.
- Validate ALL properties before inserting ANY. For each property, run the same validations as `propertyService.create` (apiName format, baseType validity, struct_schema if struct, property count limit). Collect all errors.
- If any validation fails, return 400 with `VALIDATION_FAILED` and all error messages. No properties are created.

Implementation: Add a `batchCreate` method to src/services/propertyService.js. Use a database transaction:
1. `BEGIN`
2. Validate all properties (collect errors).
3. If any errors, `ROLLBACK` and throw.
4. Insert all properties.
5. `COMMIT`

Return HTTP 201 with the array of created properties, each formatted via `formatProperty`.

**Files to modify:** src/routes/objectTypes.js, src/routes/properties.js, src/services/objectTypeService.js, src/services/propertyService.js

**Verification:**
- Batch create Employee with 10 properties → 201, all 10 properties returned, PK and title set
- Batch create with one invalid baseType in property #5 → 400, no object type created, no properties created
- Batch create with duplicate apiName → 409 OBJECT_TYPE_ALREADY_EXISTS
- Batch create with `primaryKeyProperty` not matching any property → 400 VALIDATION_FAILED
- Batch add 3 properties to existing object type → 201, 3 properties returned
- Batch add with one invalid property → 400, none of the 3 created
