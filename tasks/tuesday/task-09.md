# TASK 9: Create the Batch Document Builder

**File to create:** `/src/services/indexing/batchDocumentBuilder.js`

**Purpose:** This module takes the full output from the CSV reader (all rows) and transforms them all into OpenSearch documents, collecting valid documents for indexing and invalid documents for error reporting. It orchestrates the row transformer (Task 8) across all rows, tracks progress, and builds the final batch that will be sent to OpenSearch's bulk API. In Palantir's Funnel, this is the batch compilation step — where all rows from the datasource are compiled into a batch of object documents ready for indexing.

**Detailed specification:**

The module must export a single function: `buildBatch(rows, objectType, properties, columnMapping, primaryKeyColumn, options)` where:
- `rows` — Array of row objects from the CSV reader
- `objectType` — The object type record from PostgreSQL (passed in by the orchestrator)
- `properties` — Array of property records from PostgreSQL (passed in by the orchestrator)
- `columnMapping` — The column mapping object from the backing datasource record (passed in by the orchestrator)
- `primaryKeyColumn` — The name of the CSV column that serves as the primary key (passed in by the orchestrator)
- `options` — Optional:
  - `strict` (boolean, default: true): Passed to row transformer
  - `datasourceVersion` (string): Passed to row transformer
  - `onProgress` (function): Callback called every 100 rows with `{ processed: N, total: M, percentComplete: P }`

**Important design decision:** This function is a **pure transformation function**. It does NOT fetch metadata from PostgreSQL and does NOT validate primary keys. All metadata is passed in as parameters by the orchestrator (Task 12). Primary key validation is the sole responsibility of the orchestrator (Task 12, Stage 4). This avoids duplicate data fetching and duplicate validation.

**Step-by-step logic:**

1. Iterate through all rows, calling `transformRow()` from Task 8 for each one, passing the provided `objectType`, `properties`, `columnMapping`, and `options`. Collect results into two arrays: `validDocuments` and `invalidDocuments`.
2. Every 100 rows, call the `onProgress` callback with `{ processed, total, percentComplete }`.
3. After processing all rows, call the `onProgress` callback one final time with 100% completion.
4. If there are duplicate primary keys within the valid documents (defense in depth), deduplicate using "last row wins" — keep only the last occurrence of each primary key. This matches Palantir's "most recent transaction wins" behavior.
5. Return:
   ```javascript
   {
     success: invalidDocuments.length === 0,
     objectTypeApiName: "Employee",
     totalRows: 1000,
     validCount: 998,
     invalidCount: 2,
     validDocuments: [ { __pk: "EMP-001", ... }, { __pk: "EMP-002", ... }, ... ],
     invalidDocuments: [
       { lineNumber: 45, errors: ["..."], rawRow: { ... } },
       { lineNumber: 872, errors: ["..."], rawRow: { ... } }
     ],
     deduplicatedCount: 0,  // how many documents were removed due to duplicate PKs
     datasourceVersion: "txn-001",
     buildDurationMs: 1500
   }
   ```

**Important behavior:** If `strict` is true and there are ANY invalid rows, the `success` field is `false`. The caller (the indexing orchestrator, Task 12) must decide whether to proceed with indexing only the valid documents or abort entirely. In Palantir's default behavior, a reindex will fail if there are data validation errors (like null required properties). We replicate this: the indexing orchestrator should abort if `success` is false, matching Palantir's "the reindex will fail" behavior.

**Memory optimization:** For very large datasets (100K+ rows), do not hold all valid documents in memory at once. Instead, use a generator pattern or write batches to a temporary file. But for Week 1, holding all documents in an array is acceptable for datasets up to ~500K rows.

**Test to verify:** Process a CSV with 1000 rows where 5 rows have conversion errors. Verify that validCount is 995, invalidCount is 5, and all 5 invalid rows are correctly reported with their line numbers and error messages.
