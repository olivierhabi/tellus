# TASK 26: Create Integration Test — Basic Query Operations

**File to create:** `/tests/query-basic.test.js`

**Dependencies:** Tasks 10-14, 22-25 (all endpoints must be wired and functional).

**Purpose:** End-to-end tests that verify the query API works correctly when all services are wired together with real PostgreSQL and OpenSearch instances. These are NOT unit tests — they hit the actual running server with actual data.

**Shared test setup (also used by Tasks 27, 28, 29):**

Create a setup module at `/tests/fixtures/queryTestSetup.js` that exports `setupTestData()` and `teardownTestData()`. The setup must:

1. Create a test ontology named `"test-ontology"`.
2. Create an `Employee` object type with 8 properties:
   - `employeeId` (string) — primary key property
   - `fullName` (string) — title property
   - `email` (string)
   - `salary` (double)
   - `department` (string)
   - `startDate` (date)
   - `isActive` (boolean)
   - `skills` (string_array)
3. Create a `Company` object type with 2 properties (needed by Task 27):
   - `companyId` (string) — primary key property
   - `name` (string) — title property
4. Load exactly 100 Employee objects defined inline in the setup file as `TEST_EMPLOYEES`. The array must include these 5 specific employees (needed by Task 29):
   - `{ employeeId: "EMP-001", fullName: "Melissa Chang", email: "melissa.chang@acme.com", salary: 145000, department: "Engineering", startDate: "2021-03-15", isActive: true, skills: ["Python", "TypeScript", "SQL"] }`
   - `{ employeeId: "EMP-002", fullName: "Diego Rodriguez", email: "diego.rodriguez@acme.com", salary: 130000, department: "Sales", startDate: "2022-08-01", isActive: true, skills: ["Salesforce", "HubSpot"] }`
   - `{ employeeId: "EMP-003", fullName: "Akriti Patel", email: "akriti.patel@acme.com", salary: 155000, department: "Engineering", startDate: "2020-06-20", isActive: true, skills: ["Java", "Kubernetes"] }`
   - `{ employeeId: "EMP-004", fullName: "Michael O'Brien", email: "michael.obrien@acme.com", salary: 120000, department: "Marketing", startDate: "2023-01-10", isActive: false, skills: ["SEO", "Analytics"] }`
   - `{ employeeId: "EMP-005", fullName: "Jean-Pierre Habimana", email: "jp.habimana@acme.com", salary: 160000, department: "Finance", startDate: "2019-11-05", isActive: true, skills: ["Excel", "SAP"] }`
   - The remaining 95 employees (EMP-006 through EMP-100) must be generated with the following exact distribution:
     - **Departments:** 20 Engineering, 20 Sales, 20 Marketing, 20 Finance, 15 HR (totals including the 5 explicit employees: 22 Engineering, 21 Sales, 21 Marketing, 21 Finance, 15 HR = 100)
     - **Salaries:** evenly distributed between 50000-200000 (use `50000 + Math.round((i / 95) * 150000)` for employee index `i` from 0-94)
     - **isActive:** 80 true, 20 false total (including the 5 explicit employees: 4 active + 1 inactive, so generate 76 active and 19 inactive among the 95)
     - **startDates:** distributed across 2019-2024 (roughly 16 per year)
     - **email:** exactly 2 of the 95 generated employees must have `email: null` (use EMP-050 and EMP-075)
     - **skills:** each employee gets 1-3 skills from a rotating list
   - The `TEST_EMPLOYEES` array must be deterministic (no `Math.random()`) so that assertion counts are reproducible.
5. Index all 100 employees into OpenSearch index `ontology-employee`.
6. Index 0 Company objects (Company type exists but has no data — needed for Task 27 test 4).
7. Call `await opensearchClient.indices.refresh({ index: 'ontology-employee' })` to ensure data is searchable.

The teardown must delete the test ontology, object types, and OpenSearch indices.

**Test file structure:** Import `setupTestData` and `teardownTestData` from the shared fixture. Call setup in `beforeAll` and teardown in `afterAll`.

**Test cases (each as a separate test function):**

All list/get tests use `GET` requests. All search tests use `POST /api/v1/objects/Employee/search` with the filter in the request body.

1. `test_list_all_objects` — `GET /api/v1/objects/Employee` → returns exactly 100 objects (default pageSize is 100, matching the test data size)
2. `test_list_with_page_size` — `GET /api/v1/objects/Employee?$pageSize=10` → returns exactly 10 objects, `nextPageToken` is not null
3. `test_list_with_select` — `GET /api/v1/objects/Employee?$select=fullName,salary` → each object has only `__primaryKey`, `__objectType`, `fullName`, `salary`
4. `test_get_single_object` — `GET /api/v1/objects/Employee/EMP-001` → returns object with `fullName: "Melissa Chang"`, `salary: 145000`
5. `test_get_nonexistent_object` — `GET /api/v1/objects/Employee/FAKE-999` → 404 with `OBJECT_NOT_FOUND`
6. `test_search_eq_string` — search where `{ "type": "eq", "field": "department", "value": "Engineering" }` → returns only employees where `department === "Engineering"`, assert count matches test data
7. `test_search_eq_boolean` — search where `{ "type": "eq", "field": "isActive", "value": true }` → returns only employees where `isActive === true`
8. `test_search_gt_number` — search where `{ "type": "gt", "field": "salary", "value": 100000 }` → returns only employees where `salary > 100000`
9. `test_search_contains` — search where `{ "type": "contains", "field": "fullName", "value": "chang" }` → returns Melissa Chang. Note: the `contains` filter uses OpenSearch `match` query on the analyzed text field, which is case-insensitive and tokenized (NOT a substring search — it matches whole tokens)
10. `test_search_in` — search where `{ "type": "in", "field": "department", "value": ["Engineering", "Sales"] }` → returns employees in both departments
11. `test_search_isNull` — search where `{ "type": "isNull", "field": "email" }` → returns employees with null email (exactly 2 based on test data)
12. `test_search_and` — search where `{ "type": "and", "value": [{ "type": "eq", "field": "department", "value": "Engineering" }, { "type": "gt", "field": "salary", "value": 150000 }] }` → returns Engineering employees earning over 150K
13. `test_search_or` — search where `{ "type": "or", "value": [{ "type": "eq", "field": "department", "value": "Engineering" }, { "type": "eq", "field": "department", "value": "Sales" }] }` → returns both departments (same result as test 10)
14. `test_search_not` — search where `{ "type": "not", "value": [{ "type": "eq", "field": "isActive", "value": false }] }` → returns only active employees (excludes inactive ones)
15. `test_search_nested_compound` — search where `{ "type": "and", "value": [{ "type": "eq", "field": "department", "value": "Engineering" }, { "type": "or", "value": [{ "type": "gt", "field": "salary", "value": 150000 }, { "type": "and", "value": [{ "type": "eq", "field": "isActive", "value": true }, { "type": "gte", "field": "startDate", "value": "2023-01-01" }] }] }] }` → returns Engineering employees who either earn over 150K OR are active and started in 2023+. The test must compute the expected count programmatically from the `TEST_EMPLOYEES` array by applying the same filter logic in JavaScript, then assert `data.length` equals that computed count.

**Each test must assert:** correct HTTP status code (200 for success, 400/404 for errors), correct number of results in `data` array, correct property values on returned objects (spot-check at least one object per test).
