# TASK 15: Build the AddLink and RemoveLink Rule Handlers

**Objective:** Create the implementations for `addLink` and `removeLink` rule types. These rules manage many-to-many relationships between objects. For one-to-many links (which use foreign key properties), linking is done through `modifyObject` rules that set the FK property — no separate link rule is needed. But many-to-many links require a join table, and these rules manage entries in that join table.

In Palantir's documentation: "You can also create objects and linked many-to-many at the same time. While just creating a many-to-many link requires objects on both sides of the link to exist prior, you can create both entities via one action type." (https://www.palantir.com/docs/foundry/action-types/rules/)

This means: if an action has a `createObject` rule creating Object A, and an `addLink` rule linking A to existing Object B, this should work — the link rule should use the same execution context to find the newly-created-but-not-yet-indexed object.

**Create the module** at `src/actions/rules/linkRules.js`.

```javascript
/**
 * Processes an addLink rule.
 * @param {Object} rule - { type: "addLink", linkType: "employeeProjects",
 *                          sourceObject: { source: "parameter", param: "empRef" },
 *                          targetObject: { source: "parameter", param: "projRef" } }
 * @param {Object} resolvedParameters
 * @param {Object} context
 * @param {Array} pendingEdits - Edits produced by earlier rules in the same action 
 *                               (to detect objects being created in the same action)
 * @returns {Promise<Object>} { linkEdit: {...} | null, errors: [] }
 */
async function processAddLinkRule(rule, resolvedParameters, context, pendingEdits) {}

/**
 * Processes a removeLink rule.
 * Same signature as addLink.
 */
async function processRemoveLinkRule(rule, resolvedParameters, context, pendingEdits) {}
```

**This task produces two exported functions** because `addLink` and `removeLink` are symmetric operations on the same data structure. They share the same module file, the same cardinality-handling logic, and the same dependency on link type definitions.

**Return shape:** Both functions use a unified return shape:
```javascript
// For MANY_TO_MANY cardinality:
{ linkEdit: { linkTypeApiName, sourcePrimaryKey, targetPrimaryKey, operation: 'add'|'remove' }, edit: null, errors: [], warnings: [] }

// For ONE_TO_MANY / MANY_TO_ONE cardinality:
{ linkEdit: null, edit: { objectType, primaryKey, operation: 'update', propertyValues: { fkProp: value } }, errors: [], warnings: [] }
```
The Rule Compiler (Task 6) must check BOTH `linkEdit` and `edit` fields and handle them accordingly — `linkEdit` goes into the source object's `linkEdits` array, and `edit` goes into the regular edits list.

**Cross-task dependency:** The Rule Compiler (Task 6) must pass `pendingEdits` (the list of edits produced by earlier rules in the same action execution) to link rule handlers. This requires updating the compiler to accumulate edits as it processes rules and pass them forward.

**Implementation for addLink:**

**Step 1: Load link type definition** from PostgreSQL. Get the cardinality, source/target object types, and join configuration.

**Step 2: Resolve source and target object references** to get their primary keys.

**Step 3: Verify both objects exist.** Check OpenSearch first. If not found in OpenSearch, check if either object is being CREATED in the same action execution (search `pendingEdits` for a `create` operation with matching objectType and primaryKey). If found in neither, error: "addLink rule: source object '{pk}' of type '{type}' does not exist".

**Step 4: Handle based on cardinality:**

For `MANY_TO_MANY`:
- Record a link edit: `{ linkTypeApiName, sourcePrimaryKey, targetPrimaryKey, operation: 'add' }`
- This will be stored in the `link_edit` PostgreSQL table and, in production, also appended to the join table dataset.
- Check for duplicate links: query the `link_edit` table using `SELECT operation, COUNT(*) FROM link_edit WHERE link_type_api_name = $1 AND source_primary_key = $2 AND target_primary_key = $3 GROUP BY operation`. Compute net state: if `count(add) - count(remove) > 0`, the link is currently active. If active, add warning (not error): "Link already exists between '{source}' and '{target}' via '{linkType}'".

For `ONE_TO_MANY` / `MANY_TO_ONE`:
- Determine which side of the link type holds the foreign key by checking `linkType.foreign_key_property_api_name` and `linkType.foreign_key_object_type_api_name`. The FK is always on the "many" side of the relationship. For example, in a Company→Employee ONE_TO_MANY link, `Employee.companyId` is the FK.
- Convert to a `modifyObject` edit that sets the FK property on the object that holds the FK: `{ objectType: 'Employee', primaryKey: sourcePK, operation: 'update', propertyValues: { companyId: targetPK } }`.
- This is returned as a regular edit, not a link edit, because FK-based links are just properties.

**Implementation for removeLink:**

Same as addLink but:
- For `MANY_TO_MANY`: Record `operation: 'remove'` in link_edit table.
- For `ONE_TO_MANY`: Set the FK property to `null` via a modifyObject edit.
- Verify the link actually exists before removing. If it doesn't, error: "removeLink rule: no link exists between '{source}' and '{target}' via '{linkType}'".

**Test cases:**
```javascript
// Add a many-to-many link
const addResult = await processAddLinkRule(
    { type: 'addLink', linkType: 'employeeProjects',
      sourceObject: { source: 'parameter', param: 'empId' },
      targetObject: { source: 'parameter', param: 'projId' } },
    { empId: 'EMP-001', projId: 'PRJ-001' },
    { executedBy: 'system', ontologyId: 'ont-1' },
    [] // no pending edits
);
assert(addResult.errors.length === 0);
assert(addResult.linkEdit.operation === 'add');

// Add link where source is being created in same action
const addWithPending = await processAddLinkRule(
    { type: 'addLink', linkType: 'employeeProjects',
      sourceObject: { source: 'parameter', param: 'newEmpId' },
      targetObject: { source: 'parameter', param: 'projId' } },
    { newEmpId: 'EMP-NEW', projId: 'PRJ-001' },
    { executedBy: 'system', ontologyId: 'ont-1' },
    [{ objectType: 'Employee', primaryKey: 'EMP-NEW', operation: 'create', propertyValues: { employeeId: 'EMP-NEW' } }]
);
assert(addWithPending.errors.length === 0); // Should succeed because EMP-NEW is in pendingEdits

// Remove non-existent link
const removeResult = await processRemoveLinkRule(
    { type: 'removeLink', linkType: 'employeeProjects',
      sourceObject: { source: 'static', value: 'EMP-001' },
      targetObject: { source: 'static', value: 'PRJ-NONEXISTENT' } },
    {},
    { executedBy: 'system', ontologyId: 'ont-1' },
    []
);
assert(removeResult.errors.length === 1);
```
