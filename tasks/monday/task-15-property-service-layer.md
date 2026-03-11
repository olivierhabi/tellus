# TASK 15 OF 30: Property Service Layer

**Objective:** Create the service layer for Property CRUD with seven methods: create, getByApiName, listByObjectType, update, delete, setPrimaryKey, and setTitleProperty. This service validates base types against the type system, enforces the 2000-property limit, and handles primary key and title property assignment.

**Step-by-step instructions:**

Create src/services/propertyService.js with these seven methods:

**Method 1: create(objectTypeId, data)**

Accepts objectTypeId and an object with: apiName (required), displayName (required), baseType (required), description (optional), structSchema (optional), isRequired (optional, default false), ordinal (optional, default 0).

Validation steps in order:
1. Validate `apiName` using `validatePropertyName` (Task 8). If invalid, throw `INVALID_API_NAME`.
2. Validate `baseType` is in `VALID_BASE_TYPES` (Task 7). If not, throw `INVALID_BASE_TYPE` with message "Invalid base type '{baseType}'. Valid types: {VALID_BASE_TYPES.join(', ')}."
3. If `baseType === 'struct'`, validate `structSchema` using `validateStructSchema` (Task 22). If invalid, throw `VALIDATION_FAILED` with the specific errors.
4. If `baseType !== 'struct'` and `structSchema` is provided, throw `VALIDATION_FAILED` with message "structSchema can only be set when baseType is 'struct'."
5. Check property count: `SELECT COUNT(*)::int FROM property WHERE object_type_id = $1`. Also fetch limit: `SELECT max_properties FROM object_type WHERE object_type_id = $1`. If count >= max_properties, throw `VALIDATION_FAILED` with message "Maximum of {max_properties} properties per object type reached (current: {count})."
6. Auto-set `is_array`: if `baseType` ends with `'_array'`, set `isArray = true`, otherwise `isArray = false`.

Insert:
```sql
INSERT INTO property (object_type_id, api_name, display_name, base_type, description, struct_schema, is_required, is_array, ordinal)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
```
Catch PostgreSQL error 23505 (unique violation on `(object_type_id, api_name)`) and throw `PROPERTY_ALREADY_EXISTS`.

Return the created row.

**Method 2: getByApiName(objectTypeId, propertyApiName)**

Query: `SELECT * FROM property WHERE object_type_id = $1 AND api_name = $2`. If no row, throw `PROPERTY_NOT_FOUND` with message "Property '{propertyApiName}' not found on this object type."

Return the row.

**Method 3: listByObjectType(objectTypeId)**

Query: `SELECT * FROM property WHERE object_type_id = $1 ORDER BY ordinal ASC, api_name ASC`.

Return the array of rows. No pagination — property lists are small (max 2000).

**Method 4: update(objectTypeId, propertyApiName, data)**

Updatable fields: `displayName`, `description`, `isRequired`, `ordinal`. NOT updatable: `apiName`, `baseType` (changing these after creation would require reindexing and is a breaking change — Palantir warns against this).

1. If `data` contains `apiName` or `baseType`, throw `VALIDATION_FAILED` with message "Cannot change apiName or baseType after creation. These are breaking changes that require creating a new property."
2. Build dynamic UPDATE with only the provided fields. Always set `updated_at = NOW()` (note: the property table doesn't have updated_at in the current schema — use the object_type's updated_at instead by also running `UPDATE object_type SET updated_at = NOW() WHERE object_type_id = $1`).
3. Use `RETURNING *`. If no row returned, throw `PROPERTY_NOT_FOUND`.
4. Return the updated row.

**Method 5: delete(objectTypeId, propertyApiName)**

1. Look up the property: `SELECT * FROM property WHERE object_type_id = $1 AND api_name = $2`. If not found, throw `PROPERTY_NOT_FOUND`.
2. Check if this is the primary key: `SELECT primary_key_property_id FROM object_type WHERE object_type_id = $1`. If `primary_key_property_id === property.property_id`, throw `VALIDATION_FAILED` with message "Cannot delete the primary key property '{propertyApiName}'. Change the primary key first."
3. Check if this is the title property: `SELECT title_property_id FROM object_type WHERE object_type_id = $1`. If it matches, allow deletion but log a warning: `"Deleting title property '{propertyApiName}' — object type will have no title property."` The title_property_id will be set to NULL by the FK's ON DELETE SET NULL.
4. Guard check for link_type references: check if `pg_tables` has `link_type`. If the table exists, query for references. If the table does not exist, skip. (Link types are a future sprint.)
5. Delete: `DELETE FROM property WHERE property_id = $1`.
6. Return void.

**Method 6: setPrimaryKey(objectTypeId, propertyApiName)**

1. Look up the property: `SELECT * FROM property WHERE object_type_id = $1 AND api_name = $2`. If not found, throw `PROPERTY_NOT_FOUND` with message "Property '{propertyApiName}' not found."
2. Update: `UPDATE object_type SET primary_key_property_id = $1, updated_at = NOW() WHERE object_type_id = $2 RETURNING *`.
3. Return the updated object_type row.

**Method 7: setTitleProperty(objectTypeId, propertyApiName)**

Same pattern as setPrimaryKey but for `title_property_id`.

1. Look up the property. If not found, throw `PROPERTY_NOT_FOUND`.
2. Update: `UPDATE object_type SET title_property_id = $1, updated_at = NOW() WHERE object_type_id = $2 RETURNING *`.
3. Return the updated object_type row.

**Files to create:** src/services/propertyService.js

**Verification:**
- `create` with valid data → returns row with generated UUID
- `create` with invalid baseType → throws INVALID_BASE_TYPE
- `create` with baseType 'struct' and valid structSchema → succeeds
- `create` with duplicate apiName → throws PROPERTY_ALREADY_EXISTS
- `create` when at max_properties limit → throws VALIDATION_FAILED
- `getByApiName` with valid name → returns row
- `getByApiName` with non-existent name → throws PROPERTY_NOT_FOUND
- `listByObjectType` → returns array ordered by ordinal then apiName
- `update` with displayName change → returns updated row
- `update` with baseType change → throws VALIDATION_FAILED
- `delete` non-PK property → succeeds
- `delete` PK property → throws VALIDATION_FAILED with clear message
- `setPrimaryKey` → object_type row has updated primary_key_property_id
- `setTitleProperty` → object_type row has updated title_property_id
