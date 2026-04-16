## TASK 8: Build the Reindex API Endpoint

### Context
Task 7 built the reindex engine as an internal service function. This task exposes it as an HTTP API endpoint so that users and the system can trigger reindexing. In Palantir Foundry, reindexing is triggered automatically when a backing datasource receives new data (via the Funnel's scheduled pipeline). In our week-1 implementation, reindexing is manual — the user explicitly calls this endpoint after uploading new data or after executing actions that modify objects.

### Exact Specification

**Endpoint: `POST /api/v1/ontology/:ontologyId/objectTypes/:apiName/reindex`**

This endpoint triggers a full reindex of the specified object type. It is synchronous for week 1 — the response is not returned until the reindex is complete. (A future improvement would be to make this asynchronous with a job ID and status polling endpoint.)

**Request body:** None (POST with empty body or no body)

**Optional query parameters:**
- `force` (boolean, default false): If true, reindexes even if there are no new transactions since the last reindex. If false, the endpoint checks whether reindexing is actually needed and returns early if not.

**Processing steps:**

Step 1: Validate that the ontology and object type exist. If not, return HTTP 404 with appropriate error.

Step 2: Validate that the object type has a registered backing datasource. If not, return HTTP 400:
```json
{
  "error": "NO_BACKING_DATASOURCE",
  "message": "Object type 'Employee' has no registered backing datasource. Register one using POST /api/v1/ontology/:id/objectTypes/Employee/datasource"
}
```

Step 3: If `force` is not true, check whether reindexing is needed:
```sql
-- Get the last indexed transaction
SELECT last_indexed_transaction_id FROM funnel_state WHERE object_type_id = $1;

-- Get the latest committed transaction for this dataset
SELECT transaction_id, committed_at FROM dataset_transaction
WHERE dataset_id = $1 AND status = 'committed'
ORDER BY committed_at DESC LIMIT 1;

-- Check if there are any unindexed edits
SELECT COUNT(*) FROM ontology_edit WHERE object_type_api_name = $1 AND indexed = false;
```

If the last indexed transaction matches the latest committed transaction AND there are no unindexed edits, return HTTP 200 with:
```json
{
  "status": "no_changes",
  "message": "Object type 'Employee' is already up to date. No new data or edits to index. Use ?force=true to reindex anyway."
}
```

Step 4-5: Atomically claim the reindex lock (prevents TOCTOU race condition between checking and setting status):
```sql
UPDATE funnel_state SET index_status = 'running', error_message = NULL
WHERE object_type_id = $1 AND index_status != 'running'
RETURNING *;
```
If 0 rows are returned (either no row exists or status is already 'running'), check which case:
- If no `funnel_state` row exists at all, INSERT one with `index_status = 'running'`:
  ```sql
  INSERT INTO funnel_state (object_type_id, index_status)
  VALUES ($1, 'running')
  ON CONFLICT (object_type_id) DO NOTHING
  RETURNING *;
  ```
  If the INSERT also returns 0 rows (lost the race), another reindex just started — return HTTP 409.
- If a row exists but `index_status` is already 'running', return HTTP 409:
```json
{
  "error": "REINDEX_IN_PROGRESS",
  "message": "A reindex for object type 'Employee' is already in progress. Please wait for it to complete."
}
```

Step 6: Call `reindexService.reindexObjectType(ontologyId, objectTypeApiName)` from Task 7.

Step 7: If the reindex succeeds, return HTTP 200:
```json
{
  "status": "completed",
  "objectType": "Employee",
  "result": {
    "transactionsProcessed": 3,
    "objectsFromDatasource": 1000,
    "editsApplied": {
      "creates": 2,
      "updates": 5,
      "deletes": 1
    },
    "totalObjectsIndexed": 1001,
    "skippedNullPk": 0,
    "durationMs": 1250
  }
}
```

Step 8: If the reindex fails, return HTTP 500:
```json
{
  "error": "REINDEX_FAILED",
  "message": "Reindex failed for object type 'Employee': Required property 'employeeId' has null value for object with primary key 'null'.",
  "details": {
    "objectType": "Employee",
    "durationMs": 350,
    "failedAtStep": "required_property_validation"  // Valid values: "metadata_load", "file_read", "duplicate_pk_check", "required_property_validation", "edit_application", "opensearch_indexing", "state_update"
  }
}
```

### Validation Criteria
- Successful reindex returns 200 with accurate statistics
- Reindex with no changes returns 200 with "no_changes" status (unless force=true)
- Reindex with no backing datasource returns 400
- Concurrent reindex attempt returns 409
- Failed reindex returns 500 with descriptive error message
- After successful reindex, funnel_state shows 'completed' with correct stats
- After failed reindex, funnel_state shows 'failed' with error message
