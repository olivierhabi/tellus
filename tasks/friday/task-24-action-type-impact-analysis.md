# TASK 24: Build Action Type Impact Analysis Endpoint

**Objective:** Create an endpoint that analyzes an action type and returns information about its dependencies and potential impact. This is used by the Ontology Manager UI to warn users before they modify or delete an action type. For example, if an action type is used in 5 Workshop applications and 3 Automate rules, deleting it would break those workflows.

In week 1, we don't have Workshop or Automate yet. But we can still analyze: which object types does this action affect? Which properties does it modify? Which link types does it create/remove? How many times has it been executed (from the audit log)?

**Add endpoint:**

```
GET /api/v1/ontology/:ontologyId/actionTypes/:apiName/impact
```

**Implementation:**

1. Load the action type definition.
2. Parse the rules to extract:
   - All `objectType` references → which object types are affected
   - All property names in `createObject`/`modifyObject` rules → which properties are modified
   - All `linkType` references → which link types are affected
3. Query the audit log using the `action_audit_log` table (Task 3). Run these specific SQL queries:
   ```sql
   -- Total executions and success rate
   SELECT COUNT(*) as total,
          COUNT(*) FILTER (WHERE result = 'success') as success_count,
          MAX(executed_at) as last_executed_at
   FROM action_audit_log WHERE action_type_api_name = $1;

   -- Last 30 days count
   SELECT COUNT(*) as count
   FROM action_audit_log WHERE action_type_api_name = $1 AND executed_at > now() - interval '30 days';
   ```
   Compute `successRate` as `success_count / total` (handle division by zero: return 0 if total is 0).

4. Check for object type dependencies (use the `object_type` and `property` PostgreSQL tables):
   - For each referenced object type, verify it still exists (warn if deleted)
   - For each referenced property, verify it still exists on the object type by querying the `property` table using the object type's `object_type_id` and the property's `api_name`. Warn if removed.
   - For each referenced link type, verify it still exists by querying the `link_type` table. Warn if deleted.

**Response format:**
```json
{
    "actionTypeApiName": "createEmployee",
    "affectedObjectTypes": [
        {
            "apiName": "Employee",
            "exists": true,
            "operations": ["create"],
            "propertiesModified": ["employeeId", "fullName", "salary", "department", "status", "createdAt"]
        }
    ],
    "affectedLinkTypes": [
        { "apiName": "employeeCompany", "exists": true, "operations": ["add"] }
    ],
    "executionStats": {
        "totalExecutions": 1523,
        "last30DayExecutions": 234,
        "successRate": 0.95,
        "lastExecutedAt": "2025-03-14T14:30:00Z"
    },
    "warnings": []
}
```

**Note:** The `dependentResources` field (for Workshop applications, Automate rules, etc.) is NOT included in week 1 because those systems do not exist yet. It will be added when Workshop and Automate integrations are built.

```json
```

If there are warnings (e.g., a referenced object type has been deleted):
```json
{
    "warnings": [
        "Action rule references object type 'OldType' which no longer exists in the Ontology. Executing this action will fail.",
        "Action rule modifies property 'oldField' on 'Employee' which no longer exists. Executing this action will fail."
    ]
}
```

**Test cases:**
```javascript
const impact = await fetch('/api/v1/ontology/ont-1/actionTypes/createEmployee/impact');
const data = await impact.json();
assert(data.affectedObjectTypes.length >= 1);
assert(data.affectedObjectTypes[0].apiName === 'Employee');
assert(data.executionStats.totalExecutions >= 0);
assert(data.warnings.length === 0); // no broken references
```
