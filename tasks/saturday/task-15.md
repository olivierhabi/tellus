## TASK 15: Build the Reindex Status and History Endpoint

### Context
When a reindex takes a long time (large datasets, many edits to apply), users need visibility into what's happening. They also need to review past reindex operations to understand when data was last refreshed and whether any errors occurred. This task builds endpoints for monitoring reindex status and viewing reindex history.

In Palantir Foundry, the Ontology Manager shows the status of Funnel pipelines with a green tick for success, an in-progress indicator, or a failed red label. Our API equivalent provides the same information programmatically.

### Exact Specification

First, add a reindex history table:

```sql
CREATE TABLE IF NOT EXISTS reindex_history (
  reindex_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type_id UUID REFERENCES object_type(object_type_id),
  object_type_api_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  transactions_processed INT DEFAULT 0,
  objects_from_datasource INT DEFAULT 0,
  edits_applied_creates INT DEFAULT 0,
  edits_applied_updates INT DEFAULT 0,
  edits_applied_deletes INT DEFAULT 0,
  total_objects_indexed INT DEFAULT 0,
  skipped_null_pk INT DEFAULT 0,
  duration_ms INT,
  error_message TEXT,
  triggered_by TEXT DEFAULT 'manual'
);

CREATE INDEX idx_reindex_history_ot ON reindex_history(object_type_api_name, started_at DESC);
```

Update the reindex engine (Task 7) to write to this table at the start and end of every reindex.

**Endpoint 1: `GET /api/v2/ontology/:ontologyId/objectTypes/:apiName/reindex/status`**

Returns the current indexing status of the object type.

Response:
```json
{
  "objectType": "Employee",
  "currentStatus": "completed",
  "lastSuccessfulReindex": {
    "reindexId": "...",
    "completedAt": "2025-03-15T12:00:00.000Z",
    "totalObjectsIndexed": 1001,
    "durationMs": 1250,
    "triggeredBy": "manual"
  },
  "lastFailedReindex": null,
  "pendingEdits": 0,
  "datasetTransactionsSinceLastIndex": 0,
  "needsReindex": false,
  "indexHealth": "healthy"
}
```

If no reindex has ever been run for this object type, `currentStatus` is `"never_indexed"` and `lastSuccessfulReindex` is `null`.

**Computing `pendingEdits`:**
```sql
SELECT COUNT(*) FROM ontology_edit WHERE object_type_api_name = $1 AND indexed = false;
```

**Computing `datasetTransactionsSinceLastIndex`:**
```sql
SELECT COUNT(*) FROM dataset_transaction dt
JOIN backing_datasource bs ON bs.dataset_id = dt.dataset_id
JOIN object_type ot ON bs.object_type_id = ot.object_type_id
WHERE ot.api_name = $1
  AND dt.status = 'committed'
  AND (
    NOT EXISTS (SELECT 1 FROM funnel_state fs WHERE fs.object_type_id = ot.object_type_id AND fs.last_indexed_transaction_id IS NOT NULL)
    OR dt.committed_at > (
      SELECT dt2.committed_at FROM dataset_transaction dt2
      JOIN funnel_state fs ON fs.last_indexed_transaction_id = dt2.transaction_id
      WHERE fs.object_type_id = ot.object_type_id
    )
  );
```

The `needsReindex` flag is true if:
- There are unindexed edits (pendingEdits > 0)
- There are new dataset transactions since the last reindex (datasetTransactionsSinceLastIndex > 0)
- The last reindex failed

The `indexHealth` is:
- `"healthy"`: last reindex succeeded and no pending changes
- `"stale"`: there are pending changes (new transactions or unindexed edits) but no errors
- `"failed"`: last reindex failed
- `"never_indexed"`: no reindex has ever been run for this object type

**Endpoint 2: `GET /api/v2/ontology/:ontologyId/objectTypes/:apiName/reindex/history`**

Returns the history of all reindex operations for this object type.

Query parameters:
- `pageSize` (integer, default: 10, max: 50)
- `status` (string, optional): filter by 'completed', 'failed', 'running'

Response:
```json
{
  "data": [
    {
      "reindexId": "...",
      "status": "completed",
      "startedAt": "2025-03-15T12:00:00.000Z",
      "completedAt": "2025-03-15T12:00:01.250Z",
      "transactionsProcessed": 2,
      "objectsFromDatasource": 1000,
      "editsApplied": { "creates": 1, "updates": 5, "deletes": 0 },
      "totalObjectsIndexed": 1001,
      "skippedNullPk": 0,
      "durationMs": 1250,
      "triggeredBy": "manual"
    },
    {
      "reindexId": "...",
      "status": "failed",
      "startedAt": "2025-03-15T11:00:00.000Z",
      "completedAt": "2025-03-15T11:00:00.350Z",
      "errorMessage": "Required property 'employeeId' has null value for object with primary key 'null'.",
      "durationMs": 350,
      "triggeredBy": "auto"
    }
  ],
  "totalCount": 2
}
```

### Validation Criteria
- Status endpoint shows "healthy" after a successful reindex with no pending changes
- Status endpoint shows "stale" when there are pending edits or new dataset transactions
- Status endpoint shows "failed" after a failed reindex
- Status endpoint shows "never_indexed" for a new object type (currentStatus is "never_indexed", lastSuccessfulReindex is null)
- While a reindex is in progress, the status endpoint returns currentStatus "running" and indexHealth "stale"
- The `pendingEdits` count matches the actual number of unindexed edits
- The `datasetTransactionsSinceLastIndex` count is accurate
- The `needsReindex` flag correctly reflects the combination of pending changes
- History endpoint shows all reindex operations in reverse chronological order
- History endpoint can be filtered by status
- After a successful reindex, the history entry has accurate statistics (transactionsProcessed, objectsFromDatasource, editsApplied, totalObjectsIndexed, durationMs)
- After a failed reindex, the history entry has status "failed" and error_message populated
- The reindex_history table migration is idempotent (CREATE TABLE IF NOT EXISTS)
