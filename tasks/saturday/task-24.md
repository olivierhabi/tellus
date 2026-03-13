## TASK 24: Build Integration Test — Error Handling and Edge Cases

### Context
This test systematically exercises error cases to ensure the system fails gracefully with clear error messages. Government systems must never crash silently or return cryptic errors — operators need to understand what went wrong and how to fix it.

### Exact Specification

Create `/tests/integration/test08_error_handling.js`:

**Test sequence:**

Test 8.1: Create object type with duplicate api_name
```
Create "Employee" object type, then try to create another "Employee"
Assert: status 409, error.code === "DUPLICATE_API_NAME"
```

Test 8.2: Register backing datasource with non-existent dataset
```
POST datasource with datasetId that doesn't exist
Assert: status 404, error.code === "DATASET_NOT_FOUND"
```

Test 8.3: Register backing datasource with misspelled column
```
columnMapping: { "employeeId": "emp_iddd" } (typo)
Assert: status 400, error.code === "COLUMN_NOT_FOUND"
Assert: error.message identifies the misspelled column 'emp_iddd' and suggests available columns
Note: This test depends on the fuzzy "Did you mean" suggestion feature implemented in Task 6's backing datasource registration endpoint (Levenshtein edit distance <= 2). If the feature exists, assert: error.message includes "Did you mean 'emp_id'?"
```

Test 8.4: Reindex with null values in required properties
```
Upload CSV where some rows have empty primary key
Register as datasource, attempt reindex
Assert: status 500, error mentions null primary key or required property
Note: This returns 500 (not 400) because the reindex is a server-side process — the client triggered a valid reindex request, but the internal processing discovered data quality issues. The 500 indicates "reindex failed" at the server level.
```

Test 8.5: Reindex with duplicate PKs in single transaction
```
Upload CSV where two rows have the same emp_id
Attempt reindex
Assert: status 500, error mentions duplicate primary key within transaction
Note: Same rationale as 8.4 — this is a server-side processing error during reindex, not a client input error.
```

Test 8.6: Execute action with missing required parameter
```
POST action/apply with missing "employeeRef" parameter
Assert: status 400, error.code === "MISSING_REQUIRED_PARAMETER"
Assert: error.message identifies which parameter is missing
```

Test 8.7: Execute action with wrong parameter type
```
POST action/apply with "newSalary": "not-a-number"
Assert: status 400, error.code === "INVALID_PARAMETER_TYPE"
```

Test 8.8: Execute action targeting non-existent object
```
POST action/apply with employeeRef: "DOES-NOT-EXIST"
Assert: status 404, error.code === "OBJECT_NOT_FOUND"
```

Test 8.9: Delete dataset that is backing an object type
```
DELETE /api/v2/datasets/{datasetId} where dataset backs Employee
Assert: status 409, error.code === "DATASET_IN_USE"
Assert: error.message mentions which object type is using it
```

Test 8.10: Upload invalid CSV file
```
Upload a file that is not valid CSV (e.g., random binary data with .csv extension)
Assert: status 400, error.code includes "PARSE" or "FORMAT"
```

Test 8.11: Upload CSV with no header row
```
Upload CSV where first row is all numeric values (e.g., "100,200,300,400")
Assert: status 400, error.code === "INVALID_CSV_FORMAT" or "MISSING_HEADERS"
Assert: error.message mentions that the first row must contain column names
```

Test 8.12: Append JSON file to CSV dataset
```
Upload a .json file to a dataset that was created with .csv
Assert: status 400, error.code === "FORMAT_MISMATCH"
```

Test 8.13: Query non-existent object type
```
GET /api/v2/objects/NonExistentType
Assert: status 404, error.code === "OBJECT_TYPE_NOT_FOUND"
```

Test 8.14: Search with invalid filter operator
```
POST /api/v2/objects/Employee/search
Body: { "where": { "type": "INVALID_OPERATOR", "field": "salary", "value": 100 } }
Assert: status 400, error.code === "INVALID_FILTER_OPERATOR"
```

Test 8.15: Aggregate with non-numeric field for avg
```
POST /api/v2/objects/Employee/aggregate
Body: { "aggregations": [{ "type": "avg", "field": "fullName", "name": "test" }] }
Assert: status 400, error.code === "INVALID_AGGREGATION_TYPE"
Assert: error.message indicates that 'avg' requires a numeric field
Assert: server does NOT crash (response is valid JSON)
```

### Validation Criteria
- Every error case returns an appropriate HTTP status code (400, 404, 409, 500)
- Every error response has an error.code and error.message
- Error messages are human-readable and describe how to fix the problem
- No error case crashes the server (all caught and handled)
- No error case leaves the system in an inconsistent state
