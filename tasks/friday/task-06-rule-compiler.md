# TASK 6: Build the Rule Compiler

**Objective:** Create a module that takes an action type's rules array and a set of resolved parameters, and compiles them into a flat list of Ontology edits (creates, updates, deletes). This is Stage 4 of Palantir's action execution pipeline.

Palantir's documentation states: "When multiple rules are defined, the actions backend compiles rules to generate a single edit per object (e.g., Add object, Modify object(s), or Delete object(s)). For example, if the result of one rule updates a property to 'A', but another rule in the same action type updates the same object's property to 'B', the resulting edit would just update the property to 'B'." (https://www.palantir.com/docs/foundry/action-types/rules/)

This means the compiler must:
1. Process each rule in order, generating preliminary edits
2. Merge all edits targeting the same object (same objectType + primaryKey) into a single edit
3. For conflicts on the same property, the LAST rule's value wins
4. Return the final list of merged edits

**Create the module** at `src/actions/ruleCompiler.js`.

**The module exports a single function:**

```javascript
/**
 * Compiles action rules into a list of Ontology edits.
 *
 * @param {Array} rules - The rules array from the action type definition.
 *   Each rule has a "type" and type-specific fields.
 * 
 * @param {Object} resolvedParameters - The validated and coerced parameters from the parameter validator.
 * 
 * @param {Function} objectFetcher - An async function (objectType, primaryKey) => object | null
 *   Used by modifyObject and deleteObject rules to fetch the current state of the target object.
 *   Returns the full object from OpenSearch, or null if not found.
 * 
 * @returns {Object} { 
 *   edits: Array<{objectType, primaryKey, operation, propertyValues, linkEdits}>,
 *   errors: Array<string>,
 *   affectedObjectCount: number
 * }
 *   - edits: The compiled list of edits, one per affected object (merged)
 *   - errors: Any errors encountered during compilation (e.g., referenced object not found)
 *   - affectedObjectCount: Total number of unique objects affected
 */
async function compileRules(rules, resolvedParameters, objectFetcher, executionContext) {
    // Implementation here
}
```

**Parameter definitions:**
- `objectFetcher(objectType, primaryKey)` — Returns the full object from OpenSearch, or null if not found. This function is used ONLY for fetching existing objects (for modifyObject and deleteObject rules). Schema lookups (object type definitions, properties, link types) are handled by the direct database imports listed in the "Database dependencies" section below — NOT through objectFetcher.
- `executionContext` — An object `{ executedBy: string, ontologyId: string }` providing ambient values needed during compilation:
  - `executedBy` is used to resolve `source: "currentUser"` property mappings (hardcoded to `'system'` in week 1).
  - `ontologyId` is used to look up object type and link type definitions from the database.

**Database dependencies:** The rule compiler needs to look up schemas from the database. Import these directly:
```javascript
const { getObjectType } = require('../db/objectTypes');
const { getProperties } = require('../db/properties');
const { getLinkType } = require('../db/linkTypes');
```
- `getObjectType(ontologyId, objectTypeApiName)` — Returns the object type definition including `primary_key_property_id`.
- `getProperties(objectTypeId)` — Returns all property definitions for an object type, used to determine which property is the primary key.
- `getLinkType(ontologyId, linkTypeApiName)` — Returns the link type definition including cardinality (`MANY_TO_MANY`, `ONE_TO_MANY`, `MANY_TO_ONE`), source/target object types, and for FK-based links, the `foreign_key_property_api_name` indicating which property on which object type holds the foreign key.

```javascript
```

**Supported rule types and how to compile each one:**

**Rule type: `createObject`**
```json
{
    "type": "createObject",
    "objectType": "Employee",
    "properties": {
        "employeeId": { "source": "parameter", "param": "employeeId" },
        "fullName": { "source": "parameter", "param": "fullName" },
        "department": { "source": "parameter", "param": "department" },
        "salary": { "source": "parameter", "param": "salary" },
        "createdAt": { "source": "currentTimestamp" },
        "status": { "source": "static", "value": "active" }
    }
}
```

Compilation steps:
1. Resolve each property value based on its `source`:
   - `"parameter"`: Look up `resolvedParameters[rule.properties[propName].param]`. If the parameter is undefined (optional and not provided), skip this property (do not include it in the edit).
   - `"static"`: Use the hardcoded `value` field directly.
   - `"currentTimestamp"`: Use `new Date().toISOString()`.
   - `"currentUser"`: Use `executionContext.executedBy` (hardcoded to 'system' in week 1).
2. Determine the primary key: Look up the object type definition from the database to find which property is the primary key. The primary key property MUST be present in the resolved properties. If missing, add error "createObject rule for type '{objectType}' does not include the primary key property '{pkPropName}'".
3. Generate edit: `{ objectType: "Employee", primaryKey: "EMP-999", operation: "create", propertyValues: { ...resolved props }, linkEdits: [] }`

**Rule type: `modifyObject`**
```json
{
    "type": "modifyObject",
    "objectType": "Employee",
    "objectReference": { "source": "parameter", "param": "employeeRef" },
    "properties": {
        "salary": { "source": "parameter", "param": "newSalary" },
        "updatedAt": { "source": "currentTimestamp" }
    }
}
```

Compilation steps:
1. Resolve the object reference to get the primary key of the target object. The `objectReference` uses the same `source` system as property values.
2. Call `objectFetcher(objectType, primaryKey)` to verify the object exists. If it doesn't, add error "modifyObject rule targets object '{primaryKey}' of type '{objectType}' which does not exist".
3. Resolve each property value (same as createObject).
4. Generate edit: `{ objectType: "Employee", primaryKey: "EMP-001", operation: "update", propertyValues: { salary: 150000, updatedAt: "2025-03-14T..." }, linkEdits: [] }`

**Rule type: `deleteObject`**
```json
{
    "type": "deleteObject",
    "objectType": "Employee",
    "objectReference": { "source": "parameter", "param": "employeeRef" }
}
```

Compilation steps:
1. Resolve the object reference to get the primary key.
2. Call `objectFetcher` to verify the object exists. If not, add error.
3. Generate edit: `{ objectType: "Employee", primaryKey: "EMP-001", operation: "delete", propertyValues: null, linkEdits: [] }`

**Rule type: `addLink`**
```json
{
    "type": "addLink",
    "linkType": "employeeProjects",
    "sourceObject": { "source": "parameter", "param": "employeeRef" },
    "targetObject": { "source": "parameter", "param": "projectRef" }
}
```

Compilation steps:
1. Resolve both source and target object references to get their primary keys.
2. Look up the link type definition from the database using `getLinkType(executionContext.ontologyId, rule.linkType)`. This returns the cardinality, source/target object types, and for FK-based links, the `foreign_key_property_api_name`.
3. For many-to-many links (cardinality is `MANY_TO_MANY`): Generate a link edit entry. This is appended to the `linkEdits` array of the source object's edit: `{ linkTypeApiName: "employeeProjects", targetPrimaryKey: "PRJ-001", operation: "add" }`.
4. For one-to-many links (cardinality is `ONE_TO_MANY` or `MANY_TO_ONE`): Instead of a link edit, generate a modifyObject edit that sets the foreign key property. Determine which side holds the FK by checking `linkType.foreign_key_property_api_name` — the FK is always on the "many" side of the relationship. For example, if the link uses `Employee.companyId` as the FK, generate: `{ objectType: "Employee", primaryKey: "EMP-001", operation: "update", propertyValues: { companyId: "COMP-001" } }`.

**Rule type: `removeLink`** — Same as addLink but with `operation: "remove"` in linkEdits, or sets the FK property to null for FK-based links.

**The merge step (CRITICAL):**

After all rules are processed, you may have multiple edits targeting the same object. These must be merged:

```javascript
// Example: Rule 1 creates Employee EMP-999 with {name: "Alice", salary: 100000}
//          Rule 2 modifies Employee EMP-999 with {salary: 120000, department: "Eng"}
// 
// After merge: Single edit for EMP-999:
//   operation: "create" (create takes precedence over modify for same object)
//   propertyValues: {name: "Alice", salary: 120000, department: "Eng"}
//   (salary from Rule 2 overrides Rule 1)
```

Merge rules:
- If there's a `create` and a `modify` for the same object: keep `create` as the operation, merge property values (later rule values override earlier ones).
- If there's a `create` and a `delete` for the same object: this is an error — "Conflicting rules: cannot create and delete the same object '{primaryKey}' in one action".
- If there's a `modify` and a `delete` for the same object: keep `delete` (delete takes precedence — the modifications are moot since the object is being removed).
- Multiple `modify` rules for the same object: merge all property values, later rules override earlier ones for the same property.
- Link edits for the same object: concatenate all link edits.

**Test cases:**

```javascript
// Single create rule
let result = await compileRules(
    [{ type: 'createObject', objectType: 'Employee', properties: {
        employeeId: { source: 'parameter', param: 'id' },
        fullName: { source: 'parameter', param: 'name' },
        status: { source: 'static', value: 'active' },
        createdAt: { source: 'currentTimestamp' }
    }}],
    { id: 'EMP-999', name: 'Alice' },
    async () => null, // objectFetcher not needed for create
    { executedBy: 'system', ontologyId: 'ont-1' }
);
assert(result.edits.length === 1);
assert(result.edits[0].operation === 'create');
assert(result.edits[0].propertyValues.employeeId === 'EMP-999');
assert(result.edits[0].propertyValues.status === 'active');
assert(result.edits[0].propertyValues.createdAt !== undefined);

// Merge test: two rules modifying same object
result = await compileRules(
    [
        { type: 'modifyObject', objectType: 'Employee', objectReference: { source: 'static', value: 'EMP-001' },
          properties: { salary: { source: 'static', value: 100000 } } },
        { type: 'modifyObject', objectType: 'Employee', objectReference: { source: 'static', value: 'EMP-001' },
          properties: { salary: { source: 'static', value: 120000 }, department: { source: 'static', value: 'Eng' } } }
    ],
    {},
    async (type, pk) => ({ employeeId: pk, fullName: 'Existing', salary: 90000 }),
    { executedBy: 'system', ontologyId: 'ont-1' }
);
assert(result.edits.length === 1); // merged into one edit
assert(result.edits[0].propertyValues.salary === 120000); // last rule wins
assert(result.edits[0].propertyValues.department === 'Eng');

// deleteObject rule
result = await compileRules(
    [{ type: 'deleteObject', objectType: 'Employee', objectReference: { source: 'static', value: 'EMP-001' } }],
    {},
    async (type, pk) => ({ employeeId: pk, fullName: 'Existing' }),
    { executedBy: 'system', ontologyId: 'ont-1' }
);
assert(result.edits.length === 1);
assert(result.edits[0].operation === 'delete');

// create + delete conflict should error
result = await compileRules(
    [
        { type: 'createObject', objectType: 'Employee', properties: { employeeId: { source: 'static', value: 'EMP-NEW' }, fullName: { source: 'static', value: 'Test' } } },
        { type: 'deleteObject', objectType: 'Employee', objectReference: { source: 'static', value: 'EMP-NEW' } }
    ],
    {},
    async () => null,
    { executedBy: 'system', ontologyId: 'ont-1' }
);
assert(result.errors.length >= 1);
assert(result.errors[0].includes('Conflicting'));

// modify + delete for same object: delete wins
result = await compileRules(
    [
        { type: 'modifyObject', objectType: 'Employee', objectReference: { source: 'static', value: 'EMP-001' },
          properties: { salary: { source: 'static', value: 200000 } } },
        { type: 'deleteObject', objectType: 'Employee', objectReference: { source: 'static', value: 'EMP-001' } }
    ],
    {},
    async (type, pk) => ({ employeeId: pk, fullName: 'Existing', salary: 100000 }),
    { executedBy: 'system', ontologyId: 'ont-1' }
);
assert(result.edits.length === 1);
assert(result.edits[0].operation === 'delete');
```
