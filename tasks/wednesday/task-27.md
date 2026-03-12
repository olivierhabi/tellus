# TASK 27: Create Integration Test — Pagination

**File to create:** `/tests/query-pagination.test.js`

**Dependencies:** Tasks 22-23 (list and search endpoints must be wired). Task 26 (shared test setup).

**Purpose:** Pagination is subtle and easy to get wrong. These tests verify that cursor-based pagination returns every object exactly once, in the correct order, with no gaps or duplicates.

**Setup:** Import `setupTestData` and `teardownTestData` from `/tests/fixtures/queryTestSetup.js` (created in Task 26). This provides 100 Employee objects and a Company object type with 0 objects.

**Test cases:**

All tests use `GET /api/v2/objects/Employee` unless otherwise noted.

1. `test_paginate_all_objects` — Request pages of 10 (`$pageSize=10`) until `nextPageToken` is null. Collect all objects across all pages. Verify: total objects collected = 100, all primary keys are unique (no duplicates), no objects are missing.

2. `test_paginate_with_sort` — Paginate with `$orderBy=salary:desc` and `$pageSize=10`. Verify: within each page, salaries are in descending order. Across pages, the last salary of page N is >= the first salary of page N+1. All 100 objects are returned.

3. `test_paginate_with_filter` — Use `POST /api/v2/objects/Employee/search` with `{ "where": { "type": "eq", "field": "department", "value": "Engineering" }, "$pageSize": 5 }`. Paginate through all pages. Verify: all pages contain only Engineering employees, every Engineering employee appears exactly once. Derive the expected Engineering employee count from `totalCount` in the first response, then verify that the total collected across all pages equals that count (should be 22 based on Task 26's test data distribution).

4. `test_page_token_wrong_object_type` — Paginate Employee with `$pageSize=10`, get the `nextPageToken` from the first page. Use that token on `GET /api/v2/objects/Company?$pageToken=<token>` → 400 with `INVALID_PAGE_TOKEN` because the token encodes the object type (as implemented by `paginationService` in Task 6) and it was created for Employee, not Company.

5. `test_page_token_invalid_string` — `GET /api/v2/objects/Employee?$pageToken=not-a-real-token` → 400 with `INVALID_PAGE_TOKEN`.

6. `test_single_page_result` — `POST /api/v2/objects/Employee/search` with `{ "where": { "type": "eq", "field": "employeeId", "value": "EMP-001" }, "$pageSize": 100 }` → returns 1 object, `nextPageToken` is null.

7. `test_empty_result` — `POST /api/v2/objects/Employee/search` with `{ "where": { "type": "eq", "field": "department", "value": "NonExistentDepartment" } }` → 200, `data` is empty array, `nextPageToken` is null, `totalCount` is 0.

**Each test must assert:** correct HTTP status code (200 for success, 400 for error), correct `nextPageToken` presence/absence, correct `totalCount`, and for pagination traversal tests, all objects collected exactly once.
