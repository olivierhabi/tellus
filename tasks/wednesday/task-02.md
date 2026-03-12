# TASK 2: Create the Query Validator Service

**File to create:** `/src/services/queryValidator.js`

**Dependencies:** Task 1 (PropertyResolver for property existence and type checks).

**Purpose:** Every incoming query request must be validated before it touches OpenSearch. Invalid queries must be rejected with clear, actionable error messages that tell the caller exactly what's wrong and how to fix it. This is a security and stability concern — malformed queries could cause OpenSearch errors, return misleading results, or enable injection attacks. Palantir's Ontology rejects invalid queries at the Object Set Service level, never passing malformed requests to the backend object database.

**What this service must validate:**

The service receives the raw request body from an Express route handler and must validate every field recursively.

**This task implements ONE function: `validateSearchQuery`.** The other two functions (`validateAggregateQuery` and `validateListQuery`) are implemented in separate tasks:
- `validateAggregateQuery` is implemented in Task 16
- `validateListQuery` is implemented below in this file as a simple parameter validator

**Function: `validateSearchQuery(body, objectTypeApiName)`**

Returns the validated body with `$pageSize` defaulted to 100 if absent. No other normalization is performed — the body is returned as-is after passing all validations.

Throws `QueryValidationError` (from `/src/utils/errors.js`) on any validation failure.

**Detailed validation rules:**

1. **Top-level structure validation.** The request body must be a JSON object. It may contain these fields and ONLY these fields: `where`, `$orderBy`, `$pageSize`, `$pageToken`, `$select`. Any unexpected fields must cause a rejection with the message `"Unexpected field '${fieldName}'. Allowed fields are: where, $orderBy, $pageSize, $pageToken, $select."` This prevents typos like `$pagesize` (wrong case) from silently being ignored.

2. **`where` clause validation.** The `where` field, if present, must be an object with a `type` field. The `type` must be one of the following exact strings: `"eq"`, `"gt"`, `"gte"`, `"lt"`, `"lte"`, `"contains"`, `"startsWith"`, `"isNull"`, `"isNotNull"`, `"in"`, `"and"`, `"or"`, `"not"`. Any other type must be rejected with the message `"Unknown filter type '${type}'. Supported types are: eq, gt, gte, lt, lte, contains, startsWith, isNull, isNotNull, in, and, or, not."`.

3. **Leaf filter validation.** For leaf filters (eq, gt, gte, lt, lte, contains, startsWith, isNull, isNotNull, in), the object must have a `field` property that is a non-empty string. The `field` must correspond to an actual property on the object type (use the PropertyResolver from Task 1 to verify). For all leaf filters except `isNull` and `isNotNull`, a `value` property must be present. For `isNull` and `isNotNull`, the `value` property must NOT be present (these are unary operators). For the `in` filter, the `value` must be a non-empty array with no more than 10,000 elements (Palantir enforces limits on `in` clauses to prevent massive queries). For `eq`, the value must be a single primitive value (string, number, boolean), not an array or object. For `gt`, `gte`, `lt`, `lte`, the value must be a number, a date string (ISO 8601 or `yyyy-MM-dd` format), or a string (for lexicographic comparison on string-typed properties). The type compatibility validation in rule 9 narrows the allowed value types per property. For `contains` and `startsWith`, the value must be a string.

4. **Compound filter validation.** For compound filters (`and`, `or`, `not`), the object must have a `value` property that is an array of sub-filters. For `and` and `or`, the array must contain at least 1 element and no more than 100 elements (to prevent absurdly complex queries). For `not`, the array must contain exactly 1 element. Each sub-filter must be recursively validated using the same rules. The maximum nesting depth must be 10 levels. If a query exceeds 10 levels of nesting, reject with the message `"Filter nesting depth exceeds maximum of 10 levels. Please simplify your query."`.

5. **`$orderBy` validation.** If present, `$orderBy` must be an array of objects. Each object must have a `field` property (string, must be a valid property on the object type) and a `direction` property that is exactly `"asc"` or `"desc"`. The array must contain no more than 5 elements (you can't sort by more than 5 fields). The `field` must refer to a property that supports sorting — `geopoint`, `geoshape`, and `struct` types cannot be sorted. If a user tries to sort by a geo or struct field, reject with `"Cannot sort by property '${field}' of type '${type}'. Sorting is supported for string, numeric, date, timestamp, and boolean properties."`.

6. **`$pageSize` validation.** If present, must be a positive integer. Minimum value is 1. Maximum value is 10,000 (this is Palantir's limit). If not present, default to 100. If the value is 0, negative, greater than 10,000, or not an integer, reject with `"$pageSize must be an integer between 1 and 10000. Got: ${value}."`.

7. **`$pageToken` validation.** If present, must be a non-empty string. The token is an opaque base64-encoded cursor (created by the pagination service in Task 6). If present, it will be decoded by the pagination service; validation here only checks that it's a non-empty string. If it's present alongside `$orderBy`, that's okay — the page token already encodes the sort order from the original request.

8. **`$select` validation.** If present, must be a non-empty array of strings. Each string must be a valid property API name on the object type OR one of the system fields (`__pk`, `__objectType`, `__lastModified`, `__version`). If a string in the array is not a valid property, reject with `"Unknown property '${prop}' in $select. Valid properties for object type '${objectType}' are: ${validProps.join(', ')}."`. If `$select` is an empty array, reject with `"$select must contain at least one property."`.

9. **Type compatibility validation.** After structural validation, check that each leaf filter's value is compatible with the property's type. For example: if the property is of type `integer` and the filter is `eq` with value `"hello"` (a string), reject with `"Filter 'eq' on property '${field}' of type 'integer' requires a numeric value. Got string: 'hello'."`. The type compatibility rules are:
   - `string` properties accept string values for eq, contains, startsWith, in
   - `integer`, `long`, `byte`, `short` properties accept integer values only (not floats) for eq, gt, gte, lt, lte, in
   - `double`, `float`, `decimal` properties accept any numeric value for eq, gt, gte, lt, lte, in
   - `boolean` properties accept only `true` or `false` for eq, in
   - `date` properties accept strings in `yyyy-MM-dd` format for eq, gt, gte, lt, lte, in
   - `timestamp` properties accept strings in ISO 8601 format for eq, gt, gte, lt, lte, in
   - Array property types (string_array, integer_array, etc.) follow the same rules as their base type

**Function: `validateListQuery(queryParams, objectTypeApiName)`**

Validates the GET list endpoint query parameters parsed from `req.query`. Accepts these parameters:
- `$pageSize` — same rules as above (default 100, min 1, max 10000)
- `$pageToken` — same rules as above (non-empty string if present)
- `$orderBy` — a comma-separated string like `"salary:desc,fullName:asc"`. Parse it into an array of `{ field, direction }` objects and apply the same validation rules as rule 5 above.
- `$select` — a comma-separated string like `"fullName,salary,department"`. Parse it into an array and apply the same validation rules as rule 8 above.

Returns `{ pageSize, pageToken, orderBy: [{field, direction}], select: [string] }` with defaults applied.

**Export:** `{ validateSearchQuery, validateListQuery }`. Note: `validateAggregateQuery` will be added to this file by Task 16.

**Error format:** All validation errors must throw a `QueryValidationError` (from `/src/utils/errors.js`) that includes: `message` (human-readable description), `field` (which field caused the error), `code` (machine-readable error code like `INVALID_FILTER_TYPE`, `UNKNOWN_PROPERTY`, `TYPE_MISMATCH`, `NESTING_TOO_DEEP`, `PAGE_SIZE_OUT_OF_RANGE`).

**Acceptance criteria:**
1. Valid body with `where`, `$orderBy`, `$pageSize` passes validation and returns with `$pageSize` defaulted if absent.
2. Body with unknown field `$pgeSize` is rejected with `"Unexpected field '$pgeSize'..."`.
3. `where` clause nested 11 levels deep is rejected with nesting error.
4. `$pageSize: 0` is rejected. `$pageSize: -1` is rejected. `$pageSize: 10001` is rejected.
5. `eq` filter on `integer` property with value `"hello"` is rejected with type mismatch error.
6. `contains` filter on `integer` property is rejected (structural validation — contains requires string property).
7. `$select: []` (empty array) is rejected.
8. `validateListQuery({ "$orderBy": "salary:desc,fullName:asc" })` returns `{ orderBy: [{field:"salary",direction:"desc"},{field:"fullName",direction:"asc"}], pageSize: 100 }`.
