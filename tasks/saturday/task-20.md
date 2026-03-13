## TASK 20: Build Integration Test — Link Traversal After Reindex

### Context
This test verifies that link types work correctly with the dataset-backed Ontology. After creating two object types (Employee and Company), uploading data, creating links between them, and reindexing, the test verifies that link traversal (Search Around) returns the correct results.

### Exact Specification

Create `/tests/integration/test04_link_traversal.js`:

**Setup:** This test must be self-contained. Create its own ontology, object types, datasets, and backing datasources — do not depend on any prior test having run. Use a unique ontology name (e.g., "Link Traversal Test").

Setup steps (each step must assert status code for early failure detection):
- `POST /api/v2/ontology` — create ontology. Assert: status 201.
- `POST /api/v2/ontology/{id}/objectTypes` — create Employee object type with all 10 properties from Task 17 (including companyId). Assert: status 201.
- `POST /api/v2/ontology/{id}/objectTypes` — create Company object type with: companyId (PK, string), companyName (string), sector (string). Assert: status 201.
- `POST /api/v2/datasets/upload` — upload employees_1000.csv (generate or reuse from Task 17). Assert: status 201.
- `POST /api/v2/datasets/upload` — upload companies_5.csv (generate or reuse from Task 17). Assert: status 201.
- `POST .../Employee/datasource` — register Employee backing datasource with column mapping. Assert: status 200.
- `POST .../Company/datasource` — register Company backing datasource. Assert: status 200.
- `POST .../Employee/reindex` — reindex Employee. Assert: status 200, totalObjectsIndexed === 1000.
- `POST .../Company/reindex` — reindex Company. Assert: status 200, totalObjectsIndexed === 5.

Note: The `searchAround` endpoint (`POST /api/v2/objects/:objectType/searchAround`) and the object view endpoint (`GET /api/v2/objects/:objectType/:pk/view`) are listed in the OBJECTS and LINKS sections of the API endpoint list and were built in Days 1-5. If they do not exist, they must be built as prerequisites before this test can pass.

**Test sequence:**

Test 4.1: Create a MANY_TO_ONE link type from Employee to Company
```
POST /api/v2/ontology/{ontologyId}/linkTypes
Body: {
  "apiName": "employeeCompany",
  "displayName": "Employee → Company",
  "sourceObjectType": "Employee",
  "targetObjectType": "Company",
  "cardinality": "MANY_TO_ONE",
  "foreignKey": { "sourceProperty": "companyId" }
}
```

Test 4.2: Traverse from Employee to Company
```
GET /api/v2/objects/Employee/EMP-0001/links/employeeCompany
Assert: Returns exactly 1 company object
Assert: The returned company's companyId matches EMP-0001's companyId
```

Test 4.3: Reverse traverse — from Company to all Employees
```
GET /api/v2/objects/Company/COMP-001/links/employeeCompany
Assert: Returns multiple employees
Assert: ALL returned employees have companyId === "COMP-001"
Note: The API automatically infers traversal direction based on whether the source object is the link's source or target type. Same endpoint pattern, direction is resolved by the system.
```

Test 4.4: Search Around with filter
```
POST /api/v2/objects/Company/searchAround
Body: {
  "sourceFilter": { "type": "eq", "field": "sector", "value": "Banking" },
  "linkType": "employeeCompany",
  "targetFilter": { "type": "gt", "field": "salary", "value": 100000 }
}
Assert: Returns employees who work at Banking companies AND have salary > 100K
```

Test 4.5: Verify link count in object view
```
GET /api/v2/objects/Employee/EMP-0001/view
Assert: links.employeeCompany.count === 1
```

Test 4.5b: Record current COMP-003 employee count
```
GET /api/v2/objects/Company/COMP-003/links/employeeCompany
Store: originalComp003Count = response.totalCount
```

Test 4.6: Upload new employees (append) and reindex
```
Generate a 10-row CSV with employee IDs EMP-LINK-001 through EMP-LINK-010,
all with companyId = "COMP-003". Other fields: full_name, email, department, annual_salary, etc.

POST /api/v2/datasets/{employeeDatasetId}/transactions (multipart form, type: "APPEND")
Assert: status 201, transaction.type === "APPEND"

POST /api/v2/ontology/{ontologyId}/objectTypes/Employee/reindex?force=true
Assert: status 200, result.totalObjectsIndexed === 1010
```

Test 4.7: Verify new employees are linked correctly
```
GET /api/v2/objects/Company/COMP-003/links/employeeCompany
Assert: response.totalCount === originalComp003Count + 10
```

**Cleanup:**
After tests complete (pass or fail), delete all test data in the same order as Task 17's cleanup.

### Validation Criteria
- Forward link traversal (Employee → Company) works
- Reverse link traversal (Company → Employees) works
- Search Around with filter on both sides works
- Links remain correct after reindex with new data
- New appended objects are correctly linked via foreign key
- Link count for COMP-003 increases by exactly 10 after appending 10 employees
