# TASK 17: Request Validation Middleware

This task has three sub-tasks.

**Depends on:** Task 15 (for `ValidationError` class)

## Objective
Create a reusable request validation middleware that validates URL parameters, query parameters, and request bodies against schemas defined per endpoint. This eliminates repetitive validation code from route handlers and ensures consistent validation behavior across all endpoints.

## Exact Specification

## Sub-task 17A: Create the Validation Middleware

Create a file at `/src/middleware/validator.js` that exports a `validate` function.

The `validate` function takes a schema object and returns an Express middleware function. The schema defines rules for params, query, and body:

```javascript
function validate(schema) {
  return (req, res, next) => {
    const errors = [];
    
    if (schema.params) {
      errors.push(...validateParams(req.params, schema.params));
    }
    if (schema.query) {
      errors.push(...validateQuery(req.query, schema.query));
    }
    if (schema.body) {
      errors.push(...validateBody(req.body, schema.body));
    }
    
    if (errors.length > 0) {
      throw new ValidationError('Request validation failed', { errors });
    }
    
    next();
  };
}
```

**Schema Definition Format:**

```javascript
const createObjectTypeSchema = {
  params: {
    ontologyId: { type: 'uuid', required: true },
  },
  body: {
    apiName: { type: 'string', required: true, pattern: /^[A-Z][a-zA-Z0-9]*$/, maxLength: 100 },
    displayName: { type: 'string', required: true, maxLength: 500 },
    description: { type: 'string', required: false, maxLength: 10000 },
    status: { type: 'enum', values: ['active', 'experimental', 'deprecated'], default: 'active' },
    properties: { type: 'array', required: true, minLength: 1, maxLength: 2000, items: {
      apiName: { type: 'string', required: true, pattern: /^[a-z][a-zA-Z0-9]*$/ },
      displayName: { type: 'string', required: true },
      baseType: { type: 'enum', required: true, values: [
        'string','boolean','integer','long','double','float','date','timestamp',
        'byte','short','decimal','geopoint','geoshape',
        'string_array','integer_array','double_array','boolean_array','timestamp_array','struct'
      ]},
      isRequired: { type: 'boolean', required: false, default: false },
    }},
  }
};
```

**Supported validation types:**

1. `type: 'uuid'` — validate the value is a valid UUID v4 format (8-4-4-4-12 hex characters with dashes). Use regex: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`

2. `type: 'string'` — validate the value is a string. Support optional `pattern` (RegExp), `minLength`, `maxLength`.

3. `type: 'integer'` — validate the value is an integer (not a float). Support optional `min`, `max`.

4. `type: 'double'` — validate the value is a number (integer or float). Support optional `min`, `max`.

5. `type: 'boolean'` — validate the value is a boolean (true or false, not "true" or "false" strings).

**Query parameter type coercion:** Since Express parses all query parameters as strings, the validator must automatically coerce string values to the declared type before validation when validating `req.query`. Specifically: `'42'` becomes `42` for `type: 'integer'`, `'3.14'` becomes `3.14` for `type: 'double'`, `'true'`/`'false'` become `true`/`false` for `type: 'boolean'`. This coercion applies ONLY to query parameters, not to body fields.

6. `type: 'enum'` — validate the value is one of the specified `values` array.

7. `type: 'array'` — validate the value is an array. Support optional `minLength`, `maxLength`, and `items` (schema for each element in the array). When `items` is provided, validate EVERY element against the items schema and collect all errors.

8. `type: 'object'` — validate the value is a plain object (not null, not an array). Support optional `properties` (schema for each key).

For every validation type:
- If `required: true` and the value is `undefined`, `null`, or missing, add an error: `{ field: "fieldName", message: "fieldName is required" }`
- If `required: false` and the value is missing, SKIP validation for this field (don't apply pattern/min/max checks on missing optional fields)
- If `default` is specified and the value is missing, SET the value on the request object to the default before continuing

**Error collection:**

Collect ALL validation errors, don't stop at the first one. This allows the caller to fix all issues at once instead of playing whack-a-mole:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": {
      "errors": [
        { "field": "body.apiName", "message": "apiName must match pattern /^[A-Z][a-zA-Z0-9]*$/" },
        { "field": "body.properties[0].baseType", "message": "baseType must be one of: string, boolean, integer, ..." },
        { "field": "body.properties[2].apiName", "message": "apiName is required" }
      ]
    }
  }
}
```

Note the field paths use dot notation with array indices: `body.properties[0].baseType`. This tells the caller exactly where the error is.

**Usage in route handlers:**

```javascript
router.post(
  '/ontology/:ontologyId/objectTypes',
  validate(createObjectTypeSchema),
  asyncHandler(async (req, res) => {
    // If we reach here, req.body is validated and defaults are applied
    // No need for any validation code in the handler
  })
);
```

---

## Sub-task 17B: Create Validation Schema Definitions

**Depends on:** Sub-task 17A

**Create schema definitions for ALL existing endpoints:**

Write schema objects for every existing endpoint in the codebase. Store them in `/src/schemas/` with one file per route group:
- `/src/schemas/ontology.js` — createOntology, updateOntology
- `/src/schemas/objectTypes.js` — createObjectType, updateObjectType, addProperty, updateProperty
- `/src/schemas/datasources.js` — registerDatasource, triggerIndex
- `/src/schemas/queries.js` — search, aggregate, fullTextSearch
- `/src/schemas/links.js` — createLinkType, searchAround
- `/src/schemas/actions.js` — createActionType, applyAction, validateAction
- `/src/schemas/interfaces.js` — createInterface, updateInterface, implementInterface

Each schema file exports named constants for each endpoint's schema.

---

## Sub-task 17C: Apply Validation Middleware to All Route Handlers

**Depends on:** Sub-task 17A, Sub-task 17B

Import schemas and `validate` middleware into each route file. Add `validate(schemaName)` as middleware to each route definition. Remove any hand-written validation code that is now redundant (i.e., validation that is fully covered by the schema).

**Acceptance criteria:** Every route handler has validation middleware applied. No hand-written validation remains for fields covered by schemas.

## Verification
1. Apply validation middleware to a POST endpoint → send valid request → verify it reaches the handler
2. Send request with missing required field → verify 400 with field-specific error
3. Send request with invalid UUID in URL → verify 400 with params error
4. Send request with 3 validation errors → verify ALL 3 appear in the errors array (not just the first)
5. Send request with missing optional field that has a default → verify the default is applied (check req.body)
6. Send request with array that has an invalid element at index 2 → verify error path shows `body.properties[2].fieldName`
7. Verify every existing endpoint has a schema defined and the middleware applied
