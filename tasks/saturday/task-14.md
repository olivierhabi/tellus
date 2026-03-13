## TASK 14: Build the Bulk Action Endpoint

### Context
Individual actions (create one employee, update one salary) are useful but tax authorities often need to perform bulk operations: update the status of 500 delinquent taxpayers, assign 200 audit cases to a team, or delete 1000 duplicate records. Palantir supports bulk actions through multiple mechanisms: inline edits in Workshop (which submit actions in bulk), and the Action API's ability to process multiple parameter sets in a single request.

For our week-1 implementation, we build a bulk action endpoint that accepts an array of parameter sets and processes them sequentially within a single HTTP request-response cycle. Each parameter set is validated and applied independently; there is no database transaction wrapping the entire batch. Partial success is possible (some succeed, some fail).

### Exact Specification

**Endpoint: `POST /api/v2/actions/:actionTypeApiName/applyBulk`**

Request body:
```json
{
  "requests": [
    { "parameters": { "employeeId": "EMP-001", "newSalary": 150000 } },
    { "parameters": { "employeeId": "EMP-002", "newSalary": 160000 } },
    { "parameters": { "employeeId": "EMP-003", "newSalary": 170000 } },
    { "parameters": { "employeeId": "DOES-NOT-EXIST", "newSalary": 100000 } }
  ],
  "options": {
    "stopOnError": false,
    "autoIndex": true
  }
}
```

`stopOnError` (default: false):
- If false: process all requests regardless of individual failures. Return results for each.
- If true: stop processing at the first failure. Return results for processed items only.

`autoIndex` (default: true):
- If true: trigger a reindex after all actions are applied
- If false: edits are written to the edit store but not indexed until manual reindex

**Processing:**

For each request in the `requests` array (in order), call the existing `actionService.applyAction()` logic (the same function used by the individual `/apply` endpoint). Steps 1-5 are identical to the individual action apply flow:
1. Validate parameters against the action type's parameter schema
2. Resolve object references (look up the object by primary key in OpenSearch to verify it exists)
3. Compile and evaluate rules (the action type's validation rules and precondition checks from the existing `actionService.js`)
4. Apply edits to the edit store (write to `ontology_edit` table)
5. Write audit log entry (write to `action_audit_log` table)
6. If the request fails and stopOnError is false: record the error and continue to the next request
7. If the request fails and stopOnError is true: record the error and stop

**stopOnError + autoIndex interaction:** If `stopOnError=true` and processing stops early due to a failure, `autoIndex` still applies to the actions that succeeded before the failure. If zero actions succeeded, no reindex is triggered.

Palantir's limit: max 10,000 affected objects per action type. For bulk, this applies to the TOTAL across all requests. If the cumulative affected objects exceed 10,000, reject the remaining requests with error "SCALE_LIMIT_EXCEEDED".

After all requests are processed, if autoIndex is true, trigger a single reindex for the affected object type.

**Response (HTTP 200 — even if some individual actions failed):**

```json
{
  "summary": {
    "total": 4,
    "succeeded": 3,
    "failed": 1,
    "totalObjectsAffected": 3,
    "durationMs": 450
  },
  "results": [
    { "index": 0, "status": "success", "primaryKey": "EMP-001", "operation": "update" },
    { "index": 1, "status": "success", "primaryKey": "EMP-002", "operation": "update" },
    { "index": 2, "status": "success", "primaryKey": "EMP-003", "operation": "update" },
    { "index": 3, "status": "failed", "error": { "code": "OBJECT_NOT_FOUND", "message": "Object with primary key 'DOES-NOT-EXIST' not found in object type 'Employee'." } }
  ],
  "indexing": {
    "triggered": true,
    "objectType": "Employee",
    "totalObjectsIndexed": 1003,
    "durationMs": 300
  }
}
```

HTTP status code rules:
- 200 if at least one action succeeded (even if others failed)
- 400 if the request body itself is invalid (not a valid array, missing parameters field)
- 400 if the action type does not exist
- 422 if ALL actions failed (none succeeded)

**Validation:**
- The `requests` array must not be empty. If empty, return 400: `"The 'requests' array must contain at least one action request."`
- The `requests` array must not exceed 1000 items. If exceeded, return 400: `"Bulk action requests are limited to 1000 items per call. Received: {N}."`

### Validation Criteria
- Bulk update of 3 valid employees succeeds with 3 success results
- Including 1 invalid employee in the batch: 3 succeed, 1 fails (stopOnError=false)
- With stopOnError=true: processing stops at first failure
- Total affected objects exceeding 10,000 triggers SCALE_LIMIT_EXCEEDED for remaining items
- autoIndex=true triggers a single reindex after all actions
- autoIndex=false leaves edits in pending state
- Empty requests array returns 400
- More than 1000 requests returns 400
- Each individual result has correct status, primaryKey, and operation or error details
- When all actions fail (none succeeded), the endpoint returns HTTP 422 with all failure results
- The `durationMs` field in the summary reflects the actual wall-clock time of the bulk operation
