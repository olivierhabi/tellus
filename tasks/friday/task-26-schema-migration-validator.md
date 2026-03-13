# TASK 26: Build Action Type Schema Migration Validator

**Objective:** When an action type's parameters or rules are updated (via PUT endpoint from Task 4), validate that the changes are backward-compatible with existing audit log entries and pending edits. If an action type removes a parameter that existing audit entries reference, or changes a rule's target object type, this could cause confusion when reviewing historical audit logs. The validator warns about breaking changes but doesn't prevent them — it's a safety net for the Ontology Manager UI.

**Create the module** at `src/actions/schemaMigrationValidator.js`.

**The module exports:**

```javascript
/**
 * Validates that changes to an action type schema are safe.
 * @param {Object} currentSchema - The current action type definition (from DB)
 * @param {Object} proposedSchema - The proposed updates
 * @param {Object} recentExecutionStats - Optional stats from the audit log for detection #5:
 *   { maxAffectedCount: number } — the maximum affected_object_count from recent executions.
 *   The caller (PUT route handler in src/routes/actionTypes.js) queries this from the audit log:
 *   SELECT MAX(affected_object_count) as max FROM action_audit_log
 *   WHERE action_type_api_name = $1 AND executed_at > now() - interval '30 days'
 * @returns {Object} { safe: boolean, warnings: Array<string>, breakingChanges: Array<string> }
 *   - safe: true when BOTH warnings and breakingChanges arrays are empty, false otherwise.
 *   - warnings: non-blocking issues (detections 1, 2, and 5)
 *   - breakingChanges: significant behavioral changes (detections 3 and 4)
 */
function validateSchemaMigration(currentSchema, proposedSchema, recentExecutionStats = null) {}
```

**This task modifies two files:**
1. `src/actions/schemaMigrationValidator.js` — the new validator module (created by this task)
2. `src/routes/actionTypes.js` — the existing PUT endpoint (from Task 4) is modified to call the validator

**Breaking changes to detect:**

1. **Removed required parameter:** If the current schema has a required parameter that's not in the proposed schema, warn: "Required parameter '{apiName}' is being removed. Historical audit log entries referencing this parameter will still show the old parameter name." This is a warning, not a block — the action type can still be updated.

2. **Parameter type change:** If a parameter's type changes (e.g., string → integer), warn: "Parameter '{apiName}' type is changing from '{oldType}' to '{newType}'. This may cause existing integrations to fail."

3. **Rule target object type change:** If a rule's `objectType` changes, warn: "Rule {index} target changed from '{oldType}' to '{newType}'. This is a significant behavioral change."

4. **Primary key property change in createObject rule:** If a createObject rule changes which property it uses as the primary key, warn: "createObject rule for '{objectType}' changed its primary key property. New objects will use a different identifier pattern."

5. **maxAffectedObjects reduction:** If the limit is reduced and the audit log shows recent executions exceeding the new limit, warn: "maxAffectedObjects reduced from {old} to {new}. {count} recent executions exceeded the new limit and would fail under the new schema."

**Integration with the PUT endpoint** (Task 4): Before applying the update, call this validator. Include the warnings in the response body so the UI can display them:

```json
{
    "updated": true,
    "actionType": { ... },
    "migrationWarnings": [
        "Required parameter 'department' is being removed..."
    ]
}
```

**Test cases:**
```javascript
const current = {
    parameters: [
        { apiName: 'empId', type: 'string', required: true },
        { apiName: 'dept', type: 'string', required: true }
    ],
    rules: [{ type: 'createObject', objectType: 'Employee', properties: { employeeId: { source: 'parameter', param: 'empId' } } }]
};
const proposed = {
    parameters: [
        { apiName: 'empId', type: 'integer', required: true } // type changed, dept removed
    ],
    rules: [{ type: 'createObject', objectType: 'Contractor', properties: { contractorId: { source: 'parameter', param: 'empId' } } }] // objectType changed
};

const result = validateSchemaMigration(current, proposed);
assert(result.safe === false);
assert(result.warnings.some(w => w.includes('dept')));
assert(result.warnings.some(w => w.includes('type is changing')));
assert(result.breakingChanges.some(w => w.includes('target changed')));
```
