# TASK 7: Create the Object Set Response Formatter Service

**File to create:** `/src/services/objectResponseFormatter.js`

**Dependencies:** Task 6 (pagination service for page token creation).

**Note:** This file is intentionally named `objectResponseFormatter.js` (not `responseFormatter.js`) to avoid confusion with the existing `/src/utils/responseFormatter.js` created in Monday Task 9, which handles Ontology metadata CRUD responses. This service handles Object Set Service query responses.

**Purpose:** OpenSearch returns documents in its own internal format, which includes metadata like `_index`, `_id`, `_score`, `_source`, and `_sort`. The API must return documents in a clean format that matches Palantir's API response shape, hiding OpenSearch internals from the consumer. This service transforms OpenSearch responses into the exact response format that Palantir's Object Set Service returns.

**Palantir's response format for object lists:**

From Palantir's platform summary and API documentation, the response for listing/searching objects has this exact shape:

```json
{
  "data": [
    {
      "__primaryKey": "EMP-001",
      "__objectType": "Employee",
      "employeeId": "EMP-001",
      "fullName": "Melissa Chang",
      "email": "melissa.chang@acme.com",
      "salary": 145000,
      "department": "Engineering",
      "startDate": "2021-03-15",
      "isActive": true,
      "skills": ["Python", "TypeScript", "SQL"]
    },
    {
      "__primaryKey": "EMP-002",
      "__objectType": "Employee",
      "employeeId": "EMP-002",
      "fullName": "Diego Rodriguez",
      "salary": 130000,
      "department": "Sales",
      "startDate": "2022-08-01",
      "isActive": true,
      "skills": ["Salesforce", "HubSpot"]
    }
  ],
  "nextPageToken": "eyJzb3J0IjpbMTQ1MDAwLCJFTVAtMDAyIl19",
  "totalCount": 1523
}
```

Key aspects of this format:
- Each object in the `data` array is a flat JSON object
- The `__primaryKey` field is always present and contains the primary key value
- The `__objectType` field is always present and contains the object type API name
- All properties from the object type are included unless `$select` was specified
- Property values use their natural JSON types (strings as strings, numbers as numbers, booleans as booleans, arrays as arrays, null as null)
- There is NO `_id`, `_index`, `_score`, or any OpenSearch metadata

**Implementation details:**

1. **`formatObjectList(opensearchResponse, objectTypeApiName, allPropertyApiNames, selectProperties, pageToken, totalCount)`** — Main function. Takes the raw OpenSearch search response and transforms it into the API response format. The `allPropertyApiNames` parameter is the complete list of property API names for the object type (obtained by the caller via `propertyResolver.resolveAllProperties()`). This is needed to insert `null` for missing fields when `$select` is not specified.

   Step 1: Extract `hits.hits` from the OpenSearch response. This is an array of hit objects, each with `_source` (the document body), `_sort` (the sort values for pagination), and optionally `highlight` (matched text fragments from full-text search).

   Step 2: For each hit, extract `_source` and transform it:
   - From the `_source` object, remove ALL fields whose names start with `__` (including `__pk`, `__objectType`, `__version`, `__lastModified`)
   - Add `__primaryKey` to the output object (copied from the removed `__pk` value)
   - Add `__objectType` to the output object (copied from the removed `__objectType` value, or from the `objectTypeApiName` parameter if absent)
   - If `$select` was specified, include ONLY the selected properties plus `__primaryKey` and `__objectType` (these two system fields are always included regardless of `$select`)
   - If `$select` was NOT specified, include ALL non-`__` properties from `_source`, plus `__primaryKey` and `__objectType`
   - If the hit contains a `highlight` object (from full-text search), include it as `__highlights` on the output object. The `highlight` object from OpenSearch is keyed by field name with values being arrays of highlighted snippets. Copy it as-is to `__highlights`.

   Step 3: Build the response object with `data`, `nextPageToken`, and `totalCount`.

2. **`formatSingleObject(opensearchResponse, objectTypeApiName)`** — For the GET single object endpoint. Takes a single OpenSearch `get` response and transforms it into a flat object (not wrapped in a `data` array).

   Response for single object:
   ```json
   {
     "__primaryKey": "EMP-001",
     "__objectType": "Employee",
     "employeeId": "EMP-001",
     "fullName": "Melissa Chang",
     ...all properties...
   }
   ```

3. **`formatAggregationResponse(opensearchResponse, aggregationDefinitions)`** — For the aggregate endpoint. Transforms OpenSearch aggregation results into a clean format. Each aggregation definition has a `name` field — the response uses these names as keys.

   Response format for aggregations:
   ```json
   {
     "data": {
       "totalCount": 1523,
       "avgSalary": 125340.50,
       "maxSalary": 350000,
       "byDepartment": [
         { "key": "Engineering", "count": 450 },
         { "key": "Sales", "count": 230 },
         { "key": "Marketing", "count": 180 }
       ],
       "byStartYear": [
         { "key": "2021", "count": 120 },
         { "key": "2022", "count": 340 },
         { "key": "2023", "count": 510 },
         { "key": "2024", "count": 553 }
       ]
     }
   }
   ```

   OpenSearch returns aggregations in a nested format with `buckets`, `value`, `doc_count`, etc. The formatter must:
   - For `count` (value_count or cardinality): extract `value`
   - For `avg`, `sum`, `min`, `max`: extract `value` from the named aggregation. Return `null` if no documents matched.
   - For `terms`: extract `buckets` array, map each bucket to `{ "key": bucket.key, "count": bucket.doc_count }`. Return `[]` if no documents matched.
   - For `date_histogram`: extract `buckets` array, map each bucket to `{ "key": bucket.key_as_string, "count": bucket.doc_count }`. Return `[]` if no documents matched.
   - For `range`: extract `buckets` array, map each bucket to `{ "key": bucket.key, "from": bucket.from, "to": bucket.to, "count": bucket.doc_count }`. Return `[]` if no documents matched.

**Note on error formatting:** Error responses are handled entirely by the `errorHandler` middleware (Task 15), which catches all `OntologyError` subclasses and formats them into `{ error: { code, message, details } }`. This service does NOT need a `formatError` function — error formatting is not its responsibility.

**Null handling:** If a property has no value in the OpenSearch document (the field is missing from `_source`), it must appear as `null` in the API response — NOT be omitted. This is important because a consumer needs to distinguish between "the property exists but has no value" (null) and "this property was not included in $select" (absent). When `$select` is used, only selected properties appear. When `$select` is NOT used, ALL properties appear, with null for any that have no value.

**Type coercion:** OpenSearch may return values in slightly different types than expected. Do NOT attempt to coerce types — return exactly what OpenSearch returns for each field, since the indexer (built on Tuesday) already ensured correct types during indexing.

**Export:** `{ formatObjectList, formatSingleObject, formatAggregationResponse }`

**Acceptance criteria:**
1. An OpenSearch hit with `_source: { __pk: "EMP-001", __objectType: "Employee", __version: 3, fullName: "Test" }` produces `{ __primaryKey: "EMP-001", __objectType: "Employee", fullName: "Test" }` (no `__pk`, no `__version`).
2. When `$select: ["fullName"]` is specified, the output contains only `__primaryKey`, `__objectType`, and `fullName`.
3. When `$select` is not used and `allPropertyApiNames` is `["employeeId", "fullName", "email", "salary"]`, a hit with `_source: { __pk: "EMP-001", __objectType: "Employee", fullName: "Test" }` produces `{ __primaryKey: "EMP-001", __objectType: "Employee", employeeId: null, fullName: "Test", email: null, salary: null }` — missing properties appear as `null`.
4. An OpenSearch hit with `highlight: { fullName: ["<mark>Melissa</mark>"] }` produces `__highlights: { fullName: ["<mark>Melissa</mark>"] }` on the output object.
5. An OpenSearch hit without `highlight` produces no `__highlights` field on the output object.
6. `formatAggregationResponse` with empty result set returns `null` for metric aggregations and `[]` for bucket aggregations.
7. `formatSingleObject` with `_source: { __pk: "EMP-001", __objectType: "Employee", fullName: "Test", salary: 100000 }` returns `{ __primaryKey: "EMP-001", __objectType: "Employee", fullName: "Test", salary: 100000 }` (flat object, no `data` wrapper, no `__pk`).
