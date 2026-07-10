# API Reference - Tellus Ontology Engine

> Auto-generated on 2026-07-09
> Total endpoints: 85

## Table of Contents

- [Health & Status](#health-status) (3 endpoints)
- [Ontology](#ontology) (7 endpoints)
- [Object Types](#object-types) (5 endpoints)
- [Properties](#properties) (6 endpoints)
- [Datasources](#datasources) (4 endpoints)
- [Indexing](#indexing) (5 endpoints)
- [Objects](#objects) (10 endpoints)
- [Link Types](#link-types) (4 endpoints)
- [Action Types](#action-types) (7 endpoints)
- [Actions](#actions) (6 endpoints)
- [Audit Log](#audit-log) (4 endpoints)
- [Edits](#edits) (2 endpoints)
- [Datasets](#datasets) (7 endpoints)
- [Reindex](#reindex) (3 endpoints)
- [Interfaces](#interfaces) (10 endpoints)
- [Documentation](#documentation) (2 endpoints)

## Endpoint Summary

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Basic health check |
| `GET` | `/api/v1/health` | Enhanced health check |
| `GET` | `/api/v1/status` | Comprehensive system status |
| `POST` | `/api/v1/ontology` | Create a new ontology |
| `GET` | `/api/v1/ontology` | List all ontologies with pagination |
| `GET` | `/api/v1/ontology/:ontologyId` | Get a single ontology by ID |
| `PUT` | `/api/v1/ontology/:ontologyId` | Update an ontology (displayName and/or description) |
| `DELETE` | `/api/v1/ontology/:ontologyId` | Delete an ontology and all its children (cascades) |
| `GET` | `/api/v1/ontology/:ontologyId/export` | Export full ontology as JSON (with object types, properties, link types, action types) |
| `POST` | `/api/v1/ontology/import` | Import an ontology from a previously exported JSON payload |
| `POST` | `/api/v1/ontology/:ontologyId/objectTypes` | Create a new object type within an ontology |
| `GET` | `/api/v1/ontology/:ontologyId/objectTypes` | List all object types for an ontology |
| `GET` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName` | Get a single object type with properties, datasource, and funnel state |
| `PUT` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName` | Update an object type (displayName, description, icon, etc) |
| `DELETE` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName` | Delete an object type and its properties, datasource, and index |
| `POST` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/properties` | Create a new property on an object type |
| `GET` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/properties` | List all properties for an object type |
| `PUT` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/properties/:propertyApiName` | Update a property (displayName, description) |
| `DELETE` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/properties/:propertyApiName` | Delete a property from an object type |
| `PUT` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/primaryKey` | Set the primary key property for an object type |
| `PUT` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/titleProperty` | Set the title property for an object type |
| `POST` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/datasource` | Register a backing datasource for an object type |
| `GET` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/datasource` | Get the registered datasource for an object type |
| `DELETE` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/datasource` | Unregister the backing datasource |
| `POST` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/datasource/scan` | Re-scan the backing file and update metadata (row count, column names, schema hash) |
| `POST` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/index` | Trigger a full reindex of an object type into OpenSearch |
| `GET` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/index/status` | Get the indexing status for an object type |
| `DELETE` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/index` | Delete the OpenSearch index for an object type |
| `GET` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/index/reindex/status` | Get the current reindex status and health assessment |
| `GET` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/index/reindex/history` | Get paginated reindex history |
| `GET` | `/api/v1/objects/:objectType` | List objects of a type with pagination and optional sorting |
| `GET` | `/api/v1/objects/:objectType/:primaryKey` | Get a single object by primary key |
| `POST` | `/api/v1/objects/:objectType/search` | Search objects with filter expressions, ordering, and pagination |
| `POST` | `/api/v1/objects/:objectType/searchFullText` | Full-text search across all indexed text fields |
| `POST` | `/api/v1/objects/:objectType/aggregate` | Run aggregations (count, avg, sum, min, max, terms, date_histogram, range, cardinality) |
| `POST` | `/api/v1/objects/:objectType/searchAround` | Search around linked objects (Search Around) |
| `GET` | `/api/v1/objects/:objectType/:primaryKey/links/:linkType` | Resolve links for a specific object |
| `GET` | `/api/v1/objects/:objectType/:primaryKey/links/:linkType/count` | Count linked objects for a specific link type |
| `GET` | `/api/v1/objects/:objectType/:primaryKey/editHistory` | Get the complete edit history for a single object in reverse chronological order |
| `POST` | `/api/v1/objects/:objectType/validateForeignKeys` | Validate foreign key references for an object type |
| `POST` | `/api/v1/ontology/:ontologyId/linkTypes` | Create a new link type between two object types |
| `GET` | `/api/v1/ontology/:ontologyId/linkTypes` | List all link types for an ontology |
| `GET` | `/api/v1/ontology/:ontologyId/linkTypes/:linkApiName` | Get a single link type by API name |
| `DELETE` | `/api/v1/ontology/:ontologyId/linkTypes/:linkApiName` | Delete a link type |
| `POST` | `/api/v1/ontology/:ontologyId/actionTypes` | Create a new action type with rules and parameters |
| `GET` | `/api/v1/ontology/:ontologyId/actionTypes` | List all action types for an ontology |
| `GET` | `/api/v1/ontology/:ontologyId/actionTypes/:actionApiName` | Get a single action type by API name |
| `PUT` | `/api/v1/ontology/:ontologyId/actionTypes/:actionApiName` | Update an action type (displayName, description, parameters, rules) |
| `DELETE` | `/api/v1/ontology/:ontologyId/actionTypes/:actionApiName` | Delete an action type |
| `POST` | `/api/v1/ontology/:ontologyId/actionTypes/:actionApiName/clone` | Clone an action type with a new API name |
| `GET` | `/api/v1/ontology/:ontologyId/actionTypes/:actionApiName/impact` | Analyze the impact of an action type (which object types and properties it touches) |
| `POST` | `/api/v1/ontology/:ontologyId/actions/:actionTypeApiName/apply` | Execute an action |
| `POST` | `/api/v1/ontology/:ontologyId/actions/:actionTypeApiName/validate` | Dry-run validation of an action without applying edits |
| `POST` | `/api/v1/ontology/:ontologyId/actions/:actionTypeApiName/applyBatch` | Execute the same action type multiple times with different parameter sets (max 100 per batch) |
| `POST` | `/api/v1/actions/:actionTypeApiName/validate` | Validate an action using the default ontology (no ontologyId required) |
| `POST` | `/api/v1/actions/:actionTypeApiName/applyBatch` | Batch-execute actions using the default ontology |
| `POST` | `/api/v1/actions/:actionTypeApiName/applyBulk` | Bulk-execute an action (max 1000 per call, with stopOnError and autoIndex options) |
| `GET` | `/api/v1/ontology/:ontologyId/actions/:actionTypeApiName/audit` | Get audit log entries for a specific action type |
| `GET` | `/api/v1/audit/log` | Global audit log across all action types |
| `GET` | `/api/v1/audit/log/:executionId` | Get a single audit entry by execution ID |
| `GET` | `/api/v1/audit/stats` | Get aggregate statistics across all action executions |
| `GET` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/edits` | List all edits for an object type with filtering and pagination |
| `GET` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/edits/diff/:primaryKey` | Diff view: compare datasource state vs ontology state for one object |
| `POST` | `/api/v1/datasets/upload` | Upload a new dataset file (multipart form) |
| `GET` | `/api/v1/datasets` | List datasets with pagination and search |
| `GET` | `/api/v1/datasets/:datasetId` | Get full dataset details with transactions |
| `DELETE` | `/api/v1/datasets/:datasetId` | Delete a dataset (with safety check for backing usage) |
| `POST` | `/api/v1/datasets/:datasetId/transactions` | Add a new transaction (append or snapshot) to a dataset |
| `GET` | `/api/v1/datasets/:datasetId/transactions` | List transactions for a dataset |
| `GET` | `/api/v1/datasets/:datasetId/preview` | Preview dataset rows with column statistics |
| `POST` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/reindex` | Trigger a full reindex with smart skip logic and atomic locking |
| `GET` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/reindex/status` | Get current reindex status |
| `GET` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/reindex/history` | Get paginated reindex history |
| `POST` | `/api/v1/ontology/:ontologyId/interfaces` | Create a new Interface with typed properties |
| `GET` | `/api/v1/ontology/:ontologyId/interfaces` | List all Interfaces in an ontology with their properties and implementing object types |
| `GET` | `/api/v1/ontology/:ontologyId/interfaces/:interfaceApiName` | Get a single Interface with full details (properties, implementing OTs) |
| `PUT` | `/api/v1/ontology/:ontologyId/interfaces/:interfaceApiName` | Update an Interface (displayName, description, properties) |
| `DELETE` | `/api/v1/ontology/:ontologyId/interfaces/:interfaceApiName` | Delete an Interface |
| `POST` | `/api/v1/ontology/:ontologyId/interfaces/:interfaceApiName/search` | Polymorphic search across all Object Types implementing the Interface |
| `POST` | `/api/v1/ontology/:ontologyId/interfaces/:interfaceApiName/aggregate` | Polymorphic aggregation across implementing types |
| `POST` | `/api/v1/ontology/:ontologyId/objectTypes/:objectTypeApiName/implements` | Declare that an Object Type implements an Interface with a property mapping |
| `DELETE` | `/api/v1/ontology/:ontologyId/objectTypes/:objectTypeApiName/implements/:interfaceApiName` | Remove an Interface implementation from an Object Type |
| `GET` | `/api/v1/ontology/:ontologyId/objectTypes/:objectTypeApiName/implements` | List all Interfaces an Object Type implements with property mappings |
| `GET` | `/api/docs/spec.json` | Returns raw OpenAPI JSON specification |
| `GET` | `/api/docs` | Swagger UI interactive API documentation |

## Health & Status

### `GET /health`

Basic health check. Verifies PostgreSQL connectivity and returns database timestamp.

**Response:**
```json
{
  "status": "healthy",
  "database": "connected",
  "timestamp": "2026-03-15T10:00:00.000Z"
}
```

**Error Codes:**
- `503 — database unreachable`

**Example:**
```bash
curl http://localhost:3000/health
```

---

### `GET /api/v1/health`

Enhanced health check. Checks PostgreSQL and OpenSearch with 2s timeout each. Returns overall healthy/unhealthy status.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-03-15T10:00:00.000Z",
  "checks": {
    "postgresql": {
      "status": "up",
      "responseMs": 5
    },
    "opensearch": {
      "status": "up",
      "responseMs": 12
    }
  }
}
```

**Error Codes:**
- `503 — one or both services down`

**Example:**
```bash
curl http://localhost:3000/api/v1/health
```

---

### `GET /api/v1/status`

Comprehensive system status. Includes system memory, uptime, PG table counts, OpenSearch cluster info, ontology counts, dataset stats, and edit stats.

**Response:**
```json
{
  "status": "healthy",
  "system": {
    "memory": {},
    "uptime": "8h 30m 15s"
  },
  "postgresql": {
    "connected": true
  },
  "opensearch": {
    "connected": true
  },
  "ontology": {
    "ontologies": 1,
    "objectTypes": 5,
    "properties": 41
  }
}
```

**Error Codes:**
- `503 — both services unreachable`

**Example:**
```bash
curl http://localhost:3000/api/v1/status
```

---

## Ontology

### `POST /api/v1/ontology`

Create a new ontology.

**Request Body:**
```json
{
  "displayName": "Rwanda Revenue Authority",
  "description": "RRA digital twin"
}
```

**Response:**
```json
{
  "ontologyId": "uuid",
  "displayName": "Rwanda Revenue Authority",
  "objectTypeCount": 0
}
```

**Error Codes:**
- `409 ONTOLOGY_ALREADY_EXISTS`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology -H "Content-Type: application/json" -d '{"displayName":"Test Ontology"}'
```

---

### `GET /api/v1/ontology`

List all ontologies with pagination.

**Query Parameters:**
- `pageSize (default 100, max 1000)`
- `pageToken`

**Response:**
```json
{
  "data": [],
  "totalCount": 0,
  "pageSize": 100,
  "nextPageToken": null
}
```

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology
```

---

### `GET /api/v1/ontology/:ontologyId`

Get a single ontology by ID.

**Response:**
```json
{
  "ontologyId": "uuid",
  "displayName": "...",
  "objectTypeCount": 5
}
```

**Error Codes:**
- `404 ONTOLOGY_NOT_FOUND`

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}
```

---

### `PUT /api/v1/ontology/:ontologyId`

Update an ontology (displayName and/or description).

**Request Body:**
```json
{
  "displayName": "Updated Name",
  "description": "Updated description"
}
```

**Error Codes:**
- `404 ONTOLOGY_NOT_FOUND`
- `409 ONTOLOGY_ALREADY_EXISTS`

**Example:**
```bash
curl -X PUT http://localhost:3000/api/v1/ontology/{ontologyId} -H "Content-Type: application/json" -d '{"displayName":"New Name"}'
```

---

### `DELETE /api/v1/ontology/:ontologyId`

Delete an ontology and all its children (cascades).

**Error Codes:**
- `404 ONTOLOGY_NOT_FOUND`

**Example:**
```bash
curl -X DELETE http://localhost:3000/api/v1/ontology/{ontologyId}
```

---

### `GET /api/v1/ontology/:ontologyId/export`

Export full ontology as JSON (with object types, properties, link types, action types).

**Error Codes:**
- `404 ONTOLOGY_NOT_FOUND`

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/export
```

---

### `POST /api/v1/ontology/import`

Import an ontology from a previously exported JSON payload.

**Error Codes:**
- `400 VALIDATION_FAILED`
- `409 OBJECT_TYPE_ALREADY_EXISTS`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology/import -H "Content-Type: application/json" -d @export.json
```

---

## Object Types

### `POST /api/v1/ontology/:ontologyId/objectTypes`

Create a new object type within an ontology.

**Request Body:**
```json
{
  "apiName": "Employee",
  "displayName": "Employee",
  "icon": "person",
  "iconColor": "#1565C0"
}
```

**Response:**
```json
{
  "objectType": {
    "apiName": "Employee",
    "displayName": "Employee",
    "status": "active"
  }
}
```

**Error Codes:**
- `400 INVALID_API_NAME`
- `409 OBJECT_TYPE_ALREADY_EXISTS`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes -H "Content-Type: application/json" -d '{"apiName":"Employee","displayName":"Employee"}'
```

---

### `GET /api/v1/ontology/:ontologyId/objectTypes`

List all object types for an ontology.

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes
```

---

### `GET /api/v1/ontology/:ontologyId/objectTypes/:apiName`

Get a single object type with properties, datasource, and funnel state.

**Error Codes:**
- `404 OBJECT_TYPE_NOT_FOUND`

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}
```

---

### `PUT /api/v1/ontology/:ontologyId/objectTypes/:apiName`

Update an object type (displayName, description, icon, etc).

**Error Codes:**
- `404 OBJECT_TYPE_NOT_FOUND`

**Example:**
```bash
curl -X PUT http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName} -H "Content-Type: application/json" -d '{"displayName":"Updated"}'
```

---

### `DELETE /api/v1/ontology/:ontologyId/objectTypes/:apiName`

Delete an object type and its properties, datasource, and index.

**Error Codes:**
- `404 OBJECT_TYPE_NOT_FOUND`

**Example:**
```bash
curl -X DELETE http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}
```

---

## Properties

### `POST /api/v1/ontology/:ontologyId/objectTypes/:apiName/properties`

Create a new property on an object type.

**Request Body:**
```json
{
  "apiName": "employeeId",
  "displayName": "Employee ID",
  "baseType": "string",
  "isRequired": true
}
```

**Error Codes:**
- `400 INVALID_API_NAME`
- `400 INVALID_BASE_TYPE`
- `409 PROPERTY_ALREADY_EXISTS`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/properties -H "Content-Type: application/json" -d '{"apiName":"salary","displayName":"Salary","baseType":"double"}'
```

---

### `GET /api/v1/ontology/:ontologyId/objectTypes/:apiName/properties`

List all properties for an object type.

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/properties
```

---

### `PUT /api/v1/ontology/:ontologyId/objectTypes/:apiName/properties/:propertyApiName`

Update a property (displayName, description).

**Error Codes:**
- `404 PROPERTY_NOT_FOUND`

**Example:**
```bash
curl -X PUT http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/properties/{propName} -H "Content-Type: application/json" -d '{"displayName":"Updated"}'
```

---

### `DELETE /api/v1/ontology/:ontologyId/objectTypes/:apiName/properties/:propertyApiName`

Delete a property from an object type.

**Error Codes:**
- `404 PROPERTY_NOT_FOUND`

**Example:**
```bash
curl -X DELETE http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/properties/{propName}
```

---

### `PUT /api/v1/ontology/:ontologyId/objectTypes/:apiName/primaryKey`

Set the primary key property for an object type.

**Request Body:**
```json
{
  "propertyApiName": "employeeId"
}
```

**Error Codes:**
- `404 PROPERTY_NOT_FOUND`

**Example:**
```bash
curl -X PUT http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/primaryKey -H "Content-Type: application/json" -d '{"propertyApiName":"employeeId"}'
```

---

### `PUT /api/v1/ontology/:ontologyId/objectTypes/:apiName/titleProperty`

Set the title property for an object type.

**Request Body:**
```json
{
  "propertyApiName": "fullName"
}
```

**Error Codes:**
- `404 PROPERTY_NOT_FOUND`

**Example:**
```bash
curl -X PUT http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/titleProperty -H "Content-Type: application/json" -d '{"propertyApiName":"fullName"}'
```

---

## Datasources

### `POST /api/v1/ontology/:ontologyId/objectTypes/:apiName/datasource`

Register a backing datasource for an object type.

**Request Body:**
```json
{
  "datasetName": "employees",
  "filePath": "/data/emp.csv",
  "fileFormat": "csv",
  "columnMapping": {}
}
```

**Error Codes:**
- `409 DATASOURCE_ALREADY_REGISTERED`
- `400 DATASOURCE_FILE_NOT_FOUND`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/datasource -H "Content-Type: application/json" -d '{...}'
```

---

### `GET /api/v1/ontology/:ontologyId/objectTypes/:apiName/datasource`

Get the registered datasource for an object type.

**Error Codes:**
- `404 DATASOURCE_NOT_FOUND`

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/datasource
```

---

### `DELETE /api/v1/ontology/:ontologyId/objectTypes/:apiName/datasource`

Unregister the backing datasource.

**Error Codes:**
- `404 DATASOURCE_NOT_FOUND`

**Example:**
```bash
curl -X DELETE http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/datasource
```

---

### `POST /api/v1/ontology/:ontologyId/objectTypes/:apiName/datasource/scan`

Re-scan the backing file and update metadata (row count, column names, schema hash).

**Error Codes:**
- `404 DATASOURCE_NOT_FOUND`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/datasource/scan
```

---

## Indexing

### `POST /api/v1/ontology/:ontologyId/objectTypes/:apiName/index`

Trigger a full reindex of an object type into OpenSearch.

**Error Codes:**
- `400 NO_BACKING_DATASOURCE`
- `409 INDEXING_IN_PROGRESS`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/index
```

---

### `GET /api/v1/ontology/:ontologyId/objectTypes/:apiName/index/status`

Get the indexing status for an object type.

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/index/status
```

---

### `DELETE /api/v1/ontology/:ontologyId/objectTypes/:apiName/index`

Delete the OpenSearch index for an object type.

**Example:**
```bash
curl -X DELETE http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/index
```

---

### `GET /api/v1/ontology/:ontologyId/objectTypes/:apiName/index/reindex/status`

Get the current reindex status and health assessment.

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/index/reindex/status
```

---

### `GET /api/v1/ontology/:ontologyId/objectTypes/:apiName/index/reindex/history`

Get paginated reindex history.

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/index/reindex/history
```

---

## Objects

### `GET /api/v1/objects/:objectType`

List objects of a type with pagination and optional sorting.

**Query Parameters:**
- `$pageSize (default 100)`
- `$pageToken`
- `$orderBy`
- `$select`

**Error Codes:**
- `404 OBJECT_TYPE_NOT_FOUND`

**Example:**
```bash
curl "http://localhost:3000/api/v1/objects/Employee?\$pageSize=10"
```

---

### `GET /api/v1/objects/:objectType/:primaryKey`

Get a single object by primary key.

**Error Codes:**
- `404 OBJECT_NOT_FOUND`
- `404 OBJECT_TYPE_NOT_FOUND`

**Example:**
```bash
curl http://localhost:3000/api/v1/objects/Employee/EMP-001
```

---

### `POST /api/v1/objects/:objectType/search`

Search objects with filter expressions, ordering, and pagination.

**Request Body:**
```json
{
  "where": {
    "type": "eq",
    "field": "department",
    "value": "Engineering"
  },
  "$pageSize": 50
}
```

**Error Codes:**
- `400 QUERY_VALIDATION_ERROR`
- `404 OBJECT_TYPE_NOT_FOUND`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/objects/Employee/search -H "Content-Type: application/json" -d '{"where":{"type":"eq","field":"department","value":"Engineering"}}'
```

---

### `POST /api/v1/objects/:objectType/searchFullText`

Full-text search across all indexed text fields.

**Request Body:**
```json
{
  "query": "Habimana",
  "$pageSize": 10
}
```

**Error Codes:**
- `400 QUERY_VALIDATION_ERROR`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/objects/Employee/searchFullText -H "Content-Type: application/json" -d '{"query":"Habimana"}'
```

---

### `POST /api/v1/objects/:objectType/aggregate`

Run aggregations (count, avg, sum, min, max, terms, date_histogram, range, cardinality).

**Request Body:**
```json
{
  "aggregations": [
    {
      "type": "avg",
      "field": "salary",
      "name": "avgSalary"
    }
  ]
}
```

**Error Codes:**
- `400 INVALID_AGGREGATION`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/objects/Employee/aggregate -H "Content-Type: application/json" -d '{"aggregations":[{"type":"avg","field":"salary","name":"avgSalary"}]}'
```

---

### `POST /api/v1/objects/:objectType/searchAround`

Search around linked objects (Search Around). Returns linked objects matching filters.

**Request Body:**
```json
{
  "linkType": "employedBy",
  "direction": "forward"
}
```

**Error Codes:**
- `404 LINK_TYPE_NOT_FOUND`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/objects/Employee/searchAround -H "Content-Type: application/json" -d '{"linkType":"employedBy","direction":"forward"}'
```

---

### `GET /api/v1/objects/:objectType/:primaryKey/links/:linkType`

Resolve links for a specific object.

**Query Parameters:**
- `direction (forward|reverse)`
- `pageSize`
- `pageToken`
- `select`

**Error Codes:**
- `404 LINK_TYPE_NOT_FOUND`

**Example:**
```bash
curl "http://localhost:3000/api/v1/objects/Employee/EMP-001/links/employedBy"
```

---

### `GET /api/v1/objects/:objectType/:primaryKey/links/:linkType/count`

Count linked objects for a specific link type.

**Error Codes:**
- `404 LINK_TYPE_NOT_FOUND`

**Example:**
```bash
curl "http://localhost:3000/api/v1/objects/Employee/EMP-001/links/employedBy/count"
```

---

### `GET /api/v1/objects/:objectType/:primaryKey/editHistory`

Get the complete edit history for a single object in reverse chronological order.

**Query Parameters:**
- `$pageSize (default 50, max 500)`
- `$pageToken`
- `startTime`
- `endTime`

**Error Codes:**
- `400 QUERY_VALIDATION_ERROR`
- `400 INVALID_PAGE_TOKEN`

**Example:**
```bash
curl "http://localhost:3000/api/v1/objects/Employee/EMP-001/editHistory"
```

---

### `POST /api/v1/objects/:objectType/validateForeignKeys`

Validate foreign key references for an object type.

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/objects/Employee/validateForeignKeys -H "Content-Type: application/json" -d '{}'
```

---

## Link Types

### `POST /api/v1/ontology/:ontologyId/linkTypes`

Create a new link type between two object types.

**Request Body:**
```json
{
  "apiName": "employedBy",
  "displayName": "Employed By",
  "sourceObjectType": "Employee",
  "targetObjectType": "Company",
  "cardinality": "MANY_TO_ONE"
}
```

**Error Codes:**
- `409 ALREADY_EXISTS`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/linkTypes -H "Content-Type: application/json" -d '{...}'
```

---

### `GET /api/v1/ontology/:ontologyId/linkTypes`

List all link types for an ontology.

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/linkTypes
```

---

### `GET /api/v1/ontology/:ontologyId/linkTypes/:linkApiName`

Get a single link type by API name.

**Error Codes:**
- `404 LINK_TYPE_NOT_FOUND`

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/linkTypes/{linkApiName}
```

---

### `DELETE /api/v1/ontology/:ontologyId/linkTypes/:linkApiName`

Delete a link type.

**Error Codes:**
- `404 LINK_TYPE_NOT_FOUND`

**Example:**
```bash
curl -X DELETE http://localhost:3000/api/v1/ontology/{ontologyId}/linkTypes/{linkApiName}
```

---

## Action Types

### `POST /api/v1/ontology/:ontologyId/actionTypes`

Create a new action type with rules and parameters.

**Request Body:**
```json
{
  "apiName": "hireEmployee",
  "displayName": "Hire Employee",
  "parameters": {},
  "rules": []
}
```

**Error Codes:**
- `409 ACTION_TYPE_ALREADY_EXISTS`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/actionTypes -H "Content-Type: application/json" -d '{...}'
```

---

### `GET /api/v1/ontology/:ontologyId/actionTypes`

List all action types for an ontology.

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/actionTypes
```

---

### `GET /api/v1/ontology/:ontologyId/actionTypes/:actionApiName`

Get a single action type by API name.

**Error Codes:**
- `404 ACTION_TYPE_NOT_FOUND`

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/actionTypes/{actionApiName}
```

---

### `PUT /api/v1/ontology/:ontologyId/actionTypes/:actionApiName`

Update an action type (displayName, description, parameters, rules).

**Error Codes:**
- `404 ACTION_TYPE_NOT_FOUND`

**Example:**
```bash
curl -X PUT http://localhost:3000/api/v1/ontology/{ontologyId}/actionTypes/{actionApiName} -H "Content-Type: application/json" -d '{...}'
```

---

### `DELETE /api/v1/ontology/:ontologyId/actionTypes/:actionApiName`

Delete an action type.

**Error Codes:**
- `404 ACTION_TYPE_NOT_FOUND`

**Example:**
```bash
curl -X DELETE http://localhost:3000/api/v1/ontology/{ontologyId}/actionTypes/{actionApiName}
```

---

### `POST /api/v1/ontology/:ontologyId/actionTypes/:actionApiName/clone`

Clone an action type with a new API name.

**Request Body:**
```json
{
  "newApiName": "hireContractor",
  "newDisplayName": "Hire Contractor"
}
```

**Error Codes:**
- `404 ACTION_TYPE_NOT_FOUND`
- `409 ACTION_TYPE_ALREADY_EXISTS`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/actionTypes/{actionApiName}/clone -H "Content-Type: application/json" -d '{"newApiName":"hireContractor"}'
```

---

### `GET /api/v1/ontology/:ontologyId/actionTypes/:actionApiName/impact`

Analyze the impact of an action type (which object types and properties it touches).

**Error Codes:**
- `404 ACTION_TYPE_NOT_FOUND`

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/actionTypes/{actionApiName}/impact
```

---

## Actions

### `POST /api/v1/ontology/:ontologyId/actions/:actionTypeApiName/apply`

Execute an action. Supports idempotency via Idempotency-Key header and optimistic concurrency via $expectedVersion.

**Headers:**
- `Idempotency-Key (optional)`

**Request Body:**
```json
{
  "parameters": {
    "employeeId": "EMP-001",
    "salary": 75000
  }
}
```

**Error Codes:**
- `404 ACTION_TYPE_NOT_FOUND`
- `400 INVALID_PARAMETER`
- `404 OBJECT_NOT_FOUND`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/actions/updateSalary/apply -H "Content-Type: application/json" -d '{"parameters":{"employeeId":"EMP-001","salary":75000}}'
```

---

### `POST /api/v1/ontology/:ontologyId/actions/:actionTypeApiName/validate`

Dry-run validation of an action without applying edits.

**Request Body:**
```json
{
  "parameters": {}
}
```

**Error Codes:**
- `404 ACTION_TYPE_NOT_FOUND`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/actions/updateSalary/validate -H "Content-Type: application/json" -d '{"parameters":{}}'
```

---

### `POST /api/v1/ontology/:ontologyId/actions/:actionTypeApiName/applyBatch`

Execute the same action type multiple times with different parameter sets (max 100 per batch).

**Request Body:**
```json
{
  "requests": [
    {
      "parameters": {}
    }
  ]
}
```

**Error Codes:**
- `400 INVALID_PARAMETER`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/actions/updateSalary/applyBatch -H "Content-Type: application/json" -d '{"requests":[{"parameters":{}}]}'
```

---

### `POST /api/v1/actions/:actionTypeApiName/validate`

Validate an action using the default ontology (no ontologyId required).

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/actions/updateSalary/validate -H "Content-Type: application/json" -d '{"parameters":{}}'
```

---

### `POST /api/v1/actions/:actionTypeApiName/applyBatch`

Batch-execute actions using the default ontology.

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/actions/updateSalary/applyBatch -H "Content-Type: application/json" -d '{"requests":[...]}'
```

---

### `POST /api/v1/actions/:actionTypeApiName/applyBulk`

Bulk-execute an action (max 1000 per call, with stopOnError and autoIndex options).

**Request Body:**
```json
{
  "requests": [],
  "stopOnError": false,
  "autoIndex": true
}
```

**Error Codes:**
- `400 INVALID_PARAMETER`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/actions/updateSalary/applyBulk -H "Content-Type: application/json" -d '{"requests":[...],"autoIndex":true}'
```

---

## Audit Log

### `GET /api/v1/ontology/:ontologyId/actions/:actionTypeApiName/audit`

Get audit log entries for a specific action type.

**Query Parameters:**
- `pageSize`
- `pageToken`
- `result (success|failure)`
- `startTime`
- `endTime`

**Example:**
```bash
curl "http://localhost:3000/api/v1/ontology/{ontologyId}/actions/updateSalary/audit"
```

---

### `GET /api/v1/audit/log`

Global audit log across all action types.

**Query Parameters:**
- `pageSize`
- `pageToken`
- `result`
- `startTime`
- `endTime`

**Example:**
```bash
curl "http://localhost:3000/api/v1/audit/log"
```

---

### `GET /api/v1/audit/log/:executionId`

Get a single audit entry by execution ID.

**Error Codes:**
- `404 AUDIT_ENTRY_NOT_FOUND`

**Example:**
```bash
curl http://localhost:3000/api/v1/audit/log/{executionId}
```

---

### `GET /api/v1/audit/stats`

Get aggregate statistics across all action executions.

**Example:**
```bash
curl http://localhost:3000/api/v1/audit/stats
```

---

## Edits

### `GET /api/v1/ontology/:ontologyId/objectTypes/:apiName/edits`

List all edits for an object type with filtering and pagination.

**Query Parameters:**
- `pageSize`
- `pageToken`
- `indexed (true|false)`
- `operation`
- `primaryKey`

**Example:**
```bash
curl "http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/edits"
```

---

### `GET /api/v1/ontology/:ontologyId/objectTypes/:apiName/edits/diff/:primaryKey`

Diff view: compare datasource state vs ontology state for one object.

**Example:**
```bash
curl "http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/edits/diff/EMP-001"
```

---

## Datasets

### `POST /api/v1/datasets/upload`

Upload a new dataset file (multipart form).

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/datasets/upload -F "file=@data.csv" -F "name=employees"
```

---

### `GET /api/v1/datasets`

List datasets with pagination and search.

**Query Parameters:**
- `pageSize`
- `pageToken`
- `search`

**Example:**
```bash
curl "http://localhost:3000/api/v1/datasets"
```

---

### `GET /api/v1/datasets/:datasetId`

Get full dataset details with transactions.

**Error Codes:**
- `404 DATASET_NOT_FOUND`

**Example:**
```bash
curl http://localhost:3000/api/v1/datasets/{datasetId}
```

---

### `DELETE /api/v1/datasets/:datasetId`

Delete a dataset (with safety check for backing usage).

**Error Codes:**
- `404 DATASET_NOT_FOUND`
- `409 DATASET_IN_USE`

**Example:**
```bash
curl -X DELETE http://localhost:3000/api/v1/datasets/{datasetId}
```

---

### `POST /api/v1/datasets/:datasetId/transactions`

Add a new transaction (append or snapshot) to a dataset.

**Error Codes:**
- `404 DATASET_NOT_FOUND`
- `400 INVALID_TRANSACTION_TYPE`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/datasets/{datasetId}/transactions -F "file=@new_data.csv" -F "type=APPEND"
```

---

### `GET /api/v1/datasets/:datasetId/transactions`

List transactions for a dataset.

**Error Codes:**
- `404 DATASET_NOT_FOUND`

**Example:**
```bash
curl "http://localhost:3000/api/v1/datasets/{datasetId}/transactions"
```

---

### `GET /api/v1/datasets/:datasetId/preview`

Preview dataset rows with column statistics.

**Query Parameters:**
- `rows (default 50, max 500)`
- `transactionId`

**Error Codes:**
- `404 DATASET_NOT_FOUND`

**Example:**
```bash
curl "http://localhost:3000/api/v1/datasets/{datasetId}/preview?rows=10"
```

---

## Reindex

### `POST /api/v1/ontology/:ontologyId/objectTypes/:apiName/reindex`

Trigger a full reindex with smart skip logic and atomic locking.

**Error Codes:**
- `409 REINDEX_IN_PROGRESS`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/reindex
```

---

### `GET /api/v1/ontology/:ontologyId/objectTypes/:apiName/reindex/status`

Get current reindex status.

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/reindex/status
```

---

### `GET /api/v1/ontology/:ontologyId/objectTypes/:apiName/reindex/history`

Get paginated reindex history.

**Example:**
```bash
curl "http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/reindex/history"
```

---

## Interfaces

### `POST /api/v1/ontology/:ontologyId/interfaces`

Create a new Interface with typed properties. Enables polymorphic queries across implementing Object Types.

**Request Body:**
```json
{
  "apiName": "HasLocation",
  "displayName": "Has Location",
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
    }
  ]
}
```

**Error Codes:**
- `409 INTERFACE_ALREADY_EXISTS`
- `400 INVALID_API_NAME`
- `400 VALIDATION_FAILED`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/interfaces -H "Content-Type: application/json" -d '{...}'
```

---

### `GET /api/v1/ontology/:ontologyId/interfaces`

List all Interfaces in an ontology with their properties and implementing object types.

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/interfaces
```

---

### `GET /api/v1/ontology/:ontologyId/interfaces/:interfaceApiName`

Get a single Interface with full details (properties, implementing OTs).

**Error Codes:**
- `404 INTERFACE_NOT_FOUND`

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/interfaces/{interfaceApiName}
```

---

### `PUT /api/v1/ontology/:ontologyId/interfaces/:interfaceApiName`

Update an Interface (displayName, description, properties). Property changes validated against implementing types.

**Error Codes:**
- `404 INTERFACE_NOT_FOUND`
- `400 PROPERTY_IN_USE`
- `400 BASE_TYPE_MISMATCH`

**Example:**
```bash
curl -X PUT http://localhost:3000/api/v1/ontology/{ontologyId}/interfaces/{interfaceApiName} -H "Content-Type: application/json" -d '{...}'
```

---

### `DELETE /api/v1/ontology/:ontologyId/interfaces/:interfaceApiName`

Delete an Interface. Fails if any Object Types still implement it.

**Error Codes:**
- `404 INTERFACE_NOT_FOUND`
- `409 INTERFACE_IN_USE`

**Example:**
```bash
curl -X DELETE http://localhost:3000/api/v1/ontology/{ontologyId}/interfaces/{interfaceApiName}
```

---

### `POST /api/v1/ontology/:ontologyId/interfaces/:interfaceApiName/search`

Polymorphic search across all Object Types implementing the Interface. Translates field names via property mappings.

**Request Body:**
```json
{
  "where": {
    "type": "gt",
    "field": "latitude",
    "value": -2
  },
  "$pageSize": 50
}
```

**Error Codes:**
- `404 INTERFACE_NOT_FOUND`
- `400 QUERY_VALIDATION_ERROR`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/interfaces/HasLocation/search -H "Content-Type: application/json" -d '{"where":{"type":"gt","field":"latitude","value":-2.0}}'
```

---

### `POST /api/v1/ontology/:ontologyId/interfaces/:interfaceApiName/aggregate`

Polymorphic aggregation across implementing types. Correctly merges results (weighted avg, sum counts, merge buckets).

**Request Body:**
```json
{
  "aggregations": [
    {
      "type": "count",
      "name": "total"
    }
  ]
}
```

**Error Codes:**
- `404 INTERFACE_NOT_FOUND`
- `400 INVALID_AGGREGATION`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/interfaces/HasLocation/aggregate -H "Content-Type: application/json" -d '{"aggregations":[{"type":"count","name":"total"}]}'
```

---

### `POST /api/v1/ontology/:ontologyId/objectTypes/:objectTypeApiName/implements`

Declare that an Object Type implements an Interface with a property mapping.

**Request Body:**
```json
{
  "interfaceApiName": "HasLocation",
  "propertyMapping": {
    "latitude": "airportLat",
    "longitude": "airportLng"
  }
}
```

**Error Codes:**
- `409 ALREADY_EXISTS`
- `400 MISSING_REQUIRED_MAPPING`
- `400 TYPE_MISMATCH`

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/implements -H "Content-Type: application/json" -d '{...}'
```

---

### `DELETE /api/v1/ontology/:ontologyId/objectTypes/:objectTypeApiName/implements/:interfaceApiName`

Remove an Interface implementation from an Object Type.

**Error Codes:**
- `404 NOT_IMPLEMENTED`

**Example:**
```bash
curl -X DELETE http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/implements/{interfaceApiName}
```

---

### `GET /api/v1/ontology/:ontologyId/objectTypes/:objectTypeApiName/implements`

List all Interfaces an Object Type implements with property mappings.

**Example:**
```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/{apiName}/implements
```

---

## Documentation

### `GET /api/docs/spec.json`

Returns raw OpenAPI JSON specification.

**Example:**
```bash
curl http://localhost:3000/api/docs/spec.json
```

---

### `GET /api/docs`

Swagger UI interactive API documentation.

**Example:**
```bash
open http://localhost:3000/api/docs
```

---
