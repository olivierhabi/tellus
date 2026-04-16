# TASK 8: Build the Action Execution Orchestrator

**Objective:** Create the master orchestrator that ties together parameter validation, rule compilation, edit application, and audit logging into a single, coherent action execution pipeline. This is the main entry point — when someone calls `POST /api/v1/actions/:actionTypeApiName/apply`, this orchestrator runs all stages in sequence.

Palantir's action execution has 8 documented stages. In week 1, we implement 6 of them (skipping submission criteria and side effects). The orchestrator must track timing for each stage, handle errors at every stage, and always write to the audit log — even for failed executions.

**Create the module** at `src/actions/actionExecutor.js`.

**The module exports a single function:**

```javascript
/**
 * Executes an action: validates parameters, compiles rules, applies edits, and logs to audit.
 * This is the main entry point for all action executions.
 *
 * @param {string} ontologyId - The ontology ID
 * @param {string} actionTypeApiName - The api_name of the action type to execute
 * @param {Object} parameters - The raw parameters provided by the caller
 * @param {Object} context - Execution context: { executedBy, sourceIp, branchId? }
 *
 * @returns {Object} {
 *   success: boolean,
 *   executionId: string,
 *   result: 'success' | 'failed' | 'partial',
 *   failureType: string | null,
 *   errorMessage: string | null,
 *   affectedObjects: Array<{objectType, primaryKey, operation}>,
 *   durationMs: number
 * }
 */
async function executeAction(ontologyId, actionTypeApiName, parameters, context) {
    const startTime = Date.now();
    const executionId = generateUUID();
    let result = { success: false, executionId, result: 'failed', failureType: null, errorMessage: null, affectedObjects: [], durationMs: 0 };

    try {
        // STAGE 1: Load the action type definition
        const actionType = await getActionType(ontologyId, actionTypeApiName);
        if (!actionType) {
            result.failureType = 'unclassified';
            result.errorMessage = `Action type '${actionTypeApiName}' not found`;
            return result;
        }
        if (!actionType.is_enabled) {
            result.failureType = 'unclassified';
            result.errorMessage = `Action type '${actionTypeApiName}' is disabled`;
            return result;
        }

        // STAGE 2: Validate parameters
        const validation = await validateParameters(
            actionType.parameters,
            parameters,
            async (objectType, pk) => {
                // Check if object exists in OpenSearch
                try {
                    await opensearchClient.get({ index: `ontology-${objectType.toLowerCase()}`, id: pk });
                    return true;
                } catch (e) { return false; }
            }
        );
        if (!validation.valid) {
            result.failureType = 'invalid_parameter';
            result.errorMessage = validation.errors.join('; ');
            return result;
        }

        // STAGE 3: Submission criteria (SKIP in week 1 — allow all)

        // STAGE 4: Compile rules into edits
        const compilation = await compileRules(
            actionType.rules,
            validation.resolvedParameters,
            async (objectType, pk) => {
                try {
                    const doc = await opensearchClient.get({ index: `ontology-${objectType.toLowerCase()}`, id: pk });
                    return doc.body._source;
                } catch (e) { return null; }
            },
            { executedBy: context.executedBy || 'system', ontologyId }
        );
        if (compilation.errors.length > 0) {
            result.failureType = compilation.errors[0].includes('does not exist') ? 'object_not_found' :
                                compilation.errors[0].includes('already exists') ? 'duplicate_primary_key' :
                                'unclassified';
            result.errorMessage = compilation.errors.join('; ');
            return result;
        }

        // Check scale limit
        if (compilation.affectedObjectCount > actionType.max_affected_objects) {
            result.failureType = 'scale_limit';
            result.errorMessage = `Action would affect ${compilation.affectedObjectCount} objects, exceeding the limit of ${actionType.max_affected_objects}`;
            return result;
        }

        // STAGE 5: Writeback webhooks (SKIP in week 1)

        // STAGE 6: Apply edits
        const application = await applyEdits(compilation.edits, {
            executionId, actionTypeApiName, parameters: validation.resolvedParameters, executedBy: context.executedBy
        });

        result.success = application.success;
        result.result = application.success ? 'success' : (application.failedEdits.length > 0 ? 'partial' : 'failed');
        result.affectedObjects = application.appliedEdits.map(e => ({ objectType: e.objectType, primaryKey: e.primaryKey, operation: e.operation }));

        // STAGE 7: Side effect webhooks/notifications (SKIP in week 1)

        return result;

    } catch (err) {
        result.failureType = 'unclassified';
        result.errorMessage = err.message;
        return result;

    } finally {
        // STAGE 8: ALWAYS write audit log (even for failures)
        result.durationMs = Date.now() - startTime;
        await logActionExecution({
            action_type_api_name: actionTypeApiName,
            action_type_display_name: (await getActionType(ontologyId, actionTypeApiName))?.display_name || actionTypeApiName,
            execution_id: executionId,
            parameters: parameters,
            affected_objects: result.affectedObjects,
            affected_object_count: result.affectedObjects.length,
            result: result.result,
            failure_type: result.failureType,
            error_message: result.errorMessage,
            duration_ms: result.durationMs,
            executed_by: context.executedBy || 'system',
            source_ip: context.sourceIp || null,
            branch_id: context.branchId || null
        });
    }
}
```

The key behavior to get right: the `finally` block ALWAYS runs. Even if the action fails at Stage 2 (parameter validation), the audit log still records the attempt with `result: 'failed'` and the specific failure type and message. This is critical for security — you need to know when someone is trying to execute actions with bad parameters (could indicate an attack or a misconfigured integration).

**Create the corresponding REST endpoint** at `src/routes/actions.js`:

```
POST /api/v1/actions/:actionTypeApiName/apply
  Body: { "parameters": { ... } }
  Response (success): 200 { "executionId": "...", "result": "success", "affectedObjects": [...], "durationMs": 42 }
  Response (failure): see failureType-to-HTTP mapping below
```

**failureType-to-HTTP status code mapping** (apply this in the route handler when converting `executeAction` results to HTTP responses):

| failureType | HTTP Status | Rationale |
|---|---|---|
| `invalid_parameter` | 400 | Client sent bad input |
| `scale_limit` | 400 | Client request exceeds configured limit |
| `required_property_missing` | 400 | Client omitted a required value |
| `type_mismatch` | 400 | Client sent wrong type |
| `object_not_found` | 404 | Referenced object does not exist |
| `duplicate_primary_key` | 409 | Object already exists |
| `authentication` | 403 | User lacks permission |
| `side_effect` | 502 | External webhook failed |
| `function_failure` | 500 | Internal function error |
| `unclassified` | 500 | Unknown/internal error |
| `null` (action type not found) | 404 | Action type does not exist |
| `null` (action type disabled) | 400 | Action type is disabled |

**Note:** The `/validate` endpoint (dry-run) is defined in Task 19 (`task-19-action-validation-endpoint.md`). Do NOT implement `/validate` in this task to avoid duplicate implementations.

**Import `logActionExecution`** from the audit log database module: `const { logActionExecution } = require('../db/actionAuditLog');`

**Optimization note:** The `finally` block calls `getActionType` a second time to get the `display_name`. To avoid this redundant DB query, cache the action type object from Stage 1 in a variable accessible to the `finally` block:

```javascript
let actionType = null; // declare before try block
try {
    actionType = await getActionType(ontologyId, actionTypeApiName);
    // ... rest of pipeline ...
} finally {
    await logActionExecution({
        action_type_display_name: actionType?.display_name || actionTypeApiName,
        // ... other fields ...
    });
}
```
