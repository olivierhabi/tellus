# TASK 10: Create the OpenSearch Bulk Indexer

**File to create:** `/src/services/opensearch/bulkIndexer.js`

**Purpose:** This module sends transformed documents to OpenSearch using the bulk API for efficient indexing. The OpenSearch bulk API allows indexing thousands of documents in a single HTTP request, which is dramatically faster than indexing documents one at a time. In Palantir's Funnel architecture, the Index Job writes the merged result into the object database using bulk operations. A single Funnel pipeline run might index tens of thousands or millions of objects, so efficient bulk indexing is critical.

**Detailed specification:**

The module must export the following functions:

1. **`bulkIndex(indexName, documents, options)`** — Indexes an array of documents into the specified OpenSearch index.

   **Parameters:**
   - `indexName` (string): The OpenSearch index name (from `getIndexName()` in Task 3, re-exported by Task 4)
   - `documents` (array): Array of document objects. Each document must have a `__pk` field that will be used as the OpenSearch document ID.
   - `options` (object, optional):
     - `batchSize` (number, default: 500): How many documents to send in each bulk request. OpenSearch handles bulk requests best when each request is between 5MB and 15MB. At ~1KB per document, 500 documents is ~500KB which is conservative but safe. For larger documents, reduce this. For smaller documents, increase to 1000-2000.
     - `refreshAfterComplete` (boolean, default: true): Whether to call `_refresh` on the index after all batches are complete. This forces OpenSearch to make all indexed documents immediately searchable. Without a refresh, documents are searchable after the `refresh_interval` (1 second by default). For the indexing pipeline, we want documents to be searchable immediately after indexing completes.
     - `onBatchComplete` (function): Callback called after each batch with `{ batchNumber, totalBatches, documentsInBatch, totalIndexed, durationMs }`.

   **Step-by-step logic:**

   a) Split the `documents` array into batches of `batchSize` documents each. If there are 1000 documents and batchSize is 500, there will be 2 batches.

   b) For each batch, build the OpenSearch bulk request body. The bulk API expects a newline-delimited JSON format where each document requires two lines: an action line and a document line.

   For each document in the batch:
   ```
   { "index": { "_index": "ontology-employee", "_id": "EMP-001" } }
   { "__pk": "EMP-001", "__objectType": "Employee", "fullName": "Melissa Chang", ... }
   ```

   The action line specifies:
   - `"index"` — This means "create or replace". If a document with this `_id` already exists, it will be overwritten. If it doesn't exist, it will be created. This is the correct action for both initial indexing and re-indexing.
   - `"_index"` — The index name (must match the index created in Task 4).
   - `"_id"` — The document ID, set to the `__pk` value. This is critical: using the primary key as the document ID means that re-indexing the same data is idempotent — it will overwrite existing documents with the same PK, not create duplicates.

   c) Send the batch using `client.bulk({ body: bulkBody })`.

   d) Process the response. The bulk API response contains a result for each document:
   ```json
   {
     "took": 30,
     "errors": false,
     "items": [
       { "index": { "_id": "EMP-001", "status": 201, "result": "created" } },
       { "index": { "_id": "EMP-002", "status": 200, "result": "updated" } },
       { "index": { "_id": "EMP-003", "status": 400, "error": { "type": "mapper_parsing_exception", "reason": "..." } } }
     ]
   }
   ```

   If `errors` is `true`, iterate through `items` and collect all documents that failed (status >= 400). For each failed document, extract the error reason. Do NOT throw an exception — some documents in a batch might succeed while others fail. Track successes and failures separately.

   e) If `refreshAfterComplete` is true and all batches have been sent, call `client.indices.refresh({ index: indexName })` to make all documents immediately searchable.

   f) Return the aggregate result:
   ```javascript
   {
     success: failedCount === 0,
     indexName: "ontology-employee",
     totalDocuments: 1000,
     successCount: 998,
     failedCount: 2,
     createdCount: 900,  // documents that were newly created
     updatedCount: 98,   // documents that replaced existing ones
     failedDocuments: [
       { primaryKey: "EMP-503", status: 400, error: "mapper_parsing_exception: failed to parse field [salary] of type [double]" },
       { primaryKey: "EMP-789", status: 400, error: "..." }
     ],
     batchCount: 2,
     totalDurationMs: 850,
     avgBatchDurationMs: 425
   }
   ```

2. **`bulkDelete(indexName, primaryKeys, options)`** — Deletes multiple documents by primary key.

   **Parameters:**
   - `indexName` (string): The OpenSearch index name.
   - `primaryKeys` (array): Array of primary key strings to delete.
   - `options` (object, optional):
     - `batchSize` (number, default: 500): How many deletes per bulk request.
     - `refreshAfterComplete` (boolean, default: true): Whether to refresh after all batches.
     - `onBatchComplete` (function): Same callback signature as `bulkIndex`.

   Build bulk body with `delete` actions:
   ```
   { "delete": { "_index": "ontology-employee", "_id": "EMP-001" } }
   { "delete": { "_index": "ontology-employee", "_id": "EMP-002" } }
   ```

   Return: `{ success, indexName, totalDocuments, deletedCount, failedCount, failedDocuments, batchCount, totalDurationMs, avgBatchDurationMs }`.

3. **`indexSingleDocument(indexName, document)`** — Indexes a single document. Used by the Action engine when a single object is created or modified.

   Call `client.index({ index: indexName, id: document.__pk, body: document, refresh: "true" })`.

   The `refresh: "true"` parameter tells OpenSearch to make this document immediately searchable. This is important for actions — when a user creates an object, it should be queryable immediately, not after a 1-second delay.

   Return: `{ success: true, primaryKey: document.__pk, result: "created"|"updated" }`.

4. **`deleteSingleDocument(indexName, primaryKey)`** — Deletes a single document. Used by the Action engine when an object is deleted.

   Call `client.delete({ index: indexName, id: primaryKey, refresh: "true" })`.

   Return: `{ success: true, primaryKey, result: "deleted" }`.

**Error handling:** If the OpenSearch cluster is unreachable during a bulk operation, the entire batch fails. The function must catch this and return a clear error: `{ success: false, error: { code: "OPENSEARCH_UNREACHABLE", message: "..." } }`. For individual document failures within a successful bulk request, handle them as described above (collect in `failedDocuments`).

**Test to verify:** Create 100 documents, bulk index them, verify they're all searchable via a `match_all` query. Then bulk index 100 more documents with 5 that have invalid data for a mapped field — verify 95 succeed and 5 are in `failedDocuments`.
