# TASK 15: Create the Indexing API Endpoint — Get Indexing Status

**File to modify:** `/src/routes/indexing.js` (add route to the file created in Task 14)

**Endpoint:** `GET /api/v2/ontology/:ontologyId/objectTypes/:apiName/indexing/status`

**Purpose:** Returns the current indexing pipeline status for an object type. This includes when it was last indexed, how many objects were indexed, whether the last run succeeded or failed, and current index statistics from OpenSearch. In Palantir's Ontology Manager, the Datasources tab shows the Funnel pipeline status — we replicate that information via this API.

**Validation (same pattern as Task 14):**
1. Verify the ontology exists by querying PostgreSQL. If not found, return 404: `{ error: { code: "ONTOLOGY_NOT_FOUND", message: "Ontology '{ontologyId}' not found" } }`.
2. Verify the object type exists in this ontology. If not found, return 404: `{ error: { code: "OBJECT_TYPE_NOT_FOUND", message: "Object type '{apiName}' not found in ontology '{ontologyId}'" } }`.

**Data assembly:**
1. Call `getState(objectTypeApiName)` from Task 13's `/src/models/funnelState.js`. If no state row exists, use defaults: `{ status: "idle", lastIndexedAt: null, objectsIndexed: 0, durationMs: null, datasourceVersion: null, retryCount: 0, errorMessage: null }`.
2. Call `getIndexStats(objectTypeApiName)` from Task 4's `/src/services/opensearch/indexLifecycleManager.js`. If OpenSearch is unreachable, set `index: { exists: false, error: "OpenSearch unreachable" }`.
3. Query the backing datasource for this object type using `getDatasourceByObjectType(objectTypeApiName)` from Monday's `/src/services/backingDatasourceService.js`. If no datasource is registered, set `datasource: { registered: false }`.

**Response (200):**
```json
{
  "objectTypeApiName": "Employee",
  "indexName": "ontology-employee",
  "pipeline": {
    "status": "success",
    "lastIndexedAt": "2025-03-11T10:30:00.000Z",
    "objectsIndexed": 995,
    "durationMs": 1087,
    "datasourceVersion": "txn-001",
    "retryCount": 0,
    "errorMessage": null
  },
  "index": {
    "exists": true,
    "documentCount": 995,
    "storeSizeBytes": 425000,
    "storeSizeHuman": "415 KB"
  },
  "datasource": {
    "registered": true,
    "filePath": "/data/employees.csv",
    "primaryKeyColumn": "emp_id"
  }
}
```

**Response (404 — ontology or object type not found):**
```json
{ "error": { "code": "OBJECT_TYPE_NOT_FOUND", "message": "Object type '{apiName}' not found in ontology '{ontologyId}'" } }
```

**Response (500 — internal error):**
```json
{ "error": { "code": "INTERNAL_ERROR", "message": "Failed to retrieve indexing status: {error details}" } }
```

**Test to verify:** Index an object type via Task 14's endpoint, then call this endpoint and verify the response shows status `"success"` with correct `objectsIndexed` count. Call this endpoint for a never-indexed object type and verify it returns status `"idle"` with null timestamps. Call for a non-existent object type and verify 404.
