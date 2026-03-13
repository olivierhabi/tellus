# TASK 14: Build the Full DeleteObject Rule Handler

**Objective:** Create the implementation of the `deleteObject` rule type. This rule removes an object from the Ontology. The object must exist — attempting to delete a non-existent object is an error. Deletion is "soft" in the edit store (the edit record stays forever for audit purposes) but "hard" in OpenSearch (the document is removed from the index).

In Palantir, deletion has important implications: any links pointing to or from the deleted object become "dangling" — the link still exists in the link type's join table or foreign key, but the target/source object is gone. Our implementation should NOT automatically clean up dangling links in week 1 — that's a complex cascade operation that Palantir handles through their link consistency checks. We just delete the object and note a warning if it has links.

**Create the module** at `src/actions/rules/deleteObjectRule.js`.

```javascript
/**
 * Processes a deleteObject rule.
 *
 * @param {Object} rule - { type: "deleteObject", objectType: "Employee", 
 *                          objectReference: { source: "parameter", param: "employeeRef" } }
 * @param {Object} resolvedParameters
 * @param {Object} context - { executedBy, ontologyId }
 * @returns {Promise<Object>} { edit: {...} | null, errors: Array<string>, warnings: Array<string> }
 */
async function processDeleteObjectRule(rule, resolvedParameters, context) {}
```

**Implementation steps:**

**Step 1: Resolve object reference** to get the primary key. Same as modifyObject.

**Step 2: Verify existence.** Call `fetchObject`. If null, error: "deleteObject rule targets object '{pk}' of type '{objectType}' which does not exist".

**Step 3: Check for linked objects (warning, not error).** Load all link type definitions from the `link_type` PostgreSQL table where either `source_object_type_api_name` or `target_object_type_api_name` matches the object being deleted. Use `const { getLinkTypesByObjectType } = require('../../db/linkTypes')`.

For FK-based links (ONE_TO_MANY): Query OpenSearch for documents where the FK property equals this object's primary key. For example, if `Employee.companyId` is a FK and we're deleting Company `COMP-001`, search `ontology-employee` for documents where `companyId = 'COMP-001'`.

For many-to-many links: Query the `link_edit` table for active (non-removed) links where this object is either the source or target. An active link is one where the net count of `add` operations minus `remove` operations for the same source/target pair is positive.

If any linked objects are found, add warning: "Deleting object '{pk}' will create {count} dangling links of type '{linkTypeApiName}'. Linked objects will retain their foreign key values but the target object will no longer exist."

This is a WARNING, not an error. The deletion should still proceed. The caller can check warnings and decide whether to also clean up links via additional rules.

**Note on return shape:** This handler returns `{ edit, errors, warnings }` with a `warnings` array, which is different from the `{ edit, errors }` shape returned by createObject (Task 12) and modifyObject (Task 13) handlers. The Rule Compiler (Task 6) must check for and propagate the `warnings` array when processing deleteObject rules. Warnings should be collected and returned in the `compileRules` result alongside `edits` and `errors`.

**Step 4: Produce the edit record.**
```javascript
return {
    edit: {
        objectType: rule.objectType,
        primaryKey: primaryKey,
        operation: 'delete',
        propertyValues: null,
        systemProperties: null,
        linkEdits: []
    },
    errors: [],
    warnings: warnings
};
```

**Test cases:**
```javascript
// Successful delete
const result = await processDeleteObjectRule(
    { type: 'deleteObject', objectType: 'Employee',
      objectReference: { source: 'parameter', param: 'empId' } },
    { empId: 'EMP-001' },
    { executedBy: 'system', ontologyId: 'ont-1' }
);
assert(result.errors.length === 0);
assert(result.edit.operation === 'delete');

// After applying the edit, verify object is gone from OpenSearch
await applyEdits([result.edit], { executionId: 'exec-del', actionTypeApiName: 'deleteEmployee', parameters: {}, executedBy: 'system' });
const exists = await objectExists('Employee', 'EMP-001');
assert(exists === false);

// But the edit record still exists in PostgreSQL (audit trail)
const history = await getEditHistory('Employee', 'EMP-001');
assert(history.some(e => e.operation === 'delete'));

// Delete non-existent
const missing = await processDeleteObjectRule(
    { type: 'deleteObject', objectType: 'Employee',
      objectReference: { source: 'static', value: 'NONEXISTENT' } },
    {},
    { executedBy: 'system', ontologyId: 'ont-1' }
);
assert(missing.errors.length === 1);
```
