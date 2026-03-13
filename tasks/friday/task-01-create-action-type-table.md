# TASK 1: Create the `action_type` PostgreSQL Table

**Objective:** Create the database table that stores action type definitions. This table is the schema registry for all actions in the Ontology. Every action that users or AI agents can execute must have a corresponding row in this table. The table must store the action's parameters (what inputs the caller must provide), rules (what edits the action performs), submission criteria (who can execute it), and side effect configuration (webhooks and notifications).

**Exact SQL to execute:**

Connect to PostgreSQL database `ontology_db` and execute the following DDL statement. Do NOT modify the column names, types, or constraints — these are designed to exactly mirror how Palantir structures action type definitions internally based on their public documentation.

```sql
CREATE TABLE IF NOT EXISTS action_type (
    action_type_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ontology_id UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
    api_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT DEFAULT '',
    
    -- Parameters: defines the inputs the caller must provide when executing this action.
    -- This is a JSON array of parameter definition objects. Each parameter has:
    --   apiName (string, required): The machine-readable name used in API calls, e.g., "employeeId"
    --   displayName (string, required): The human-readable label shown in UIs, e.g., "Employee ID"
    --   type (string, required): The data type of the parameter. Must be one of:
    --     'string', 'boolean', 'integer', 'long', 'double', 'float', 'date', 'timestamp',
    --     'object_reference' (a primary key of an existing object),
    --     'object_set' (a filter that resolves to a set of objects),
    --     'string_array', 'integer_array', 'double_array',
    --     'struct' (a nested JSON object with a defined schema)
    --   required (boolean, default false): Whether the parameter must be provided
    --   objectType (string, optional): For 'object_reference' and 'object_set' types, specifies which object type
    --   defaultValue (any, optional): The default value if the parameter is not provided
    --   constraints (object, optional): Validation constraints like { "regex": "^EMP-\\d{6}$", "min": 0, "max": 1000000 }
    parameters JSONB NOT NULL DEFAULT '[]'::jsonb,
    
    -- Rules: defines the logic that transforms parameters into Ontology edits.
    -- This is a JSON array of rule objects. Each rule has a "type" field and type-specific fields.
    -- Supported rule types (from Palantir docs):
    --   "createObject": Creates a new object of a specified type
    --   "modifyObject": Modifies properties on one or more existing objects
    --   "deleteObject": Deletes one or more existing objects
    --   "addLink": Creates a many-to-many link between two objects
    --   "removeLink": Removes a many-to-many link between two objects
    -- When multiple rules exist, Palantir's backend "compiles rules to generate a single edit per object"
    -- This means if Rule A sets property X to "A" and Rule B sets property X to "B" on the same object,
    -- the final result is property X = "B" (last rule wins).
    rules JSONB NOT NULL DEFAULT '[]'::jsonb,
    
    -- Submission criteria: defines who can execute this action.
    -- For week 1, this will be null (anyone can execute any action).
    -- In production, this would contain conditions like:
    --   { "type": "userInGroup", "groupId": "tax-auditors" }
    --   { "type": "parameterCondition", "param": "amount", "operator": "lt", "value": 10000 }
    submission_criteria JSONB DEFAULT NULL,
    
    -- Side effects: webhooks and notifications triggered after successful execution.
    -- For week 1, this will be null (no side effects).
    -- Structure when implemented:
    --   { "webhooks": [...], "notifications": [...] }
    side_effects JSONB DEFAULT NULL,
    
    -- Maximum number of objects that can be affected by a single execution of this action.
    -- Palantir default is 10,000. If an action would affect more objects, it fails with a "scale limit failure".
    -- This is documented in Palantir's Action Metrics page under failure types.
    max_affected_objects INTEGER NOT NULL DEFAULT 10000,
    
    -- Whether this action is enabled. Disabled actions cannot be executed but remain in the schema.
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    
    -- Timestamps for audit and management purposes
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT DEFAULT 'system',
    
    -- Ensure action type API names are unique within an ontology.
    -- Just as you cannot have two object types with the same api_name, you cannot have two action types
    -- with the same api_name in the same ontology.
    CONSTRAINT uq_action_type_api_name UNIQUE (ontology_id, api_name)
);

-- Create indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_action_type_ontology ON action_type(ontology_id);
CREATE INDEX IF NOT EXISTS idx_action_type_api_name ON action_type(api_name);

-- Add a comment explaining the table's purpose
COMMENT ON TABLE action_type IS 'Stores action type definitions for the Ontology. Each action type defines a parameterized, auditable set of changes that can be applied to objects, properties, and links. Mirrors Palantir Foundry action type schema.';
```

**After executing the SQL, create a database access module** at `src/db/actionTypes.js` that exports these functions:

1. `createActionType(ontologyId, actionTypeDef)` — Inserts a new row. Validates that `ontologyId` exists in the `ontology` table. Validates that `api_name` matches the pattern `^[a-zA-Z][a-zA-Z0-9_]*$` (alphanumeric with underscores, starting with a letter). Returns the full row including the generated `action_type_id`.

2. `getActionType(ontologyId, apiName)` — Retrieves a single action type by ontology ID and API name. Returns null if not found.

3. `listActionTypes(ontologyId)` — Returns all action types for a given ontology, ordered by `created_at` ascending.

4. `updateActionType(ontologyId, apiName, updates)` — Updates specified fields on an existing action type. Only allows updating: `display_name`, `description`, `parameters`, `rules`, `submission_criteria`, `side_effects`, `max_affected_objects`, `is_enabled`. Always sets `updated_at` to `now()`. Returns the updated row.

5. `deleteActionType(ontologyId, apiName)` — Deletes an action type. Returns true if deleted, false if not found.

**Each function must:**
- Use parameterized queries (never string interpolation) to prevent SQL injection
- Use the existing PostgreSQL pool. Check the existing codebase for the import pattern — look for `src/db/db.js` or `src/db/pool.js` and import accordingly. If the pool is exported from `src/db/db.js`, use `const { pool } = require('./db')`. If from `src/db/pool.js`, use `const pool = require('./pool')`.
- Return plain JavaScript objects (not raw pg Result objects)
- Throw descriptive errors with HTTP-appropriate status codes (e.g., `{ status: 404, message: 'Action type not found' }`)

**Test case to verify:** After creating this table and module, the following code should work without errors:
```javascript
const actionType = await createActionType('ontology-uuid-here', {
    apiName: 'createEmployee',
    displayName: 'Create Employee',
    description: 'Creates a new employee in the system',
    parameters: [
        { apiName: 'employeeId', displayName: 'Employee ID', type: 'string', required: true },
        { apiName: 'fullName', displayName: 'Full Name', type: 'string', required: true }
    ],
    rules: [
        { type: 'createObject', objectType: 'Employee', properties: { employeeId: { source: 'parameter', param: 'employeeId' }, fullName: { source: 'parameter', param: 'fullName' } } }
    ]
});
console.log(actionType.action_type_id); // UUID
console.log(actionType.api_name); // 'createEmployee'

// Test getActionType
const fetched = await getActionType('ontology-uuid-here', 'createEmployee');
assert(fetched !== null);
assert(fetched.api_name === 'createEmployee');

// Test listActionTypes
const list = await listActionTypes('ontology-uuid-here');
assert(list.length >= 1);

// Test updateActionType
const updated = await updateActionType('ontology-uuid-here', 'createEmployee', { display_name: 'Create New Employee' });
assert(updated.display_name === 'Create New Employee');

// Test deleteActionType
const deleted = await deleteActionType('ontology-uuid-here', 'createEmployee');
assert(deleted === true);

// Verify deletion
const afterDelete = await getActionType('ontology-uuid-here', 'createEmployee');
assert(afterDelete === null);
```
