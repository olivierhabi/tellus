# TASK 12: Create the Indexing Orchestrator

**File to create:** `/src/services/indexing/indexingOrchestrator.js`

**Purpose:** This is the main orchestration module that ties together all previous tasks into a single end-to-end indexing pipeline. When someone calls "index this object type," this module coordinates the entire flow: read the datasource, validate primary keys, transform rows, merge edits, create/update the OpenSearch index, and bulk-index all documents. In Palantir's architecture, the Object Data Funnel orchestrates this entire pipeline as a series of jobs (Changelog → Merge → Index → Metadata). Our orchestrator replicates this pipeline in a simplified single-pass form for Week 1.

**Detailed specification:**

The module must export a single function: `indexObjectType(objectTypeApiName, options)` where:
- `objectTypeApiName` — The API name of the object type to index
- `options` — Optional:
  - `forceRecreateIndex` (boolean, default: false): If true, delete and recreate the OpenSearch index before indexing. If false, update the mapping and re-use the existing index.
  - `strict` (boolean, default: true): Whether to abort on any data validation errors
  - `onProgress` (function): Progress callback

**Step-by-step pipeline (must execute in EXACTLY this order):**

**Pipeline state management (using Task 13 model functions):**
- Before Stage 1: Call `setRunning(objectTypeApiName)` from Task 13's `/src/models/funnelState.js`.
- After Stage 7 succeeds: Call `setSuccess(objectTypeApiName, objectsIndexed, durationMs, datasourceVersion)` from Task 13.
- If any stage throws an error: Call `setFailed(objectTypeApiName, error.message)` from Task 13, then re-throw the error.

**Stage 1: Load Metadata**
- Fetch the object type from PostgreSQL. If not found, throw.
- Fetch all properties for this object type. If none, throw.
- Fetch the backing datasource mapping. If not registered, throw: "Object type '{apiName}' has no backing datasource registered. Register a datasource first."
- Extract `columnMapping` and `primaryKeyColumn` from the backing datasource record.
- Log: "Stage 1/7: Loaded metadata for '{apiName}' — {N} properties, datasource: '{filePath}'"

**Stage 2: Prepare Index**
- Check if the OpenSearch index exists (Task 4's `indexExists`).
- If it does not exist, create it (Task 4's `createIndex`).
- If it exists and `forceRecreateIndex` is true, recreate it (Task 4's `recreateIndex`).
- If it exists and `forceRecreateIndex` is false, update the mapping to add any new properties (Task 4's `updateMapping`).
- Log: "Stage 2/7: Index '{indexName}' ready"

**Stage 3: Read Datasource**
- Read the CSV file using `readCSV()` from Task 5.
- Log: "Stage 3/7: Read {N} rows from '{filePath}'"

**Stage 4: Validate Primary Keys**
- Call `validatePrimaryKeys(rows, primaryKeyColumn)` from Task 7.
- If validation fails (null PKs or duplicates), return failure result with full error details. Do not proceed. This matches Palantir: "a duplicate primary key will cause Funnel batch pipeline errors leading to a build failure."
- Log: "Stage 4/7: Primary keys validated — {N} unique keys"
- **Note:** This is the SOLE location where primary key validation occurs. Task 9's `buildBatch` does NOT perform PK validation — it receives pre-validated data.

**Stage 5: Transform Rows**
- Call `buildBatch(rows, objectType, properties, columnMapping, primaryKeyColumn, { strict, datasourceVersion, onProgress })` from Task 9. Pass the metadata loaded in Stage 1 as parameters.
- If `strict` is true and there are invalid rows, return failure result. Do not proceed.
- Log: "Stage 5/7: Transformed {validCount}/{totalRows} rows ({invalidCount} rejected)"

**Stage 6: Merge User Edits**
- Call `mergeEditsWithDatasource()` from Task 11 to apply any pending Action edits.
- Log: "Stage 6/7: Merged {editsApplied} user edits — {finalDocumentCount} documents to index"

**Stage 7: Bulk Index**
- Call `bulkIndex()` from Task 10 to send all documents to OpenSearch.
- Log: "Stage 7/7: Indexed {successCount}/{totalDocuments} documents in {durationMs}ms"

**Return the full pipeline result:**
```javascript
{
  success: true,
  objectTypeApiName: "Employee",
  indexName: "ontology-employee",
  pipeline: {
    stage1_metadata: { properties: 10, datasource: "/data/employees.csv" },
    stage2_index: { action: "created"|"updated"|"recreated", indexName: "ontology-employee" },
    stage3_read: { rowCount: 1000, durationMs: 45 },
    stage4_validate: { uniqueKeys: 1000, durationMs: 12 },
    stage5_transform: { validCount: 998, invalidCount: 2, durationMs: 150 },
    stage6_merge: { editsApplied: 5, finalCount: 995, durationMs: 30 },
    stage7_index: { successCount: 995, failedCount: 0, durationMs: 850 }
  },
  totalDurationMs: 1087,
  objectsIndexed: 995,
  timestamp: new Date().toISOString()
}
```

**Test to verify:** Run the full pipeline on a 1,000-row CSV. Verify all 7 stages complete. Query OpenSearch to verify all expected documents exist. Run the pipeline again on the same data — verify it's idempotent (same documents, updated not duplicated).
