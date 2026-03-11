# TASK 6: Create the Type Converter for CSV Values

**File to create:** `/src/services/indexing/typeConverter.js`

**Purpose:** This module converts raw string values from CSV rows into properly typed JavaScript values that can be indexed into OpenSearch. CSV files contain everything as strings — "145000" needs to become the number 145000, "true" needs to become the boolean true, "2020-03-15" needs to remain a string but in ISO format, and "python,java,sql" (a comma-separated value inside a single field) needs to become an array ["python", "java", "sql"]. This is one of the most error-prone parts of the system because real-world data is messy — dates come in dozens of formats, numbers might have currency symbols or thousands separators, booleans might be "yes"/"no" instead of "true"/"false".

In Palantir's architecture, the Object Data Funnel performs type conversion when indexing datasources into Object Storage V2. The conversion follows the property type definitions in the Ontology schema. If a value cannot be converted (e.g., "abc" for an integer property), Palantir rejects the row and logs an error. We replicate this exact behavior.

**Detailed specification:**

The module must export a main function: `convertValue(rawValue, property)` where:
- `rawValue` is the string value from the CSV (or null/undefined)
- `property` is the property definition from PostgreSQL: `{ api_name, base_type, is_required, is_array, struct_schema }`

The function must return: `{ value: <convertedValue>, valid: true }` on success, or `{ value: null, valid: false, error: "Conversion error message" }` on failure.

**Conversion rules for each type:**

**Null/empty handling (applies to ALL types):**
- If `rawValue` is null, undefined, or empty string (""):
  - If `property.is_required` is true: return `{ value: null, valid: false, error: "Required property '{api_name}' has null/empty value" }`. This matches Palantir's behavior: "if there is any null value currently set on the backing column for a required property, the reindex will fail."
  - If `property.is_required` is false: return `{ value: null, valid: true }`. Null is a valid value for non-required properties.
- If `rawValue` is a string containing only whitespace: treat it as empty string (same rules as above).

**String:** Return the trimmed string value as-is. No conversion needed. `{ value: "Melissa Chang", valid: true }`.

**Boolean:** Accept (case-insensitive): "true", "1", "yes", "y", "on" → `true`. Accept: "false", "0", "no", "n", "off" → `false`. Anything else: `{ valid: false, error: "Cannot convert '{rawValue}' to boolean. Expected: true/false, yes/no, 1/0, on/off" }`.

**Integer:** Parse using `parseInt(rawValue, 10)`. Strip thousands separators (commas in "1,000,000" → "1000000") and currency symbols matching `/^[\$\u20AC\u00A3\u00A5]|^(RWF|USD|EUR|GBP|JPY|KES|UGX|TZS|BIF)\s*/i` before parsing. If the result is NaN, return invalid. If the result is outside the 32-bit signed integer range (-2,147,483,648 to 2,147,483,647), return invalid with message "Value {value} is outside the integer range". Return the integer as a JavaScript number.

**Long:** Same as integer but the valid range is -9,223,372,036,854,775,808 to 9,223,372,036,854,775,807. For values that exceed JavaScript's Number.MAX_SAFE_INTEGER (9,007,199,254,740,991), return the value as a string (OpenSearch will parse it correctly). For values within safe integer range, return as a JavaScript number.

**Double and Float:** Parse using `parseFloat(rawValue)`. Strip thousands separators and currency symbols first. Accept decimal points and scientific notation (e.g., "1.5e6"). If NaN, return invalid. For float, additionally check that the value is within 32-bit float range (approximately ±3.4e38).

**Byte:** Parse as integer, check range -128 to 127.

**Short:** Parse as integer, check range -32,768 to 32,767.

**Decimal:** Parse using `parseFloat(rawValue)`. Strip thousands separators and currency symbols. Return as a JavaScript number (OpenSearch's scaled_float handles the precision). If NaN, return invalid.

**Date:** Accept these formats (try in order):
1. `YYYY-MM-DD` (ISO date) — e.g., "2025-03-11"
2. `MM/DD/YYYY` (US format) — e.g., "03/11/2025"
3. `DD/MM/YYYY` (European/Rwandan format) — e.g., "11/03/2025" — AMBIGUITY WARNING: distinguish from US format by checking if the first number is >12 (must be day). If both first and second numbers are ≤12, PREFER DD/MM/YYYY format (this matches Rwandan convention).
4. `YYYY/MM/DD` — e.g., "2025/03/11"
5. `DD-Mon-YYYY` — e.g., "11-Mar-2025"
6. `Mon DD, YYYY` — e.g., "Mar 11, 2025"

Always output in ISO format: `"2025-03-11"`. If none of these formats match, return invalid with message listing the accepted formats.

**Timestamp:** Accept ISO 8601 timestamps with various timezone formats:
1. `YYYY-MM-DDTHH:mm:ss.SSSZ` (full ISO) — e.g., "2025-03-11T10:30:00.000Z"
2. `YYYY-MM-DDTHH:mm:ssZ` — e.g., "2025-03-11T10:30:00Z"
3. `YYYY-MM-DDTHH:mm:ss` (no timezone, assumed UTC) — e.g., "2025-03-11T10:30:00"
4. `YYYY-MM-DD HH:mm:ss` (space instead of T) — e.g., "2025-03-11 10:30:00"
5. Unix epoch milliseconds (purely numeric string, 13 digits) — e.g., "1741651800000"
6. Unix epoch seconds (purely numeric string, 10 digits) — e.g., "1741651800"

Always output in ISO 8601 format with timezone: `"2025-03-11T10:30:00.000Z"`. For epoch timestamps, convert to ISO string using `new Date(epochMs).toISOString()`.

**Geopoint:** Accept:
1. Object-like string: `"{"lat":-1.9403,"lon":29.8739}"` — parse as JSON
2. Comma-separated string: `"-1.9403,29.8739"` — split on comma, first is lat, second is lon
3. Two-element array string: `"[29.8739,-1.9403]"` — parse as JSON, note GeoJSON uses [lon,lat] order

Always output as object: `{ lat: -1.9403, lon: 29.8739 }`. Validate: lat must be between -90 and 90, lon must be between -180 and 180.

**Geoshape:** Accept GeoJSON string. Parse as JSON and validate it has a `type` field (Point, Polygon, etc.) and a `coordinates` field. Return the parsed GeoJSON object.

**Array types (string_array, integer_array, etc.):** Accept:
1. JSON array string: `"["python","java","sql"]"` — parse as JSON
2. Comma-separated string: `"python,java,sql"` — split on comma, trim each element
3. Pipe-separated string: `"python|java|sql"` — split on pipe, trim each element
4. Semicolon-separated string: `"python;java;sql"` — split on semicolon, trim each element

Detection priority: try JSON parse first. If that fails, check if the string contains pipes → split on pipe. If no pipes, check for semicolons → split on semicolon. Otherwise, split on comma.

After splitting, convert each element using the base type converter (e.g., for `integer_array`, convert each element using the integer converter). If ANY element fails conversion, return invalid with message: `"Array element at index {i} ('{elementValue}') cannot be converted to {baseType}"`.

**Struct:** Accept JSON string. Parse as JSON and validate that all fields defined in `struct_schema` are present (or null if not required). Convert each field value using the appropriate type converter based on the field's type in the schema.

**Additional exports:**
- `convertRow(row, properties, columnMapping)` — Converts an entire CSV row (object with column names as keys) into a typed object with property API names as keys. Uses `columnMapping` (from the `backing_datasource` table) to map CSV column names to property API names. For each property, looks up the corresponding CSV column via `columnMapping`, retrieves the raw value, and calls `convertValue(rawValue, property)`. Returns `{ values: { ...convertedValues }, valid: true, errors: [] }` or `{ values: { ...partialValues }, valid: false, errors: ["Property X: ...", "Property Y: ..."] }`. Collect ALL errors for the row, not just the first one, so the user can fix all problems at once.

  **Relationship to Task 8:** Task 8's `transformRow` delegates to `convertRow` for type conversion (not directly to `convertValue`). `convertRow` handles ONLY type conversion across columns. `transformRow` (Task 8) adds system fields (`__pk`, `__objectType`, `__lastModified`, etc.) and handles unmapped properties on top of what `convertRow` returns.

**Test to verify:** Write comprehensive tests covering: every type conversion, null handling for required vs optional, date format ambiguity, array parsing from different formats, invalid values for every type, currency symbol stripping, thousands separator handling.
