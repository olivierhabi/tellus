# TASK 9: Build the Audit Log Query REST API Endpoints

**Objective:** Create REST endpoints for querying the audit log. These endpoints allow administrators and auditors to review all action executions — who did what, when, with what parameters, what was the result. For a tax authority system, this is legally mandatory — every data modification must be traceable.

**Create endpoints** in `src/routes/auditLog.js`:

**Endpoint 1: GET /api/v2/actions/:actionTypeApiName/audit**

Returns the audit log entries for a specific action type. This is the endpoint Palantir documents directly on their action types page.

Query parameters:
- `$pageSize` (integer, default 50, max 1000): Number of entries per page.
- `$pageToken` (string, optional): Opaque cursor for pagination. This is a base64-encoded JSON string containing the `executed_at` timestamp of the last entry in the previous page. To decode: `JSON.parse(Buffer.from(pageToken, 'base64').toString())`. To encode: `Buffer.from(JSON.stringify({ executed_at: lastEntry.executed_at })).toString('base64')`.
- `result` (string, optional): Filter by result ('success', 'failed', 'partial').
- `startTime` (ISO timestamp, optional): Only entries after this time.
- `endTime` (ISO timestamp, optional): Only entries before this time.
- `executedBy` (string, optional): Filter by the user who executed the action.

Implementation:
1. Build a PostgreSQL query against `action_audit_log` with the following WHERE clauses:
   - `action_type_api_name = $1` (always, since it's in the URL)
   - If `result` is provided: `AND result = $2`
   - If `startTime` is provided: `AND executed_at >= $3`
   - If `endTime` is provided: `AND executed_at <= $4`
   - If `executedBy` is provided: `AND executed_by = $5`
   - If `$pageToken` is provided: `AND executed_at < $6` (for descending pagination)
2. Add `ORDER BY executed_at DESC` and `LIMIT $pageSize + 1` (fetch one extra to determine if there's a next page).
3. If the result set has more than `$pageSize` entries, there's a next page. Set `nextPageToken` to the encoded `executed_at` of the last entry within the page (not the extra entry). Remove the extra entry from the results.
4. Get the total count (`totalCount` in the response) with a separate `SELECT COUNT(*) ...` query with the same WHERE clauses (without LIMIT or pageToken cursor). This is the total number of matching entries across ALL pages, not just the current page.

Response format:
```json
{
    "data": [
        {
            "auditId": "uuid",
            "actionTypeApiName": "updateSalary",
            "actionTypeDisplayName": "Update Salary",
            "executionId": "uuid",
            "parameters": { "employeeId": "EMP-001", "newSalary": 150000 },
            "affectedObjects": [
                { "objectType": "Employee", "primaryKey": "EMP-001", "operation": "update" }
            ],
            "affectedObjectCount": 1,
            "result": "success",
            "failureType": null,
            "errorMessage": null,
            "durationMs": 42,
            "executedBy": "system",
            "executedAt": "2025-03-14T10:30:00Z"
        }
    ],
    "nextPageToken": "eyJleGVjdXRlZF9hdCI6...",
    "totalCount": 1523
}
```

**Endpoint 2: GET /api/v2/audit/log**

Returns the global audit log across ALL action types. Same query parameters as Endpoint 1 except no `:actionTypeApiName` filter (or it's optional as a query param instead of a URL param). This endpoint is used by the platform admin to see all activity across the entire Ontology.

Additional query parameter:
- `actionType` (string, optional): Filter by a specific action type api_name.

Same response format and pagination logic as Endpoint 1.

**Endpoint 3: GET /api/v2/audit/log/:executionId**

Returns a single audit log entry by execution ID. Returns 404 if not found.

Response: The single audit log entry object (not wrapped in a `data` array).

**Endpoint 4: GET /api/v2/audit/stats**

Returns aggregate statistics about action executions. This maps to Palantir's Action Metrics feature.

Query parameters:
- `startTime` (ISO timestamp, default: 24 hours ago)
- `endTime` (ISO timestamp, default: now)
- `actionType` (string, optional): Filter to a specific action type.

Implementation: Run aggregate SQL queries:
```sql
-- Total counts by result
SELECT result, COUNT(*) as count FROM action_audit_log
WHERE executed_at BETWEEN $1 AND $2
GROUP BY result;

-- Average and p95 duration
SELECT 
    AVG(duration_ms) as avg_duration,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_duration
FROM action_audit_log
WHERE executed_at BETWEEN $1 AND $2;

-- Failure breakdown
SELECT failure_type, COUNT(*) as count FROM action_audit_log
WHERE executed_at BETWEEN $1 AND $2 AND result = 'failed'
GROUP BY failure_type;

-- Top action types by execution count
SELECT action_type_api_name, COUNT(*) as count FROM action_audit_log
WHERE executed_at BETWEEN $1 AND $2
GROUP BY action_type_api_name
ORDER BY count DESC
LIMIT 10;
```

Response format:
```json
{
    "period": { "startTime": "...", "endTime": "..." },
    "totalExecutions": 1500,
    "results": { "success": 1420, "failed": 80, "partial": 0 },
    "timing": { "avgDurationMs": 45, "p95DurationMs": 120 },
    "failureBreakdown": {
        "invalid_parameter": 30,
        "object_not_found": 25,
        "duplicate_primary_key": 15,
        "type_mismatch": 10
    },
    "topActionTypes": [
        { "apiName": "updateSalary", "displayName": "Update Salary", "count": 500 },
        { "apiName": "createEmployee", "displayName": "Create Employee", "count": 300 }
    ]
}
```

**Router architecture:** Create TWO Express routers in `src/routes/auditLog.js` — one for action-scoped audit routes and one for global audit routes. Export them separately:

```javascript
const actionAuditRouter = express.Router({ mergeParams: true });
// Endpoint 1: GET /:actionTypeApiName/audit — mounted under /api/v2/actions
actionAuditRouter.get('/:actionTypeApiName/audit', async (req, res) => { /* ... */ });

const globalAuditRouter = express.Router();
// Endpoint 2: GET /log — mounted under /api/v2/audit
globalAuditRouter.get('/log', async (req, res) => { /* ... */ });
// Endpoint 3: GET /log/:executionId — mounted under /api/v2/audit
globalAuditRouter.get('/log/:executionId', async (req, res) => { /* ... */ });
// Endpoint 4: GET /stats — mounted under /api/v2/audit
globalAuditRouter.get('/stats', async (req, res) => { /* ... */ });

module.exports = { actionAuditRouter, globalAuditRouter };
```

**Register both routers** in `src/server.js`:
```javascript
const { actionAuditRouter, globalAuditRouter } = require('./routes/auditLog');
app.use('/api/v2/actions', actionAuditRouter);
app.use('/api/v2/audit', globalAuditRouter);
```

**Test the complete flow:**
1. Execute several actions (some successful, some failing)
2. Query the action-specific audit log — verify entries appear
3. Query the global audit log — verify entries from all action types appear
4. Query with filters (result=failed, time range) — verify correct filtering
5. Test pagination with $pageSize=2 — verify $pageToken works
6. Get stats — verify counts and durations are correct
