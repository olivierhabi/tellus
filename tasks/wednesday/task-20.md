# TASK 20: Create Property Type Coercion Utility

**File to create:** `/src/utils/typeCoercion.js`

**Purpose:** When filter values arrive in the request body, they're JSON values — strings, numbers, booleans, arrays, and null. Before these values are used in OpenSearch queries, they must be validated against the property's base type and potentially coerced into the correct format. For example, a date property expects a string in `yyyy-MM-dd` format, but a user might send `"2024-1-5"` (missing leading zeros) which is technically valid but should be normalized to `"2024-01-05"`. This utility provides type-checking and optional coercion for all 15+ Palantir base types.

**Functions to implement:**

1. `validateAndCoerce(value, baseType)` — Takes a JSON value and a Palantir base type string. Returns the coerced value if valid, or throws with a descriptive message if invalid. The rules for each base type:

   - `string`: value must be a JavaScript string. No coercion needed. Return as-is.
   - `boolean`: value must be `true` or `false` (not truthy/falsy — the string `"true"` is NOT valid, only the boolean `true`). Throw if not a boolean: `"Expected boolean (true/false), got ${typeof value}: ${JSON.stringify(value)}"`.
   - `integer`: value must be a JavaScript number with no decimal part. `30` is valid, `30.0` is valid (treat as 30), `30.5` is NOT valid. Throw: `"Expected integer, got float: ${value}"`. Also reject NaN and Infinity.
   - `long`: same as integer but allow larger values. JavaScript numbers are 64-bit floats and can represent integers up to 2^53-1 safely. Beyond that, warn but still accept (OpenSearch handles the conversion).
   - `double`, `float`, `decimal`: value must be a JavaScript number. Any numeric value is valid including decimals. Reject NaN and Infinity.
   - `byte`: integer in range -128 to 127. Throw if out of range.
   - `short`: integer in range -32768 to 32767. Throw if out of range.
   - `date`: value must be a string matching `yyyy-MM-dd` pattern. Validate with regex `^\d{4}-\d{2}-\d{2}$`. Also validate that the date is actually valid (month 1-12, day 1-31 with month-appropriate limits, account for leap years). Coercion: if the value matches `^\d{4}-\d{1,2}-\d{1,2}$` (missing leading zeros), pad the month and day with leading zeros and return the normalized string.
   - `timestamp`: value must be a string in ISO 8601 format. Accept any valid ISO 8601 string including timezone offsets. Use `new Date(value)` to validate — if it returns `Invalid Date`, throw. Return the original string (don't normalize — preserve the caller's timezone format).
   - `geopoint`: value must be an object with `lat` (number, -90 to 90) and `lon` (number, -180 to 180). Throw if missing fields or out of range.
   - `geoshape`: value must be a valid GeoJSON object with a `type` field. Accept any GeoJSON type (Point, LineString, Polygon, MultiPolygon, etc.). Do NOT deeply validate the GeoJSON structure — let OpenSearch handle that.
   - `struct`: value must be a JSON object (not array, not null, not primitive). The individual field values are NOT validated here because the struct schema is defined per-property and would require separate resolution.

2. `validateArrayValues(values, baseType)` — For `in` filter and array types. Takes an array of values and a base type. Calls `validateAndCoerce` on each element. Returns the array of coerced values. Throws if any element is invalid, including which element index failed.
