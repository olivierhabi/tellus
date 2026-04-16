## TASK 22: Build Integration Test — Dataset Transaction Versioning

### Context
This test verifies that the dataset transaction model works correctly — that datasets maintain full history across SNAPSHOT and APPEND transactions, that the preview endpoint shows the correct data for each transaction, and that the dataset detail endpoint accurately reports transaction counts and sizes.

### Exact Specification

Create `/tests/integration/test06_dataset_versioning.js`:

**Setup:** This test must be self-contained. No prior test data is needed.

Generate a test CSV for products with the following columns:
- `product_id` (string, PK): "PROD-" + zero-padded 3-digit number (PROD-001 through PROD-100)
- `product_name` (string): Generated product names (e.g., "Product 001")
- `price` (number): Deterministic — use formula `(index * 5.00) + 10.00` (range 15.00 to 510.00)
- `category` (string): Cycle through ["Electronics", "Clothing", "Food", "Office", "Tools"]

The primary key column is `product_id`. The preview endpoint resolves duplicates using this column as the primary key.

**Test sequence:**

Test 6.1: Upload initial dataset with 100 rows
```
POST /api/v1/datasets/upload (multipart form)
File: products_100.csv (generated with columns above)
Name: "Versioning Test Products"
Assert: dataset.rowCount === 100
Assert: transaction.type === "SNAPSHOT"
Assert: transaction.status === "committed"
Store: datasetId, txn1Id
```

Test 6.2: Verify dataset detail shows 1 transaction
```
GET /api/v1/datasets/{datasetId}
Assert: transactions.length === 1
Assert: transactions[0].type === "SNAPSHOT"
Assert: transactions[0].rowCount === 100
```

Test 6.3: Preview initial data
```
GET /api/v1/datasets/{datasetId}/preview?rows=5
Assert: rows.length === 5
Assert: columns match the CSV headers
Assert: totalRows === 100
```

Test 6.4: Append 50 new rows
```
Generate CSV with 50 rows: PROD-101 to PROD-150

POST /api/v1/datasets/{datasetId}/transactions (multipart form)
File: products_append_50.csv
type: "APPEND"
Assert: transaction.type === "APPEND"
Assert: transaction.status === "committed"
Assert: dataset.totalRowCount === 150
Store: txn2Id
```

Test 6.5: Verify dataset now has 2 transactions
```
GET /api/v1/datasets/{datasetId}
Assert: transactions.length === 2
Assert: transactions are sorted newest-first
```

Test 6.6: Preview specific transaction (initial SNAPSHOT)
```
GET /api/v1/datasets/{datasetId}/preview?transactionId={txn1Id}&rows=200
Assert: rows.length === 100 (all rows from initial upload)
Assert: No products from the append appear
```

Test 6.7: Preview specific transaction (APPEND)
```
GET /api/v1/datasets/{datasetId}/preview?transactionId={txn2Id}&rows=200
Assert: rows.length === 50 (only rows from the append)
```

Test 6.8: Preview merged view (no transaction specified)
```
GET /api/v1/datasets/{datasetId}/preview?rows=200
Assert: rows.length === 150 (merged SNAPSHOT + APPEND)
```

Test 6.9: Append with overlapping PKs
```
Create CSV with 10 rows: PROD-001 through PROD-010 with price = 777.77 (sentinel value)

POST /api/v1/datasets/{datasetId}/transactions (multipart form)
File: products_overlap.csv
type: "APPEND"
Assert: dataset.totalRowCount === 160 (150 + 10, NOT deduplicated at dataset level)
```

Test 6.10: Preview merged view shows deduplicated data
```
GET /api/v1/datasets/{datasetId}/preview?rows=200
Assert: Only one row per PK — PROD-001 appears once, with price === "777.77" (the sentinel value from the latest APPEND, not the original price)
Assert: Total unique rows === 150 (100 original + 50 appended - 10 deduplicated overlap = 150 unique PKs, but presented as 150 rows in preview)

Note: Deduplication in preview uses the `product_id` column as the primary key, with "most recent transaction wins" logic (same as reindex engine).
```

Test 6.11: Upload a new SNAPSHOT (full replacement)
```
Generate CSV with 25 rows: PROD-201 to PROD-225

POST /api/v1/datasets/{datasetId}/transactions (multipart form)
File: products_snapshot_25.csv
type: "SNAPSHOT"
Assert: status 201, transaction.type === "SNAPSHOT"
```

Test 6.12: Verify SNAPSHOT replaces row count
```
GET /api/v1/datasets/{datasetId}
Assert: dataset.rowCount === 25 (SNAPSHOT replaced everything)
Assert: transactions.length === 4 (all transactions preserved in history)
```

Test 6.13: Preview merged view after SNAPSHOT
```
GET /api/v1/datasets/{datasetId}/preview?rows=100
Assert: rows.length === 25 (only SNAPSHOT data — previous transactions are superseded)
```

**Cleanup:**
After tests complete (pass or fail), delete all test data.

### Validation Criteria
- Transaction history preserves ALL transactions (never deleted)
- APPEND increments total row count
- SNAPSHOT replaces total row count
- Preview of specific transaction shows only that transaction's data
- Preview of merged view applies "most recent transaction wins" deduplication using `product_id` as PK
- SNAPSHOT supersedes all previous transactions in the merged view
- Overlapping PK prices use deterministic sentinel value (777.77) for reliable assertions
