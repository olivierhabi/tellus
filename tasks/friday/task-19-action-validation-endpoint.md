# TASK 19: Build Action Validation Endpoint (Dry Run)

**Objective:** Build the `/validate` endpoint that runs the full action execution pipeline WITHOUT actually applying edits. This is critical for UIs — it lets users preview what an action will do before committing. In Palantir, this is used by Workshop's action forms to show validation errors in real-time as the user fills in parameters, and to show a preview of affected objects before the user clicks "Submit".

**Add endpoint** to `src/routes/actions.js`:

```
POST /api/v2/actions/:actionTypeApiName/validate
```

Request body: identical to `/apply`.

**Implementation:** Create a separate `validateAction` function (do NOT reuse `executeAction` with a flag). This function runs Stages 1, 2, and 4 of the execution pipeline. Stage 3 (submission criteria) is intentionally skipped in week 1 because it is not yet implemented — add a `// TODO: Add submission criteria check here when implemented` comment. Stage 6 (edit application) and Stage 8 (audit logging) are not executed.

**Where does `ontologyId` come from?** The action execution routes (`/api/v2/actions/:actionTypeApiName/...`) do NOT include `:ontologyId` in the URL path. For week 1, use the default ontology: query the `ontology` table for the single ontology and use its ID. In the route handler: `const ontologyId = await getDefaultOntologyId();` where `getDefaultOntologyId` returns the ID of the first (and only) ontology.

**HTTP status codes:**
- Action type not found: return **404** (not 400), consistent with `ACTION_TYPE_NOT_FOUND` error code from Task 20.
- Validation passed: return **200**.
- Parameter validation failed: return **400**.
- Rule compilation errors: return **400**.

```javascript
async function validateAction(ontologyId, actionTypeApiName, parameters, context) {
    // Run stages 1-4 only
    const actionType = await getActionType(ontologyId, actionTypeApiName);
    if (!actionType) return { valid: false, errors: ['Action type not found'] };

    const validation = await validateParameters(actionType.parameters, parameters, objectExistsChecker);
    if (!validation.valid) return { valid: false, errors: validation.errors };

    const compilation = await compileRules(actionType.rules, validation.resolvedParameters, objectFetcher);
    if (compilation.errors.length > 0) return { valid: false, errors: compilation.errors };

    if (compilation.affectedObjectCount > actionType.max_affected_objects) {
        return { valid: false, errors: [`Would affect ${compilation.affectedObjectCount} objects (limit: ${actionType.max_affected_objects})`] };
    }

    return {
        valid: true,
        errors: [],
        preview: {
            affectedObjectCount: compilation.affectedObjectCount,
            edits: compilation.edits.map(e => ({
                objectType: e.objectType,
                primaryKey: e.primaryKey,
                operation: e.operation,
                properties: e.operation !== 'delete' ? Object.keys(e.propertyValues || {}) : []
            }))
        }
    };
}
```

Response format:

Success (200):
```json
{
    "valid": true,
    "preview": {
        "affectedObjectCount": 1,
        "edits": [
            { "objectType": "Employee", "primaryKey": "EMP-001", "operation": "update", "properties": ["salary"] }
        ]
    }
}
```

Failure (400):
```json
{
    "valid": false,
    "errors": ["Required parameter 'employeeId' is missing"]
}
```

**Test cases:**
```javascript
// Valid action preview
const valid = await fetch('/api/v2/actions/updateSalary/validate', {
    method: 'POST', body: JSON.stringify({ parameters: { employeeRef: 'EMP-001', newSalary: 150000 } })
});
assert(valid.status === 200);
const body = await valid.json();
assert(body.valid === true);
assert(body.preview.affectedObjectCount === 1);

// Invalid parameters
const invalid = await fetch('/api/v2/actions/updateSalary/validate', {
    method: 'POST', body: JSON.stringify({ parameters: {} })
});
assert(invalid.status === 400);
const errBody = await invalid.json();
assert(errBody.valid === false);
assert(errBody.errors.length > 0);

// CRITICAL: Verify no edits were applied (dry run)
// The object should NOT have been modified
const emp = await fetchObject('Employee', 'EMP-001');
assert(emp.salary !== 150000); // salary should be unchanged
```
