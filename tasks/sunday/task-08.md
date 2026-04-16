# TASK 8: Polymorphic Query — Search Across All Implementing Object Types

## Objective
Build the API endpoint that enables querying objects from ALL Object Types that implement a given Interface, using the Interface's property names in the query. This is the core value of Interfaces — polymorphic queries. For example, if the HasLocation Interface is implemented by Airport, Warehouse, and StoreFront, a single query can search across all three Object Types using `latitude` and `longitude` as filter fields, even though each Object Type stores these values under different property names.

## Exact Specification

**Endpoint:** `POST /api/v1/ontology/:ontologyId/interfaces/:interfaceApiName/search`

**Request Body (same query DSL as the regular object search):**
```json
{
  "where": {
    "type": "and",
    "value": [
      { "type": "gt", "field": "latitude", "value": -2.0 },
      { "type": "lt", "field": "latitude", "value": 0.0 },
      { "type": "gt", "field": "longitude", "value": 29.0 },
      { "type": "lt", "field": "longitude", "value": 31.0 }
    ]
  },
  "$pageSize": 50,
  "$orderBy": [{ "field": "latitude", "direction": "asc" }],
  "$select": ["latitude", "longitude", "locationName"]
}
```

Note that the `field` names in the query use the INTERFACE property names ("latitude", "longitude"), not the Object Type property names ("airportLatitude", "warehouseLat", etc.). The endpoint must translate these to the correct Object Type property names for each implementing type.

**Implementation Algorithm:**

Step 1: Look up the Interface and get all its properties:
```sql
SELECT ip.api_name, ip.base_type FROM interface i JOIN interface_property ip ON ip.interface_id = i.interface_id WHERE i.api_name = $1 AND i.ontology_id = $2
```

Step 2: Get all implementing Object Types with their mappings:
```sql
SELECT ot.api_name AS object_type_api_name, oti.property_mapping FROM object_type_interface oti JOIN object_type ot ON ot.object_type_id = oti.object_type_id WHERE oti.interface_id = $1
```

Step 3: For each implementing Object Type, translate the Interface-based query into an Object-Type-specific query by replacing Interface property names with the mapped Object Type property names. For example, if the query filters on `latitude > -2.0` and the Airport mapping says `{ "latitude": "airportLatitude" }`, the translated query for the Airport index becomes `airportLatitude > -2.0`.

Step 4: Execute the translated query against each implementing Object Type's OpenSearch index. Use OpenSearch's multi-search API (`_msearch`) to execute all queries in a single HTTP request for efficiency.

Step 5: Merge the results from all Object Types into a single result set. Each result object must include a `__objectType` field indicating which Object Type it came from, and the property values must be mapped BACK to the Interface property names (so the caller sees `latitude`, not `airportLatitude`).

Step 6: Apply sorting across the merged result set using the Interface property names. If the caller requested `$orderBy: [{ "field": "latitude", "direction": "asc" }]`, sort all merged results by their latitude value regardless of which Object Type they came from.

Step 7: Apply pagination to the sorted, merged result set. Pagination on merged results uses offset-based slicing of the in-memory sorted array (NOT OpenSearch `search_after`, which only works within a single index). The `$pageToken` for interface search encodes `{ offset: <number> }` as base64. On the first request, offset is 0. For subsequent pages, offset = previous offset + pageSize.

**Response (HTTP 200):**
```json
{
  "data": [
    {
      "__primaryKey": "APT-KGL",
      "__objectType": "Airport",
      "latitude": -1.9686,
      "longitude": 30.1395,
      "locationName": "Kigali International Airport"
    },
    {
      "__primaryKey": "WH-001",
      "__objectType": "Warehouse",
      "latitude": -1.9500,
      "longitude": 30.0588,
      "locationName": "Kigali Central Warehouse"
    }
  ],
  "nextPageToken": null,
  "totalCount": 2
}
```

**Edge cases to handle:**
1. If the Interface has no implementing Object Types, return an empty result set (not an error).
2. If the `$select` includes an Interface property that an Object Type has NOT mapped (it's optional and not in the mapping), return `null` for that property on those objects.
3. If the `where` filter references an Interface property that is NOT mapped by a particular Object Type, EXCLUDE that Object Type from the search (don't search it at all, because the filter cannot be applied).
4. If `$orderBy` references an unmapped optional property, objects from Object Types that don't map it should be sorted to the END of the result set (nulls last behavior).

**Query translation function (add to the existing `/src/services/queryTranslator.js`):**

Add a new function `translateInterfaceQuery(query, propertyMapping)` that recursively walks the query DSL tree and replaces all field names using the mapping. The function must handle nested `and`/`or`/`not` operators by recursively translating their `value` arrays.

```javascript
function translateInterfaceQuery(node, mapping) {
  if (node.type === 'and' || node.type === 'or') {
    return { type: node.type, value: node.value.map(v => translateInterfaceQuery(v, mapping)) };
  }
  if (node.type === 'not') {
    return { type: 'not', value: [translateInterfaceQuery(node.value[0], mapping)] };
  }
  // Leaf node (eq, gt, lt, contains, isNull, in)
  const mappedField = mapping[node.field];
  if (!mappedField) {
    return null; // This Object Type doesn't map this field — signal to skip
  }
  return { ...node, field: mappedField };
}
```

If the translation produces any `null` nodes (unmapped fields), handle them as follows:
- If the root `where` node is a single leaf filter (not wrapped in `and`/`or`) and it references an unmapped field, that Object Type is excluded entirely from the search.
- If a `null` node is a direct child of the root `and`, that Object Type is excluded entirely (the required filter cannot be satisfied).
- If a `null` node is inside an `or`, only that branch of the `or` is dropped; the remaining branches are still evaluated.

## Verification
1. Create Interface HasLocation with latitude (double, required), longitude (double, required), locationName (string, optional)
2. Create Airport Object Type implementing HasLocation with mapping { latitude: "airportLat", longitude: "airportLng", locationName: "airportName" }
3. Create Warehouse Object Type implementing HasLocation with mapping { latitude: "warehouseLat", longitude: "warehouseLng" } (no locationName mapping)
4. Index 5 airports and 5 warehouses
5. POST interface search with latitude filter → results include BOTH airports and warehouses
6. Verify all results use Interface property names (latitude/longitude), not Object Type names
7. POST interface search with locationName filter → results include ONLY airports (warehouses excluded because they don't map locationName)
8. Verify $select with locationName returns null for warehouse objects
9. Verify sorting by latitude works across both Object Types
10. Verify pagination works on the merged result set
