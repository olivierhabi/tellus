# TASK 18: Create the Document Count Verification Utility

**File to create:** `/src/services/indexing/verifier.js`

**Purpose:** After indexing completes, verify that the number of documents in OpenSearch matches the expected count. This catches silent failures where the bulk API reported success but documents were not actually persisted (due to, e.g., disk space issues, mapping conflicts, or cluster instability). Palantir's Funnel includes pipeline health checks that verify indexed data integrity.

**Specification:**

Import the OpenSearch client from Task 1's `/src/services/opensearch/client.js`.
Import `getIndexName` from Task 3 to compute the index name.

Export: `verifyIndexCount(objectTypeApiName, expectedCount)` that:

1. Computes the index name using `getIndexName(objectTypeApiName)`.
2. Calls `client.count({ index: indexName })` to get the actual document count in OpenSearch.
3. Compares with `expectedCount`.
4. Returns:
   ```javascript
   {
     verified: true|false,
     expectedCount: 995,
     actualCount: 995,
     discrepancy: 0,
     message: "Document count matches expected count"
     // or: "Document count mismatch: expected 995, found 993 (2 missing)"
   }
   ```
5. If there's a discrepancy, log a WARNING (not an error — the indexer already reported success for those documents, so this is a post-hoc check).

**Edge cases:**
- If the index does not exist, return `{ verified: false, expectedCount, actualCount: 0, discrepancy: expectedCount, message: "Index 'ontology-{name}' does not exist" }`.
- If `expectedCount` is 0 and `actualCount` is 0, return `{ verified: true, expectedCount: 0, actualCount: 0, discrepancy: 0, message: "Document count matches expected count (both zero)" }`.
- If OpenSearch is unreachable, throw with message: `"Unable to verify document count: OpenSearch connection failed"`.

**Note:** The indexing orchestrator (Task 12) is the intended consumer of this function. Integration of this verifier into the orchestrator pipeline is tracked separately and is not part of this task.

**Test to verify:** Index 100 documents, call `verifyIndexCount` with expectedCount 100 — verify `verified: true`. Call with expectedCount 105 — verify `verified: false` with discrepancy 5. Call for a non-existent index — verify `verified: false` with `actualCount: 0`.
