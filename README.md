# Ontology Engine

## 1. Overview

The Ontology System Engine is an open-source implementation of the core concepts from Palantir Foundry's Ontology. It provides a semantic layer that maps datasets to real-world entities (objects), with typed properties, relationships (links), and parameterized edit operations (actions).

### Palantir Concept Mapping (Week 1 Scope)

| Palantir Concept | Our Implementation |
|---|---|
| Ontology | `ontology` table (PostgreSQL) |
| Object Type | `object_type` table + future OpenSearch index |
| Property | `property` table + future OpenSearch field |
| Backing Datasource | `backing_datasource` table + file scanner |
| Object Data Funnel | `funnel_state` table (state tracking only; actual indexer is Week 2) |

## 2. Architecture

```
CSV/JSON File → File Scanner Service → Backing Datasource (metadata in PostgreSQL)
                                            ↓
                                     Funnel State (tracks indexing status)
                                            ↓
PostgreSQL ← stores all metadata ← REST API (Express) ← Client (curl/UI)
```

**Stack:** Node.js 20+, Express 4, PostgreSQL 16, TypeScript 5

**Key modules:**

- `src/server.ts` — Express app, health endpoint, router mounts
- `src/db.ts` — PostgreSQL connection pool with transaction support
- `src/migrate.ts` — Schema migrations (5 tables)
- `src/seed.ts` — Idempotent RRA Tax Ontology seed (5 object types, 41 properties, 500 CSV rows)
- `src/services/` — Business logic layer (ontology, objectType, property, datasource, fileScanner)
- `src/routes/` — Express routers (thin handlers that delegate to services)
- `src/utils/` — Type system, validators, formatters, schema diff
- `src/middleware/` — Request logger, error handler, body validation

## 3. Quick Start

### Prerequisites

- Docker
- Node.js 20+

### Setup

```bash
# 1. Start PostgreSQL
docker run --name ontology-pg \
  -e POSTGRES_PASSWORD=ontology \
  -e POSTGRES_DB=ontology \
  -p 5432:5432 -d postgres:16

# 2. Install dependencies
npm install

# 3. Run migrations
npm run migrate

# 4. Seed test data
npm run seed

# 5. Start development server
npm run dev
```

The server starts on `http://localhost:3000`.

### Example Workflow

**1. Verify server is running:**

```bash
curl http://localhost:3000/health
```

```json
{"status":"healthy","database":"connected","timestamp":"2026-03-11 12:00:00.000000+00"}
```

**2. Create an ontology:**

```bash
curl -X POST http://localhost:3000/api/v1/ontology \
  -H "Content-Type: application/json" \
  -d '{"displayName":"My Ontology","description":"A test ontology"}'
```

```json
{
  "ontologyId": "a1b2c3d4-...",
  "displayName": "My Ontology",
  "description": "A test ontology",
  "objectTypeCount": 0
}
```

**3. Create an object type with properties (batch):**

```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/batch \
  -H "Content-Type: application/json" \
  -d '{
    "apiName": "Employee",
    "displayName": "Employee",
    "properties": [
      {"apiName": "employeeId", "displayName": "Employee ID", "baseType": "string", "isRequired": true},
      {"apiName": "fullName", "displayName": "Full Name", "baseType": "string", "isRequired": true},
      {"apiName": "salary", "displayName": "Salary", "baseType": "double"}
    ],
    "primaryKeyProperty": "employeeId",
    "titleProperty": "fullName"
  }'
```

**4. List object types:**

```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes
```

```json
{
  "data": [
    {
      "apiName": "Employee",
      "displayName": "Employee",
      "status": "active",
      "propertyCount": 3,
      "datasourceName": null,
      "indexStatus": "not_indexed"
    }
  ],
  "totalCount": 1,
  "pageSize": 100,
  "nextPageToken": null
}
```

**5. Get object type with full details:**

```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Employee
```

```json
{
  "objectType": {
    "apiName": "Employee",
    "displayName": "Employee",
    "status": "active",
    "primaryKey": "employeeId",
    "titleProperty": "fullName",
    "properties": {
      "employeeId": {"apiName": "employeeId", "baseType": "string", "isRequired": true},
      "fullName": {"apiName": "fullName", "baseType": "string", "isRequired": true},
      "salary": {"apiName": "salary", "baseType": "double", "isRequired": false}
    },
    "backingDatasource": null,
    "indexingState": {"status": "not_indexed", "objectsIndexed": 0}
  }
}
```

### Running Tests

```bash
# Start the server in one terminal
npm run dev

# Run integration tests in another terminal
npm test
```

All 315 unit tests and 50 integration tests should pass:

```
=== Unit test summary: 315 passed, 0 failed ===
50/50 tests passed, 0 failed
```

You can also run them separately:

```bash
npm run test:unit          # 315 self-tests (no server needed)
npm run test:integration   # 50 integration tests (server must be running)
```

## 4. API Reference

All endpoints return JSON. Error responses follow this shape:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message.",
    "details": {},
    "timestamp": "2026-03-11T12:00:00.000Z"
  }
}
```

### Ontology

#### POST /api/v1/ontology

Create a new ontology.

```bash
curl -X POST http://localhost:3000/api/v1/ontology \
  -H "Content-Type: application/json" \
  -d '{"displayName":"My Ontology","description":"Optional description"}'
```

**Response:** `201 Created`

```json
{
  "ontologyId": "uuid",
  "displayName": "My Ontology",
  "description": "Optional description",
  "createdAt": "...",
  "updatedAt": "...",
  "createdBy": "system",
  "objectTypeCount": 0
}
```

**Errors:** `409 ONTOLOGY_ALREADY_EXISTS`, `400 REQUIRED_FIELD_MISSING`

#### GET /api/v1/ontology

List all ontologies with pagination.

```bash
curl "http://localhost:3000/api/v1/ontology?pageSize=10"
```

**Response:** `200 OK`

```json
{
  "data": [{"ontologyId": "...", "displayName": "...", "objectTypeCount": 5}],
  "totalCount": 1,
  "pageSize": 10,
  "nextPageToken": null
}
```

#### GET /api/v1/ontology/:ontologyId

Get a single ontology by ID.

```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}
```

**Response:** `200 OK`

**Errors:** `404 ONTOLOGY_NOT_FOUND`, `400 INVALID_PARAMETER` (invalid UUID)

#### PUT /api/v1/ontology/:ontologyId

Update an ontology's displayName and/or description.

```bash
curl -X PUT http://localhost:3000/api/v1/ontology/{ontologyId} \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Updated Name"}'
```

**Response:** `200 OK`

**Errors:** `404 ONTOLOGY_NOT_FOUND`, `409 ONTOLOGY_ALREADY_EXISTS`, `400 VALIDATION_FAILED`

#### DELETE /api/v1/ontology/:ontologyId

Delete an ontology and all cascaded resources (object types, properties, datasources, funnel states).

```bash
curl -X DELETE http://localhost:3000/api/v1/ontology/{ontologyId}
```

**Response:** `204 No Content`

**Errors:** `404 ONTOLOGY_NOT_FOUND`

---

### Object Types

All object type routes are nested under `/api/v1/ontology/:ontologyId/objectTypes`.

#### POST .../objectTypes/batch

Atomically create an object type with all its properties, primary key, and title property.

```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/batch \
  -H "Content-Type: application/json" \
  -d '{
    "apiName": "Employee",
    "displayName": "Employee",
    "description": "Employee records",
    "properties": [
      {"apiName": "employeeId", "displayName": "Employee ID", "baseType": "string", "isRequired": true},
      {"apiName": "fullName", "displayName": "Full Name", "baseType": "string"}
    ],
    "primaryKeyProperty": "employeeId",
    "titleProperty": "fullName"
  }'
```

**Response:** `201 Created` — Full object type with all properties.

**Errors:** `400 REQUIRED_FIELD_MISSING`, `400 PRIMARY_KEY_NOT_SET`, `400 VALIDATION_FAILED`, `400 INVALID_API_NAME`, `400 INVALID_BASE_TYPE`, `409 OBJECT_TYPE_ALREADY_EXISTS`

#### POST .../objectTypes

Create an object type (without properties — add them separately).

```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes \
  -H "Content-Type: application/json" \
  -d '{"apiName":"Employee","displayName":"Employee"}'
```

**Response:** `201 Created`

**Errors:** `400 INVALID_API_NAME`, `409 OBJECT_TYPE_ALREADY_EXISTS`, `404 ONTOLOGY_NOT_FOUND`

#### GET .../objectTypes

List object types with pagination and summary data.

```bash
curl "http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes?pageSize=10"
```

**Response:** `200 OK`

```json
{
  "data": [
    {
      "apiName": "Taxpayer",
      "displayName": "Taxpayer",
      "status": "active",
      "propertyCount": 10,
      "datasourceName": "RRA Taxpayers",
      "indexStatus": "not_indexed"
    }
  ],
  "totalCount": 5,
  "pageSize": 10,
  "nextPageToken": null
}
```

#### GET .../objectTypes/:apiName

Get a single object type with full properties, datasource, and indexing state.

```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Taxpayer
```

**Response:** `200 OK`

**Errors:** `404 OBJECT_TYPE_NOT_FOUND`

#### PUT .../objectTypes/:apiName

Update displayName, description, icon, iconColor, or status.

```bash
curl -X PUT http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Taxpayer \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Updated Taxpayer"}'
```

**Response:** `200 OK`

**Errors:** `404 OBJECT_TYPE_NOT_FOUND`, `400 VALIDATION_FAILED`

#### DELETE .../objectTypes/:apiName

Delete an object type and all cascaded resources.

```bash
curl -X DELETE http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Employee
```

**Response:** `204 No Content`

**Errors:** `404 OBJECT_TYPE_NOT_FOUND`, `400 VALIDATION_FAILED` (if referenced by link types)

---

### Properties

All property routes are nested under `.../objectTypes/:apiName`.

#### POST .../properties

Create a single property.

```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Employee/properties \
  -H "Content-Type: application/json" \
  -d '{"apiName":"email","displayName":"Email","baseType":"string","isRequired":false}'
```

**Response:** `201 Created`

```json
{
  "apiName": "email",
  "displayName": "Email",
  "baseType": "string",
  "description": null,
  "structSchema": null,
  "isRequired": false,
  "isArray": false,
  "ordinal": 0
}
```

**Errors:** `400 INVALID_API_NAME`, `400 INVALID_BASE_TYPE`, `400 VALIDATION_FAILED`, `409 PROPERTY_ALREADY_EXISTS`

#### POST .../properties/batch

Atomically create multiple properties. Validates all before inserting any.

```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Employee/properties/batch \
  -H "Content-Type: application/json" \
  -d '{
    "properties": [
      {"apiName":"department","displayName":"Department","baseType":"string"},
      {"apiName":"startDate","displayName":"Start Date","baseType":"date"}
    ]
  }'
```

**Response:** `201 Created`

```json
{"data": [{"apiName": "department", "baseType": "string"}, {"apiName": "startDate", "baseType": "date"}]}
```

**Errors:** `400 REQUIRED_FIELD_MISSING`, `400 VALIDATION_FAILED`

#### GET .../properties

List all properties on an object type.

```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Employee/properties
```

**Response:** `200 OK` — `{"data": [...]}`

#### GET .../properties/:propApiName

Get a single property.

```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Employee/properties/email
```

**Response:** `200 OK`

**Errors:** `404 PROPERTY_NOT_FOUND`

#### PUT .../properties/:propApiName

Update displayName, description, isRequired, or ordinal. `apiName` and `baseType` are immutable.

```bash
curl -X PUT http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Employee/properties/email \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Work Email","isRequired":true}'
```

**Response:** `200 OK`

**Errors:** `404 PROPERTY_NOT_FOUND`, `400 VALIDATION_FAILED` (if attempting to change apiName or baseType)

#### DELETE .../properties/:propApiName

Delete a property. Cannot delete the primary key property.

```bash
curl -X DELETE http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Employee/properties/email
```

**Response:** `204 No Content`

**Errors:** `404 PROPERTY_NOT_FOUND`, `400 VALIDATION_FAILED` (if property is PK)

#### POST .../primaryKey

Set the primary key property for the object type.

```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Employee/primaryKey \
  -H "Content-Type: application/json" \
  -d '{"propertyApiName":"employeeId"}'
```

**Response:** `200 OK`

**Errors:** `400 REQUIRED_FIELD_MISSING`, `404 PROPERTY_NOT_FOUND`

#### POST .../titleProperty

Set the title (display) property for the object type.

```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Employee/titleProperty \
  -H "Content-Type: application/json" \
  -d '{"propertyApiName":"fullName"}'
```

**Response:** `200 OK`

**Errors:** `400 REQUIRED_FIELD_MISSING`, `404 PROPERTY_NOT_FOUND`

---

### Datasources

All datasource routes are nested under `.../objectTypes/:apiName/datasource`.

#### POST .../datasource

Register a backing datasource (CSV or JSON file). One datasource per object type.

```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Taxpayer/datasource \
  -H "Content-Type: application/json" \
  -d '{
    "datasetName": "Taxpayer Dataset",
    "filePath": "/tmp/ontology-testdata/taxpayers.csv",
    "fileFormat": "csv",
    "columnMapping": {"tin": "tin", "fullName": "full_name", "email": "email"}
  }'
```

**Response:** `201 Created`

```json
{
  "datasetName": "Taxpayer Dataset",
  "filePath": "/tmp/ontology-testdata/taxpayers.csv",
  "fileFormat": "csv",
  "columnMapping": {"tin": "tin", "fullName": "full_name"},
  "primaryKeyColumn": "tin",
  "rowCount": 100,
  "columnNames": ["tin", "full_name", "email"],
  "schemaHash": "abc123...",
  "lastScannedAt": null,
  "registeredAt": "..."
}
```

**Errors:** `409 DATASOURCE_ALREADY_REGISTERED`, `400 DATASOURCE_FILE_NOT_FOUND`, `400 COLUMN_MAPPING_INVALID`, `404 OBJECT_TYPE_NOT_FOUND`

#### GET .../datasource

Get the registered datasource for an object type.

```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Taxpayer/datasource
```

**Response:** `200 OK`

**Errors:** `404 DATASOURCE_NOT_FOUND`

#### DELETE .../datasource

Unregister the datasource. Resets funnel state to `not_indexed`.

```bash
curl -X DELETE http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Taxpayer/datasource
```

**Response:** `204 No Content`

**Errors:** `404 DATASOURCE_NOT_FOUND`

#### POST .../datasource/scan

Re-scan the file and update metadata (row count, column names, schema hash).

```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Taxpayer/datasource/scan
```

**Response:** `200 OK`

```json
{
  "datasource": {"datasetName": "...", "rowCount": 100, "schemaHash": "..."},
  "schemaChanged": false
}
```

**Errors:** `404 DATASOURCE_NOT_FOUND`, `400 DATASOURCE_FILE_NOT_FOUND`

---

### Statistics

#### GET .../objectTypes/:apiName/statistics

Get aggregated metrics: property counts by type, datasource status, indexing metrics, health.

```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Taxpayer/statistics
```

**Response:** `200 OK`

```json
{
  "statistics": {
    "propertyCount": 10,
    "propertiesByType": {"string": 8, "date": 1, "double": 1},
    "requiredPropertyCount": 2,
    "arrayPropertyCount": 0,
    "propertyCapacityUsed": "0.5%",
    "datasource": {
      "status": "registered",
      "filePath": "/tmp/ontology-testdata/taxpayers.csv",
      "fileFormat": "csv",
      "rowCount": 100,
      "lastScanned": null
    },
    "indexing": {
      "status": "not_indexed",
      "objectsIndexed": 0,
      "objectsFailed": 0,
      "editsPending": 0,
      "lastIndexedAt": null,
      "lastDurationMs": null
    },
    "health": "not_indexed"
  }
}
```

Health values: `not_indexed`, `indexing`, `healthy`, `warning`, `error`.

**Errors:** `404 OBJECT_TYPE_NOT_FOUND`

---

### Lifecycle Operations

#### POST .../objectTypes/:apiName/changeStatus

Change an object type's status. Valid statuses: `active`, `experimental`, `deprecated`.

```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Employee/changeStatus \
  -H "Content-Type: application/json" \
  -d '{"status":"experimental"}'
```

**Response:** `200 OK` — Full object type.

**Errors:** `404 OBJECT_TYPE_NOT_FOUND`, `400 VALIDATION_FAILED` (invalid status)

#### POST .../objectTypes/:apiName/clone

Clone an object type's schema (properties, PK, title) into a new object type. Clone starts with status `experimental`. Does NOT copy backing datasource.

```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Employee/clone \
  -H "Content-Type: application/json" \
  -d '{"newApiName":"EmployeeClone","newDisplayName":"Employee Clone"}'
```

**Response:** `201 Created` — Full cloned object type.

**Errors:** `404 OBJECT_TYPE_NOT_FOUND`, `400 INVALID_API_NAME`, `409 OBJECT_TYPE_ALREADY_EXISTS`, `400 REQUIRED_FIELD_MISSING`

#### GET .../objectTypes/:apiName/export

Export a single object type definition as JSON.

```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/Employee/export
```

**Response:** `200 OK`

```json
{
  "exportVersion": "1.0",
  "exportedAt": "...",
  "objectType": {
    "apiName": "Employee",
    "primaryKeyProperty": "employeeId",
    "properties": [{"apiName": "employeeId", "baseType": "string"}]
  }
}
```

**Errors:** `404 OBJECT_TYPE_NOT_FOUND`

#### POST .../objectTypes/import

Import a single object type from a JSON definition (the inverse of export).

```bash
curl -X POST http://localhost:3000/api/v1/ontology/{ontologyId}/objectTypes/import \
  -H "Content-Type: application/json" \
  -d @exported-object-type.json
```

**Response:** `201 Created` — Full imported object type.

**Errors:** `400 VALIDATION_FAILED`, `400 INVALID_API_NAME`, `400 INVALID_BASE_TYPE`, `409 OBJECT_TYPE_ALREADY_EXISTS`

---

### Export / Import

#### GET /api/v1/ontology/:ontologyId/export

Export the entire ontology definition as JSON. Sets `Content-Disposition` header for file download.

```bash
curl http://localhost:3000/api/v1/ontology/{ontologyId}/export
```

**Response:** `200 OK`

```json
{
  "exportVersion": "1.0",
  "exportedAt": "2026-03-11T12:00:00.000Z",
  "exportedFrom": "ontology-engine-v0.1.0",
  "ontology": {
    "displayName": "RRA Tax Ontology",
    "description": "...",
    "objectTypes": [
      {
        "apiName": "Taxpayer",
        "displayName": "Taxpayer",
        "primaryKeyProperty": "tin",
        "titleProperty": "fullName",
        "properties": [{"apiName": "tin", "baseType": "string", "isRequired": true}]
      }
    ],
    "linkTypes": [],
    "actionTypes": [],
    "interfaces": []
  }
}
```

**Errors:** `404 ONTOLOGY_NOT_FOUND`

#### POST /api/v1/ontology/import

Import an ontology from a previously exported JSON body. If `displayName` conflicts, appends `(imported)`.

```bash
curl -X POST http://localhost:3000/api/v1/ontology/import \
  -H "Content-Type: application/json" \
  -d @exported-ontology.json
```

**Response:** `201 Created`

```json
{
  "ontologyId": "new-uuid",
  "displayName": "RRA Tax Ontology (imported)",
  "objectTypeCount": 5
}
```

**Errors:** `400 VALIDATION_FAILED` (invalid exportVersion or structure), `400 INVALID_API_NAME`, `400 INVALID_BASE_TYPE`

#### GET .../objectTypes/:apiName/export (Single Object Type)

Export a single object type definition.

#### POST .../objectTypes/import (Single Object Type)

Import a single object type into an ontology.

---

### Error Codes Reference

| Code | HTTP Status | Description |
|---|---|---|
| `ONTOLOGY_NOT_FOUND` | 404 | Ontology does not exist |
| `OBJECT_TYPE_NOT_FOUND` | 404 | Object type does not exist |
| `PROPERTY_NOT_FOUND` | 404 | Property does not exist |
| `DATASOURCE_NOT_FOUND` | 404 | No datasource registered |
| `ONTOLOGY_ALREADY_EXISTS` | 409 | Display name already taken |
| `OBJECT_TYPE_ALREADY_EXISTS` | 409 | API name already exists in ontology |
| `PROPERTY_ALREADY_EXISTS` | 409 | Property API name already exists on object type |
| `DATASOURCE_ALREADY_REGISTERED` | 409 | Object type already has a datasource |
| `INVALID_API_NAME` | 400 | API name fails naming convention |
| `INVALID_BASE_TYPE` | 400 | Base type not in the 23 valid types |
| `INVALID_PARAMETER` | 400 | Generic invalid parameter |
| `VALIDATION_FAILED` | 400 | Business rule validation failed |
| `PRIMARY_KEY_NOT_SET` | 400 | Primary key required but not provided |
| `DATASOURCE_FILE_NOT_FOUND` | 400 | File path does not exist on disk |
| `COLUMN_MAPPING_INVALID` | 400 | Column mapping validation failed |
| `REQUIRED_FIELD_MISSING` | 400 | Required request body field missing |
| `ALREADY_EXISTS` | 409 | Generic uniqueness conflict |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

## 5. Palantir Documentation References

| Palantir Doc URL | Concept It Defines | Implementing File(s) |
|---|---|---|
| https://www.palantir.com/docs/foundry/object-link-types/base-types/ | The 23 base property types (string, boolean, integer, long, double, etc.) | `src/utils/typeSystem.ts` |

## 6. Roadmap

| Week | Focus |
|---|---|
| Week 2 | OpenSearch indexing, Object Data Funnel execution |
| Week 3 | Query API, Object Set Service, authentication |
| Week 4 | Link Types, join tables |
| Week 5 | Action Types, execution engine |

## 7. Technical Decisions

### Why PostgreSQL (not MongoDB)

Relational integrity is essential for schema definitions. Every property must reference a valid object type, every object type must belong to a valid ontology, and every datasource must reference a valid object type. PostgreSQL's foreign key constraints enforce these relationships at the database level, preventing orphaned records. MongoDB's document model would require application-level enforcement of these invariants, which is fragile and error-prone.

### Why OpenSearch (not PostgreSQL full-text search)

Palantir uses a dedicated search engine for object data, and we follow the same architecture. PostgreSQL's full-text search works for small datasets but lacks the aggregation performance needed at scale. OpenSearch provides sub-second faceted search, nested field queries, and horizontal scaling via sharding. Week 2 introduces the OpenSearch indexer that reads from the backing datasource and populates search indices.

### Why raw SQL (not Prisma/Sequelize)

ORMs abstract away the exact SQL being executed, making it impossible to verify our queries match Palantir's expected behavior. With raw parameterized queries, every SQL statement is visible in the service layer, easily audited, and directly optimizable. The `pg` library's parameterized query support (`$1`, `$2`, etc.) prevents SQL injection while keeping queries transparent. This is particularly important for the complex JOIN queries in list endpoints and the transactional operations in batch create and clone.
