## TASK 19: Build Integration Test — Multi-Transaction Dataset (Append and Merge)

### Context
This test verifies that the multi-transaction merge logic works correctly. It uploads an initial dataset, appends new data, and verifies that the reindex engine correctly merges all transactions — with the "most recent transaction wins" behavior for duplicate primary keys.

### Exact Specification

Create `/tests/integration/test03_multi_transaction.js`:

**Test sequence:**

**Setup:** This test must be self-contained. Create its own ontology (name: "Multi-Transaction Test") and Product object type.

Test 3.1: Create ontology and Product object type
```
POST /api/v1/ontology
Body: { "displayName": "Multi-Transaction Test", "description": "Test ontology for multi-transaction merge" }
Assert: status 201

POST /api/v1/ontology/{ontologyId}/objectTypes
Body: {
  "apiName": "Product",
  "displayName": "Product",
  "properties": [
    { "apiName": "productId", "displayName": "Product ID", "baseType": "string", "isRequired": true },
    { "apiName": "productName", "displayName": "Product Name", "baseType": "string", "isRequired": true },
    { "apiName": "price", "displayName": "Price", "baseType": "double" },
    { "apiName": "category", "displayName": "Category", "baseType": "string" },
    { "apiName": "inStock", "displayName": "In Stock", "baseType": "boolean" }
  ],
  "primaryKey": "productId",
  "titleProperty": "productName"
}
Assert: status 201
```

Test 3.2: Upload initial dataset with 100 products
```
Generate CSV programmatically with columns: product_id, product_name, price, category, in_stock
- product_id: "PROD-" + zero-padded 3-digit number (PROD-001 through PROD-100)
- product_name: Generated product names (e.g., "Widget A", "Gadget B")
- price: Deterministic prices — use formula: (index * 4.99) + 10.00 (range 14.99 to 509.00)
- category: Cycle through ["Electronics", "Clothing", "Food", "Tools", "Books"]
- in_stock: Alternate "true"/"false" (80% true)

POST /api/v1/datasets/upload (multipart form)
File: products_100.csv
Name: "Product Catalog Test"
Assert: status 201, dataset.rowCount === 100
Store: datasetId
```

Test 3.3: Register datasource and reindex
```
Assert: 100 objects indexed
```

Test 3.4: Record original prices of PROD-001 and PROD-050
```
GET /api/v1/objects/Product/PROD-050
Store: originalPrice050 = response.price
GET /api/v1/objects/Product/PROD-001
Store: originalPrice001 = response.price
```

Test 3.5: Append a new transaction with 20 rows
```
Generate CSV with 20 rows:
- 10 NEW products: PROD-101 through PROD-110 (prices: 999.99 each — outside original range to make assertions deterministic)
- 10 UPDATED products: PROD-041 through PROD-050 with price = 888.88 (a sentinel value that cannot appear in the original data)

POST /api/v1/datasets/{datasetId}/transactions (multipart form)
File: products_append.csv
type: "APPEND"
Assert: status 201, transaction.type === "APPEND", transaction.rowCount === 20
```

Test 3.6: Reindex
```
Assert: totalObjectsIndexed === 110 (100 original + 10 new)
NOT 120 — because 10 of the appended rows have the same PKs as existing rows
```

Test 3.7: Verify new products exist
```
GET /api/v1/objects/Product/PROD-101
Assert: status 200
```

Test 3.8: Verify updated products have NEW values (most recent transaction wins)
```
GET /api/v1/objects/Product/PROD-050
Assert: price === 888.88 (the sentinel value from the APPEND, NOT originalPrice050)
Assert: price !== originalPrice050
```

Test 3.9: Verify original-only products are unchanged
```
GET /api/v1/objects/Product/PROD-001
Assert: price === originalPrice001 (stored in Test 3.4, untouched by append)
```

Test 3.10: Append a THIRD transaction with a delete marker
```
Generate CSV with 1 row: PROD-001 with an is_deleted column set to "true"
Columns: product_id, product_name, price, category, in_stock, is_deleted
Row: "PROD-001", "Widget A", 14.99, "Electronics", "true", "true"

POST /api/v1/datasets/{datasetId}/transactions (multipart form)
File: products_delete.csv
type: "APPEND"
Assert: status 201

Note: The reindex engine (Task 7) MUST already handle the is_deleted column.
During the merge in Step 3 of the reindex engine, after setting a row in the objectMap,
check if the row has an `is_deleted` column mapped and its value is truthy ("true", "1", true).
If so, call `objectMap.delete(pkStr)` to remove the object.
This is_deleted handling MUST be added to the reindex engine as part of this task if not already present.
```

Test 3.11: Reindex and verify PROD-001 is removed
```
GET /api/v1/objects/Product/PROD-001
Assert: status 404 (deleted via is_deleted marker in dataset)
Assert: totalObjectsIndexed === 109
```

Test 3.12: Upload a SNAPSHOT transaction (full replacement)
```
Generate CSV with 50 rows: PROD-201 through PROD-250 with new product data
Columns: product_id, product_name, price, category, in_stock

POST /api/v1/datasets/{datasetId}/transactions (multipart form)
File: products_snapshot.csv
type: "SNAPSHOT"
Assert: status 201, transaction.type === "SNAPSHOT"
```

Test 3.13: Reindex and verify complete replacement
```
Assert: totalObjectsIndexed === 50 (SNAPSHOT replaces everything)
GET /api/v1/objects/Product/PROD-050
Assert: status 404 (no longer exists — replaced by SNAPSHOT)
GET /api/v1/objects/Product/PROD-201
Assert: status 200 (new product from SNAPSHOT)
```

**Summary:** Tests 3.8 and 3.13 are the critical ones — they verify "most recent transaction wins" and SNAPSHOT replacement respectively.

**Cleanup:**
After tests complete (pass or fail), delete all test data in the same order as Task 17's cleanup.

### Validation Criteria
- Append adds new rows and updates existing rows (by PK)
- Duplicate PKs across transactions: latest transaction value is used
- Total object count reflects deduplicated PKs (no double-counting)
- SNAPSHOT transaction replaces all previous data
- is_deleted marker removes objects during reindex
- All prices use deterministic sentinel values (888.88, 999.99) to guarantee assertions pass
