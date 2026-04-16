# TASK 4: Create the Action Type CRUD REST API Endpoints

**Objective:** Build the complete set of REST API endpoints for creating, reading, updating, and deleting action type definitions. These endpoints are what the Ontology Manager UI (in week 2) will call, and what developers use directly via API to configure actions in the Ontology. The endpoints must validate all input thoroughly — an invalid action type definition should never be saved to the database because it would cause failures at execution time that are much harder to debug.

**Create a new Express router file** at `src/routes/actionTypes.js` and register it in the main `src/server.js` file under the path prefix `/api/v1/ontology/:ontologyId/actionTypes`.

**Endpoint 1: POST /api/v1/ontology/:ontologyId/actionTypes (Create Action Type)**

This endpoint creates a new action type definition in the Ontology. It must perform comprehensive validation before persisting to the database. The request body must be a JSON object with the following structure:

```json
{
    "apiName": "createEmployee",
    "displayName": "Create Employee",
    "description": "Creates a new employee record in the system with the provided details.",
    "parameters": [
        {
            "apiName": "employeeId",
            "displayName": "Employee ID",
            "type": "string",
            "required": true,
            "constraints": { "regex": "^EMP-\\d{6}$" }
        },
        {
            "apiName": "fullName",
            "displayName": "Full Name",
            "type": "string",
            "required": true
        },
        {
            "apiName": "department",
            "displayName": "Department",
            "type": "string",
            "required": false,
            "defaultValue": "Unassigned"
        },
        {
            "apiName": "salary",
            "displayName": "Annual Salary",
            "type": "double",
            "required": false,
            "constraints": { "min": 0, "max": 10000000 }
        }
    ],
    "rules": [
        {
            "type": "createObject",
            "objectType": "Employee",
            "properties": {
                "employeeId": { "source": "parameter", "param": "employeeId" },
                "fullName": { "source": "parameter", "param": "fullName" },
                "department": { "source": "parameter", "param": "department" },
                "salary": { "source": "parameter", "param": "salary" }
            }
        }
    ],
    "maxAffectedObjects": 10000
}
```

**Validation rules (all must pass before saving):**

1. `apiName` must be a non-empty string matching `^[a-zA-Z][a-zA-Z0-9_]{0,99}$` (starts with letter, alphanumeric and underscores, max 100 chars). Return 400 with message "apiName must start with a letter and contain only letters, numbers, and underscores (max 100 characters)" if invalid.

2. `apiName` must not already exist in this ontology. Query the `action_type` table to check. Return 409 (Conflict) with message "Action type with apiName '{apiName}' already exists in this ontology" if duplicate.

3. `displayName` must be a non-empty string, max 200 characters. Return 400 if invalid.

4. `parameters` must be an array (can be empty). Each parameter element must have:
   - `apiName`: non-empty string, unique within the parameters array. Return 400 "Duplicate parameter apiName: '{name}'" if duplicate.
   - `displayName`: non-empty string
   - `type`: must be one of: `'string'`, `'boolean'`, `'integer'`, `'long'`, `'double'`, `'float'`, `'date'`, `'timestamp'`, `'object_reference'`, `'object_set'`, `'string_array'`, `'integer_array'`, `'double_array'`, `'struct'`. Return 400 "Invalid parameter type '{type}' for parameter '{apiName}'. Must be one of: ..." if invalid.
   - `required`: optional boolean, defaults to false
   - `objectType`: required if type is `'object_reference'` or `'object_set'`. Must reference an existing object type in this ontology. Query the `object_type` table to verify. Return 400 "Parameter '{apiName}' has type 'object_reference' but references non-existent object type '{objectType}'" if invalid.
   - `constraints`: optional object. Validate that constraint types match the parameter type (e.g., `regex` only valid for string, `min`/`max` only valid for numeric types).

5. `rules` must be a non-empty array (an action with no rules is meaningless). Each rule must have a `type` field that is one of: `'createObject'`, `'modifyObject'`, `'deleteObject'`, `'addLink'`, `'removeLink'`. Return 400 if invalid.

6. For each rule, validate the `objectType` references an existing object type. Return 400 "Rule references non-existent object type '{objectType}'" if invalid.

7. For `createObject` and `modifyObject` rules, validate that each property name in the `properties` object corresponds to an actual property on the referenced object type. Query the `property` table for that object type and verify each property api_name exists. Return 400 "Rule references non-existent property '{propName}' on object type '{objectType}'" if invalid.

8. For each property mapping in rules, the `source` must be one of: `'parameter'` (value comes from an action parameter), `'static'` (hardcoded value), `'currentTimestamp'` (set to current time), `'currentUser'` (set to the executing user's ID). If source is `'parameter'`, the `param` field must reference an existing parameter by `apiName`. Return 400 if the referenced parameter doesn't exist.

9. `maxAffectedObjects` must be a positive integer, max 100,000. Defaults to 10,000 if not provided.

**On success:** Return 201 with the full action type object including the generated `action_type_id` and `created_at` timestamp.

**On validation failure:** Return 400 with a JSON body: `{ "error": "VALIDATION_ERROR", "message": "Human-readable error message", "details": { ... } }`

**On conflict:** Return 409 with: `{ "error": "CONFLICT", "message": "Action type with apiName 'X' already exists" }`

**Endpoint 2: GET /api/v1/ontology/:ontologyId/actionTypes (List Action Types)**

Returns all action types for the given ontology. No pagination needed for week 1 (action type counts are small — typically dozens, not thousands). Return as an array sorted by `created_at` ascending.

Response format:
```json
{
    "data": [
        {
            "actionTypeId": "uuid",
            "apiName": "createEmployee",
            "displayName": "Create Employee",
            "description": "...",
            "parameters": [...],
            "rules": [...],
            "maxAffectedObjects": 10000,
            "isEnabled": true,
            "createdAt": "2025-03-14T10:00:00Z",
            "updatedAt": "2025-03-14T10:00:00Z"
        }
    ]
}
```

**Endpoint 3: GET /api/v1/ontology/:ontologyId/actionTypes/:apiName (Get Single Action Type)**

Returns a single action type by its `apiName`. If not found, return 404 with: `{ "error": "NOT_FOUND", "message": "Action type 'X' not found in this ontology" }`.

Response format: The raw action type object (e.g., `{ "actionTypeId": "uuid", "apiName": "createEmployee", ... }`), NOT wrapped in a `data` array or any other wrapper object.

**Endpoint 4: PUT /api/v1/ontology/:ontologyId/actionTypes/:apiName (Update Action Type)**

Updates an existing action type. The request body can contain any subset of: `displayName`, `description`, `parameters`, `rules`, `submissionCriteria`, `sideEffects`, `maxAffectedObjects`, `isEnabled`. Fields not included in the request body are not modified. The `apiName` cannot be changed (it's the identifier).

**JSONB field replacement semantics:** When `parameters` or `rules` are included in the PUT body, they FULLY REPLACE the existing array (not merge). For example, if the current action type has 3 parameters and the PUT body includes `"parameters": [param1, param2]`, the result has exactly 2 parameters. This is because partial array merging is ambiguous (how to match elements?). Scalar fields like `displayName` replace individually as expected.

Apply the same validation rules as the create endpoint for any fields that are being updated. If parameters or rules are updated, re-validate all cross-references (parameter references in rules, object type references, property references). For object type and property validation (rules 6 and 7), import from the existing database access modules: `const { getObjectType } = require('../db/objectTypes')` and `const { getProperties } = require('../db/properties')`.

Return 200 with the updated action type object. Return 404 if the action type doesn't exist. Return 400 if validation fails.

**Endpoint 5: DELETE /api/v1/ontology/:ontologyId/actionTypes/:apiName (Delete Action Type)**

Deletes an action type definition. This does NOT undo any edits previously made by this action type — those edits are permanent in the `ontology_edit` table and the audit log.

Return 204 (No Content) on success. Return 404 if not found.

**Register the router** in `src/server.js`:
```javascript
const actionTypeRoutes = require('./routes/actionTypes');
app.use('/api/v1/ontology/:ontologyId/actionTypes', actionTypeRoutes);
```

Make sure the `:ontologyId` parameter is accessible in the route handlers. In Express, you may need to use `{ mergeParams: true }` when creating the Router.

**Test the complete CRUD cycle:**
1. POST to create "createEmployee" action type → expect 201
2. POST again with same apiName → expect 409
3. GET list → expect array with 1 element
4. GET by apiName → expect the created action type
5. PUT to update displayName → expect 200 with updated name
6. PUT to add a new parameter → expect 200
7. DELETE → expect 204
8. GET by apiName → expect 404
