# TASK 14: Create the Indexing API Endpoint — Trigger Full Reindex

**File to create:** `/src/routes/indexing.js` (new file — Tasks 15 and 16 will add additional routes to this same file)

**Endpoint:** `POST /api/v2/ontology/:ontologyId/objectTypes/:apiName/index`

**Purpose:** This endpoint triggers a full reindex of an object type. When called, it runs the complete indexing orchestrator pipeline (Task 12). This is the API equivalent of clicking "Sync" in Palantir's Ontology Manager when you want to reindex an object type from its backing datasource.

**Detailed specification:**

**Request:**
- Method: POST
- Path params: `ontologyId` (UUID), `apiName` (string — the object type API name)
- Body (optional JSON):
  ```json
  {
    "forceRecreateIndex": false,
    "strict": true
  }
  ```
- If no body is provided, use defaults: `forceRecreateIndex: false, strict: true`

**Validation:**
1. Verify the ontology exists. If not → 404: `{ error: { code: "ONTOLOGY_NOT_FOUND", message: "Ontology '{ontologyId}' not found" } }`
2. Verify the object type exists in this ontology. If not → 404: `{ error: { code: "OBJECT_TYPE_NOT_FOUND", message: "Object type '{apiName}' not found in ontology '{ontologyId}'" } }`
3. Verify a backing datasource is registered. If not → 400: `{ error: { code: "NO_BACKING_DATASOURCE", message: "Object type '{apiName}' has no backing datasource. Register one first via POST /api/v2/ontology/{ontologyId}/objectTypes/{apiName}/datasource" } }`
4. Check the funnel pipeline state. If status is 'running', reject with 409 Conflict: `{ error: { code: "INDEXING_IN_PROGRESS", message: "Object type '{apiName}' is already being indexed. Wait for the current indexing to complete." } }`. This prevents concurrent indexing of the same object type, which could cause data corruption.

**Execution:**
- Call `indexObjectType(apiName, { forceRecreateIndex, strict })` from Task 12.
- For Week 1, this runs synchronously (the HTTP response waits until indexing completes). For production, this would be async with a job ID and polling.

**Response (success — 200):**
```json
{
  "status": "success",
  "objectTypeApiName": "Employee",
  "indexName": "ontology-employee",
  "objectsIndexed": 995,
  "totalDurationMs": 1087,
  "pipeline": { ... }
}
```

**Response (data validation failure — 400):**
```json
{
  "status": "failed",
  "objectTypeApiName": "Employee",
  "error": {
    "code": "DATA_VALIDATION_ERROR",
    "message": "Indexing failed due to data validation errors",
    "details": {
      "duplicateKeys": [...],
      "nullKeys": [...],
      "invalidRows": [...]
    }
  }
}
```

**Response (internal error — 500):**
```json
{
  "status": "failed",
  "objectTypeApiName": "Employee",
  "error": {
    "code": "INDEXING_INTERNAL_ERROR",
    "message": "Unexpected error during indexing",
    "details": "..."
  }
}
```

**Test to verify:** Upload a CSV, register as datasource, call this endpoint, verify 200 response with correct counts. Call again with bad data, verify 400 response with validation details.
