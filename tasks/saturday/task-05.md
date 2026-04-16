## TASK 5: Build the Append Transaction Endpoint

### Context
Task 3 handled the initial dataset upload (SNAPSHOT transaction — full replacement). But Palantir datasets also support APPEND transactions, where new rows are added to an existing dataset without replacing the original data. This is critical for the Ontology because many data sources produce incremental data — for example, new tax returns filed each day are appended to the existing tax returns dataset. The Funnel's incremental indexing (a future week's feature) will use APPEND transactions to know which rows are new.

For week 1, our APPEND implementation is simple: the new file's rows are added to the dataset's total row count, and when reindexing occurs, ALL files across ALL committed transactions are read and merged. True incremental indexing (only indexing the new rows from the APPEND) will come in week 3.

### Exact Specification

**Endpoint: `POST /api/v1/datasets/:datasetId/transactions`**

This endpoint uploads a new file of data to append to an existing dataset.

Request format: multipart form-data with:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | The data file to append |
| `type` | String | No | Transaction type: `"SNAPSHOT"` or `"APPEND"` (default: `"APPEND"`). If the value is present but not one of these two, return HTTP 400: `{ "error": "INVALID_TRANSACTION_TYPE", "message": "Transaction type must be 'SNAPSHOT' or 'APPEND'. Received: '{value}'" }` |

**Validation rules (must all be checked before any data is written):**

1. The dataset with the given `datasetId` must exist. If not, return HTTP 404:
```json
{ "error": "DATASET_NOT_FOUND", "message": "Dataset with ID '...' was not found." }
```

2. The uploaded file format must match the existing dataset's format. If the dataset is CSV but the user uploads JSON, return HTTP 400:
```json
{ "error": "FORMAT_MISMATCH", "message": "This dataset uses 'csv' format but the uploaded file is 'json'. The format must match." }
```

3. The uploaded file's columns must be compatible with the existing dataset's schema:
   - **For CSV files**: the header row must contain at least all the columns in the dataset's `schema_definition`. Extra columns are allowed (they will be ignored during Ontology mapping). Missing columns are NOT allowed — they would cause null values in required properties. Compare column names case-sensitively.
   - **For JSON files**: the first object in the new file must contain at least all keys present in the dataset's `schema_definition`. Missing keys trigger the same SCHEMA_MISMATCH error as CSV. Extra keys are allowed.
   - If columns/keys are missing, return HTTP 400:
   ```json
   { "error": "SCHEMA_MISMATCH", "message": "The uploaded file is missing columns that exist in the dataset schema: ['salary', 'department']. All existing columns must be present in appended data." }
   ```

**Processing steps (if all validation passes):**

Step 1: Extract metadata from the uploaded file (same as Task 2 — get row count, file size).

Step 2: Begin PostgreSQL transaction.

Step 3: Create a new `dataset_transaction` record:
```sql
INSERT INTO dataset_transaction (transaction_id, dataset_id, type, status, file_path, row_count, file_size_bytes, created_by, metadata)
VALUES ($1, $2, $3, 'open', $4, $5, $6, 'system', $7);
```
The `type` is either 'SNAPSHOT' or 'APPEND' based on the request.

If the type is 'SNAPSHOT': this replaces all previous data. All previous committed transactions should be marked with a metadata flag `{ "superseded": true }` using the following SQL (merge into existing metadata, do not replace it):
```sql
UPDATE dataset_transaction
SET metadata = metadata || '{"superseded": true}'::jsonb
WHERE dataset_id = $1 AND status = 'committed' AND transaction_id != $2;
```
The dataset's `row_count` is set to the new file's row count (not incremented).

If the type is 'APPEND': the dataset's `row_count` is incremented by the new file's row count.

Step 4: Move the file to permanent storage:
```
/data/datasets/{datasetId}/transactions/{transactionId}/{filename}
```

Step 5: Update the `dataset` table. Use different SQL depending on the transaction type:

For SNAPSHOT (replaces all data — reset both `row_count` and `file_size_bytes` to the new file's values):
```sql
UPDATE dataset SET
  row_count = $1,
  file_size_bytes = $2,
  updated_at = now()
WHERE dataset_id = $3;
```

For APPEND (adds to existing data — increment both `row_count` and `file_size_bytes`):
```sql
UPDATE dataset SET
  row_count = row_count + $1,
  file_size_bytes = file_size_bytes + $2,
  updated_at = now()
WHERE dataset_id = $3;
```

Step 6: Commit the transaction and set status to 'committed'.

Step 7: Commit the PostgreSQL transaction.

Step 8: Return HTTP 201:
```json
{
  "transaction": {
    "transactionId": "...",
    "datasetId": "...",
    "type": "APPEND",
    "status": "committed",
    "rowCount": 50,
    "fileSizeBytes": 2340,
    "committedAt": "2025-03-15T11:00:00.000Z"
  },
  "dataset": {
    "datasetId": "...",
    "totalRowCount": 1050,
    "totalFileSizeBytes": 48018,
    "transactionCount": 2
  }
}
```

### Validation Criteria
- Appending a valid CSV to a CSV dataset succeeds and increments row count
- Appending JSON to a CSV dataset fails with FORMAT_MISMATCH
- Appending a CSV with missing columns fails with SCHEMA_MISMATCH
- Appending a JSON file with missing keys fails with SCHEMA_MISMATCH
- SNAPSHOT transaction replaces the row count (not increments) and resets file_size_bytes
- Multiple APPEND transactions accumulate correctly (upload 100 rows 3 times → total 300)
- Transaction history shows all transactions in order
- File is stored at the correct path under the new transaction ID
- After a SNAPSHOT transaction, all previous committed transactions have `metadata.superseded` set to `true`
- Sending `type: "UPDATE"` returns HTTP 400 with INVALID_TRANSACTION_TYPE
- If the PostgreSQL INSERT in Step 3 fails (e.g., due to database error), no transaction record exists, and the temporary uploaded file is deleted
