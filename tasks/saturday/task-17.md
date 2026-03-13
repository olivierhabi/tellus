## TASK 17: Build Integration Test — Full Upload-to-Query Pipeline

### Context
This is the first of our integration tests. It tests the complete pipeline from file upload to Ontology query, verifying that every component works together correctly. This test must be runnable as a standalone script that sets up test data, exercises the APIs, and validates the results.

### Exact Specification

Create a file at `/tests/integration/test01_upload_to_query.js` that:

**Setup:**
1. Create a test CSV file at `/tests/fixtures/employees_1000.csv` with exactly 1000 rows of employee data. Generate this data programmatically with these columns:
   - `emp_id`: "EMP-" + zero-padded 4-digit number (EMP-0001 through EMP-1000)
   - `full_name`: Generated from arrays of first names and last names (at least 50 of each to ensure variety)
   - `email`: `{firstname}.{lastname}@example.com` (lowercase)
   - `department`: Randomly chosen from ["Engineering", "Sales", "Marketing", "Finance", "HR", "Operations", "Legal", "Support"]
   - `annual_salary`: Random integer between 45000 and 350000
   - `start_date`: Random date between 2015-01-01 and 2025-01-01 in YYYY-MM-DD format
   - `is_active`: Randomly "true" or "false" (80% true, 20% false)
   - `skills`: Pipe-separated list of 1-4 random skills from ["python", "java", "sql", "react", "kubernetes", "ml", "analytics", "management", "sales", "finance"]
   - `office_location`: Randomly chosen from ["-1.9403,30.0587", "-1.9536,30.0606", "-1.9441,30.0619", "-2.3496,29.2494", "-2.5967,29.5724"] (Rwanda coordinates: Kigali, Huye, Rubavu)
   - `company_id`: Randomly chosen from ["COMP-001", "COMP-002", "COMP-003", "COMP-004", "COMP-005"]

2. Also create `/tests/fixtures/companies_5.csv` with 5 company rows. Note: this companies CSV is generated here as a shared fixture for Task 20 (link traversal test) but is NOT used in this test's assertions:
   - `company_id`: COMP-001 through COMP-005
   - `company_name`: ["Rwanda Revenue Authority", "Bank of Kigali", "MTN Rwanda", "Airtel Rwanda", "BPR Bank"]
   - `sector`: ["Government", "Banking", "Telecom", "Telecom", "Banking"]
   - `registration_date`: Various dates

**Test Sequence (each step must pass before the next):**

Test 1.1: Create ontology
```
POST /api/v2/ontology
Body: { "displayName": "RRA Tax System", "description": "Test ontology for integration tests" }
Assert: status 201, ontologyId is returned
```

Test 1.2: Create Employee object type with 10 properties
```
POST /api/v2/ontology/{ontologyId}/objectTypes
Body: {
  "apiName": "Employee",
  "displayName": "Employee",
  "properties": [
    { "apiName": "employeeId", "displayName": "Employee ID", "baseType": "string", "isRequired": true },
    { "apiName": "fullName", "displayName": "Full Name", "baseType": "string", "isRequired": true },
    { "apiName": "email", "displayName": "Email", "baseType": "string" },
    { "apiName": "department", "displayName": "Department", "baseType": "string" },
    { "apiName": "salary", "displayName": "Annual Salary", "baseType": "double" },
    { "apiName": "startDate", "displayName": "Start Date", "baseType": "date" },
    { "apiName": "isActive", "displayName": "Is Active", "baseType": "boolean" },
    { "apiName": "skills", "displayName": "Skills", "baseType": "string_array" },
    { "apiName": "officeLocation", "displayName": "Office Location", "baseType": "geopoint" },
    { "apiName": "companyId", "displayName": "Company ID", "baseType": "string" }
  ],
  "primaryKey": "employeeId",
  "titleProperty": "fullName"
}
Assert: status 201
```

Test 1.3: Upload employee CSV
```
POST /api/v2/datasets/upload (multipart form)
File: employees_1000.csv
Name: "Employee Directory Test"
Assert: status 201, dataset.rowCount === 1000
```

Test 1.4: Register backing datasource
```
POST /api/v2/ontology/{ontologyId}/objectTypes/Employee/datasource
Body: {
  "datasetId": "{datasetId from 1.3}",
  "columnMapping": {
    "employeeId": "emp_id",
    "fullName": "full_name",
    "email": "email",
    "department": "department",
    "salary": "annual_salary",
    "startDate": "start_date",
    "isActive": "is_active",
    "skills": "skills",
    "officeLocation": "office_location",
    "companyId": "company_id"
  },
  "primaryKeyColumn": "emp_id"
}
Assert: status 200
```

Test 1.5: Trigger reindex
```
POST /api/v2/ontology/{ontologyId}/objectTypes/Employee/reindex
Assert: status 200, result.totalObjectsIndexed === 1000
```

Test 1.6: Query all employees — verify count
```
GET /api/v2/objects/Employee?$pageSize=1
Assert: totalCount === 1000
```

Test 1.7: Get single employee by PK
```
GET /api/v2/objects/Employee/EMP-0001
Assert: status 200, __primaryKey === "EMP-0001", all properties present
```

Test 1.8: Search with filter
```
POST /api/v2/objects/Employee/search
Body: { "where": { "type": "eq", "field": "department", "value": "Engineering" } }
Assert: status 200, all returned objects have department === "Engineering"
Assert: totalCount > 0 and totalCount < 1000
```

Test 1.9: Search with compound filter
```
POST /api/v2/objects/Employee/search
Body: {
  "where": {
    "type": "and",
    "value": [
      { "type": "eq", "field": "department", "value": "Engineering" },
      { "type": "gt", "field": "salary", "value": 100000 },
      { "type": "eq", "field": "isActive", "value": true }
    ]
  }
}
Assert: all returned objects match ALL three conditions
```

Test 1.10: Aggregate
```
POST /api/v2/objects/Employee/aggregate
Body: {
  "aggregations": [
    { "type": "count", "name": "total" },
    { "type": "avg", "field": "salary", "name": "avgSalary" },
    { "type": "terms", "field": "department", "name": "byDept", "size": 10 }
  ]
}
Assert: total === 1000
Assert: avgSalary is a number between 45000 and 350000
Assert: byDept is an array with department names and counts that sum to 1000
```

Test 1.11: Full-text search
```
POST /api/v2/objects/Employee/searchFullText
Body: { "query": "Engineering python", "$pageSize": 10 }
Assert: status 200, response.data is an array with length <= 10, response.data is an array (may be empty if no objects match — full-text relevance depends on OpenSearch analyzer configuration)
```

**Reporting:**

After all tests run, print a summary:
```
=== Integration Test: Upload to Query Pipeline ===
Test 1.1  Create ontology:           PASS (45ms)
Test 1.2  Create object type:        PASS (120ms)
Test 1.3  Upload CSV:                PASS (890ms)
Test 1.4  Register datasource:       PASS (35ms)
Test 1.5  Reindex:                   PASS (1250ms)
Test 1.6  Query count:               PASS (80ms)
Test 1.7  Get by PK:                 PASS (25ms)
Test 1.8  Filter search:             PASS (45ms)
Test 1.9  Compound filter:           PASS (52ms)
Test 1.10 Aggregation:               PASS (65ms)
Test 1.11 Full-text search:          PASS (38ms)

11/11 tests passed. Total time: 2645ms
```

If any test fails, print the expected value, actual value, and the full API response body for debugging.

**Cleanup:**

After tests complete (pass or fail), delete all test data:
- Delete the OpenSearch index (e.g., `ontology-employee`)
- Delete the dataset files from disk (e.g., `rm -rf /data/datasets/{datasetId}/`)
- Delete all database records in this exact order (to respect foreign keys): `ontology_edit`, `action_audit_log`, `reindex_history`, `funnel_state`, `backing_datasource`, `dataset_transaction`, `dataset`, `property`, `link_type`, `action_type`, `object_type`, `ontology`

**Test runner:** This test must be runnable via `node tests/integration/test01_upload_to_query.js` without any test framework dependency. Use Node.js built-in `assert` module for assertions.

### Validation Criteria
- All 11 tests pass when run against a clean database
- The test is idempotent — can be run multiple times without leaving stale data
- The test completes in under 30 seconds total
- Failed tests show clear diagnostic information
