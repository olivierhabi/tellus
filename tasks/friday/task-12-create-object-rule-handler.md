# TASK 12: Build the Full CreateObject Rule Handler

**Objective:** Create the complete implementation of the `createObject` rule type. This is the rule that creates a brand new object in the Ontology with the specified property values. It is the most common rule type — every "Create Employee", "File Tax Return", "Register Business" action uses it.

The handler must orchestrate: resolve property values from parameters/static/computed sources → validate all property types → validate primary key uniqueness → produce the edit record. If ANY step fails, the entire rule fails and no edit is produced.

**Create the module** at `src/actions/rules/createObjectRule.js`.

**How this module is used:** The Rule Compiler (Task 6, `src/actions/ruleCompiler.js`) calls `processCreateObjectRule()` when it encounters a rule with `type: 'createObject'`. The rule compiler delegates all createObject processing to this handler and uses the returned edit record in its merge step.

**Dependencies:**
- `objectExists` from `src/actions/objectChecker.js` (Task 10) — for duplicate PK check
- `validatePropertyValues` from `src/actions/propertyValidator.js` (Task 11) — for property type validation
- `getObjectType` from `src/db/objectTypes.js` — for loading object type schema
- `getProperties` from `src/db/properties.js` — for loading property definitions

**The module exports a single function:**

```javascript
/**
 * Processes a createObject rule and produces an edit record.
 *
 * @param {Object} rule - The rule definition from the action type:
 *   {
 *     type: "createObject",
 *     objectType: "Employee",
 *     properties: {
 *       employeeId: { source: "parameter", param: "id" },
 *       fullName: { source: "parameter", param: "name" },
 *       status: { source: "static", value: "active" },
 *       createdAt: { source: "currentTimestamp" },
 *       createdBy: { source: "currentUser" }
 *     }
 *   }
 *
 * @param {Object} resolvedParameters - The validated parameters from the parameter validator
 * @param {Object} context - { executedBy: string, ontologyId: string }
 *
 * @returns {Promise<Object>} {
 *   edit: { objectType, primaryKey, operation: 'create', propertyValues, linkEdits: [] } | null,
 *   errors: Array<string>
 * }
 */
async function processCreateObjectRule(rule, resolvedParameters, context) {}
```

**Implementation steps (in exact order):**

**Step 1: Load the object type definition.** Query the `object_type` and `property` tables to get the full schema for `rule.objectType`. Cache this within the request using a `schemaCache` Map on the `context` object: `context.schemaCache` is a `Map<string, {objectType, properties}>` that persists across all rule handler calls within a single action execution. The orchestrator (Task 8) initializes `context.schemaCache = new Map()` before processing rules. Check the cache first; only query the database on cache miss. If the object type doesn't exist, return error: "createObject rule references non-existent object type '{objectType}'".

**Step 2: Resolve each property value.** Iterate over `rule.properties`. For each property name and its source definition:

- `source: "parameter"` → Look up `resolvedParameters[source.param]`. If the parameter is undefined (optional, not provided), and the property is not required, SKIP this property entirely (do not include it in the edit — this allows the object to be created without optional properties). If the parameter is undefined and the property IS required, error: "createObject rule maps required property '{propName}' to parameter '{source.param}' which was not provided".

- `source: "static"` → Use `source.value` directly. Validate that the value matches the property's base type using the property validator from Task 11.

- `source: "currentTimestamp"` → Use `new Date().toISOString()`. Only valid for properties of type `timestamp` or `date` (for `date`, truncate to "YYYY-MM-DD").

- `source: "currentUser"` → Use `context.executedBy`. Only valid for `string` properties.

**Step 3: Identify and validate the primary key.** Look up which property is the primary key (from `object_type.primary_key_property_id` → `property.api_name`). The primary key MUST be present in the resolved properties. If missing, error: "createObject rule does not set the primary key property '{pkApiName}' for object type '{objectType}'. The primary key must be set when creating an object."

Extract the primary key value. It must be a non-null, non-empty string (all Palantir primary keys are string-typed at the index level, even if the property is typed as integer — the PK in OpenSearch's `_id` field is always a string).

**Step 4: Check for duplicate primary key.** Call `objectExists(rule.objectType, primaryKeyValue)` from the object checker (Task 10). If the object already exists, return error: "Cannot create object of type '{objectType}' with primary key '{pkValue}' — an object with this primary key already exists. Use a modifyObject rule to update existing objects."

**Step 5: Validate all property values.** Call `validatePropertyValues` from the property validator (Task 11) with `operation = 'create'`. This checks required properties and type correctness. If validation fails, return the errors.

**Step 6: Add system properties.** These are internal properties that Palantir adds to every object but are not defined in the user's property schema:
- `__pk`: The primary key value (string)
- `__objectType`: The object type api_name (string)
- `__lastModified`: Current ISO timestamp (string)
- `__editedBy`: The `context.executedBy` value (string)
- `__version`: `1` (integer — this is a new object, so version starts at 1)

These are NOT included in the `propertyValues` of the edit record (they're not user-facing properties). They are added by the edit applicator (Task 7) when writing to OpenSearch. However, the rule handler should include them in a separate `systemProperties` field so the edit applicator knows to add them.

**Step 7: Produce the edit record.**
```javascript
return {
    edit: {
        objectType: rule.objectType,
        primaryKey: primaryKeyValue,
        operation: 'create',
        propertyValues: coercedValues, // from property validator
        systemProperties: { __pk: primaryKeyValue, __objectType: rule.objectType, __lastModified: now, __editedBy: context.executedBy, __version: 1 },
        linkEdits: []
    },
    errors: []
};
```

**Edge cases to handle:**

1. **Property not in rule but required:** If the object type has a required property that is NOT mentioned in `rule.properties` at all, error: "createObject rule for '{objectType}' does not set required property '{propName}'. All required properties must be set when creating an object."

2. **Property in rule but not in schema:** If `rule.properties` mentions a property that doesn't exist on the object type, error: "createObject rule references property '{propName}' which does not exist on object type '{objectType}'".

3. **Array properties:** If the property is an array type (e.g., `string_array`) and the value is a single string (not an array), wrap it in an array: `"tag"` → `["tag"]`. This is a common usability improvement.

4. **Null handling:** If a property value resolves to `null` for a required property, error. If null for an optional property, include it in the edit (the property will be set to null in OpenSearch, making it queryable with `isNull` filter).

**Test cases:**
```javascript
// Successful create
const result = await processCreateObjectRule(
    { type: 'createObject', objectType: 'Employee', properties: {
        employeeId: { source: 'parameter', param: 'id' },
        fullName: { source: 'parameter', param: 'name' },
        status: { source: 'static', value: 'active' },
        createdAt: { source: 'currentTimestamp' }
    }},
    { id: 'EMP-NEW-001', name: 'Test Person' },
    { executedBy: 'system', ontologyId: 'ont-1' }
);
assert(result.errors.length === 0);
assert(result.edit.operation === 'create');
assert(result.edit.primaryKey === 'EMP-NEW-001');
assert(result.edit.propertyValues.status === 'active');
assert(result.edit.propertyValues.createdAt !== undefined);

// Duplicate PK
// (assuming EMP-001 already exists in OpenSearch)
const dupResult = await processCreateObjectRule(
    { type: 'createObject', objectType: 'Employee', properties: {
        employeeId: { source: 'parameter', param: 'id' },
        fullName: { source: 'parameter', param: 'name' }
    }},
    { id: 'EMP-001', name: 'Duplicate' },
    { executedBy: 'system', ontologyId: 'ont-1' }
);
assert(dupResult.errors.length === 1);
assert(dupResult.errors[0].includes('already exists'));

// Missing required property
const missingResult = await processCreateObjectRule(
    { type: 'createObject', objectType: 'Employee', properties: {
        employeeId: { source: 'parameter', param: 'id' }
        // fullName is required but not set
    }},
    { id: 'EMP-NEW-002' },
    { executedBy: 'system', ontologyId: 'ont-1' }
);
assert(missingResult.errors.length >= 1);
assert(missingResult.errors[0].includes('required'));
```
