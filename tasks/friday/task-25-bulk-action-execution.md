# TASK 25: Build Bulk Action Execution Endpoint

**Objective:** Create an endpoint that executes the same action type multiple times with different parameter sets in a single API call. This is the programmatic equivalent of Palantir's "inline edits" in Workshop, where a user can edit multiple cells in a table and all changes are submitted together.

Palantir's documentation on inline edits states: "Inline edits differ in that they are validated and submitted in bulk. Because of this, not all actions are suitable for inline edits." and "When inline edits are applied, the submitted actions are applied sequentially (in a non-deterministic order) rather than simultaneously."

**Add endpoint:**

```
POST /api/v1/actions/:actionTypeApiName/applyBatch
Body: {
    "requests": [
        { "parameters": { "employeeRef": "EMP-001", "newSalary": 120000 } },
        { "parameters": { "employeeRef": "EMP-002", "newSalary": 130000 } },
        { "parameters": { "employeeRef": "EMP-003", "newSalary": 140000 } }
    ]
}
```

**Implementation:**

1. Load the action type definition once (shared across all requests in the batch).
2. For each request in the batch, execute the full action pipeline (validate → compile → apply → audit).
3. Each individual action within the batch is independent — if request 2 fails, requests 1 and 3 still succeed. This matches Palantir's inline edit behavior where each cell edit is independent.
4. Track individual results for each request.
5. The batch as a whole returns HTTP **200** regardless of individual action results (even if some fail). The per-item results in the response body indicate individual success/failure. Only return HTTP **400** if the batch itself is invalid (e.g., over 100 requests, missing `requests` field, or total affected objects exceed 100,000). Each batch request counts as 1 hit against the `batchPerUser` rate limit from Task 27. Individual actions within the batch do NOT count against `perActionType` or `perUser` limits separately.

**Limits:**
- Maximum 100 requests per batch (prevent abuse). Return 400 if exceeded.
- Each individual action still enforces `maxAffectedObjects`.
- Total affected objects across the entire batch cannot exceed 100,000.

**Response format:**
```json
{
    "batchId": "uuid",
    "totalRequests": 3,
    "successCount": 2,
    "failedCount": 1,
    "results": [
        { "index": 0, "success": true, "executionId": "uuid", "affectedObjects": [...] },
        { "index": 1, "success": true, "executionId": "uuid", "affectedObjects": [...] },
        { "index": 2, "success": false, "executionId": "uuid", "failureType": "object_not_found", "errorMessage": "..." }
    ],
    "totalDurationMs": 230
}
```

**Test cases:**
```javascript
// Batch update 3 salaries
const res = await fetch('/api/v1/actions/updateSalary/applyBatch', {
    method: 'POST',
    body: JSON.stringify({ requests: [
        { parameters: { employeeRef: 'EMP-001', newSalary: 120000 } },
        { parameters: { employeeRef: 'EMP-002', newSalary: 130000 } },
        { parameters: { employeeRef: 'EMP-NONEXISTENT', newSalary: 999 } } // will fail
    ]})
});
const data = await res.json();
assert(data.successCount === 2);
assert(data.failedCount === 1);
assert(data.results[0].success === true);
assert(data.results[2].success === false);

// Verify the successful ones were applied
assert((await fetchObject('Employee', 'EMP-001')).salary === 120000);
assert((await fetchObject('Employee', 'EMP-002')).salary === 130000);

// Over limit
const bigBatch = { requests: Array(101).fill({ parameters: { employeeRef: 'EMP-001', newSalary: 1 } }) };
const overLimit = await fetch('/api/v1/actions/updateSalary/applyBatch', { method: 'POST', body: JSON.stringify(bigBatch) });
assert(overLimit.status === 400);
```
