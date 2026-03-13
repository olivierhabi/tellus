## TASK 18: Build Integration Test — Edit Preservation Across Reindex

### Context
This is the most critical integration test. It verifies that the Palantir behavior "user edits take precedence over datasource data" works correctly. The test creates objects from a dataset, modifies some via Actions, reindexes with the same dataset, and verifies that the user modifications are preserved.

### Exact Specification

Create `/tests/integration/test02_edit_preservation.js`:

**Setup:** This test must be self-contained. Always create its own ontology, Employee object type, dataset, backing datasource, and reindex — even if Test 01 has already run. Use a unique ontology name (e.g., "Edit Preservation Test") to avoid collisions. The setup must produce 1000 indexed Employee objects before the test sequence begins. Generate or reuse the `employees_1000.csv` fixture from Task 17.

**Test sequence:**

Test 2.1: Create an action type for salary updates
```
POST /api/v2/ontology/{ontologyId}/actionTypes
Body: {
  "apiName": "updateEmployeeSalary",
  "displayName": "Update Employee Salary",
  "parameters": [
    { "apiName": "employeeRef", "type": "string", "required": true },
    { "apiName": "newSalary", "type": "double", "required": true }
  ],
  "rules": [{
    "type": "modifyObject",
    "objectType": "Employee",
    "objectReference": { "source": "parameter", "param": "employeeRef" },
    "properties": {
      "salary": { "source": "parameter", "param": "newSalary" }
    }
  }]
}
Assert: status 201
```

Test 2.2: Record the original salary of EMP-0001
```
GET /api/v2/objects/Employee/EMP-0001
Store: originalSalary = response.salary (should be whatever was in the CSV)
Assert: salary is a number
```

Test 2.3: Update EMP-0001's salary to 999999 via action
```
POST /api/v2/actions/updateEmployeeSalary/apply
Body: { "parameters": { "employeeRef": "EMP-0001", "newSalary": 999999 } }
Assert: status 200, result === "success"
```

Test 2.4: Verify the salary changed in the Ontology
```
GET /api/v2/objects/Employee/EMP-0001
Assert: salary === 999999 (not the original CSV value)
```

Test 2.5: Verify the edit is recorded
```
GET /api/v2/ontology/{ontologyId}/objectTypes/Employee/edits?primaryKey=EMP-0001
Assert: at least 1 edit with operation "update" and propertyValues.salary === 999999
```

Test 2.6: Reindex the object type (THIS IS THE CRITICAL TEST)
```
POST /api/v2/ontology/{ontologyId}/objectTypes/Employee/reindex?force=true
Assert: status 200, result.editsApplied.updates >= 1
```

Test 2.7: Verify the salary is STILL 999999 after reindex (EDIT PRESERVED!)
```
GET /api/v2/objects/Employee/EMP-0001
Assert: salary === 999999
Assert: salary !== originalSalary (the datasource value was NOT used)
```

Test 2.8: Verify via the diff endpoint
```
GET /api/v2/ontology/{ontologyId}/objectTypes/Employee/edits/diff/EMP-0001
Assert: diff.salary.datasource === originalSalary
Assert: diff.salary.ontology === 999999
Assert: diff.salary.source === "user_edit"
```

Test 2.9a: Create an action type for creating employees
```
POST /api/v2/ontology/{ontologyId}/actionTypes
Body: {
  "apiName": "createEmployee",
  "displayName": "Create Employee",
  "parameters": [
    { "apiName": "employeeId", "type": "string", "required": true },
    { "apiName": "fullName", "type": "string", "required": true },
    { "apiName": "salary", "type": "double", "required": false }
  ],
  "rules": [{
    "type": "createObject",
    "objectType": "Employee",
    "properties": {
      "employeeId": { "source": "parameter", "param": "employeeId" },
      "fullName": { "source": "parameter", "param": "fullName" },
      "salary": { "source": "parameter", "param": "salary" }
    }
  }]
}
Assert: status 201
```

Test 2.9b: Create a new employee via action (not in the CSV)
```
POST /api/v2/actions/createEmployee/apply
Body: { "parameters": { "employeeId": "EMP-NEW-TEST", "fullName": "Test Created", "salary": 50000 } }
Assert: status 200, result === "success"
```

Test 2.10: Verify the new employee exists
```
GET /api/v2/objects/Employee/EMP-NEW-TEST
Assert: status 200, fullName === "Test Created"
```

Test 2.11: Reindex again
```
POST /api/v2/ontology/{ontologyId}/objectTypes/Employee/reindex?force=true
Assert: result.editsApplied.creates >= 1
```

Test 2.12: Verify the action-created employee STILL exists after reindex
```
GET /api/v2/objects/Employee/EMP-NEW-TEST
Assert: status 200, fullName === "Test Created"
Assert: This object is NOT in the CSV — it was created purely via action and must survive reindex
```

Test 2.13a: Create an action type for deleting employees
```
POST /api/v2/ontology/{ontologyId}/actionTypes
Body: {
  "apiName": "deleteEmployee",
  "displayName": "Delete Employee",
  "parameters": [
    { "apiName": "employeeRef", "type": "string", "required": true }
  ],
  "rules": [{
    "type": "deleteObject",
    "objectType": "Employee",
    "objectReference": { "source": "parameter", "param": "employeeRef" }
  }]
}
Assert: status 201
```

Test 2.13b: Delete an employee via action
```
POST /api/v2/actions/deleteEmployee/apply
Body: { "parameters": { "employeeRef": "EMP-0002" } }
Assert: status 200, result === "success"
```

Test 2.14: Verify the employee is gone
```
GET /api/v2/objects/Employee/EMP-0002
Assert: status 404
```

Test 2.15: Reindex again
```
POST /api/v2/ontology/{ontologyId}/objectTypes/Employee/reindex?force=true
Assert: status 200, result.editsApplied.deletes >= 1
```

Test 2.16: Verify the deleted employee is STILL gone after reindex
```
GET /api/v2/objects/Employee/EMP-0002
Assert: status 404
Assert: Even though EMP-0002 is in the CSV, the delete edit takes precedence
```

Test 2.17: Verify total count is correct
```
GET /api/v2/objects/Employee?$pageSize=1
Assert: totalCount === 1000 (original) + 1 (created) - 1 (deleted) = 1000
```

**Summary output:**
```
=== Integration Test: Edit Preservation ===
Test 2.1   Create action type:             PASS
Test 2.2   Record original salary:          PASS (original: 127000)
Test 2.3   Update salary to 999999:         PASS
Test 2.4   Salary changed in Ontology:      PASS (999999)
Test 2.5   Edit recorded:                   PASS
Test 2.6   Reindex with edits:              PASS (1 update applied)
Test 2.7   SALARY PRESERVED AFTER REINDEX:  PASS (999999 ✓)
Test 2.8   Diff shows edit source:          PASS
Test 2.9   Create new employee via action:  PASS
Test 2.10  New employee exists:             PASS
Test 2.11  Reindex with creates:            PASS (1 create applied)
Test 2.12  CREATED EMPLOYEE SURVIVES REINDEX: PASS ✓
Test 2.13  Delete employee via action:      PASS
Test 2.14  Employee is gone:                PASS
Test 2.15  Reindex with deletes:            PASS
Test 2.16  DELETED EMPLOYEE STAYS DELETED:  PASS ✓
Test 2.17  Total count correct (1000):      PASS

17/17 tests passed. Total time: 8540ms
```

**Cleanup:**
After tests complete (pass or fail), delete all test data in the same order as Task 17's cleanup.

### Validation Criteria
- ALL 17 tests pass (note: sub-tests 2.9 and 2.13 are split into a/b parts)
- The three critical assertions (2.7, 2.12, 2.16) are the heart of edit preservation:
  - Modified salary survives reindex
  - Action-created object survives reindex
  - Action-deleted object stays deleted after reindex
