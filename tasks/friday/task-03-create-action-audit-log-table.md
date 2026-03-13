# TASK 3: Create the `action_audit_log` PostgreSQL Table

**Objective:** Create the immutable audit log table that records every action execution attempt — successful or failed. This is separate from the `ontology_edit` table. The edit table records the actual data changes; the audit log records the metadata about the execution itself (who ran it, when, what parameters, what happened, how long it took, whether it succeeded or failed, and why).

In Palantir's documentation on Action Metrics (https://www.palantir.com/docs/foundry/action-types/action-metrics/), they list specific failure types that must be tracked:
- "Invalid parameter failure: The action was submitted with parameters that are not valid"
- "Scale limit failure: The action affected more than the permitted limit of object types (by default, usually 10,000)"
- "Authentication failure: The user did not pass the security submission criteria"
- "Side effect failure: The action failed due to a webhook or an incorrectly configured side effect"
- "Function failure: The action failed because the underlying function failed"
- "Unclassified failure: The action failure did not fall into any of the above categories"

The audit log must be truly immutable — once a record is written, it can never be modified or deleted. This is a legal requirement for tax authority systems where every data modification must be traceable. In PostgreSQL, we enforce this by revoking UPDATE and DELETE privileges on the table after creation.

**Exact SQL to execute:**

```sql
CREATE TABLE IF NOT EXISTS action_audit_log (
    audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- The action type that was executed (or attempted). Stored as api_name.
    action_type_api_name TEXT NOT NULL,
    
    -- The display name of the action type at the time of execution.
    -- Stored separately because the action type might be renamed later,
    -- and the audit log should reflect what the user saw when they executed it.
    action_type_display_name TEXT NOT NULL,
    
    -- A unique identifier for this specific execution attempt.
    -- This matches the execution_id in the ontology_edit table,
    -- linking the audit log entry to the specific edits produced.
    execution_id UUID NOT NULL UNIQUE,
    
    -- The full set of parameters that were passed to the action.
    -- This is a snapshot — stored so you can always see exactly what inputs were provided.
    -- Example: {"employeeId": "EMP-001", "newSalary": 150000}
    parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
    
    -- The list of objects that were affected by this action execution.
    -- Each element contains: { "objectType": "Employee", "primaryKey": "EMP-001", "operation": "update" }
    -- For failed actions, this may be empty or contain the objects that WOULD have been affected.
    affected_objects JSONB NOT NULL DEFAULT '[]'::jsonb,
    
    -- The number of objects affected. Stored separately for efficient querying
    -- without needing to parse the affected_objects JSON.
    affected_object_count INTEGER NOT NULL DEFAULT 0,
    
    -- The result of the execution. One of:
    --   'success': All rules executed, all edits applied, all side effects triggered
    --   'failed': The action did not complete. See failure_type and error_message for details.
    --   'partial': Some edits were applied but side effects failed (side effects are best-effort).
    --              In Palantir's model, Ontology edits succeed even if side effect webhooks fail.
    result TEXT NOT NULL CHECK (result IN ('success', 'failed', 'partial')),
    
    -- The type of failure, if result is 'failed'. Maps to Palantir's documented failure types:
    --   'invalid_parameter': Parameters didn't pass validation
    --   'scale_limit': Would affect more than max_affected_objects
    --   'authentication': User doesn't have permission (week 1: not used)
    --   'object_not_found': A modify/delete rule referenced an object that doesn't exist
    --   'duplicate_primary_key': A create rule tried to create an object with a PK that already exists
    --   'required_property_missing': A create rule didn't provide a required property
    --   'type_mismatch': A parameter or property value doesn't match the expected type
    --   'side_effect': A webhook or notification side effect failed
    --   'function_failure': A function-backed action's function threw an error (future)
    --   'unclassified': Any other failure
    failure_type TEXT CHECK (failure_type IN (
        'invalid_parameter', 'scale_limit', 'authentication',
        'object_not_found', 'duplicate_primary_key', 'required_property_missing',
        'type_mismatch', 'side_effect', 'function_failure', 'unclassified'
    )),
    
    -- Human-readable error message describing why the action failed.
    -- Example: "Object with primary key 'EMP-001' already exists in object type 'Employee'"
    error_message TEXT,
    
    -- How long the action took to execute, in milliseconds.
    -- Measured from the start of parameter validation to the end of side effect execution.
    duration_ms INTEGER NOT NULL DEFAULT 0,
    
    -- Who executed the action. In week 1, always 'system'.
    -- In production, this is the authenticated user's ID.
    executed_by TEXT NOT NULL DEFAULT 'system',
    
    -- When the action was executed.
    executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    -- The branch this action was executed on. NULL = Main branch.
    -- In Palantir's branching model, actions can be executed on branches for testing.
    -- By default, webhooks do NOT fire on branches (Palantir doc: "webhooks will not execute when
    -- the action is applied on a branch. This behavior is to prevent accidentally writing to
    -- external systems while in a testing environment.")
    branch_id UUID DEFAULT NULL,
    
    -- IP address of the caller, if available. For audit trail purposes.
    source_ip TEXT,
    
    -- Additional metadata that might be useful for debugging or analytics.
    -- Can include things like: API version, client SDK version, request ID, etc.
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Index for querying audit logs by action type (e.g., "show me all salary update actions")
CREATE INDEX IF NOT EXISTS idx_audit_action_type 
    ON action_audit_log(action_type_api_name, executed_at DESC);

-- Index for querying audit logs by user (e.g., "show me everything user X did")
CREATE INDEX IF NOT EXISTS idx_audit_user 
    ON action_audit_log(executed_by, executed_at DESC);

-- Index for querying by result (e.g., "show me all failed actions")
CREATE INDEX IF NOT EXISTS idx_audit_result 
    ON action_audit_log(result, executed_at DESC);

-- Index for time-range queries (e.g., "show me all actions in the last 24 hours")
CREATE INDEX IF NOT EXISTS idx_audit_time 
    ON action_audit_log(executed_at DESC);

-- CRITICAL: Make the audit log immutable. After this, no one can UPDATE or DELETE rows.
-- Only INSERT is allowed. This is a legal requirement for tax authority audit trails.
-- If you need to "correct" an audit entry, you must insert a NEW entry explaining the correction.
REVOKE UPDATE, DELETE ON action_audit_log FROM PUBLIC;

COMMENT ON TABLE action_audit_log IS 'Immutable audit log for all action execution attempts. Records every action execution with full parameter snapshots, affected objects, results, and timing. Once written, rows cannot be modified or deleted. Mirrors Palantir action audit system.';
```

**Create a database access module** at `src/db/actionAuditLog.js` that exports:

1. `logActionExecution(logEntry)` — Inserts a new audit log record. The `logEntry` parameter contains all fields listed above. Returns the complete record including the generated `audit_id`. This function must NEVER throw an error that would prevent the caller from continuing — if the audit log insert fails (e.g., database connectivity issue), it should log the error to stderr and return null rather than throwing. The reason: a failed audit log write should NOT cause the action itself to fail. The action edits are more important than the audit metadata. However, the caller SHOULD log a critical warning if this returns null.

2. `getAuditLog(filters)` — Query the audit log with optional filters. The `filters` parameter is an object that can contain any combination of:
   - `actionTypeApiName` (string): Filter by specific action type
   - `executedBy` (string): Filter by specific user
   - `result` (string): Filter by result ('success', 'failed', 'partial')
   - `failureType` (string): Filter by failure type
   - `startTime` (ISO timestamp string): Only entries after this time
   - `endTime` (ISO timestamp string): Only entries before this time
   - `pageSize` (integer, default 50, max 1000): Number of results per page
   - `pageToken` (string, optional): Opaque cursor for pagination (base64-encoded `executed_at` of the last result)
   
   Returns: `{ data: [...entries], nextPageToken: "..." | null, totalCount: number }`

3. `getAuditEntry(executionId)` — Get a single audit log entry by execution ID. Returns null if not found.

4. `getAuditStats(startTime, endTime, actionTypeApiName?)` — Returns aggregate statistics for the time period. Note: this function does NOT take an `ontologyId` parameter because the `action_audit_log` table has no `ontology_id` column. To filter by ontology, callers should first look up which action types belong to the ontology and pass a specific `actionTypeApiName`. If `actionTypeApiName` is provided, filter stats to that action type only; otherwise, return stats across all action types.

   Compute `p95DurationMs` using PostgreSQL's `PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)` aggregate function. Return the top 10 action types by execution count.

   ```javascript
   {
       totalExecutions: 1500,
       successCount: 1420,
       failedCount: 80,
       partialCount: 0,
       avgDurationMs: 45,
       p95DurationMs: 120, // computed via PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)
       failureBreakdown: {
           invalid_parameter: 30,
           object_not_found: 25,
           duplicate_primary_key: 15,
           type_mismatch: 10
       },
       topActionTypes: [ // top 10 by count
           { apiName: 'updateSalary', count: 500 },
           { apiName: 'createEmployee', count: 300 }
       ]
   }
   ```

**Test case:**
```javascript
const entry = await logActionExecution({
    action_type_api_name: 'updateSalary',
    action_type_display_name: 'Update Salary',
    execution_id: 'exec-uuid',
    parameters: { employeeId: 'EMP-001', newSalary: 150000 },
    affected_objects: [{ objectType: 'Employee', primaryKey: 'EMP-001', operation: 'update' }],
    affected_object_count: 1,
    result: 'success',
    duration_ms: 42,
    executed_by: 'system'
});
assert(entry.audit_id !== undefined);
assert(entry.result === 'success');

// Verify immutability — this should fail or be blocked
// await pool.query('DELETE FROM action_audit_log WHERE audit_id = $1', [entry.audit_id]);
// Expected: Permission denied

// Test getAuditLog with filters and pagination
const log = await getAuditLog({ actionTypeApiName: 'updateSalary', result: 'success', pageSize: 10 });
assert(Array.isArray(log.data));
assert(typeof log.totalCount === 'number');

// Test getAuditEntry by executionId
const fetched = await getAuditEntry(entry.execution_id);
assert(fetched.audit_id === entry.audit_id);

// Test getAuditStats (no ontologyId parameter — see function signature)
const stats = await getAuditStats(new Date(Date.now() - 86400000).toISOString(), new Date().toISOString());
assert(typeof stats.totalExecutions === 'number');
assert(typeof stats.p95DurationMs === 'number');
```
