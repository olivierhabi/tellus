# TASK 3: Create the Index Mapping Generator

**File to create:** `/src/services/opensearch/indexMappingGenerator.js`

**Purpose:** This module takes a complete object type definition (from PostgreSQL — the object type metadata plus all its properties) and generates a complete OpenSearch index mapping document. This is the document that gets sent to OpenSearch's `PUT /{index}` API to create the index with the correct schema. In Palantir's Object Storage V2, when you create an object type and register a backing datasource, the system automatically generates the index mapping and creates the corresponding index. This module replicates that automatic mapping generation.

**Detailed specification:**

The module must export the following:

1. **`generateIndexMapping(objectTypeApiName)`** — An async function that takes the API name of an object type, fetches its metadata and properties from PostgreSQL, and returns a complete OpenSearch index creation request body.

2. **`getIndexName(objectTypeApiName)`** — A pure utility function that computes the OpenSearch index name from the object type API name. The logic is: `"ontology-" + objectTypeApiName.toLowerCase().replace(/[^a-z0-9-]/g, "-")`. This is the **canonical source** for index name computation — all other modules (Tasks 4-30) must import this function from this module rather than re-implementing the logic.

**Step-by-step logic:**

1. Query PostgreSQL to fetch the object type record by `api_name`. If not found, throw an error: `"Object type '{apiName}' not found in metadata store"`.

2. Query PostgreSQL to fetch all properties for this object type, ordered by `ordinal` (display order). There must be at least one property (the primary key). If zero properties, throw: `"Object type '{apiName}' has no properties defined"`.

3. Verify that the `primary_key_property_id` on the object type points to an existing property. If the primary key property is not found, throw: `"Object type '{apiName}' has no primary key property configured"`.

4. Build the OpenSearch mapping by iterating over all properties and calling `mapPropertyToOpenSearch` from Task 2 for each one.

5. Add system fields that are always present on every object, regardless of the object type's properties. These system fields replicate what Palantir's Object Storage V2 stores on every indexed object:

   - `__pk` — The primary key value. Mapped as `{ "type": "keyword" }`. This is ALWAYS a keyword, even if the primary key property is an integer, because OpenSearch document IDs and primary key lookups must be exact-match. The indexer will convert the primary key value to a string before indexing.
   
   - `__objectType` — The API name of the object type. Mapped as `{ "type": "keyword" }`. Always the same value for every document in the index, but stored for cross-index queries where documents from multiple object types might be in the same result set.
   
   - `__lastModified` — The timestamp when this object was last indexed or edited. Mapped as `{ "type": "date" }`. Set by the indexer during indexing and updated when user edits are applied.
   
   - `__version` — A monotonically increasing version number for the object. Mapped as `{ "type": "long" }`. Starts at 1 on first index, incremented on each update. Used for optimistic concurrency control in the action execution engine (Day 5).
   
   - `__editedBy` — The user ID of the last person who edited this object via an action. Mapped as `{ "type": "keyword" }`. Null for objects that have never been edited (only indexed from datasource).
   
   - `__datasourceVersion` — The transaction ID of the backing datasource transaction that produced this object. Mapped as `{ "type": "keyword" }`. Used by the Funnel to track which datasource version has been indexed.

6. Assemble the complete index creation request body. The structure must be:

```json
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 0,
    "refresh_interval": "1s",
    "max_result_window": 100000,
    "analysis": {
      "analyzer": {
        "default": {
          "type": "standard"
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "__pk": { "type": "keyword" },
      "__objectType": { "type": "keyword" },
      "__lastModified": { "type": "date" },
      "__version": { "type": "long" },
      "__editedBy": { "type": "keyword" },
      "__datasourceVersion": { "type": "keyword" },
      "employeeId": { "type": "keyword" },
      "fullName": { "type": "text", "fields": { "keyword": { "type": "keyword", "ignore_above": 256 } } },
      "salary": { "type": "double" },
      ...etc for all properties
    }
  }
}
```

**Settings explanation:**
- `number_of_shards: 1` — Single shard for development. In production, this would be calculated based on expected data volume (Palantir's guideline: roughly 1 shard per 20-50GB of data).
- `number_of_replicas: 0` — No replicas for single-node development. Production would use 1-2 replicas.
- `refresh_interval: "1s"` — OpenSearch makes newly indexed documents searchable every 1 second. This is the default and matches Palantir's near-real-time indexing behavior. Setting this to "-1" would disable automatic refresh (used during bulk indexing for better performance, then manually refreshed after).
- `max_result_window: 100000` — Palantir's default Search Around limit is 100,000 objects. This setting controls the maximum value of `from + size` for search requests. Without this, OpenSearch's default is 10,000.
- `analysis.analyzer.default` — Use the standard analyzer as default. This tokenizes on word boundaries and lowercases. Custom analyzers for specific properties (like language-specific analysis for Kinyarwanda text) would be added later.

**Index naming convention:** The index name is computed by calling `getIndexName(objectTypeApiName)` (exported from this module). The logic is: `"ontology-" + objectTypeApiName.toLowerCase().replace(/[^a-z0-9-]/g, "-")`. For example: object type `"Employee"` → index `"ontology-employee"`, object type `"FlightSchedule"` → index `"ontology-flightschedule"`. OpenSearch index names must be lowercase, cannot start with a dash or underscore, and cannot contain certain special characters.

**The function must also return metadata** alongside the mapping:
```javascript
{
  indexName: "ontology-employee",
  objectTypeApiName: "Employee",
  propertyCount: 10,
  mapping: { /* the full mapping document above */ },
  systemFields: ["__pk", "__objectType", "__lastModified", "__version", "__editedBy", "__datasourceVersion"],
  primaryKeyProperty: "employeeId",
  primaryKeyOpenSearchType: "keyword"
}
```

**Test to verify:** Create an Employee object type with 6 properties (string, integer, double, date, boolean, string_array) in PostgreSQL, call `generateIndexMapping("Employee")`, and verify the output contains all properties correctly mapped plus all 6 system fields.
