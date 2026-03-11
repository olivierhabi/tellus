# TASK 2: Create the Property Type to OpenSearch Mapping Engine

**File to create:** `/src/services/mapping/typeMapper.js`

**Purpose:** This module is the heart of the index generation system. It translates Ontology property types (as defined in the PostgreSQL metadata store) into OpenSearch field mappings. This is one of the most critical modules because an incorrect mapping means data is stored in OpenSearch in a format that cannot be queried correctly. For example, if a `date` property is mapped as `text` instead of `date` in OpenSearch, then date range queries (`gt`, `lt`) will not work — they'll do lexicographic string comparison instead of temporal comparison, producing wrong results.

In Palantir's architecture, Object Storage V2 maintains a mapping between Ontology property types and the underlying search engine field types. When an object type is created or modified, the system generates an index mapping and creates (or updates) the corresponding index in the object database.

**Detailed specification:**

You must create a module that exports a single function: `mapPropertyToOpenSearch(property)` where `property` is an object from the PostgreSQL `property` table with fields: `{ api_name, base_type, is_array, is_required, struct_schema }`.

The function must return an OpenSearch field mapping object. Here is the EXACT mapping for every base type supported by the system. This mapping must be followed precisely with no deviations:

**String type:** When `base_type` is `"string"`, the OpenSearch mapping must be:
```json
{
  "type": "text",
  "fields": {
    "keyword": {
      "type": "keyword",
      "ignore_above": 256
    }
  }
}
```
The reason for this dual mapping is that `text` fields are analyzed (tokenized, lowercased) for full-text search, while the `.keyword` sub-field stores the exact value for exact-match filtering, sorting, and aggregations. This is the standard OpenSearch pattern for string data. When the query API (built on Day 3) needs to do an exact match (`eq` filter), it will query `fieldName.keyword`. When it needs full-text search (`contains` filter), it will query `fieldName` (the text field). When it needs to sort or aggregate, it will use `fieldName.keyword`. This dual approach is exactly how Palantir's Object Storage V2 handles string properties — they support both full-text search and exact filtering on the same field.

**Boolean type:** When `base_type` is `"boolean"`, the mapping must be:
```json
{ "type": "boolean" }
```
OpenSearch booleans accept `true`, `false`, `"true"`, `"false"`, `""` (interpreted as false). Note: Boolean value normalization to actual JavaScript booleans is handled by the type converter (Task 6) and row transformer (Task 8), not by this module.

**Integer type:** When `base_type` is `"integer"`, the mapping must be:
```json
{ "type": "integer" }
```
OpenSearch integers are 32-bit signed integers with a range of -2,147,483,648 to 2,147,483,647. If a value exceeds this range, OpenSearch will reject the document during indexing. The indexer must validate values are within range and reject rows with out-of-range integers.

**Long type:** When `base_type` is `"long"`, the mapping must be:
```json
{ "type": "long" }
```
64-bit signed integers. Range: -9,223,372,036,854,775,808 to 9,223,372,036,854,775,807. Note that JavaScript's `Number` type cannot represent the full range of longs accurately (it loses precision above 2^53). The indexer must handle this carefully — for values larger than Number.MAX_SAFE_INTEGER, they should be passed to OpenSearch as strings and OpenSearch will parse them correctly.

**Double type:** When `base_type` is `"double"`, the mapping must be:
```json
{ "type": "double" }
```
64-bit IEEE 754 floating point. This is the default numeric type for decimal numbers in the Ontology.

**Float type:** When `base_type` is `"float"`, the mapping must be:
```json
{ "type": "float" }
```
32-bit IEEE 754 floating point. Less precision than double but uses less storage.

**Date type:** When `base_type` is `"date"`, the mapping must be:
```json
{ "type": "date", "format": "yyyy-MM-dd||yyyy-MM-dd'T'HH:mm:ss||yyyy-MM-dd'T'HH:mm:ssZ||epoch_millis" }
```
This format string tells OpenSearch to accept dates in multiple formats: bare date (2025-03-11), date with time (2025-03-11T10:30:00), date with timezone (2025-03-11T10:30:00Z), or Unix epoch milliseconds (1741651800000). This flexibility is important because data from different source systems will use different date formats, and we don't want to force the user to standardize before indexing.

**Timestamp type:** When `base_type` is `"timestamp"`, the mapping must be:
```json
{ "type": "date", "format": "yyyy-MM-dd'T'HH:mm:ss.SSSZ||yyyy-MM-dd'T'HH:mm:ssZ||yyyy-MM-dd'T'HH:mm:ss||epoch_millis" }
```
Timestamps always include time components. The format string is slightly different from `date` because it also accepts millisecond precision (`.SSS`).

**Byte type:** When `base_type` is `"byte"`, the mapping must be:
```json
{ "type": "byte" }
```
8-bit signed integer. Range: -128 to 127.

**Short type:** When `base_type` is `"short"`, the mapping must be:
```json
{ "type": "short" }
```
16-bit signed integer. Range: -32,768 to 32,767.

**Decimal type:** When `base_type` is `"decimal"`, the mapping must be:
```json
{ "type": "scaled_float", "scaling_factor": 10000 }
```
Decimals require exact precision (important for financial data like tax amounts). OpenSearch's `scaled_float` type stores the value multiplied by the scaling factor as a long, preserving precision up to 4 decimal places. The scaling factor of 10000 means values are stored with up to 4 decimal places of precision. OpenSearch handles the scaling automatically — the indexer should pass the raw decimal value (e.g., 99.1234), and OpenSearch will internally store it multiplied by the scaling factor. No manual multiplication or division is required by the indexer or query API.

**Geopoint type:** When `base_type` is `"geopoint"`, the mapping must be:
```json
{ "type": "geo_point" }
```
OpenSearch geo_points accept multiple formats: object `{ "lat": -1.9403, "lon": 29.8739 }`, string `"-1.9403,29.8739"` (lat,lon), array `[29.8739, -1.9403]` (note: lon,lat order in arrays!), or GeoHash `"kw7yx"`. The indexer must normalize all geopoint values to the object format `{ lat, lon }` for consistency.

**Geoshape type:** When `base_type` is `"geoshape"`, the mapping must be:
```json
{ "type": "geo_shape" }
```
Accepts GeoJSON geometries: Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon, GeometryCollection. Values must be valid GeoJSON objects.

**String array type:** When `base_type` is `"string_array"`, the mapping must be:
```json
{ "type": "keyword" }
```
OpenSearch natively handles arrays — any field can contain an array of values without special mapping. For string arrays, we use `keyword` (not `text`) because array elements are typically discrete values (like tags or skills) that should be matched exactly, not full-text searched. If full-text search on array elements is needed, a `text` field with `.keyword` sub-field can be added later.

**Integer array, double array, boolean array, timestamp array types:** These follow the same pattern — use the mapping of the base element type. OpenSearch handles the array aspect automatically.
- `"integer_array"` → `{ "type": "integer" }`
- `"double_array"` → `{ "type": "double" }`
- `"boolean_array"` → `{ "type": "boolean" }`
- `"timestamp_array"` → same as timestamp mapping above

**Struct type:** When `base_type` is `"struct"`, the mapping must be dynamically generated from the `struct_schema` JSONB field on the property. The `struct_schema` is an array of sub-field definitions: `[{ "name": "street", "type": "string" }, { "name": "city", "type": "string" }, { "name": "zip", "type": "string" }]`. The mapping must be:
```json
{
  "type": "object",
  "properties": {
    "street": { "type": "text", "fields": { "keyword": { "type": "keyword", "ignore_above": 256 } } },
    "city": { "type": "text", "fields": { "keyword": { "type": "keyword", "ignore_above": 256 } } },
    "zip": { "type": "keyword" }
  }
}
```
Each sub-field in the struct is mapped using the same `mapPropertyToOpenSearch` function recursively (create a sub-property object and call the function). This means structs can contain any base type, including nested structs.

**The function must also handle unknown types** by throwing an error: `throw new Error(\`Unsupported property base_type: "\${property.base_type}". Supported types: string, boolean, integer, long, double, float, date, timestamp, byte, short, decimal, geopoint, geoshape, string_array, integer_array, double_array, boolean_array, timestamp_array, struct\`)`.

**Additional export:** `getAllSupportedTypes()` — Returns an array of all supported base type strings. This is used by the validation layer to check that a property's base_type is valid before saving it to PostgreSQL.

**Additional export:** `getOpenSearchTypeForBaseType(baseType)` — A simpler function that returns just the OpenSearch type name (e.g., "keyword", "integer", "date") without the full mapping object. Used for quick lookups.

**Test to verify:** Create a test that calls `mapPropertyToOpenSearch` for every supported type and verifies the output shape matches exactly what's specified above. Also test that an unsupported type throws the expected error.
