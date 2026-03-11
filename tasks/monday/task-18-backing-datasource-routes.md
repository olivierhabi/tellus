# TASK 18 OF 30: Backing Datasource Routes

**Objective:** Create Express routes for datasource registration and management, nested under object types at `/api/v2/ontologies/:ontologyId/objectTypes/:apiName/datasource`.

**Step-by-step instructions:**

Create src/routes/datasources.js with `{mergeParams: true}`.

**Helper: resolveObjectTypeId**

Same pattern as Task 16: resolve the object type ID from `:ontologyId` and `:apiName` params. If not found, return 404.

**Route 1: POST .../datasource**

Register a backing datasource. Input validation via `validateBody(REGISTER_DATASOURCE_SCHEMA)` from Task 19.

Required request body fields:
- `datasetName` (string, 1–256 chars): human-readable name for the datasource
- `filePath` (string): filesystem path to the CSV/JSON file
- `fileFormat` (string, one of: 'csv', 'json'): format of the backing file
- `columnMapping` (object): maps property apiNames to file column names, e.g., `{"employeeId": "emp_id", "fullName": "name"}`

Handler:
1. Resolve objectTypeId.
2. Call `datasourceService.register(objectTypeId, req.body)`.
3. Format using `formatDatasource(result)`.
4. Return HTTP 201 with `sendCreated(res, formatted)`.
5. Error handling: DATASOURCE_ALREADY_REGISTERED → 409, DATASOURCE_FILE_NOT_FOUND → 400, COLUMN_MAPPING_INVALID → 400, PRIMARY_KEY_NOT_SET → 400, OBJECT_TYPE_NOT_FOUND → 404.

**Route 2: GET .../datasource**

Get the current backing datasource for this object type.
1. Resolve objectTypeId.
2. Call `datasourceService.getByObjectType(objectTypeId)`.
3. If result is null, return HTTP 404 with `sendError(res, 'DATASOURCE_NOT_FOUND', "No datasource registered for this object type.")`.
4. Format using `formatDatasource(result)`.
5. Return HTTP 200 with `sendSuccess(res, formatted)`.

**Route 3: DELETE .../datasource**

Unregister the backing datasource.
1. Resolve objectTypeId.
2. Call `datasourceService.unregister(objectTypeId)`.
3. Return HTTP 204 with `sendNoContent(res)`.
4. If DATASOURCE_NOT_FOUND, return 404.

**Route 4: POST .../datasource/scan**

Re-scan the file without reindexing. Useful when the file has been updated externally.
1. Resolve objectTypeId.
2. Call `datasourceService.scan(objectTypeId)`.
3. Return HTTP 200 with `sendSuccess(res, {datasource: formatDatasource(result.datasource), schemaChanged: result.schemaChanged})`.
4. If DATASOURCE_NOT_FOUND, return 404. If DATASOURCE_FILE_NOT_FOUND (file was deleted), return 400.

**Registration in src/server.js:**
```javascript
const datasourceRouter = require('./routes/datasources');
app.use('/api/v2/ontologies/:ontologyId/objectTypes/:apiName/datasource', datasourceRouter);
```

**Files to create:** src/routes/datasources.js
**Modify:** src/server.js to mount the router

**Verification:**
- `POST .../datasource` with valid CSV path and column mapping → 201 with columnNames and rowCount in response
- `POST .../datasource` again → 409 DATASOURCE_ALREADY_REGISTERED
- `GET .../datasource` → 200 with datasource info
- `GET .../datasource` when none registered → 404
- `POST .../datasource/scan` → 200 with schemaChanged field
- `DELETE .../datasource` → 204
- `DELETE .../datasource` again → 404
- `POST .../datasource` with non-existent file → 400 DATASOURCE_FILE_NOT_FOUND
- `POST .../datasource` with invalid column mapping → 400 COLUMN_MAPPING_INVALID
