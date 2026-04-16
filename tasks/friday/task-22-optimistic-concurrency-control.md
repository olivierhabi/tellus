# TASK 22: Build Optimistic Concurrency Control for Edits

**Objective:** Implement optimistic concurrency control (OCC) to prevent lost updates when two users modify the same object simultaneously. Without concurrency control, the "last write wins" — if User A and User B both load an employee's salary (100K), User A changes it to 120K, and User B changes it to 130K, User B's write silently overwrites User A's change. With OCC, User B's request would fail because the object was modified since they last read it.

Palantir uses optimistic concurrency via object versioning. Each object has a `__version` field that increments on every edit. When executing a modify action, the client can optionally provide the expected version. If the current version doesn't match, the action fails with a concurrency conflict.

**Implementation:**

Add a `$expectedVersion` field to the action execution request:
```json
POST /api/v1/actions/updateSalary/apply
{
    "parameters": { "employeeRef": "EMP-001", "newSalary": 150000 },
    "$expectedVersion": 3
}
```

**Scope for week 1:** This feature is scoped to actions affecting a **single object** (single `modifyObject` rule). For multi-object actions (multiple modify rules targeting different objects), version checking is deferred — if `$expectedVersion` is provided for a multi-object action, return a 400 error: "Optimistic concurrency control is only supported for single-object actions in week 1."

**Target object identification:** The `$expectedVersion` applies to the object referenced by the first `modifyObject` rule in the action type's rules array. The object type and primary key are determined by resolving that rule's `objectReference` field against the provided parameters.

If `$expectedVersion` is provided, the action executor (Task 8) must add a version check **during Stage 4** (rule compilation), after the target object is fetched from OpenSearch. Note: this happens during rule compilation, not after "Stage 3" — Stage 3 is submission criteria which is skipped in week 1.

```javascript
// In the action executor, after fetching the target object
if (req.body.$expectedVersion !== undefined) {
    const currentObject = await fetchObject(objectType, primaryKey);
    const currentVersion = currentObject?.__version || 0;
    if (currentVersion !== req.body.$expectedVersion) {
        throw new OntologyError('CONFLICT',
            `Object '${primaryKey}' of type '${objectType}' has been modified since you last read it. ` +
            `Expected version ${req.body.$expectedVersion}, current version ${currentVersion}. ` +
            `Reload the object and try again.`,
            { objectType, primaryKey, expectedVersion: req.body.$expectedVersion, currentVersion }
        );
    }
}
```

The `__version` field must be incremented by the edit applicator (Task 7) when applying `update` operations to OpenSearch:

```javascript
// In the edit applicator, for update operations:
// Use OpenSearch's update with script to atomically increment version
{
    update: { _index: indexName, _id: primaryKey },
    script: {
        source: "ctx._source.__version = (ctx._source.__version ?: 0) + 1; ctx._source.__lastModified = params.now; ctx._source.__editedBy = params.editedBy; for (entry in params.props.entrySet()) { ctx._source[entry.getKey()] = entry.getValue(); }",
        params: {
            now: new Date().toISOString(),
            editedBy: context.executedBy,
            props: propertyValues
        }
    }
}
```

**Implementation approach (use this, not alternatives):** Use the OpenSearch scripted update shown above to atomically increment `__version` in the document. Do NOT use OpenSearch's `if_seq_no` / `if_primary_term` — that is a future optimization. The scripted update approach is more explicit, portable, and easier to debug.

**Test cases:**
```javascript
// Setup: Create employee, note version
const emp = await fetchObject('Employee', 'EMP-001');
const version = emp.__version; // e.g., 1

// User A updates with correct version — succeeds
const resA = await executeWithVersion('updateSalary', { employeeRef: 'EMP-001', newSalary: 120000 }, version);
assert(resA.success === true);

// User B updates with OLD version — fails
const resB = await executeWithVersion('updateSalary', { employeeRef: 'EMP-001', newSalary: 130000 }, version);
assert(resB.success === false);
assert(resB.errorCode === 'CONFLICT');

// User B refreshes, gets new version, retries — succeeds
const empRefreshed = await fetchObject('Employee', 'EMP-001');
const resBRetry = await executeWithVersion('updateSalary', { employeeRef: 'EMP-001', newSalary: 130000 }, empRefreshed.__version);
assert(resBRetry.success === true);
```
