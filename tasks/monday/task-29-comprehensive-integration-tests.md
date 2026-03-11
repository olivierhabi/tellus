# TASK 29 OF 30: Comprehensive Integration Tests

**Objective:** Create a standalone test script (no test framework) that exercises the core API endpoints in sequence, verifying the complete system works end-to-end. The script uses plain Node.js with the built-in `assert` module and the `fetch` API (Node.js 18+).

**Step-by-step instructions:**

Create tests/day1.test.js. The script assumes the server is already running on `http://localhost:3000` (start it separately with `npm run dev`).

**Test configuration:**
```javascript
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
```

**Test sequence (24 tests, executed in order):**

Each test is a separate async function. Tests are numbered and depend on state from previous tests (e.g., Test 2 creates an ontology, Test 3 uses its ID).

1. **Health check:** `GET /health` → assert status 200, assert body has `status: "healthy"`.
2. **Create ontology:** `POST /api/v2/ontologies` with `{"displayName": "Test Ontology", "description": "Integration test ontology"}` → assert status 201, assert body has `ontologyId` (UUID), store `ontologyId` for later tests.
3. **Duplicate ontology fails:** `POST /api/v2/ontologies` with same displayName → assert status 409, assert body.error.code === "ONTOLOGY_ALREADY_EXISTS".
4. **List ontologies:** `GET /api/v2/ontologies` → assert status 200, assert body.data is array with length >= 1.
5. **Get ontology by ID:** `GET /api/v2/ontologies/{ontologyId}` → assert status 200, assert body.displayName === "Test Ontology".
6. **Batch create object type:** `POST /api/v2/ontologies/{ontologyId}/objectTypes/batch` with body:
   ```json
   {
     "apiName": "Employee",
     "displayName": "Employee",
     "properties": [
       {"apiName": "employeeId", "displayName": "Employee ID", "baseType": "string", "isRequired": true},
       {"apiName": "fullName", "displayName": "Full Name", "baseType": "string", "isRequired": true},
       {"apiName": "department", "displayName": "Department", "baseType": "string"},
       {"apiName": "salary", "displayName": "Salary", "baseType": "double"},
       {"apiName": "startDate", "displayName": "Start Date", "baseType": "date"},
       {"apiName": "isActive", "displayName": "Is Active", "baseType": "boolean"}
     ],
     "primaryKeyProperty": "employeeId",
     "titleProperty": "fullName"
   }
   ```
   → assert status 201, assert response has 6 properties.
7. **Duplicate object type fails:** `POST` same batch body → assert status 409.
8. **List object types:** `GET .../objectTypes` → assert status 200, assert body.data.length === 1.
9. **Get object type:** `GET .../objectTypes/Employee` → assert status 200, assert properties has 6 entries.
10. **Add a property:** `POST .../objectTypes/Employee/properties` with `{"apiName": "email", "displayName": "Email", "baseType": "string"}` → assert status 201.
11. **Invalid baseType fails:** `POST .../objectTypes/Employee/properties` with `{"apiName": "bad", "displayName": "Bad", "baseType": "invalid"}` → assert status 400.
12. **Set primary key:** Already set during batch create. Verify: `GET .../objectTypes/Employee` → assert primaryKey === "employeeId".
13. **Set title property:** Already set during batch create. Verify: `GET .../objectTypes/Employee` → assert titleProperty === "fullName".
14. **Create test CSV:** Write a CSV file to `/tmp/test-employees.csv` with 50 rows of employee data. Columns: `emp_id`, `full_name`, `dept`, `salary`, `start_date`, `is_active`, `email`. Generate simple test data (e.g., `emp_id` = "E001"–"E050", `full_name` = "Test Employee 1"–"Test Employee 50", `salary` = random integer 30000–100000, `start_date` = "2024-01-15", `is_active` = "true"/"false", `dept` = "Engineering"/"Sales"/"HR", `email` = "emp1@test.com"–"emp50@test.com").
15. **Register backing datasource:** `POST .../objectTypes/Employee/datasource` with:
    ```json
    {
      "datasetName": "Employee Dataset",
      "filePath": "/tmp/test-employees.csv",
      "fileFormat": "csv",
      "columnMapping": {
        "employeeId": "emp_id",
        "fullName": "full_name",
        "department": "dept",
        "salary": "salary",
        "startDate": "start_date",
        "isActive": "is_active",
        "email": "email"
      }
    }
    ```
    → assert status 201, assert body has rowCount === 50.
16. **Duplicate datasource fails:** `POST` same body → assert status 409.
17. **Scan datasource:** `POST .../objectTypes/Employee/datasource/scan` → assert status 200.
18. **Get statistics:** `GET .../objectTypes/Employee/statistics` → assert status 200, assert body.statistics.propertyCount === 7.
19. **Export ontology:** `GET /api/v2/ontologies/{ontologyId}/export` → assert status 200, assert body.ontology.objectTypes is array with length 1.
20. **Delete non-PK property:** `DELETE .../objectTypes/Employee/properties/email` → assert status 204.
21. **Delete PK property fails:** `DELETE .../objectTypes/Employee/properties/employeeId` → assert status 400.
22. **Update object type:** `PUT .../objectTypes/Employee` with `{"displayName": "Updated Employee"}` → assert status 200, assert body.displayName === "Updated Employee".
23. **Delete object type:** `DELETE .../objectTypes/Employee` → assert status 204. Verify cascade: `GET .../objectTypes/Employee` → assert status 404.
24. **Import from export:** `POST /api/v2/ontologies/import` with the JSON from test 19 → assert status 201.

**Output format:**

Each test prints one line:
- Pass: `"  PASS  Test {n}: {description}"`
- Fail: `"  FAIL  Test {n}: {description} — {error message}"`

At the end, print summary: `"\n{passed}/{total} tests passed, {failed} failed"`.

Exit with code 0 if all tests pass, code 1 if any fail.

**Files to create:** tests/day1.test.js

**Verification:**
- `npm test` runs all 24 tests
- All 24 tests pass when run against a freshly migrated and seeded database
- Exit code is 0 on all pass, 1 on any failure
- Each test outputs a clear PASS/FAIL line
