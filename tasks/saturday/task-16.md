## TASK 16: Build the Data Preview Endpoint

### Context
Before mapping a dataset to an object type, users need to see what's in the dataset — the raw data, column names, and sample values. In Palantir Foundry, the Dataset Preview application shows a tabular view of the data with column types and statistics. Our API equivalent provides a preview endpoint that returns the first N rows of a dataset along with column statistics.

This is particularly important for the RRA use case because tax data often contains unexpected formatting, missing values, and encoding issues. A preview lets the user spot problems before they cause indexing failures.

### Exact Specification

Add the following endpoint to `/src/routes/datasets.js` (or create a supporting service function in `/src/services/previewService.js`):

**Endpoint: `GET /api/v2/datasets/:datasetId/preview`**

Query parameters:
- `rows` (integer, default: 50, max: 500): Number of rows to preview
- `transactionId` (UUID, optional): Preview data from a specific transaction only. If omitted, preview the merged view of all committed transactions (same merge logic as the reindex engine — most recent transaction wins for duplicate PKs).

**Processing:**

Step 1: Load the dataset and its committed transactions from PostgreSQL.

Step 2: If `transactionId` is specified, read only that transaction's file. If not, read and merge all committed transaction files using the same logic as the reindex engine (Task 7), but WITHOUT the edit overlay (this shows pure datasource data, not Ontology state).

Step 3: Take the first `rows` rows from the merged result.

Step 4: For each column, compute basic statistics from ALL rows (not just the preview subset):
- `nullCount`: Number of null/empty values
- `uniqueCount`: Number of distinct non-null values (capped at 1000 for performance). When distinct non-null values exceed 1000, return `uniqueCount: 1000` and add `uniqueCountCapped: true` to the statistics object. When under 1000, `uniqueCountCapped` is `false`.
- `sampleValues`: Up to 5 unique non-null values
- `minValue` / `maxValue`: For columns where the `detectedType` from the dataset's `schema_definition` is `"integer"`, `"number"`, `"date"`, or `"timestamp"`
- `avgValue`: For columns where the `detectedType` is `"integer"` or `"number"`

Response:
```json
{
  "datasetId": "...",
  "datasetName": "Employee Directory Q1 2025",
  "format": "csv",
  "totalRows": 1000,
  "previewRows": 50,
  "columns": [
    {
      "columnName": "emp_id",
      "detectedType": "string",
      "nullable": false,
      "statistics": {
        "nullCount": 0,
        "uniqueCount": 1000,
        "sampleValues": ["EMP-001", "EMP-002", "EMP-003", "EMP-004", "EMP-005"]
      }
    },
    {
      "columnName": "annual_salary",
      "detectedType": "number",
      "nullable": true,
      "statistics": {
        "nullCount": 12,
        "uniqueCount": 450,
        "minValue": 45000,
        "maxValue": 350000,
        "avgValue": 125340.50,
        "sampleValues": [120000, 95000, 145000, 88000, 210000]
      }
    }
  ],
  "rows": [
    { "emp_id": "EMP-001", "full_name": "Alice Smith", "annual_salary": "120000", "start_date": "2020-01-15" },
    { "emp_id": "EMP-002", "full_name": "Bob Jones", "annual_salary": "95000", "start_date": "2019-06-01" }
  ]
}
```

Note: The `rows` array contains raw string values (as they appear in the CSV), NOT type-converted values. This lets the user see exactly what the file contains, including any formatting issues.

**Error responses:**
- If `datasetId` does not exist, return HTTP 404: `{ "error": "DATASET_NOT_FOUND", "message": "Dataset with ID '...' was not found." }`
- If `transactionId` is specified but does not belong to this dataset, return HTTP 400: `{ "error": "TRANSACTION_NOT_FOUND", "message": "Transaction '...' does not belong to dataset '...'." }`
- If `rows` exceeds 500 or is not a positive integer, return HTTP 400: `{ "error": "INVALID_ROWS_PARAMETER", "message": "The 'rows' parameter must be a positive integer between 1 and 500. Received: '...'." }`

### Validation Criteria
- Preview with default parameters returns 50 rows
- Preview with rows=10 returns exactly 10 rows
- Preview of a specific transaction shows only that transaction's data
- Column statistics are computed from ALL rows, not just the preview subset
- Null counts are accurate
- Numeric min/max/avg are accurate
- Preview of merged multi-transaction dataset shows the correct merged view (most recent transaction wins for duplicate PKs)
- Large dataset (10K+ rows) preview responds within 5 seconds
- Non-existent datasetId returns 404
- Invalid transactionId returns 400
- rows > 500 returns 400
