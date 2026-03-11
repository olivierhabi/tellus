# TASK 17 OF 30: Backing Datasource Service Layer

**Objective:** Create the service for registering, scanning, and managing backing datasources with four methods: register, getByObjectType, scan, and unregister. This service validates file existence, scans file headers, validates column mapping against properties, and enforces Palantir's one-datasource-per-object-type rule.

**Step-by-step instructions:**

Create src/services/datasourceService.js with these four methods:

**Method 1: register(objectTypeId, data)**

Accepts objectTypeId and an object with: datasetName (string), filePath (string), fileFormat (string: 'csv' or 'json'), and columnMapping (object: {propertyApiName: fileColumnName}).

Validation steps in this exact order:
1. Check object type exists: `SELECT * FROM object_type WHERE object_type_id = $1`. If not found, throw `OBJECT_TYPE_NOT_FOUND`.
2. Check no datasource already registered: `SELECT mapping_id FROM backing_datasource WHERE object_type_id = $1`. If exists, throw `DATASOURCE_ALREADY_REGISTERED` with message "This object type already has a registered datasource."
3. Check no other object type uses this file: `SELECT object_type_id FROM backing_datasource WHERE file_path = $1`. If exists, throw `DATASOURCE_ALREADY_REGISTERED` with message "File '{filePath}' is already registered to another object type."
4. Check file exists on filesystem: `fs.existsSync(filePath)`. If not, throw `DATASOURCE_FILE_NOT_FOUND` with message "File not found: {filePath}".
5. Scan the file using `fileScannerService.scanFile(filePath, fileFormat)` (Task 24). This returns `{columnNames, rowCount, schemaHash, sampleRows, inferredTypes}`.
6. Validate column mapping using `validateColumnMapping` (Task 23). Pass `(columnMapping, properties, columnNames, primaryKeyPropertyApiName)`. The `properties` are fetched from the DB: `SELECT * FROM property WHERE object_type_id = $1`. The `primaryKeyPropertyApiName` is looked up from the object type's `primary_key_property_id`. If validation returns `{valid: false}`, throw `COLUMN_MAPPING_INVALID` with the errors array joined as message.
7. Validate primary key property is included: look up the object type's `primary_key_property_id`, get the property's `api_name`, verify it's a key in columnMapping. If not, throw `PRIMARY_KEY_NOT_SET` with message "The primary key property must be included in the column mapping."
8. Determine `primary_key_column`: the columnMapping value for the primary key property's api_name.

Insert the row:
```sql
INSERT INTO backing_datasource (object_type_id, dataset_name, file_path, file_format, column_mapping, primary_key_column, row_count, column_names, schema_hash)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
```

After insert, update funnel_state:
- If funnel_state.status is `'not_indexed'` or `null`, keep it as `'not_indexed'` (datasource registered but not yet indexed).
- If funnel_state.status is `'indexed'`, set to `'stale'` (datasource replaced, reindexing needed).
- If funnel_state.status is `'indexing'`, do NOT change it (an indexing operation is in progress).
- If funnel_state.status is `'failed'`, set to `'not_indexed'` (reset after new datasource).

Return the created backing_datasource row.

**Method 2: getByObjectType(objectTypeId)**

Query: `SELECT * FROM backing_datasource WHERE object_type_id = $1`. If no row found, return `null` (not an error — many object types have no datasource). Return the row if found.

**Method 3: scan(objectTypeId)**

Re-scan the file without reindexing. Steps:
1. Fetch the backing_datasource row: `SELECT * FROM backing_datasource WHERE object_type_id = $1`. If not found, throw `DATASOURCE_NOT_FOUND`.
2. Verify the file still exists: `fs.existsSync(row.file_path)`. If not, throw `DATASOURCE_FILE_NOT_FOUND`.
3. Call `fileScannerService.scanFile(row.file_path, row.file_format)`.
4. Compare `schemaHash` with the stored `schema_hash`. If different, update funnel_state to `'stale'`.
5. Update the backing_datasource row: `UPDATE backing_datasource SET row_count = $1, column_names = $2, schema_hash = $3, last_scanned_at = NOW() WHERE mapping_id = $4 RETURNING *`.
6. Return `{datasource: updatedRow, schemaChanged: newHash !== oldHash}`.

**Method 4: unregister(objectTypeId)**

1. Check datasource exists: `SELECT mapping_id FROM backing_datasource WHERE object_type_id = $1`. If not found, throw `DATASOURCE_NOT_FOUND`.
2. Delete: `DELETE FROM backing_datasource WHERE object_type_id = $1`.
3. Update funnel_state to `'not_indexed'` and reset `objects_indexed` to 0.
4. Return void.

**Files to create:** src/services/datasourceService.js

**Verification:**
- `register` with valid CSV → succeeds, returns row with row_count and column_names populated
- `register` second datasource for same object type → throws DATASOURCE_ALREADY_REGISTERED
- `register` with non-existent file → throws DATASOURCE_FILE_NOT_FOUND
- `register` with invalid column mapping (property maps to non-existent column) → throws COLUMN_MAPPING_INVALID with specific column name
- `register` without primary key property in mapping → throws PRIMARY_KEY_NOT_SET
- `getByObjectType` with no datasource → returns null
- `scan` after file update → returns schemaChanged: true and funnel_state becomes 'stale'
- `unregister` → datasource deleted, funnel_state reset to 'not_indexed'
