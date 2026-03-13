# TASK 23: Build the Action Type Cloning Endpoint

**Objective:** Create an endpoint that clones an existing action type to create a new one with a different name. This is a convenience feature for the Ontology Manager UI — when building similar action types (e.g., "Create Employee" and "Create Contractor"), it's faster to clone and modify than to recreate from scratch. The cloned action type gets a new API name, a new UUID, and the `created_at` is set to now.

**Add endpoint** to `src/routes/actionTypes.js`:

```
POST /api/v2/ontology/:ontologyId/actionTypes/:apiName/clone
Body: { "newApiName": "createContractor", "newDisplayName": "Create Contractor" }
```

**Implementation:**
1. Fetch the source action type by `apiName`.
2. If not found, return 404.
3. Validate `newApiName` follows the naming rules (Task 4, validation rule 1).
4. Check `newApiName` doesn't already exist (Task 4, validation rule 2).
5. Create a new action type with ALL fields copied from the source, except:
   - `action_type_id`: new UUID
   - `api_name`: the `newApiName` from the request
   - `display_name`: the `newDisplayName` from the request (or "Copy of {original}" if not provided)
   - `created_at` and `updated_at`: set to now
6. Return 201 with the new action type.

The cloned action type is completely independent of the original — subsequent changes to either one don't affect the other. This is a deep copy of the `parameters`, `rules`, `submission_criteria`, and `side_effects` JSONB fields. The `is_enabled` field is copied from the source action type (i.e., cloning a disabled action type produces a disabled clone). The `max_affected_objects` field is also copied.

**Test cases:**
```javascript
// Clone createEmployee → createContractor
const res = await fetch('/api/v2/ontology/ont-1/actionTypes/createEmployee/clone', {
    method: 'POST',
    body: JSON.stringify({ newApiName: 'createContractor', newDisplayName: 'Create Contractor' })
});
assert(res.status === 201);
const cloned = await res.json();
assert(cloned.apiName === 'createContractor');
assert(cloned.displayName === 'Create Contractor');
// Parameters and rules should be identical to the original
const original = await getActionType('ont-1', 'createEmployee');
assert(JSON.stringify(cloned.parameters) === JSON.stringify(original.parameters));
assert(JSON.stringify(cloned.rules) === JSON.stringify(original.rules));
// But IDs are different
assert(cloned.actionTypeId !== original.action_type_id);
```
