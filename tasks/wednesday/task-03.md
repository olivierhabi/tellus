# TASK 3: Create the Filter Translator — Equality and Inequality Operators

**File to create:** `/src/services/queryTranslator.js` (first part — this file will be extended in Tasks 4 and 5)

**Purpose:** This is the core of the Object Set Service. It translates our query DSL (the `where` clause) into OpenSearch Query DSL. This task covers the `eq`, `gt`, `gte`, `lt`, `lte` operators. These are the most commonly used filters and must work correctly for every property type.

**How Palantir's Ontology translates queries:** The Object Set Service receives a high-level filter expression, resolves each property to its OpenSearch field name and type (using the PropertyResolver), and constructs the equivalent OpenSearch bool query. The translation must be deterministic — the same input always produces the same OpenSearch query.

**The function signature:**

```javascript
/**
 * Translates a filter clause from our query DSL into an OpenSearch query clause.
 * 
 * @param {Object} filter - The filter object from the request body's `where` field
 * @param {string} objectTypeApiName - The API name of the object type being queried
 * @param {PropertyResolver} propertyResolver - Instance of the property resolver service
 * @returns {Object} An OpenSearch query clause (to be placed inside a bool query)
 */
async function translateFilter(filter, objectTypeApiName, propertyResolver)
```

**Translation rules for `eq` (equality):**

The `eq` filter tests whether a property's value exactly equals the given value. The translation depends entirely on the property type:

For `string` properties: The property is mapped in OpenSearch as `{ type: "text", fields: { keyword: { type: "keyword" } } }`. An exact equality match MUST use the `.keyword` sub-field, NOT the analyzed text field. Using the text field would perform a full-text match, which is NOT equality — for example, searching for "John Smith" on a text field would match "Smith John" or "John P. Smith", which is wrong for equality. The correct translation is:
```json
{ "term": { "fullName.keyword": "John Smith" } }
```

For `integer`, `long`, `byte`, `short` properties: These are mapped directly as their numeric type. No sub-field needed:
```json
{ "term": { "age": 30 } }
```

For `double`, `float`, `decimal` properties: Same as integer — direct term query. However, be aware of floating point precision issues. The value should be passed through as-is without rounding:
```json
{ "term": { "salary": 125000.50 } }
```

For `boolean` properties: Direct term query:
```json
{ "term": { "isActive": true } }
```

For `date` properties: The value must be a date string in `yyyy-MM-dd` format. OpenSearch will parse it according to the format specified in the mapping:
```json
{ "term": { "startDate": "2024-01-15" } }
```

For `timestamp` properties: The value must be an ISO 8601 string. OpenSearch handles the parsing:
```json
{ "term": { "createdAt": "2024-01-15T10:30:00Z" } }
```

For array properties (`string_array`, `integer_array`, etc.): The `eq` filter on an array property means "the array contains this value" (OpenSearch's natural behavior — a term query on an array field matches if ANY element equals the value). Use the same translation as the base type. For `string_array`, use `.keyword` sub-field:
```json
{ "term": { "skills.keyword": "Python" } }
```

**Translation rules for `gt`, `gte`, `lt`, `lte` (range):**

Range filters test whether a property's value is greater than, greater than or equal to, less than, or less than or equal to the given value. All four operators translate to a single OpenSearch `range` query with different parameters.

For numeric types (`integer`, `long`, `double`, `float`, `byte`, `short`, `decimal`):
```json
// gt (greater than)
{ "range": { "salary": { "gt": 100000 } } }

// gte (greater than or equal)
{ "range": { "salary": { "gte": 100000 } } }

// lt (less than)
{ "range": { "salary": { "lt": 200000 } } }

// lte (less than or equal)
{ "range": { "salary": { "lte": 200000 } } }
```

For `date` properties:
```json
{ "range": { "startDate": { "gte": "2024-01-01", "format": "yyyy-MM-dd" } } }
```

For `timestamp` properties:
```json
{ "range": { "createdAt": { "lt": "2024-06-01T00:00:00Z" } } }
```

For `string` properties: Range on strings does lexicographic comparison. Use the `.keyword` sub-field:
```json
{ "range": { "lastName.keyword": { "gte": "M" } } }
```

For `boolean` properties: Range queries on booleans are not meaningful. The translator must throw an error: `"Range filters (gt, gte, lt, lte) are not supported on boolean properties. Use 'eq' instead."`.

For `geopoint` and `geoshape` properties: Range queries are not applicable. Throw: `"Range filters are not supported on geo properties. Use geo-specific filters instead."`.

**Implementation structure:**

The `translateFilter` function must use a switch statement on `filter.type` and dispatch to specific handler functions: `translateEq`, `translateGt`, `translateGte`, `translateLt`, `translateLte`. Each handler receives the filter object and the resolved property metadata from the PropertyResolver. Each handler returns an OpenSearch query clause object.

Create a helper function `translateRangeFilter(filter, propertyMeta, rangeOperator)` that is shared by gt/gte/lt/lte to avoid code duplication. The `rangeOperator` parameter is the string `"gt"`, `"gte"`, `"lt"`, or `"lte"`.

**Edge cases to handle:**
- Null values in `eq`: If the value is `null`, translate to an `isNull` filter internally: `{ "bool": { "must_not": { "exists": { "field": fieldName } } } }`
- Empty string in `eq` on string property: This is valid — some fields legitimately have empty string values. Translate as `{ "term": { "field.keyword": "" } }`
- Date strings that don't match the expected format: The translator should NOT do its own date parsing — pass the value to OpenSearch and let it return an error if the format is wrong. However, do a basic regex check for obviously wrong formats (like passing a number where a date string is expected).
- Very large numbers in range queries: Pass through to OpenSearch as-is. OpenSearch handles the type checking.

**Do NOT do in this task:** The compound filters (and, or, not), full-text search (contains), isNull/isNotNull, in, and startsWith are covered in subsequent tasks. The translateFilter function should have placeholder cases for these that throw `"Not yet implemented: ${filter.type}"`.
