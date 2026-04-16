## TASK 21: Build Integration Test — Bulk Actions and Audit Trail

### Context
This test exercises the bulk action endpoint (Task 14) and verifies that every single action — successful or failed — is recorded in the audit log with complete details. Tax authorities like RRA have strict audit requirements: every modification to taxpayer data must be traceable to who made the change, when, why (which action), and what the exact changes were. This test ensures that the audit trail is complete and accurate even for bulk operations with partial failures.

### Exact Specification

Create `/tests/integration/test05_bulk_actions_audit.js`:

**Setup:** This test must be self-contained. Create its own ontology (name: "Bulk Actions Test"), Employee object type, upload 1000 employees, register backing datasource, and reindex. Do not depend on any prior test having run.

**Test sequence:**

Test 5.1: Create action type for bulk department reassignment
```
POST /api/v1/ontology/{ontologyId}/actionTypes
Body: {
  "apiName": "reassignDepartment",
  "displayName": "Reassign Employee Department",
  "parameters": [
    { "apiName": "employeeRef", "type": "string", "required": true },
    { "apiName": "newDepartment", "type": "string", "required": true }
  ],
  "rules": [{
    "type": "modifyObject",
    "objectType": "Employee",
    "objectReference": { "source": "parameter", "param": "employeeRef" },
    "properties": {
      "department": { "source": "parameter", "param": "newDepartment" }
    }
  }]
}
```

Test 5.2: Execute bulk action with 50 valid + 5 invalid requests
```
POST /api/v1/actions/reassignDepartment/applyBulk
Body: {
  "requests": [
    // 50 valid: EMP-0001 through EMP-0050, all reassigned to "Audit Division"
    ...Array.from({length: 50}, (_, i) => ({
      parameters: { employeeRef: `EMP-${String(i+1).padStart(4, '0')}`, newDepartment: "Audit Division" }
    })),
    // 5 invalid: non-existent employee IDs
    ...Array.from({length: 5}, (_, i) => ({
      parameters: { employeeRef: `INVALID-${i}`, newDepartment: "Audit Division" }
    }))
  ],
  "options": { "stopOnError": false, "autoIndex": true }
}
Assert: summary.succeeded === 50
Assert: summary.failed === 5
Assert: status code 200 (partial success is still 200)
Assert: each result[i] has correct status ("success" or "failed")
Assert: failed results have error.code === "OBJECT_NOT_FOUND"
```

Test 5.3: Verify all 50 employees now have department "Audit Division"
```
POST /api/v1/objects/Employee/search
Body: { "where": { "type": "eq", "field": "department", "value": "Audit Division" } }
Assert: totalCount >= 50
```

Test 5.4: Verify audit log has 55 entries (50 success + 5 failure)
```
GET /api/v1/actions/reassignDepartment/audit?pageSize=100
Assert: data.length === 55
Assert: 50 entries have result === "success"
Assert: 5 entries have result === "failed"
Assert: each entry has: action_type_api_name, parameters, affected_objects, result, executed_at
```

Test 5.5: Verify individual audit entry completeness
```
Select the entry at index 0 from the Test 5.4 audit response where result === "success":
Assert: parameters.employeeRef is present
Assert: parameters.newDepartment === "Audit Division"
Assert: affected_objects includes the employee PK and operation "update"
Assert: executed_at is a valid ISO timestamp
Assert: duration_ms is a positive integer
```

Test 5.6: Test stopOnError=true behavior
```
POST /api/v1/actions/reassignDepartment/applyBulk
Body: {
  "requests": [
    { "parameters": { "employeeRef": "EMP-0051", "newDepartment": "Legal" } },
    { "parameters": { "employeeRef": "INVALID-99", "newDepartment": "Legal" } },  // This will fail
    { "parameters": { "employeeRef": "EMP-0053", "newDepartment": "Legal" } }      // This should NOT execute
  ],
  "options": { "stopOnError": true }
}
Assert: summary.succeeded === 1
Assert: summary.failed === 1
Assert: results.length === 2 (only 2 processed, 3rd was skipped)
Assert: results[0].status === "success" (EMP-0051)
Assert: results[1].status === "failed" (INVALID-99)
```

Test 5.7: Verify EMP-0053 was NOT changed (stopOnError prevented it)
```
GET /api/v1/objects/Employee/EMP-0053
Assert: department !== "Legal" (should still be its original department)
```

Test 5.8: Test scale limit
```
POST /api/v1/actions/reassignDepartment/applyBulk
Body: { "requests": Array of 1001 items }
Assert: status 400, error mentions "limited to 1000 items"
```

**Cleanup:**
After tests complete (pass or fail), delete all test data in the same order as Task 17's cleanup.

**Note:** The audit query endpoint (`GET /api/v1/actions/:actionType/audit`) is listed in the ACTIONS section of the API endpoint summary. Its response format must include a `data` array where each entry has: `action_type_api_name` (string), `parameters` (object), `affected_objects` (array), `result` (string: "success" or "failed"), `executed_at` (ISO timestamp), and `duration_ms` (integer). Pagination uses `pageSize` and `pageToken` query parameters.

### Validation Criteria
- Bulk operation with mixed success/failure returns correct summary
- All 55 audit entries are created (50 success + 5 failure)
- Audit entries contain complete parameter and result data
- stopOnError=true halts processing at first failure
- Subsequent items after failure are not processed
- Scale limit (1000 items) is enforced
