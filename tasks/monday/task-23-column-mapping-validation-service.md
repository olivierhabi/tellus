# TASK 23 OF 30: Column Mapping Validation Service

**Objective:** Create a validation service for column mappings used when registering a backing datasource. The column mapping tells the indexer how to translate file columns into object properties. This module is called by datasourceService.register (Task 17) and is the single source of truth for column mapping validation.

**Step-by-step instructions:**

Create src/utils/columnMappingValidator.js.

**Export: validateColumnMapping(columnMapping, properties, fileColumns, primaryKeyPropertyApiName, sampleRows)**

Parameters:
- `columnMapping` (object): `{propertyApiName: fileColumnName}` — maps property apiNames to file column headers
- `properties` (array): array of property DB rows for this object type (from `SELECT * FROM property WHERE object_type_id = $1`)
- `fileColumns` (string[]): array of column names from the file header (from fileScannerService, Task 24)
- `primaryKeyPropertyApiName` (string): the api_name of the primary key property
- `sampleRows` (object[]): first 10 rows from the file as objects keyed by column name (from fileScannerService, Task 24)

Returns: `{valid: boolean, errors: string[], warnings: string[]}`
- `valid`: true if `errors` array is empty, false otherwise
- `errors`: hard failures that prevent registration
- `warnings`: non-blocking issues shown to the user

Validation rules in this exact order:

1. `columnMapping` must be a non-null object with at least one key. If not: error `"Column mapping must be a non-empty object."`.

2. Every KEY in `columnMapping` must match an existing property `api_name` on this object type. Build a Set of property apiNames for efficient lookup. For each key that doesn't match: error `"Property '{key}' in column mapping does not exist on this object type. Available properties: [{available}]."`.

3. Every VALUE in `columnMapping` must match a column name in `fileColumns`. For each value that doesn't match: error `"Column '{value}' in mapping for property '{key}' does not exist in the file. Available columns: [{fileColumns}]."`.

4. The primary key property must be included as a key in `columnMapping`. If missing: error `"Primary key property '{primaryKeyPropertyApiName}' must be included in the column mapping."`.

5. Check for duplicate values: if two or more properties map to the same file column, add a WARNING (not error): `"Warning: Properties '{propA}' and '{propB}' both map to column '{column}'. Both properties will have the same value."`.

6. Check required properties: for each property with `is_required === true` that is NOT a key in `columnMapping`: error `"Required property '{apiName}' is not included in the column mapping. All objects will have null values for this property, which will cause indexing to fail."`.

7. Type compatibility check using sample data: for each mapped property, take the corresponding column values from `sampleRows` (up to 10 rows). For each value, attempt to coerce it using `coerceFromString(property.base_type, value)` from Task 7. If coercion fails for any row, add a WARNING: `"Column '{column}' mapped to property '{apiName}' (type: {baseType}) contains value '{value}' in row {rowIndex + 1} that cannot be coerced. These rows will fail during indexing."`. Only report the first 3 failures per property to avoid flooding the response.

**Files to create:** src/utils/columnMappingValidator.js

**Verification:**
- Valid mapping with all columns matching → `{valid: true, errors: [], warnings: []}`
- Property not on object type → error includes property name and available properties
- Column not in file → error includes column name and available columns
- Missing PK property → error includes PK property name
- Two properties mapping to same column → warning (not error)
- Required property not mapped → error
- Column with non-numeric values mapped to double property → warning with specific row number and value
- Mapping with 0 keys → error "Column mapping must be a non-empty object"
