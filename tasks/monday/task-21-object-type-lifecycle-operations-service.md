# TASK 21 OF 30: Object Type Lifecycle Operations Service

**Objective:** Add four lifecycle methods to the existing objectTypeService (src/services/objectTypeService.js): changeStatus, clone, exportDefinition, and importDefinition. These go beyond basic CRUD and mirror Palantir's Ontology Manager lifecycle management.

**Step-by-step instructions:**

Add these four methods to src/services/objectTypeService.js:

**Method 1: changeStatus(ontologyId, apiName, newStatus)**

1. Validate `newStatus` is one of: `'active'`, `'experimental'`, `'deprecated'`. If not, throw `VALIDATION_FAILED` with message "Invalid status. Must be one of: active, experimental, deprecated."
2. Look up the object type: `SELECT * FROM object_type WHERE ontology_id = $1 AND api_name = $2`. If not found, throw `OBJECT_TYPE_NOT_FOUND`.
3. If `newStatus === 'deprecated'`, log a warning: `"Object type '{apiName}' set to deprecated — dependent applications may break."`
4. Update: `UPDATE object_type SET status = $1, updated_at = NOW() WHERE object_type_id = $2 RETURNING *`.
5. Return the updated object_type row.

**Method 2: clone(ontologyId, sourceApiName, newApiName, newDisplayName)**

Creates a complete copy of an object type's schema (properties) but NOT its backing datasource or funnel state.

1. Fetch the source object type: `SELECT * FROM object_type WHERE ontology_id = $1 AND api_name = $2`. If not found, throw `OBJECT_TYPE_NOT_FOUND`.
2. Fetch source properties: `SELECT * FROM property WHERE object_type_id = $1 ORDER BY ordinal`.
3. Validate `newApiName` using `validateObjectTypeName`. If invalid, throw `INVALID_API_NAME`.
4. Insert a new object_type row: same `ontology_id`, `icon`, `icon_color` as the source. Use `newApiName` and `newDisplayName`. Set `status` to `'experimental'` (clones start as experimental). Do NOT copy `primary_key_property_id` or `title_property_id` yet (the new property UUIDs don't exist yet).
5. For each source property, insert a new property row on the clone with the same `api_name`, `display_name`, `base_type`, `description`, `struct_schema`, `is_required`, `is_array`, and `ordinal`.
6. Set the clone's `primary_key_property_id`: find the cloned property whose `api_name` matches the source's primary key property's `api_name`. Update the clone's object_type row.
7. Set the clone's `title_property_id`: same lookup by `api_name` for the title property. If the source has no title property, skip.
8. Create a funnel_state row for the clone with status `'not_indexed'`.
9. Return the new object type with its properties (same shape as `getByApiName`).

Use a database transaction (BEGIN/COMMIT/ROLLBACK) to ensure atomicity — if any step fails, nothing is created.

**Method 3: exportDefinition(ontologyId, apiName)**

Exports a single object type definition as a JSON-serializable object. This does NOT include actual data or datasource configuration — only the schema definition.

1. Call `getByApiName(ontologyId, apiName)` to get the full object type with properties.
2. Build and return this exact structure:
```json
{
  "exportVersion": "1.0",
  "exportedAt": "<ISO 8601 timestamp>",
  "objectType": {
    "apiName": "Employee",
    "displayName": "Employee",
    "description": "...",
    "icon": "person",
    "iconColor": "#1565C0",
    "status": "active",
    "primaryKeyProperty": "employeeId",
    "titleProperty": "fullName",
    "properties": [
      {
        "apiName": "employeeId",
        "displayName": "Employee ID",
        "baseType": "string",
        "description": null,
        "structSchema": null,
        "isRequired": true,
        "isArray": false,
        "ordinal": 0
      }
    ]
  }
}
```
Note: `primaryKeyProperty` and `titleProperty` are the property `api_name` strings (not UUIDs). Properties are an array (not an object) in the export format. Task 28's full ontology export reuses this method internally.

**Method 4: importDefinition(ontologyId, definition)**

Imports a single object type from a JSON definition object (the inverse of exportDefinition).

1. Validate `definition.exportVersion === "1.0"`. If not, throw `VALIDATION_FAILED` with message "Unsupported export version: {version}. Expected: 1.0."
2. Validate `definition.objectType` exists and has required fields: `apiName`, `displayName`, `properties` (array).
3. Check no object type with the same `apiName` exists in this ontology. If it does, throw `OBJECT_TYPE_ALREADY_EXISTS`.
4. Use a database transaction:
   a. Create the object type using `objectTypeService.create`.
   b. Create each property from `definition.objectType.properties` using `propertyService.create`.
   c. If `primaryKeyProperty` is specified, call `propertyService.setPrimaryKey`.
   d. If `titleProperty` is specified, call `propertyService.setTitleProperty`.
5. Return the created object type with all properties (same shape as `getByApiName`).

**Files to modify:** src/services/objectTypeService.js

**Verification:**
- `changeStatus(ontologyId, 'Employee', 'deprecated')` → returns updated row with status 'deprecated'
- `changeStatus` with invalid status → throws VALIDATION_FAILED
- `clone(ontologyId, 'Employee', 'EmployeeCopy', 'Employee Copy')` → creates new object type with same properties, PK, and title. Clone has status 'experimental' and its own funnel_state
- `clone` with duplicate newApiName → throws OBJECT_TYPE_ALREADY_EXISTS
- `exportDefinition(ontologyId, 'Employee')` → returns JSON with exportVersion, objectType, and properties array
- `importDefinition(ontologyId, exportedJson)` into a different ontology → creates identical object type with all properties, PK, and title
- `importDefinition` with existing apiName → throws OBJECT_TYPE_ALREADY_EXISTS
