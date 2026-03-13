# TASK 13: Build the Full ModifyObject Rule Handler

**Objective:** Create the complete implementation of the `modifyObject` rule type. This rule modifies properties on one or more existing objects. It performs a partial update — only the properties specified in the rule are changed; all other properties retain their current values. This is the most common rule type for operational workflows: "Update status", "Change salary", "Reassign department", "Flag for review".

The key difference from `createObject`: the target object MUST already exist, and only specified properties are changed (not the full object). The rule handler must fetch the current state of the object to verify existence, then produce an edit record containing only the changed properties.

**Create the module** at `src/actions/rules/modifyObjectRule.js`.

**Dependencies:**
- `fetchObject` from `src/actions/objectChecker.js` (Task 10) — for verifying target object exists and fetching its current state
- `validatePropertyValues` from `src/actions/propertyValidator.js` (Task 11) — for property type validation with `operation = 'update'`
- `getObjectType` from `src/db/objectTypes.js` — for loading object type schema (use `context.schemaCache` as described in Task 12)
- `getProperties` from `src/db/properties.js` — for loading property definitions to identify the primary key property

**The module exports:**

```javascript
/**
 * Processes a modifyObject rule and produces an edit record.
 *
 * @param {Object} rule - The rule definition:
 *   {
 *     type: "modifyObject",
 *     objectType: "Employee",
 *     objectReference: { source: "parameter", param: "employeeRef" },
 *     properties: {
 *       salary: { source: "parameter", param: "newSalary" },
 *       updatedAt: { source: "currentTimestamp" }
 *     }
 *   }
 *
 *   The objectReference field identifies WHICH object to modify. It uses the same
 *   source system as property values:
 *   - { source: "parameter", param: "employeeRef" } → the PK comes from the "employeeRef" parameter
 *   - { source: "static", value: "EMP-001" } → hardcoded PK (rare but valid)
 *
 * @param {Object} resolvedParameters - Validated parameters
 * @param {Object} context - { executedBy, ontologyId }
 *
 * @returns {Promise<Object>} { edit: {...} | null, errors: Array<string> }
 */
async function processModifyObjectRule(rule, resolvedParameters, context) {}
```

**Implementation steps:**

**Step 1: Resolve the object reference.** Determine the primary key of the target object from `rule.objectReference` using the same source resolution as property values. If the reference source is `"parameter"`, look up the parameter value. If it's `"static"`, use the hardcoded value. If the reference resolves to null/undefined, error: "modifyObject rule has no object reference — cannot determine which object to modify".

**Step 2: Verify the target object exists.** Call `fetchObject(rule.objectType, primaryKey)`. If null, return error: "modifyObject rule targets object '{primaryKey}' of type '{objectType}' which does not exist in the Ontology. Use a createObject rule to create new objects." This is classified as `object_not_found` failure type in Palantir's metrics.

**Step 3: Resolve property values.** Same logic as createObject (Task 12, Step 2), but with one key difference: for modifyObject, it's perfectly fine for optional parameters to be undefined — those properties simply aren't changed. Only properties with resolved non-undefined values are included in the edit.

Handle the special case where a parameter is explicitly set to `null` — this should SET the property to null (clearing it), which is different from the parameter being undefined (not changing it). In JavaScript, check: `if (paramValue !== undefined)` to include it, even if it's `null`.

**Step 4: Validate property values.** Call `validatePropertyValues` with `operation = 'update'`. This skips required property checks (it's fine to update only salary without providing name) but still validates types.

**Step 5: Check for no-op.** If after resolution, zero properties have values to change, error: "modifyObject rule for object '{primaryKey}' of type '{objectType}' has no properties to update. At least one property must be changed." (Alternatively, you could silently succeed as a no-op — Palantir's behavior is not explicitly documented here. Choose to error for week 1 to catch misconfigured actions.)

**Step 6: Produce the edit record.**
```javascript
return {
    edit: {
        objectType: rule.objectType,
        primaryKey: primaryKey,
        operation: 'update',
        propertyValues: coercedValues,
        systemProperties: { __lastModified: new Date().toISOString(), __editedBy: context.executedBy },
        linkEdits: []
    },
    errors: []
};
```

Note: `__version` is NOT incremented in the edit record — version tracking is handled by OpenSearch's internal versioning. The `__lastModified` and `__editedBy` system properties ARE updated.

**Edge cases:**

1. **Setting a property to null explicitly:** If the parameter is provided as `null` (not undefined), the property should be set to null in the edit. This allows users to "clear" a property value. Example: setting `department` to null to indicate an employee is unassigned. The edit record should include `{ department: null }`. When applied to OpenSearch, this removes the field from the document.

2. **Modifying the primary key:** This should be REJECTED. The primary key is immutable in Palantir. Error: "Cannot modify the primary key property '{pkApiName}' of an existing object. Primary keys are immutable. To change an object's primary key, delete it and create a new object."

3. **Modifying a property not in the rule:** The modify rule only changes properties listed in `rule.properties`. Properties not listed are untouched. The edit record should ONLY contain the changed properties, not the full object.

**Test cases:**
```javascript
// Successful modify
const result = await processModifyObjectRule(
    { type: 'modifyObject', objectType: 'Employee',
      objectReference: { source: 'parameter', param: 'empId' },
      properties: { salary: { source: 'parameter', param: 'newSalary' } } },
    { empId: 'EMP-001', newSalary: 150000 },
    { executedBy: 'system', ontologyId: 'ont-1' }
);
assert(result.errors.length === 0);
assert(result.edit.operation === 'update');
assert(result.edit.propertyValues.salary === 150000);
assert(Object.keys(result.edit.propertyValues).length === 1); // only salary

// Target doesn't exist
const missing = await processModifyObjectRule(
    { type: 'modifyObject', objectType: 'Employee',
      objectReference: { source: 'static', value: 'NONEXISTENT' },
      properties: { salary: { source: 'static', value: 100 } } },
    {},
    { executedBy: 'system', ontologyId: 'ont-1' }
);
assert(missing.errors.length === 1);
assert(missing.errors[0].includes('does not exist'));

// Attempt to modify primary key
const pkModify = await processModifyObjectRule(
    { type: 'modifyObject', objectType: 'Employee',
      objectReference: { source: 'parameter', param: 'empId' },
      properties: { employeeId: { source: 'static', value: 'NEW-ID' } } },
    { empId: 'EMP-001' },
    { executedBy: 'system', ontologyId: 'ont-1' }
);
assert(pkModify.errors.length === 1);
assert(pkModify.errors[0].includes('primary key'));
```
