# TASK 19 OF 30: Request Body Validation Middleware

**Objective:** Create reusable request body validation middleware that checks required fields, types, and constraints before the request reaches the service layer. This prevents invalid data from reaching the database.

**Step-by-step instructions:**

Create src/middleware/validateBody.js.

**Export 1: validateBody(schema) factory function**

Returns an Express middleware function `(req, res, next)`. The `schema` parameter is an object where keys are field names and values are validation rule objects.

Schema format:
```javascript
{
  fieldName: {
    required: true|false,    // is this field required?
    type: 'string',          // expected typeof: 'string', 'number', 'boolean', 'object'
    minLength: 1,            // for strings: minimum character length
    maxLength: 256,          // for strings: maximum character length
    min: 0,                  // for numbers: minimum value
    max: 10000,              // for numbers: maximum value
    enum: ['a', 'b'],        // value must be one of these
    default: false           // default value if field is missing and not required
  }
}
```

Middleware behavior:
1. Collect ALL validation errors (not just the first one).
2. For each key in schema:
   - If `required: true` and the field is `undefined` or `null` in `req.body`: add error `"Field '{fieldName}' is required."`
   - If the field is present:
     - Type check: `typeof req.body[fieldName]` must match `schema[fieldName].type`. If not: add error `"Field '{fieldName}' must be of type {type}. Got: {actual typeof}."`
     - String length: if `minLength` defined and `value.length < minLength`: add error `"Field '{fieldName}' must be at least {minLength} characters."`
     - String length: if `maxLength` defined and `value.length > maxLength`: add error `"Field '{fieldName}' must be at most {maxLength} characters."`
     - Number range: if `min` defined and `value < min`: add error `"Field '{fieldName}' must be at least {min}."`
     - Number range: if `max` defined and `value > max`: add error `"Field '{fieldName}' must be at most {max}."`
     - Enum: if `enum` defined and value is not in the array: add error `"Field '{fieldName}' must be one of: {enum.join(', ')}. Got: '{value}'."`
3. If any errors were collected: call `sendError(res, 'VALIDATION_FAILED', errors.join(' '))` with HTTP 400. Do NOT call `next()`.
4. If no errors: for each field with a `default` value, if the field is missing from `req.body`, set `req.body[fieldName] = default`. Then call `next()`.

**Export 2: Pre-built schemas**

```javascript
const CREATE_ONTOLOGY_SCHEMA = {
  displayName: { required: true, type: 'string', minLength: 1, maxLength: 256 },
  description: { required: false, type: 'string' }
};

const CREATE_OBJECT_TYPE_SCHEMA = {
  apiName: { required: true, type: 'string', minLength: 1, maxLength: 256 },
  displayName: { required: true, type: 'string', minLength: 1, maxLength: 256 },
  description: { required: false, type: 'string' },
  icon: { required: false, type: 'string', default: 'cube' },
  iconColor: { required: false, type: 'string', default: '#1565C0' },
  status: { required: false, type: 'string', enum: ['active', 'experimental', 'deprecated'], default: 'active' }
};

const CREATE_PROPERTY_SCHEMA = {
  apiName: { required: true, type: 'string', minLength: 1, maxLength: 256 },
  displayName: { required: true, type: 'string', minLength: 1, maxLength: 256 },
  baseType: { required: true, type: 'string' },
  description: { required: false, type: 'string' },
  structSchema: { required: false, type: 'object' },
  isRequired: { required: false, type: 'boolean', default: false },
  ordinal: { required: false, type: 'number', min: 0, max: 10000, default: 0 }
};

const REGISTER_DATASOURCE_SCHEMA = {
  datasetName: { required: true, type: 'string', minLength: 1, maxLength: 256 },
  filePath: { required: true, type: 'string', minLength: 1 },
  fileFormat: { required: true, type: 'string', enum: ['csv', 'json'] },
  columnMapping: { required: true, type: 'object' }
};
```

**Exports:** `validateBody`, `CREATE_ONTOLOGY_SCHEMA`, `CREATE_OBJECT_TYPE_SCHEMA`, `CREATE_PROPERTY_SCHEMA`, `REGISTER_DATASOURCE_SCHEMA`.

**Files to create:** src/middleware/validateBody.js

**Verification:**
- `POST /api/v1/ontologies` with empty body → 400 with `"Field 'displayName' is required."`
- `POST /api/v1/ontologies` with `{"displayName": 123}` → 400 with `"Field 'displayName' must be of type string."`
- `POST /api/v1/ontologies` with `{"displayName": ""}` → 400 with `"Field 'displayName' must be at least 1 characters."`
- `POST .../properties` with `{"apiName": "foo", "displayName": "Foo", "baseType": "string"}` → passes validation, `isRequired` defaults to `false`, `ordinal` defaults to `0`
- `POST` with multiple invalid fields → error message contains ALL field errors (not just the first)
