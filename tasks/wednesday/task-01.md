# TASK 1: Create the Property Resolver Service

**File to create:** `/src/services/propertyResolver.js`

**Dependencies:** None (first task in the series).

**Purpose:** Before any query can be translated into OpenSearch query DSL, the system must know the exact base type of every property being queried. This is critical because the same filter operator (for example, `eq`) translates to completely different OpenSearch queries depending on the property type. A string property uses `{ term: { "fieldName.keyword": value } }` because string properties are mapped as both `text` (for full-text search) and `keyword` (for exact match), and you must target the `.keyword` sub-field for exact equality. An integer property uses `{ term: { "fieldName": value } }` directly because numeric fields don't have sub-fields. A geopoint property cannot use `eq` at all — it requires geo-specific query types. Getting this wrong means queries silently return wrong results, which is the worst kind of bug.

**What this service must do:**

The service must export a class or set of functions that, given an object type's API name and a property's API name, returns the complete property metadata including its base type, whether it's an array, whether it's required, and critically, the exact OpenSearch field name to use in queries (including the `.keyword` suffix for string types).

**Implementation details:**

1. Create a function called `resolveProperty(objectTypeApiName, propertyApiName)` that queries the PostgreSQL database. It must join the `property` table with the `object_type` table using the following SQL:

   ```sql
   SELECT p.id AS "propertyId", p.api_name AS "apiName", p.display_name AS "displayName",
          p.base_type AS "baseType", p.is_array AS "isArray", p.is_required AS "isRequired"
   FROM property p
   JOIN object_type ot ON p.object_type_id = ot.id
   WHERE ot.api_name = $1 AND p.api_name = $2
   ```

   It must return an object with this exact shape:

```javascript
{
  propertyId: "uuid",
  apiName: "fullName",
  displayName: "Full Name",
  baseType: "string",          // the Ontology base type
  isArray: false,
  isRequired: false,
  opensearchField: "fullName", // the field name to use in OpenSearch queries
  opensearchKeywordField: "fullName.keyword", // for exact match on text fields
  opensearchFieldType: "text", // the OpenSearch mapping type
  supportsExactMatch: true,    // can use term/terms queries
  supportsRangeMatch: true,    // can use range queries
  supportsFullText: true,      // can use match queries
  supportsGeoQueries: false,   // can use geo queries
}
```

2. Create a function called `resolveAllProperties(objectTypeApiName)` that returns a Map of propertyApiName → property metadata for ALL properties of an object type. SQL:

   ```sql
   SELECT p.id AS "propertyId", p.api_name AS "apiName", p.display_name AS "displayName",
          p.base_type AS "baseType", p.is_array AS "isArray", p.is_required AS "isRequired"
   FROM property p
   JOIN object_type ot ON p.object_type_id = ot.id
   WHERE ot.api_name = $1
   ```

   This is used when the query doesn't specify `$select` and all properties must be returned, and also when doing full-text search across all text fields. If the object type does not exist in the `object_type` table (the query returns zero rows), throw `ObjectTypeNotFoundError` with the list of available object types (query `SELECT api_name FROM object_type` to get the list).

3. Create a function called `getOpenSearchFieldForFilter(objectTypeApiName, propertyApiName, filterType)` that returns the exact OpenSearch field name to use for a given filter operation. The logic must be:

   - For `eq`, `in` filters on `string` type: return `propertyApiName.keyword` (the keyword sub-field, because exact match on text fields must use the keyword sub-field, not the analyzed text field)
   - For `eq`, `in` filters on `boolean`, `integer`, `long`, `double`, `float`, `byte`, `short`, `decimal`, `date`, `timestamp` types: return `propertyApiName` directly (no sub-field needed for non-text types)
   - For `gt`, `gte`, `lt`, `lte` range filters on numeric types (`integer`, `long`, `double`, `float`, `byte`, `short`, `decimal`): return `propertyApiName` directly
   - For `gt`, `gte`, `lt`, `lte` range filters on `date` and `timestamp` types: return `propertyApiName` directly
   - For `gt`, `gte`, `lt`, `lte` range filters on `string` type: return `propertyApiName.keyword` (range on keyword field for lexicographic comparison)
   - For `contains` (full-text search) filter on `string` type: return `propertyApiName` (the analyzed text field, NOT the keyword sub-field, because full-text search needs tokenization)
   - For `contains` filter on non-string types: throw `IncompatibleFilterError` — full-text search only works on text fields
   - For `startsWith` filter on `string` type: return `propertyApiName.keyword` (use prefix query on keyword field)
   - For `isNull`, `isNotNull` on any type: return `propertyApiName` (the base field name without `.keyword`, because `exists` checks whether the field exists at all regardless of sub-field)
   - For any filter on `geopoint` or `geoshape` type: throw `IncompatibleFilterError` with message "Geo queries require specialized filter types (geoDistance, geoBoundingBox). Standard filters are not supported on geo properties."
   - For filters on `struct` type: throw `IncompatibleFilterError` with message "Cannot filter directly on struct properties. Filter on individual struct fields using dot notation (e.g., 'address.city')."
   - For filters on array types (`string_array`, `integer_array`, etc.): use the same rules as the base type. OpenSearch natively handles arrays — a `term` query on an array field matches if ANY element matches.

4. Create a function called `validatePropertyExists(objectTypeApiName, propertyApiName)` that throws a `PropertyNotFoundError` (from `/src/utils/errors.js`) if the property doesn't exist on the given object type. The error message must include the object type name and the property name, and should list all valid property names for that object type to help the user fix their query.

5. Cache the property metadata in memory (using a simple Map with a TTL of 60 seconds) to avoid hitting PostgreSQL on every single query. The cache key should be `${objectTypeApiName}:${propertyApiName}`. Provide a function `invalidateCache(objectTypeApiName)` that clears all cached entries for an object type (called when properties are modified via the metadata CRUD API).

6. Handle the special system fields that exist on every object but are NOT defined in the property table: `__pk` (keyword type, always supports exact match), `__objectType` (keyword type), `__lastModified` (date type), `__version` (long type). When the user queries on `__pk`, it should work exactly like any keyword field. These system fields must be recognized by the resolver without requiring them to be in the PostgreSQL property table.

**Error handling:** This service uses error classes from `/src/utils/errors.js`. Those error classes are defined in Task 15. During development, you may stub them as simple `Error` subclasses and replace them once Task 15 is complete. Never return null silently. If a property doesn't exist, throw `PropertyNotFoundError`. If a filter type is incompatible with a property type, throw `IncompatibleFilterError`.

**Export:** `{ resolveProperty, resolveAllProperties, getOpenSearchFieldForFilter, validatePropertyExists, invalidateCache }`

**Acceptance criteria:**
1. `resolveProperty("Employee", "fullName")` returns the metadata object with `baseType: "string"`, `opensearchKeywordField: "fullName.keyword"`, `supportsFullText: true`.
2. `resolveProperty("Employee", "salary")` returns `baseType: "double"`, `supportsFullText: false`.
3. `resolveProperty("Employee", "__pk")` returns system field metadata with `baseType: "keyword"` without querying PostgreSQL.
4. `resolveProperty("Employee", "nonExistent")` throws `PropertyNotFoundError` listing all valid Employee properties.
5. `getOpenSearchFieldForFilter("Employee", "fullName", "eq")` returns `"fullName.keyword"`.
6. `getOpenSearchFieldForFilter("Employee", "salary", "gt")` returns `"salary"`.
7. `getOpenSearchFieldForFilter("Employee", "fullName", "contains")` returns `"fullName"` (analyzed text field).
8. `getOpenSearchFieldForFilter("Employee", "salary", "contains")` throws `IncompatibleFilterError`.
9. Second call to `resolveProperty("Employee", "fullName")` within 60s uses cache (no PostgreSQL query).
10. `invalidateCache("Employee")` clears all Employee entries; next call hits PostgreSQL.
