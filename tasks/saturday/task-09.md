## TASK 9: Build the Auto-Index-on-Upload Pipeline

### Context
In Tasks 3 and 5, when a user uploads data or appends to a dataset, nothing happens to the Ontology automatically — the user must manually call the /reindex endpoint. In Palantir Foundry, the Object Data Funnel automatically picks up new dataset transactions and indexes them. While our week-1 system doesn't have a background scheduler (that's a future feature), we can at least offer an automatic reindex option: when new data is uploaded to a dataset that is already backing an object type, the system can automatically trigger a reindex.

This task adds an optional `autoIndex` flag to the dataset upload and append endpoints, and also builds an internal function that checks whether a newly committed transaction should trigger a reindex.

### Exact Specification

**Function: `checkAndTriggerAutoIndex(datasetId)`**

Create this function in `/src/services/autoIndexService.js`. It is called after every successful dataset transaction commit (from the upload and append endpoints).

Logic:
```javascript
async function checkAndTriggerAutoIndex(datasetId) {
  // 1. Check if this dataset backs any object type
  const result = await db.query(
    `SELECT ot.api_name, ot.ontology_id, bs.object_type_id
     FROM backing_datasource bs
     JOIN object_type ot ON bs.object_type_id = ot.object_type_id
     WHERE bs.dataset_id = $1`,
    [datasetId]
  );
  
  if (result.rows.length === 0) {
    // Dataset doesn't back any object type — nothing to do
    return { triggered: false, reason: 'dataset_not_backing_any_object_type' };
  }
  
  const objectType = result.rows[0];
  
  // 2. Check if auto-indexing is configured for this object type
  // For week 1, we always auto-index when the request includes autoIndex=true
  // This function is only called when autoIndex was requested
  
  // 3. Trigger reindex
  try {
    const reindexResult = await reindexService.reindexObjectType(
      objectType.ontology_id,
      objectType.api_name
    );
    return {
      triggered: true,
      objectType: objectType.api_name,
      result: reindexResult
    };
  } catch (error) {
    // Auto-index failure should NOT fail the upload — log the error and return
    console.error(`Auto-index failed for ${objectType.api_name}:`, error.message);
    return {
      triggered: true,
      objectType: objectType.api_name,
      error: error.message
    };
  }
}
```

Critical design decision: If auto-indexing fails, the upload/append operation must still succeed. The data is in the dataset; it just hasn't been indexed into the Ontology yet. The user can manually retry the reindex. This matches Palantir's behavior — a failed Funnel sync doesn't delete the underlying data.

**Update the upload endpoint (POST /api/v1/datasets/upload):**

Add an optional query parameter `autoIndex` (boolean, default false). The parameter is truthy if its value is `'true'` or `'1'`. All other values (including absent) are falsy. When truthy, after the dataset and transaction are committed, call `checkAndTriggerAutoIndex(datasetId)`.

**Important:** Auto-indexing is synchronous — the upload/append response is not returned until reindexing completes. This means uploads with `autoIndex=true` will take longer. The `indexing.result.durationMs` field in the response communicates this latency to the caller.

The response body is extended with an `indexing` field:
```json
{
  "dataset": { ... },
  "transaction": { ... },
  "indexing": {
    "triggered": true,
    "objectType": "Employee",
    "result": {
      "totalObjectsIndexed": 1000,
      "durationMs": 850
    }
  }
}
```

If auto-indexing was not requested:
```json
{
  "dataset": { ... },
  "transaction": { ... },
  "indexing": {
    "triggered": false,
    "reason": "autoIndex parameter not set. Call POST /reindex to index this data."
  }
}
```

If auto-indexing was requested but the dataset doesn't back any object type:
```json
{
  "indexing": {
    "triggered": false,
    "reason": "dataset_not_backing_any_object_type"
  }
}
```

If auto-indexing was requested but failed:
```json
{
  "indexing": {
    "triggered": true,
    "objectType": "Employee",
    "error": "Required property 'employeeId' has null value for object with primary key 'null'."
  }
}
```

**Update the append endpoint (POST /api/v1/datasets/:datasetId/transactions):**

Add optional `autoIndex` query parameter (truthy if `'true'` or `'1'`). When truthy, trigger auto-indexing after the append transaction is committed. The response body is extended with the same `indexing` field as the upload endpoint, with all four possible shapes:

1. **Triggered and succeeded:** `{ "indexing": { "triggered": true, "objectType": "Employee", "result": { "totalObjectsIndexed": 1050, "durationMs": 900 } } }`
2. **Triggered but failed:** `{ "indexing": { "triggered": true, "objectType": "Employee", "error": "..." } }`
3. **Not requested:** `{ "indexing": { "triggered": false, "reason": "autoIndex parameter not set. Call POST /reindex to index this data." } }`
4. **No backing object type:** `{ "indexing": { "triggered": false, "reason": "dataset_not_backing_any_object_type" } }`

### Validation Criteria
- Upload with autoIndex=true and a registered object type triggers reindex automatically
- Upload with autoIndex=true but no registered object type returns "dataset_not_backing_any_object_type"
- Upload with autoIndex=false does NOT trigger reindex
- If auto-indexing fails, the upload still succeeds (data is in the dataset)
- Append with autoIndex=true triggers reindex with merged data (original + appended)
- The response body includes the `indexing` field in all cases
