## TASK 4: Build the Dataset Listing and Detail Endpoints

### Context
After datasets can be uploaded (Task 3), users need to be able to list all datasets in the system and view details of a specific dataset including its transaction history. In Palantir Foundry, datasets are browsable through the filesystem-like project structure and through Data Lineage. Our simplified version provides REST API endpoints for listing and retrieving dataset details.

### Exact Specification

Add the following endpoints to `/src/routes/datasets.js`:

**Endpoint 1: `GET /api/v1/datasets`**

Lists all datasets in the system, ordered by creation date descending (newest first). Supports pagination.

Query parameters:
- `pageSize` (integer, default 20, max 100): Number of datasets to return per page
- `pageToken` (string, optional): Opaque pagination token (base64-encoded created_at timestamp of the last item on the previous page)
- `search` (string, optional): Filter datasets whose name contains this string (case-insensitive)

SQL query pattern:
```sql
SELECT d.*, 
  (SELECT COUNT(*) FROM dataset_transaction dt WHERE dt.dataset_id = d.dataset_id AND dt.status = 'committed') as transaction_count,
  (SELECT MAX(dt.committed_at) FROM dataset_transaction dt WHERE dt.dataset_id = d.dataset_id AND dt.status = 'committed') as last_transaction_at
FROM dataset d
WHERE ($1::text IS NULL OR d.name ILIKE '%' || $1 || '%')
  AND ($2::timestamptz IS NULL OR d.created_at < $2)
ORDER BY d.created_at DESC
LIMIT $3;
```

Response format:
```json
{
  "data": [
    {
      "datasetId": "a1b2c3d4-...",
      "name": "Employee Directory Q1 2025",
      "description": "...",
      "format": "csv",
      "rowCount": 1000,
      "fileSizeBytes": 45678,
      "transactionCount": 3,
      "lastTransactionAt": "2025-03-15T10:30:00.000Z",
      "createdAt": "2025-03-14T08:00:00.000Z"
    }
  ],
  "nextPageToken": "MjAyNS0wMy0xNFQwODowMDowMC4wMDBa"
}
```

The `nextPageToken` must be a base64 encoding of the `created_at` timestamp of the last item in the current page. If there are no more results, `nextPageToken` must be `null`. To decode: `Buffer.from(token, 'base64').toString('utf8')` gives the ISO timestamp which is used as the `$2` parameter in the SQL query.

**Endpoint 2: `GET /api/v1/datasets/:datasetId`**

Returns full details of a single dataset, including its schema and all committed transactions.

Path parameters:
- `datasetId` (UUID): The ID of the dataset

If the dataset does not exist, return HTTP 404:
```json
{
  "error": "DATASET_NOT_FOUND",
  "message": "Dataset with ID 'a1b2c3d4-...' was not found."
}
```

Successful response (HTTP 200):
```json
{
  "dataset": {
    "datasetId": "a1b2c3d4-...",
    "name": "Employee Directory Q1 2025",
    "description": "All active employees as of March 2025",
    "format": "csv",
    "schema": [
      { "columnName": "emp_id", "detectedType": "string", "nullable": false },
      { "columnName": "full_name", "detectedType": "string", "nullable": false },
      { "columnName": "salary", "detectedType": "number", "nullable": true }
    ],
    "rowCount": 1000,
    "fileSizeBytes": 45678,
    "createdAt": "2025-03-14T08:00:00.000Z",
    "updatedAt": "2025-03-15T10:30:00.000Z"
  },
  "transactions": [
    {
      "transactionId": "f7g8h9i0-...",
      "type": "SNAPSHOT",
      "status": "committed",
      "rowCount": 1000,
      "fileSizeBytes": 45678,
      "committedAt": "2025-03-14T08:00:01.000Z"
    },
    {
      "transactionId": "k1l2m3n4-...",
      "type": "APPEND",
      "status": "committed",
      "rowCount": 50,
      "fileSizeBytes": 2340,
      "committedAt": "2025-03-15T10:30:01.000Z"
    }
  ],
  "backingObjectTypes": ["Employee"]
}
```

The `backingObjectTypes` array must be populated by querying the `backing_datasource` table: find all object types where `backing_datasource.dataset_id` matches this dataset's ID, and return their api_names. Legacy rows (where `dataset_id` is NULL and only `file_path` is set) are NOT included in this list — they are not linked to the new dataset model.

The `transactions` array must be ordered by `committed_at` descending (newest first), and must only include transactions with status = 'committed' (not 'open' or 'aborted').

**Endpoint 3: `DELETE /api/v1/datasets/:datasetId`**

Deletes a dataset and all its transactions and files. However, if the dataset is currently referenced as a backing datasource for any object type, the deletion must be REJECTED. This matches Palantir's behavior — you cannot delete a dataset that is actively backing an object type.

Check for active references:
```sql
SELECT COUNT(*) FROM backing_datasource WHERE dataset_id = $1;
```

If count > 0, return HTTP 409 (Conflict):
```json
{
  "error": "DATASET_IN_USE",
  "message": "Cannot delete dataset 'a1b2c3d4-...' because it is used as a backing datasource for object types: ['Employee']. Remove the backing datasource reference first."
}
```

If the dataset is not in use:
1. Delete all transaction records from `dataset_transaction`
2. Delete the dataset record from `dataset`
3. Delete all files from `/data/datasets/{datasetId}/` recursively using `fs.rmSync(path, { recursive: true, force: true })`
4. Return HTTP 204 (No Content) with empty body

### Validation Criteria
- GET /datasets returns paginated list sorted by newest first
- Pagination token correctly advances to the next page
- GET /datasets with an invalid (non-base64) pageToken returns HTTP 400 with a clear error message
- Search filter works case-insensitively
- GET /datasets/:id returns full details with transactions and backing object types
- GET /datasets/:id returns 404 for non-existent dataset
- GET /datasets/:id with a non-UUID string returns HTTP 400
- DELETE /datasets/:id returns 409 when dataset is referenced by an object type
- DELETE /datasets/:id successfully deletes dataset, transactions, and files when not in use
- DELETE /datasets/:id with a non-existent UUID returns HTTP 404
