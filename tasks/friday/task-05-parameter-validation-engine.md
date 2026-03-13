# TASK 5: Build the Parameter Validation Engine

**Objective:** Create a standalone module that validates action parameters against the action type's parameter schema. This module is used in Stage 1 of the action execution pipeline — before any edits are applied, every parameter provided by the caller must pass validation. This is critical because invalid parameters that slip through would cause data corruption in the Ontology.

Palantir's documentation states that "Invalid parameter failure: The action was submitted with a parameter or parameters that are not valid within the context of the action" is a specific failure type tracked in action metrics. Our implementation must produce clear, specific error messages that tell the caller exactly which parameter failed and why.

**Create the module** at `src/actions/parameterValidator.js`.

**The module exports a single function:**

```javascript
/**
 * Validates action parameters against the action type's parameter schema.
 * 
 * @param {Array} parameterDefinitions - The parameter schema from action_type.parameters
 *   Each element: { apiName, displayName, type, required, objectType?, defaultValue?, constraints? }
 * 
 * @param {Object} providedParameters - The parameters provided by the caller in the action execution request.
 *   Keys are parameter apiNames, values are the provided values.
 *   Example: { "employeeId": "EMP-001", "salary": 150000 }
 * 
 * @param {Function} objectExistsChecker - An async function that takes (objectType, primaryKey) and returns
 *   true if the object exists in OpenSearch, false otherwise. Used to validate 'object_reference' parameters.
 * 
 * @returns {Object} { valid: boolean, errors: Array<string>, resolvedParameters: Object }
 *   - valid: true if all validation passed, false otherwise
 *   - errors: array of human-readable error messages (empty if valid)
 *   - resolvedParameters: the final parameter values after applying defaults and type coercion
 *     This is the object that should be used in subsequent execution stages, not the raw input.
 */
async function validateParameters(parameterDefinitions, providedParameters, objectExistsChecker) {
    // Implementation here
}
```

**Validation rules the function must implement (in this exact order):**

**Step 1: Check for unknown parameters.** If the caller provides a parameter key that doesn't match any `apiName` in the parameter definitions, add error: "Unknown parameter '{key}'. Valid parameters are: {list of valid apiNames}". This prevents typos from being silently ignored.

**Step 2: Check required parameters.** For each parameter definition where `required === true`, verify that the caller provided a non-null, non-undefined value for it. If missing, add error: "Required parameter '{apiName}' ({displayName}) is missing". If the parameter has a `defaultValue`, the default is NOT used for required parameters — the caller must explicitly provide it. (This matches Palantir behavior where required parameters must always be provided even if a default exists.)

**Step 3: Apply default values.** For each parameter definition where `required !== true` and the caller did not provide a value (or provided null/undefined), set the value to `defaultValue` if one exists. If no default exists, the value remains undefined (which is fine — the rule engine will handle optional properties).

**Step 4: Type validation and coercion.** For each provided parameter, validate and coerce the value to match the declared type:

- `string`: Must be a string. If a number is provided, convert to string. If a boolean is provided, convert to "true"/"false". If null is provided for a non-required parameter, keep as null. Max length: 10,000,000 characters (Palantir allows very long strings for text fields).
  
- `boolean`: Must be boolean. Accept "true"/"false" strings and convert. Accept 0/1 numbers and convert. Anything else: error "Parameter '{apiName}' must be a boolean, received: {typeof value}".

- `integer`: Must be a whole number. Accept numeric strings and convert with parseInt. If the result is NaN or has a fractional part, error "Parameter '{apiName}' must be an integer, received: '{value}'". Range: -2147483648 to 2147483647 (32-bit signed integer, matching Java int).

- `long`: Same as integer but range: -9223372036854775808 to 9223372036854775807 (64-bit). Note: JavaScript cannot represent the full long range precisely. Use BigInt for validation, but store as a number in the resolved parameters (for JSON compatibility). If the value exceeds Number.MAX_SAFE_INTEGER, log a warning to `console.warn` but do not reject — the warning is informational only and is not surfaced in the return value (no `warnings` array in the return type).

- `double` / `float`: Must be numeric. Accept numeric strings and convert with parseFloat. NaN and Infinity are not valid: error "Parameter '{apiName}' must be a finite number, received: '{value}'".

- `date`: Must be a string in the format "YYYY-MM-DD". Validate with a regex and check that the date is actually valid (e.g., "2025-02-30" is not valid). Error: "Parameter '{apiName}' must be a valid date in YYYY-MM-DD format, received: '{value}'".

- `timestamp`: Must be a string in ISO 8601 format (e.g., "2025-03-14T10:30:00Z" or "2025-03-14T10:30:00+02:00"). Also accept millisecond timestamps (number) and convert to ISO string. Error: "Parameter '{apiName}' must be a valid ISO 8601 timestamp, received: '{value}'".

- `object_reference`: Must be a string (the primary key of an existing object). Call `objectExistsChecker(paramDef.objectType, value)` to verify the referenced object exists in the Ontology. If it doesn't exist, error "Parameter '{apiName}' references object '{value}' of type '{objectType}' which does not exist in the Ontology".

- `string_array` / `integer_array` / `double_array`: Must be an array. Each element must pass the validation for the base type (string, integer, or double). If any element fails, error "Parameter '{apiName}' array element at index {i} is invalid: {element error}".

- `object_set`: Must be an array of strings (each string being a primary key). No deep validation of object set contents in week 1 — just verify it's an array of strings. Do NOT call `objectExistsChecker` for individual elements (object sets can be large and are resolved lazily in Palantir).

- `struct`: Must be a plain object (not null, not array). No deep validation of struct fields in week 1 — just verify it's an object.

**Null handling for all types:** If `null` is provided for a non-required parameter, keep as `null` in the resolved parameters. This applies to ALL parameter types, not just strings. A `null` value for a non-required parameter means "explicitly set to null / clear this value" and is distinct from `undefined` which means "not provided".

**Step 5: Constraint validation.** For each parameter that has a `constraints` object and passed type validation:

- `regex` (for string types): Test the value against the regex pattern. Error: "Parameter '{apiName}' value '{value}' does not match required pattern '{regex}'".

- `min` (for numeric types): Value must be >= min. Error: "Parameter '{apiName}' value {value} is below minimum {min}".

- `max` (for numeric types): Value must be <= max. Error: "Parameter '{apiName}' value {value} exceeds maximum {max}".

- `minLength` (for string types): String length must be >= minLength. Error: "Parameter '{apiName}' length {length} is below minimum {minLength}".

- `maxLength` (for string types): String length must be <= maxLength. Error: "Parameter '{apiName}' length {length} exceeds maximum {maxLength}".

- `allowedValues` (for string types): Value must be one of the listed values. Error: "Parameter '{apiName}' value '{value}' is not one of the allowed values: {list}".

- `minItems` / `maxItems` (for array types): Array length constraints. Error: "Parameter '{apiName}' has {length} items, expected between {minItems} and {maxItems}".

**Step 6: Return the result.** If any errors were accumulated, return `{ valid: false, errors: [...], resolvedParameters: null }`. If all validation passed, return `{ valid: true, errors: [], resolvedParameters: { ...coerced values with defaults applied... } }`.

**Test cases (must all pass):**

```javascript
const defs = [
    { apiName: 'id', displayName: 'ID', type: 'string', required: true, constraints: { regex: '^EMP-\\d+$' } },
    { apiName: 'name', displayName: 'Name', type: 'string', required: true },
    { apiName: 'salary', displayName: 'Salary', type: 'double', required: false, defaultValue: 0, constraints: { min: 0, max: 10000000 } },
    { apiName: 'active', displayName: 'Active', type: 'boolean', required: false, defaultValue: true },
    { apiName: 'tags', displayName: 'Tags', type: 'string_array', required: false },
];

// Valid input
let result = await validateParameters(defs, { id: 'EMP-001', name: 'Alice', salary: 95000 }, async () => true);
assert(result.valid === true);
assert(result.resolvedParameters.active === true); // default applied
assert(result.resolvedParameters.salary === 95000);

// Missing required
result = await validateParameters(defs, { name: 'Alice' }, async () => true);
assert(result.valid === false);
assert(result.errors[0].includes("Required parameter 'id'"));

// Invalid regex
result = await validateParameters(defs, { id: 'INVALID', name: 'Alice' }, async () => true);
assert(result.valid === false);
assert(result.errors[0].includes("does not match required pattern"));

// Salary too high
result = await validateParameters(defs, { id: 'EMP-001', name: 'Alice', salary: 99999999 }, async () => true);
assert(result.valid === false);
assert(result.errors[0].includes("exceeds maximum"));

// Unknown parameter
result = await validateParameters(defs, { id: 'EMP-001', name: 'Alice', nonexistent: 'x' }, async () => true);
assert(result.valid === false);
assert(result.errors[0].includes("Unknown parameter"));

// Type coercion: string number → double
result = await validateParameters(defs, { id: 'EMP-001', name: 'Alice', salary: '95000' }, async () => true);
assert(result.valid === true);
assert(result.resolvedParameters.salary === 95000);
assert(typeof result.resolvedParameters.salary === 'number');
```
