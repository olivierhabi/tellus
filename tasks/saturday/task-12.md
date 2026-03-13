## TASK 12: Build the Type Conversion Utility

### Context
When the reindex engine (Task 7) reads raw string values from CSV files and needs to store them as typed Ontology properties in OpenSearch, it must convert strings to the appropriate JavaScript/OpenSearch types. For example, the string "120000" must become the number 120000 when the property type is `double`, and the string "2020-01-15" must remain a string but be validated as a proper date format when the property type is `date`.

This task builds a comprehensive type conversion utility that handles all 15+ Palantir base types, including edge cases like invalid values, empty strings, and locale-specific number formats (relevant for RRA where numbers might use European formatting with commas as decimal separators).

### Exact Specification

Create a file at `/src/utils/typeConverter.js` that exports:

**Function: `convertValue(rawValue, baseType, options = {})`**

Parameters:
- `rawValue`: The raw value from the CSV/JSON file. Can be a string, number, boolean, null, undefined, array, or object.
- `baseType`: The Palantir base type string (e.g., 'string', 'integer', 'double', 'boolean', 'date', 'timestamp', 'geopoint', 'struct', 'string_array', etc.)
- `options`: Optional configuration:
  - `strict` (boolean, default: false): If true, throw errors on conversion failure instead of returning null
  - `arrayDelimiter` (string, default: '|'): Delimiter for splitting string values into arrays

Return value: The converted value in the appropriate JavaScript type, or `null` if the conversion fails and strict mode is off.

**Conversion rules for each base type:**

1. **`string`**: 
   - null/undefined → null
   - any other value → `String(value)`
   - Trim whitespace from both ends
   - Empty string after trimming → null

2. **`integer`**:
   - null/undefined/empty string → null
   - If value is already a number: `Math.round(value)` (truncate decimals, Palantir integers don't have decimals)
   - If value is a string: strip all characters that are not digits (0-9) or a leading minus sign (-). Specifically: remove currency symbols, whitespace, commas, and other punctuation. Then call `parseInt(result, 10)`
   - If the string contains commas as thousands separators (e.g., "1,200,000"): remove commas before parsing
   - If result is NaN → null (or throw if strict)
   - Valid range: -2147483648 to 2147483647 (32-bit signed integer). If outside this range and baseType is 'integer' (not 'long'), return null or throw.

3. **`long`**:
   - Same as integer but valid range is -9223372036854775808 to 9223372036854775807 (64-bit)
   - In JavaScript, numbers larger than Number.MAX_SAFE_INTEGER (2^53 - 1) lose precision. Log a warning if the value exceeds this threshold but still store it (this is a known limitation of JavaScript).

4. **`double`** and **`float`**:
   - null/undefined/empty string → null
   - If value is already a number: use as-is
   - If value is a string: remove commas (thousands separator), then `parseFloat(value)`
   - Handle European decimal format: if the value contains a comma but no period, and the comma appears to be a decimal separator (e.g., "1234,56"), replace comma with period before parsing. Heuristic: if there's exactly one comma and the part after it has 1-2 digits, treat it as a decimal separator. If the part after has 3+ digits (e.g., "1,200"), treat it as a thousands separator and remove it. Priority rule: when ambiguous (e.g., "1,2"), the European decimal interpretation takes precedence (becomes 1.2) since this system is built for RRA (Rwandan/European formatting).
   - If result is NaN → null (or throw if strict)
   - Infinity and -Infinity → null (or throw if strict)

5. **`boolean`**:
   - null/undefined/empty string → null
   - If value is already a boolean: use as-is
   - If value is a string: convert to lowercase and check:
     - "true", "1", "yes", "y", "on" → true
     - "false", "0", "no", "n", "off" → false
     - anything else → null (or throw if strict)
   - If value is a number: 0 → false, any other number → true

6. **`date`**:
   - null/undefined/empty string → null
   - If value matches regex `/^\d{4}-\d{2}-\d{2}$/`: validate that it's a real date (e.g., 2020-02-30 is not valid). If valid, return the string as-is. If not valid, return null.
   - If value matches other common date formats:
     - "DD/MM/YYYY" (common in Rwanda): parse and convert to "YYYY-MM-DD"
     - "MM/DD/YYYY" (American): this is ambiguous with DD/MM/YYYY — use DD/MM/YYYY by default since this system is for RRA (Rwandan/European date format). There is no per-column override for week 1; the DD/MM/YYYY default applies globally.
     - "YYYY/MM/DD": convert to "YYYY-MM-DD"
   - If no format matches → null (or throw if strict)

7. **`timestamp`**:
   - null/undefined/empty string → null
   - If value is already a valid ISO 8601 string (e.g., "2020-01-15T10:30:00Z" or "2020-01-15T10:30:00.000+02:00"): return as-is
   - If value is a date string without time: append "T00:00:00Z" and return
   - If value is a Unix timestamp (number > 1000000000 and < 10000000000): convert to ISO 8601
   - If value is a Unix timestamp in milliseconds (number > 1000000000000): divide by 1000 then convert

8. **`byte`** and **`short`**:
   - Same as integer but with different valid ranges:
     - byte: -128 to 127
     - short: -32768 to 32767

9. **`decimal`**:
   - Same as double (in JavaScript, there's no separate decimal type — we use floating point)

10. **`geopoint`**:
    - null/undefined/empty string → null
    - If value is a string in format "lat,lon" (e.g., "-1.9403,29.8739"): parse to `{ lat: -1.9403, lon: 29.8739 }`
    - If value is a JSON string: parse to object, expect `{ lat, lon }` or `{ latitude, longitude }`
    - If value is already an object with lat/lon: use as-is
    - Validate: lat must be -90 to 90, lon must be -180 to 180. If outside range → null

11. **`geoshape`**:
    - null/undefined/empty string → null
    - If value is a GeoJSON string: parse and validate. Must have a `type` field (e.g., "Polygon", "MultiPolygon", "LineString", "Point") and a `coordinates` field.
    - If value is already an object with type and coordinates: use as-is

12. **`string_array`**:
    - null/undefined/empty string → null (NOT empty array — Palantir: "Setting an array property to required ensures the presence of at least one item")
    - If value is already an array: convert each element to string
    - If value is a string: split by the `arrayDelimiter` (default "|"), trim each element, filter out empty strings
    - Example: "engineering|design|marketing" → ["engineering", "design", "marketing"]

13. **`integer_array`**:
    - Same split logic as string_array, then convert each element to integer using the integer rules above
    - Filter out null values (elements that failed conversion)

14. **`double_array`** and **`boolean_array`** and **`timestamp_array`**:
    - Same pattern: split string into array, convert each element using the corresponding base type rules

15. **`struct`**:
    - null/undefined/empty string → null
    - If value is a JSON string: parse it
    - If value is already an object: use as-is
    - Validate against the struct_schema from the property definition (if provided in options): check that all required fields exist and have the correct types. But for week 1, skip deep validation — just ensure it's a valid object.

**Function: `isTypeCompatible(palantirType, detectedType)`**

Returns true if a column with `detectedType` can be used for a property with `palantirType` without loss of information.

```javascript
const compatibilityMatrix = {
  'string': ['string', 'number', 'integer', 'boolean', 'date', 'timestamp'], // string accepts anything
  'integer': ['integer'],
  'long': ['integer', 'number'],
  'double': ['number', 'integer'],
  'float': ['number', 'integer'],
  'boolean': ['boolean'],
  'date': ['date', 'string'],
  'timestamp': ['timestamp', 'date', 'string'],
  'decimal': ['number', 'integer'],
  // arrays and structs are always from string (parsed) in CSV
};
```

**Function: `isTypeCoercible(palantirType, detectedType)`**

Returns true if the conversion is possible but might lose information or fail for some values. Coercion rules:
- `integer` / `long` property ← `"string"` column: coercible (strings may contain numeric text)
- `double` / `float` property ← `"string"` column: coercible
- `boolean` property ← `"string"` column: coercible (strings may be "true"/"false")
- `date` / `timestamp` property ← `"string"` column: coercible (strings may contain date text)
- `integer` / `long` property ← `"number"` column: coercible (may truncate decimals)
- All other cross-type combinations: NOT coercible (return false)

### Validation Criteria
- "120000" as integer → 120000
- "120,000" as integer → 120000 (comma stripped)
- "1234.56" as double → 1234.56
- "1234,56" as double → 1234.56 (European decimal detected)
- "true", "1", "yes" as boolean → true
- "false", "0", "no" as boolean → false
- "2020-01-15" as date → "2020-01-15"
- "15/01/2020" as date → "2020-01-15" (DD/MM/YYYY → YYYY-MM-DD)
- "2020-02-30" as date → null (invalid date)
- "-1.9403,29.8739" as geopoint → { lat: -1.9403, lon: 29.8739 }
- "engineering|design" as string_array → ["engineering", "design"]
- null/undefined/empty for any type → null
- Integer outside 32-bit range → null (not long range)
- NaN result → null (not NaN stored in OpenSearch)
- `"2020-01-15T10:30:00Z"` as timestamp → `"2020-01-15T10:30:00Z"` (returned as-is)
- `1610000000` as timestamp → `"2021-01-07T09:46:40.000Z"` (Unix seconds to ISO 8601)
- `"-1.9403,29.8739"` as geopoint → `{ lat: -1.9403, lon: 29.8739 }`; `"200,300"` as geopoint → null (out of range)
- `"engineering|design"` as string_array → `["engineering", "design"]`
- `"1|2|abc"` as integer_array → `[1, 2]` (abc filtered out as null)
- `isTypeCompatible('integer', 'integer')` returns true; `isTypeCompatible('integer', 'string')` returns false
- `isTypeCoercible('integer', 'string')` returns true; `isTypeCoercible('boolean', 'number')` returns false
- `convertValue('hello', 'integer', { strict: true })` throws an error
- byte value 200 → null (outside -128 to 127 range)
- short value 40000 → null (outside -32768 to 32767 range)
