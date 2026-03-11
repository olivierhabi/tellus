# TASK 9 OF 30: Response Formatter Utility

**Objective:** Create the utility that formats ALL API responses into Palantir-compatible shapes. Every endpoint must use this module — no endpoint constructs its own response object directly.

**Step-by-step instructions:**

Create src/utils/responseFormatter.js.

**Helper: snakeToCamel(obj)**

Recursively converts all keys in an object from snake_case to camelCase. Rules:
- `object_type_id` → `objectTypeId`
- `primary_key_property_id` → `primaryKeyPropertyId`
- Handles nested objects recursively
- Handles arrays (convert each element if it's an object)
- If a value is `null`, keep it as `null`
- Skip conversion for JSONB fields that contain user-defined data: `column_mapping`, `struct_schema`, `column_names`. These fields' internal keys are user-defined and must NOT be converted. Detection: if the key (before conversion) is one of `['column_mapping', 'struct_schema', 'column_names']`, pass the value through as-is.

**Formatter: formatOntology(dbRow, objectTypeCount)**

Converts an ontology DB row to the API response shape:
```json
{
  "ontologyId": "uuid",
  "displayName": "RRA Tax Ontology",
  "description": "...",
  "createdAt": "2025-03-11T...",
  "updatedAt": "2025-03-11T...",
  "createdBy": "system",
  "objectTypeCount": 5
}
```

**Formatter: formatObjectType(dbRow, properties[], datasource, funnelState)**

Converts to the full object type response:
```json
{
  "objectType": {
    "apiName": "Employee",
    "displayName": "Employee",
    "description": null,
    "icon": "person",
    "iconColor": "#1565C0",
    "status": "active",
    "editsViaActionsOnly": true,
    "maxProperties": 2000,
    "primaryKey": "employeeId",
    "titleProperty": "fullName",
    "createdAt": "...",
    "updatedAt": "...",
    "properties": {
      "employeeId": {
        "apiName": "employeeId",
        "displayName": "Employee ID",
        "baseType": "string",
        "description": null,
        "structSchema": null,
        "isRequired": true,
        "isArray": false,
        "ordinal": 0
      }
    },
    "backingDatasource": null,
    "indexingState": null
  }
}
```

Key rules:
- `primaryKey`: look up the property whose `property_id` matches `dbRow.primary_key_property_id`, return its `api_name` string. If `primary_key_property_id` is null, return `null`.
- `titleProperty`: same lookup for `title_property_id`.
- `properties`: returned as `{[apiName]: definition}` object (not an array). Keys are property apiNames.
- `backingDatasource`: `formatDatasource(datasource)` if provided, else `null`.
- `indexingState`: `formatFunnelState(funnelState)` if provided, else `null`.

**Formatter: formatObjectTypeSummary(dbRow, propertyCount, datasourceName, indexStatus)**

Lightweight format for list endpoints (without full property details):
```json
{
  "apiName": "Employee",
  "displayName": "Employee",
  "status": "active",
  "propertyCount": 10,
  "datasourceName": "Employee Dataset",
  "indexStatus": "not_indexed",
  "createdAt": "...",
  "updatedAt": "..."
}
```

**Formatter: formatProperty(dbRow)** — converts property DB row to camelCase.

**Formatter: formatDatasource(dbRow)** — converts backing_datasource DB row to camelCase. Includes: `datasetName`, `filePath`, `fileFormat`, `columnMapping`, `primaryKeyColumn`, `rowCount`, `columnNames`, `schemaHash`, `lastScannedAt`, `registeredAt`.

**Formatter: formatFunnelState(dbRow)** — converts funnel_state DB row to camelCase. Includes: `status`, `objectsIndexed`, `objectsFailed`, `editsPending`, `lastIndexedAt`, `lastIndexDurationMs`, `errorMessage`, `indexName`.

**Error handling:**

`ERROR_CODES` object mapping error code strings to HTTP status codes:

| Error Code | HTTP Status |
|---|---|
| ONTOLOGY_NOT_FOUND | 404 |
| OBJECT_TYPE_NOT_FOUND | 404 |
| PROPERTY_NOT_FOUND | 404 |
| DATASOURCE_NOT_FOUND | 404 |
| ONTOLOGY_ALREADY_EXISTS | 409 |
| OBJECT_TYPE_ALREADY_EXISTS | 409 |
| PROPERTY_ALREADY_EXISTS | 409 |
| DATASOURCE_ALREADY_REGISTERED | 409 |
| ALREADY_EXISTS | 409 |
| INVALID_API_NAME | 400 |
| INVALID_BASE_TYPE | 400 |
| INVALID_PARAMETER | 400 |
| VALIDATION_FAILED | 400 |
| PRIMARY_KEY_NOT_SET | 400 |
| DATASOURCE_FILE_NOT_FOUND | 400 |
| COLUMN_MAPPING_INVALID | 400 |
| REQUIRED_FIELD_MISSING | 400 |
| INTERNAL_ERROR | 500 |

Note: `ONTOLOGY_ALREADY_EXISTS` is used by ontologyService (Task 11) for duplicate ontology display names. `ALREADY_EXISTS` is used by errorHandler middleware (Task 10) as a generic translation of PostgreSQL unique-violation error code 23505.

**formatError(code, message, details?):**
```json
{"error": {"code": "OBJECT_TYPE_NOT_FOUND", "message": "Object type 'Foo' not found.", "details": {}, "timestamp": "2025-03-11T..."}}
```
`details` defaults to `{}` if not provided.

**sendError(res, code, message, details?):** Looks up HTTP status from `ERROR_CODES[code]` (default 500). Calls `res.status(httpStatus).json(formatError(code, message, details))`.

**sendSuccess(res, data, status?):** Calls `res.status(status || 200).json(data)`.

**sendCreated(res, data):** Calls `res.status(201).json(data)`.

**sendNoContent(res):** Calls `res.status(204).end()`.

**Pagination:**

`encodePageToken(offset)`: `Buffer.from(JSON.stringify({offset})).toString('base64')`.

`decodePageToken(token)`: `JSON.parse(Buffer.from(token, 'base64').toString()).offset`. If token is null/undefined, return 0. If decoding fails, throw `INVALID_PARAMETER` with message "Invalid page token."

Default pageSize: 100. Maximum pageSize: 1000. Clamp in route handlers.

**Exports:** `formatOntology`, `formatObjectType`, `formatObjectTypeSummary`, `formatProperty`, `formatDatasource`, `formatFunnelState`, `formatError`, `sendError`, `sendSuccess`, `sendCreated`, `sendNoContent`, `snakeToCamel`, `encodePageToken`, `decodePageToken`, `ERROR_CODES`.

**Inline self-tests** (run when `require.main === module`):
1. `snakeToCamel({object_type_id: "123", display_name: "Foo"})` → `{objectTypeId: "123", displayName: "Foo"}`
2. `snakeToCamel({column_mapping: {"custom_key": "val"}})` → `{columnMapping: {"custom_key": "val"}}` (inner keys preserved)
3. `encodePageToken(20)` decoded back → offset 20
4. `formatError('ONTOLOGY_NOT_FOUND', 'test')` has all 4 fields: code, message, details, timestamp

**Files to create:** src/utils/responseFormatter.js

**Verification:**
- `node src/utils/responseFormatter.js` runs all inline tests and prints "All formatter tests passed"
- ERROR_CODES has exactly 18 entries
