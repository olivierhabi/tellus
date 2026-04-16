# TASK 17: Build the Edit History API Endpoint

**Objective:** Create an API endpoint that returns the complete edit history for a single object. This shows every create, update, and delete operation that has ever been applied to a specific object, in chronological order. This is essential for audit and compliance — a tax auditor must be able to see every change ever made to a taxpayer record, who made it, when, and what the old and new values were.

**Add endpoint** to `src/routes/objects.js` (the existing objects router):

```
GET /api/v1/objects/:objectType/:primaryKey/editHistory
```

Query parameters:
- `$pageSize` (integer, default 50, max 500)
- `$pageToken` (string, opaque cursor — this is the `executed_at` ISO timestamp of the last item on the previous page, base64-encoded. The server decodes it with `Buffer.from(pageToken, 'base64').toString()` and uses it in the WHERE clause as `executed_at < decoded_timestamp`. If not provided, pagination starts from the most recent edit.)
- `startTime` (ISO timestamp, optional): Only edits after this time
- `endTime` (ISO timestamp, optional): Only edits before this time

**Implementation:**

1. Query `ontology_edit` table:
```sql
SELECT edit_id, object_type_api_name, primary_key, operation, 
       property_values, link_edits, action_type_api_name, 
       execution_id, action_parameters, executed_by, executed_at, indexed
FROM ontology_edit
WHERE object_type_api_name = $1 AND primary_key = $2
  AND ($3::timestamptz IS NULL OR executed_at >= $3)
  AND ($4::timestamptz IS NULL OR executed_at <= $4)
  AND ($5::timestamptz IS NULL OR executed_at < $5)  -- pageToken cursor
ORDER BY executed_at DESC
LIMIT $6
```

2. For each edit, also fetch the corresponding audit log entry (JOIN on execution_id) to include the action display name and execution result.

3. For `update` operations, compute a "diff" showing what changed. This requires comparing the edit's `property_values` with the object's state BEFORE the edit. To compute "before" values: look at the previous edit for the same PK, or if this is the first edit, look at the datasource value. For week 1, a simpler approach: just show the property_values in the edit (what was SET), without computing the "before" values. Add a `TODO` comment for computing full diffs in a future iteration.

**Response format:**

```json
{
    "objectType": "Employee",
    "primaryKey": "EMP-001",
    "data": [
        {
            "editId": "uuid",
            "operation": "update",
            "propertyValues": { "salary": 150000 },
            "actionTypeApiName": "updateSalary",
            "actionTypeDisplayName": "Update Salary",
            "executionId": "uuid",
            "executedBy": "auditor-jane",
            "executedAt": "2025-03-14T14:30:00Z",
            "indexed": true,
            "indexedAt": "2025-03-14T14:30:01Z"
        },
        {
            "editId": "uuid",
            "operation": "create",
            "propertyValues": { "employeeId": "EMP-001", "fullName": "Melissa Chang", "salary": 120000, "department": "Engineering" },
            "actionTypeApiName": "createEmployee",
            "actionTypeDisplayName": "Create Employee",
            "executionId": "uuid",
            "executedBy": "system",
            "executedAt": "2025-03-14T10:00:00Z",
            "indexed": true,
            "indexedAt": "2025-03-14T10:00:02Z"
        }
    ],
    "nextPageToken": "...",
    "totalCount": 2  // Total number of edits matching the query filters across ALL pages (not just this page).
                     // Computed via a separate SELECT COUNT(*) query with the same WHERE clause but without LIMIT.
}
```

**Test case:**
```javascript
// Create an employee, then update salary twice
await executeAction('ont-1', 'createEmployee', { employeeId: 'EMP-HIST', fullName: 'Test', salary: 100000 }, { executedBy: 'user-a' });
await executeAction('ont-1', 'updateSalary', { employeeRef: 'EMP-HIST', newSalary: 120000 }, { executedBy: 'user-b' });
await executeAction('ont-1', 'updateSalary', { employeeRef: 'EMP-HIST', newSalary: 150000 }, { executedBy: 'user-a' });

// Fetch edit history
const response = await fetch('/api/v1/objects/Employee/EMP-HIST/editHistory');
const history = await response.json();
assert(history.totalCount === 3);
assert(history.data[0].operation === 'update'); // most recent first
assert(history.data[0].propertyValues.salary === 150000);
assert(history.data[2].operation === 'create');
```
