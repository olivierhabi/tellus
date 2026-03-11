# TASK 7 OF 30: Palantir Type System Implementation

**Objective:** Create the type system utility defining all 23 Palantir base types with their OpenSearch mappings, validation functions, and CSV coercion functions. This module is imported by property creation (Task 15), struct validation (Task 22), column mapping validation (Task 23), and the file scanner (Task 24). Reference: https://www.palantir.com/docs/foundry/object-link-types/base-types/.

**Step-by-step instructions:**

Create src/utils/typeSystem.js. Define a `TYPE_DEFINITIONS` object where each key is a base_type string and each value has:
- `opensearchMapping` (object): the exact JSON for OpenSearch PUT mapping
- `validate(value)` (function): returns `{valid: true}` or `{valid: false, error: "message"}`
- `coerceFromString(raw)` (function): converts a CSV string value to the typed JavaScript value, or throws an Error with a descriptive message

**All 23 types with their exact OpenSearch mappings and behavior:**

1. **string**: mapping `{"type":"text","fields":{"keyword":{"type":"keyword","ignore_above":32766}}}`. Validate: any string or null. Coerce: trim whitespace, `""` → null.

2. **boolean**: mapping `{"type":"boolean"}`. Validate: `true`, `false`, or null. Coerce: `"true"/"TRUE"/"1"/"yes"` → true, `"false"/"FALSE"/"0"/"no"` → false, `""` → null. Anything else → throw `"Cannot coerce '{raw}' to boolean"`.

3. **integer**: mapping `{"type":"integer"}`. Validate: whole number in range -2,147,483,648 to 2,147,483,647, or null. Coerce: `parseInt(raw, 10)`, verify result is within range and `!isNaN`, `""` → null.

4. **long**: mapping `{"type":"long"}`. Validate: whole number in 64-bit signed range, or null. Coerce: `parseInt(raw, 10)`. **Important:** JavaScript's `Number.MAX_SAFE_INTEGER` is 2^53-1, which is smaller than the 64-bit long range (2^63-1). For Week 1, accept values within `Number.MAX_SAFE_INTEGER` and log a warning if the raw string represents a value outside this range. Full BigInt support is deferred to a future sprint.

5. **double**: mapping `{"type":"double"}`. Validate: finite number or null. Coerce: `parseFloat(raw)`, reject `NaN` and `Infinity`, `""` → null.

6. **float**: mapping `{"type":"float"}`. Validate/coerce: same as double.

7. **byte**: mapping `{"type":"byte"}`. Validate: integer -128 to 127. Coerce: `parseInt(raw, 10)` + range check.

8. **short**: mapping `{"type":"short"}`. Validate: integer -32,768 to 32,767. Coerce: `parseInt(raw, 10)` + range check.

9. **decimal**: mapping `{"type":"double"}`. Validate/coerce: same as double (Palantir maps decimal to double in OpenSearch).

10. **date**: mapping `{"type":"date","format":"yyyy-MM-dd"}`. Validate: string matching YYYY-MM-DD, must be a valid calendar date (reject "2025-02-30", "2025-13-01"). Coerce: regex `^\d{4}-\d{2}-\d{2}$`, then `new Date(raw)` and verify `getDate()/getMonth()/getFullYear()` match the input, `""` → null.

11. **timestamp**: mapping `{"type":"date"}`. Validate: ISO 8601 string. Coerce: `new Date(raw).toISOString()`, reject if result is "Invalid Date", `""` → null.

12. **geopoint**: mapping `{"type":"geo_point"}`. Validate: object with `lat` (number, -90 to 90) and `lon` (number, -180 to 180). Coerce from CSV: parse `"lat,lon"` string (e.g., `"-1.94,29.87"` → `{lat: -1.94, lon: 29.87}`), `""` → null.

13. **geoshape**: mapping `{"type":"geo_shape"}`. Validate: object with `type` field (GeoJSON). Coerce: `JSON.parse(raw)`, verify result has `type` property.

14. **struct**: mapping `{"type":"object","properties":{}}` — properties are generated dynamically from `struct_schema` by Task 22's `generateOpenSearchStructMapping`. Validate: object matching the struct schema fields. Coerce: `JSON.parse(raw)` + field validation against schema.

15. **string_array**: mapping `{"type":"keyword"}`. Coerce: split by `"|"` delimiter, trim each element.
16. **integer_array**: mapping `{"type":"integer"}`. Coerce: split by `"|"`, coerce each via integer coercion.
17. **double_array**: mapping `{"type":"double"}`. Coerce: split by `"|"`, coerce each via double coercion.
18. **boolean_array**: mapping `{"type":"boolean"}`. Coerce: split by `"|"`, coerce each via boolean coercion.
19. **timestamp_array**: mapping `{"type":"date"}`. Coerce: split by `"|"`, coerce each via timestamp coercion.

20. **attachment**: mapping `{"type":"keyword"}`. Validate: string (attachment RID/path). Coerce: trim.
21. **marking**: mapping `{"type":"keyword"}`. Validate: string. Coerce: trim and uppercase.
22. **media_reference**: mapping `{"type":"object","enabled":false}`. Validate: object. Coerce: `JSON.parse(raw)`.
23. **timeseries**: mapping `{"type":"keyword"}`. Validate: string (timeseries reference). Coerce: trim.

**Exports:**
- `VALID_BASE_TYPES`: array of all 23 type name strings
- `TYPE_DEFINITIONS`: the full definitions object
- `getOpenSearchMapping(baseType, structSchema?)`: returns the OpenSearch mapping for the given type. For 'struct', uses structSchema to build nested properties.
- `validateValue(baseType, value, structSchema?)`: returns `{valid, error?}`
- `coerceFromString(baseType, raw, structSchema?)`: returns the coerced value or throws
- `isArrayType(baseType)`: returns true if baseType ends with '_array'
- `getBaseTypeOfArray(baseType)`: e.g., 'string_array' → 'string'. Throws if not an array type.

**Inline self-tests** (run when `require.main === module`):
1. Verify VALID_BASE_TYPES has exactly 23 entries
2. `coerceFromString('integer', '42')` → `42`
3. `coerceFromString('date', '2025-02-30')` → throws (invalid calendar date)
4. `coerceFromString('geopoint', '-1.94,29.87')` → `{lat: -1.94, lon: 29.87}`
5. `coerceFromString('boolean', 'true')` → `true`
6. `isArrayType('string_array')` → `true`
7. `getBaseTypeOfArray('string_array')` → `'string'`

**Files to create:** src/utils/typeSystem.js

**Verification:**
- `node src/utils/typeSystem.js` runs all inline tests and prints "All type system tests passed"
- `VALID_BASE_TYPES` contains exactly 23 entries
- Every type has opensearchMapping, validate, and coerceFromString defined
