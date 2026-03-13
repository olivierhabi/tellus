# TASK 11: Build the Property Type Validator for Edit Values

**Objective:** Create a module that validates property values against the property definitions of an object type. When an action creates or modifies an object, every property value must match the declared type of that property. This module is separate from the parameter validator (Task 5) — the parameter validator checks action INPUT parameters, while this module checks the RESOLVED property values that will be written to the Ontology.

The distinction matters: an action parameter might be a `string` that maps to a property of type `integer` via a static mapping in the rule. The parameter validator ensures the input string is valid; this module ensures the resulting integer value is valid for the property.

Palantir's documentation on required properties (https://www.palantir.com/docs/foundry/object-link-types/required-properties/) states: "Validation happens when data is being indexed into the object: The check for null values happens as backing datasources are indexed into Object Storage." and "Changes via actions are validated at apply time: If you attempt to write a null or empty value to a property via an action, the action will fail to execute."

This means our property validator runs at TWO points: (1) during action execution (Task 8), and (2) during indexing from a backing datasource (Task 2's indexer). The same validation logic should be shared.

**Create the module** at `src/actions/propertyValidator.js`.

**The module exports:**

```javascript
/**
 * Validates a set of property values against an object type's property definitions.
 *
 * @param {string} objectTypeApiName - The object type being validated against
 * @param {Object} propertyValues - Keys are property apiNames, values are the values to validate
 * @param {string} operation - 'create' or 'update'. For 'create', required properties must be present.
 *                             For 'update', only provided properties are validated (partial update).
 * @param {Array} propertyDefinitions - The property definitions from the database (property table rows)
 *
 * @returns {Object} { valid: boolean, errors: Array<string>, coercedValues: Object }
 */
function validatePropertyValues(objectTypeApiName, propertyValues, operation, propertyDefinitions) {}
```

**Validation rules implemented by this function:**

**1. Required property check (create only).** When `operation === 'create'`, check that every property definition where `is_required === true` has a non-null, non-undefined value in `propertyValues`. The primary key property is always implicitly required for create operations. Error: "Required property '{displayName}' ({apiName}) must have a value when creating a {objectTypeApiName} object".

For `operation === 'update'`, required property checks are NOT performed — you're allowed to update a subset of properties without providing all required ones. However, if a required property IS included in the update and set to null, that should fail: "Cannot set required property '{apiName}' to null on {objectTypeApiName}".

**2. Unknown property check.** If `propertyValues` contains a key that doesn't match any property `apiName` in the definitions, error: "Unknown property '{key}' on object type '{objectTypeApiName}'. Valid properties are: {list}".

**3. Type validation per property.** For each property value provided, validate it matches the property's `base_type`:

- `string`: Must be a string or null. Max length 10MB (Palantir doesn't document a specific limit, but this is reasonable). If a number or boolean is provided, coerce to string.

- `boolean`: Must be boolean. Accept "true"/"false" strings. Error if anything else.

- `integer`: Must be whole number in range [-2147483648, 2147483647]. Accept numeric strings, reject floats. Coerce valid strings to numbers.

- `long`: Must be whole number in range [-9007199254740991, 9007199254740991] (JavaScript safe integer range — in production you'd use BigInt but for week 1 this is sufficient). Accept numeric strings.

- `double` / `float`: Must be finite number. Accept numeric strings. Reject NaN and Infinity.

- `date`: Must be string in "YYYY-MM-DD" format. Validate the date is real (no Feb 30th). Use regex `^\d{4}-\d{2}-\d{2}$` plus Date parsing to verify.

- `timestamp`: Must be ISO 8601 string or numeric millisecond timestamp. Coerce numeric to ISO string.

- `byte`: Integer in range [-128, 127].

- `short`: Integer in range [-32768, 32767].

- `decimal`: Must be finite number. Accept numeric strings. No range limit (arbitrary precision in theory, but JavaScript double in practice).

- `geopoint`: Must be an object with exactly `{ lat: number, lon: number }` where lat is in [-90, 90] and lon is in [-180, 180]. This matches OpenSearch's geo_point format. Also accept `{ latitude: number, longitude: number }` and normalize to `{ lat, lon }`.

- `geoshape`: Must be a valid GeoJSON object with a `type` field that is one of: "Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon". Validate that the `coordinates` field exists and is an array. Deep validation of coordinate arrays is optional for week 1.

- `string_array`: Must be an array where every element is a string (or coercible to string). Must not contain null elements. For week 1, empty arrays are always allowed — the `allowEmptyArrays: false` constraint (which Palantir supports as a per-property configuration in the property definition) is deferred to a future iteration. When implemented, it would be a boolean field on the `property` table row.

- `integer_array`, `double_array`, `boolean_array`, `timestamp_array`: Same pattern — must be an array where every element passes the base type validation.

- `struct`: Must be a plain JavaScript object (not null, not array, not a primitive). If the property definition has `struct_schema` defined (a JSONB field listing the expected sub-fields), validate that all required sub-fields are present and that sub-field types match. If `struct_schema` is null, accept any object. Each sub-field in the schema has `{ fieldName, type, required }` — recurse the same type validation for each sub-field. For week 1, limit struct recursion to 5 levels deep; if a struct is nested deeper than 5 levels, return an error: "Struct nesting exceeds maximum depth of 5 levels for property '{apiName}'".

**4. Return coerced values.** The returned `coercedValues` object contains the validated values with any type coercions applied (e.g., string "123" coerced to integer 123, lat/longitude normalized to lat/lon). This is the object that should be written to the edit store and OpenSearch — never the raw input.

**Test cases spanning every type:**

```javascript
const propDefs = [
    { api_name: 'id', base_type: 'string', is_required: true },
    { api_name: 'count', base_type: 'integer', is_required: false },
    { api_name: 'score', base_type: 'double', is_required: false },
    { api_name: 'active', base_type: 'boolean', is_required: false },
    { api_name: 'created', base_type: 'timestamp', is_required: false },
    { api_name: 'birthday', base_type: 'date', is_required: false },
    { api_name: 'location', base_type: 'geopoint', is_required: false },
    { api_name: 'tags', base_type: 'string_array', is_required: false },
    { api_name: 'metadata', base_type: 'struct', is_required: false },
];

// Valid create
let r = validatePropertyValues('TestObj', { id: 'T-001', count: 5, score: 3.14, active: true, tags: ['a','b'] }, 'create', propDefs);
assert(r.valid === true);

// Missing required on create
r = validatePropertyValues('TestObj', { count: 5 }, 'create', propDefs);
assert(r.valid === false);
assert(r.errors[0].includes("Required property"));

// Missing required OK on update
r = validatePropertyValues('TestObj', { count: 10 }, 'update', propDefs);
assert(r.valid === true);

// Type mismatch
r = validatePropertyValues('TestObj', { id: 'T-001', count: 3.14 }, 'create', propDefs);
assert(r.valid === false);
assert(r.errors[0].includes("must be an integer"));

// Geopoint validation
r = validatePropertyValues('TestObj', { id: 'T-001', location: { lat: -1.9403, lon: 29.8739 } }, 'create', propDefs);
assert(r.valid === true);

r = validatePropertyValues('TestObj', { id: 'T-001', location: { lat: 100, lon: 29 } }, 'create', propDefs);
assert(r.valid === false);
assert(r.errors[0].includes("lat"));

// String coercion
r = validatePropertyValues('TestObj', { id: 'T-001', count: '42' }, 'create', propDefs);
assert(r.valid === true);
assert(r.coercedValues.count === 42);
```
