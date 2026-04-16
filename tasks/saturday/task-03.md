## TASK 3: Build the Dataset Creation API Endpoint

### Context
With the database tables from Task 1 and the file upload handler from Task 2, we now need to build the API endpoint that ties them together. When a user uploads a file, the system must: (1) receive and validate the file, (2) extract metadata from it, (3) create a `dataset` record in PostgreSQL, (4) create an initial `dataset_transaction` record, (5) move the file to its permanent location, and (6) commit the transaction. This endpoint is the primary way data enters the system in week 1.

In Palantir Foundry, datasets are created through Data Connection syncs or by writing transforms in Code Repositories. Our simplified version combines dataset creation and initial data upload into a single API call for ease of use.

### Exact Specification

Create or update the file `/src/routes/datasets.js` with the following endpoint:

**Endpoint: `POST /api/v1/datasets/upload`**

This endpoint accepts a multipart form-data request with the following fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | The data file (CSV or JSON) |
| `name` | String | Yes | Human-readable name for the dataset (e.g., "Employee Directory Q1 2025") |
| `description` | String | No | Optional description of the dataset contents |

**Processing Steps (must execute in this exact order):**

Step 1: Validate the request. If no file is attached, return HTTP 400 with body:
```json
{
  "error": "MISSING_FILE",
  "message": "A file must be attached to create a dataset. Supported formats: CSV (.csv), JSON (.json), JSON Lines (.jsonl)"
}
```
If the `name` field is missing or empty, return HTTP 400 with body:
```json
{
  "error": "MISSING_NAME",
  "message": "The 'name' field is required when creating a dataset."
}
```

Step 2: Detect the file format using `uploadService.detectFileFormat()`. If the format cannot be detected, delete the temporary file and return HTTP 400 with body:
```json
{
  "error": "UNSUPPORTED_FORMAT",
  "message": "Unable to detect file format. Supported formats: CSV (.csv), JSON (.json), JSON Lines (.jsonl)"
}
```

Step 3: Extract metadata from the file. Call `extractCsvMetadata()` or `extractJsonMetadata()` depending on the detected format. If extraction fails, delete the temporary file and return HTTP 400 with the parsing error message.

Step 4: Begin a PostgreSQL transaction (using `BEGIN` / `COMMIT` / `ROLLBACK`). All database writes in steps 5-7 must be inside this transaction so that if any step fails, all changes are rolled back and the system remains in a consistent state.

Step 5: Insert a row into the `dataset` table with the extracted metadata:
```sql
INSERT INTO dataset (dataset_id, name, description, format, schema_definition, storage_path, row_count, file_size_bytes, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'system')
RETURNING *;
```
The `storage_path` should be `/data/datasets/{datasetId}/` (the directory, not the file — the file will be under a transaction subdirectory).

Step 6: Insert a row into the `dataset_transaction` table:
```sql
INSERT INTO dataset_transaction (transaction_id, dataset_id, type, status, file_path, row_count, file_size_bytes, created_by, metadata)
VALUES ($1, $2, 'SNAPSHOT', 'open', $3, $4, $5, 'system', $6)
RETURNING *;
```
The `metadata` JSONB should include: `{ "originalFilename": "employees.csv", "uploadedAt": "2025-03-15T10:30:00Z" }`.

Step 7: Move the file from the temporary upload location to its permanent location using `uploadService.moveToFinalLocation()`. If the file move fails, the PostgreSQL transaction must be rolled back and the temporary file must be cleaned up.

Step 8: Update the transaction status to 'committed' and set `committed_at`:
```sql
UPDATE dataset_transaction SET status = 'committed', committed_at = now() WHERE transaction_id = $1;
```

Step 9: Commit the PostgreSQL transaction.

Step 10: Return HTTP 201 with the following response body:
```json
{
  "dataset": {
    "datasetId": "a1b2c3d4-e5f6-...",
    "name": "Employee Directory Q1 2025",
    "description": "All active employees as of March 2025",
    "format": "csv",
    "schema": [
      { "columnName": "emp_id", "detectedType": "string", "nullable": false, "sampleValues": ["EMP-001", "EMP-002"] },
      { "columnName": "full_name", "detectedType": "string", "nullable": false, "sampleValues": ["Alice Smith", "Bob Jones"] },
      { "columnName": "salary", "detectedType": "number", "nullable": true, "sampleValues": [120000, 95000] }
    ],
    "rowCount": 1000,
    "fileSizeBytes": 45678,
    "createdAt": "2025-03-15T10:30:00.000Z"
  },
  "transaction": {
    "transactionId": "f7g8h9i0-...",
    "type": "SNAPSHOT",
    "status": "committed",
    "rowCount": 1000,
    "committedAt": "2025-03-15T10:30:01.000Z"
  }
}
```

**Error Recovery:**

If any step after file upload fails, the system must:
1. Roll back the PostgreSQL transaction (if one was started)
2. Delete the temporary uploaded file from `/data/datasets/uploads/`
3. If the file was already moved to the permanent location, delete it from there too
4. Return an appropriate HTTP error code (400 for client errors, 500 for server errors)

Use a try-catch-finally pattern:
```javascript
const client = await pool.connect();
try {
  await client.query('BEGIN');
  // ... steps 5-8 ...
  await client.query('COMMIT');
  return res.status(201).json(response);
} catch (error) {
  await client.query('ROLLBACK');
  // Clean up files
  if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
  if (finalFilePath && fs.existsSync(finalFilePath)) fs.unlinkSync(finalFilePath);
  return res.status(error.statusCode || 500).json({ error: error.code || 'INTERNAL_ERROR', message: error.message });
} finally {
  client.release();
}
```

### Validation Criteria
- Uploading a valid CSV file returns 201 with correct dataset and transaction details
- Uploading without a file returns 400 with MISSING_FILE error
- Uploading without a name returns 400 with MISSING_NAME error
- Uploading an invalid file returns 400 with UNSUPPORTED_FORMAT error
- If PostgreSQL is temporarily down, the file is cleaned up and a 500 error is returned
- The file is stored at the correct permanent path: `/data/datasets/{datasetId}/transactions/{transactionId}/{filename}`
- The dataset's `schema_definition` matches the actual CSV columns
- The transaction's status is 'committed' and `committed_at` is set
