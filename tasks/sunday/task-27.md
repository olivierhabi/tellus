# TASK 27: End-to-End Test Suite — Complete System Verification

This task has four sub-tasks. Tests run in order (later tests depend on data created by earlier tests).

**Depends on:** ALL Tasks 1-26 must be complete before this test suite can pass.

## Objective
Create `/src/tests/e2e.test.js` with 30+ test cases that exercise the entire system end-to-end, from data upload through query, action, and Object View. This is the final validation that all 7 days of work function correctly together.

## Common Setup

Use the built-in `fetch` API (available in Node.js 18+) for all HTTP requests. Do not introduce additional dependencies.

Tests run in the order specified below. Each describe block depends on data created by previous tests. Implement a global `after()` hook that deletes all test data regardless of test outcomes (wrap cleanup in try/catch to ensure it runs even after failures).

Run with: `node --test src/tests/e2e.test.js`

The test file must start with a comment: `// Tests run in sequential order. Each describe block depends on data from previous blocks.`

## Sub-task 27A: E2E Tests — Ontology, Object Types, and Data Loading

**Describe Block: "Data Setup and Indexing"**

Test 1: "should create a fresh ontology"
- POST /api/v2/ontology with `{ "apiName": "E2ETest", "displayName": "E2E Test Ontology" }`
- Assert: HTTP 201, save ontologyId for subsequent tests

Test 2: "should create TestProduct object type"
- POST object type with properties: productId (string, PK), name (string, title), price (double), category (string), inStock (boolean)
- Assert: HTTP 201, 5 properties created

Test 3: "should create TestOrder object type"
- POST object type with properties: orderId (string, PK), productId (string), quantity (integer), total (double), orderDate (date)
- Assert: HTTP 201

Test 4: "should create TestCustomer object type"
- POST object type with properties: customerId (string, PK), name (string, title), email (string), signupDate (date), tier (string)
- Assert: HTTP 201

Test 5: "should upload and index 100 products"
- Upload CSV with 100 rows of known product data (use deterministic data: Product-001 through Product-100, prices from 10.00 to 1000.00, categories cycling through "electronics", "clothing", "food", "books")
- Trigger indexing
- Assert: 100 objects indexed

Test 6: "should upload and index 100 orders"
- Upload CSV with 100 rows, productId references products from Test 5
- Assert: 100 objects indexed

Test 7: "should upload and index 100 customers"
- Upload CSV with 100 rows, tiers cycling through "bronze", "silver", "gold"
- Assert: 100 objects indexed

---

## Sub-task 27B: E2E Tests — Search, Filter, and Aggregation

**Describe Block: "Search and Aggregation"**

Test 8: "should search with eq filter"
- POST search TestProduct where category eq "electronics"
- Assert: exactly 25 results (100 / 4 categories)

Test 9: "should search with gt filter"
- POST search TestProduct where price gt 500.0
- Assert: results returned, all have price > 500

Test 10: "should search with lt filter"
- POST search TestProduct where price lt 100.0
- Assert: results returned, all have price < 100

Test 11: "should search with contains filter"
- POST search TestProduct where name contains "Product-01"
- Assert: results include Product-010 through Product-019

Test 12: "should search with compound and/or filter"
- POST search TestProduct where (category eq "electronics" AND price gt 500) OR (category eq "food")
- Assert: results match the compound condition

Test 13: "should search with isNull filter"
- POST search TestCustomer where email isNull false
- Assert: all 100 customers returned (none have null email)

Test 14: "should search with in filter"
- POST search TestCustomer where tier in ["gold", "silver"]
- Assert: approximately 50 results (2/3 of 100)

Test 15: "should aggregate count"
- POST aggregate TestProduct with count
- Assert: totalCount === 100

Test 16: "should aggregate avg"
- POST aggregate TestProduct with avg(price)
- Assert: result is a number between 10 and 1000

Test 17: "should aggregate terms by category"
- POST aggregate TestProduct with terms(category)
- Assert: 4 buckets, each with count 25

Test 18: "should full-text search"
- POST full-text search TestProduct with query "Product-042"
- Assert: at least 1 result containing "Product-042"

---

## Sub-task 27C: E2E Tests — Links, Actions, and Audit

**Describe Block: "Links, Actions, and Audit"**

Test 19: "should create link types"
- Create ONE_TO_MANY link: TestCustomer → TestOrder (via TestOrder.customerId... Note: the test data should include a customerId field on TestOrder that references TestCustomer)
- Assert: HTTP 201

Test 20: "should traverse links (Search Around)"
- GET linked TestOrders for a specific TestCustomer
- Assert: results returned, all have the correct customerId

Test 21: "should create action types"
- Create action type "updatePrice" that modifies TestProduct.price
- Assert: HTTP 201

Test 22: "should execute a modify action"
- Execute updatePrice on Product-001, setting price to 999.99
- Assert: HTTP 200, action completed

Test 23: "should verify audit log entry"
- GET audit log entries
- Assert: the updatePrice action appears with correct details

Test 24: "should verify reindex preserves edits"
- Re-index TestProduct
- Search for Product-001
- Assert: price is still 999.99 (edit preserved)

---

## Sub-task 27D: E2E Tests — Interfaces, Object Views, Error Cases, and Cleanup

**Describe Block: "Interfaces, Object Views, and System"**

Test 25: "should create an interface"
- Create Interface "Purchasable" with property price (double, required)
- Assert: HTTP 201

Test 26: "should implement interface on object type"
- POST TestProduct implements Purchasable with mapping { price: "price" }
- Assert: HTTP 201

Test 27: "should polymorphic search across implementing types"
- POST /interfaces/Purchasable/search with price gt 500
- Assert: results returned with Interface property names

Test 28: "should return single Object View"
- GET /objects/TestProduct/Product-001/view
- Assert: HTTP 200, response contains properties, links, availableActions, interfaces sections

Test 29: "should return batch Object Views"
- POST batch view for Product-001, Product-002, Product-003
- Assert: HTTP 200, 3 objects returned

Test 30: "should return 404 for non-existent object"
- GET /objects/TestProduct/NONEXISTENT
- Assert: HTTP 404

Test 31: "should return 400 for invalid input"
- POST object type with invalid apiName "bad-name"
- Assert: HTTP 400

Test 32: "should health endpoint return healthy"
- GET /api/v2/health
- Assert: HTTP 200, status === "healthy"

Test 33: "should status endpoint return metrics"
- GET /api/v2/status
- Assert: HTTP 200, objectTypeCount >= 3

Test 34: "should clean up all test data"
- Delete all test Interfaces, Object Types, and the test Ontology
- Delete OpenSearch indexes for test object types
- Assert: GET /ontology/{testOntologyId} returns 404

## Verification
All 34 test cases pass. Zero failures. Zero skipped tests.
