# TASK 3: Create Interface API — GET Endpoints for Reading Interfaces

This task delivers two related GET endpoints that share a common query implementation.

## Objective
Build the REST API endpoints for listing all Interfaces in an Ontology and retrieving a single Interface by its API name. Both endpoints must return the complete Interface definition including all properties and a list of Object Types that implement the Interface.

## Exact Specification

Add two GET endpoints to `/src/routes/interfaces.js`:

**Endpoint 1:** `GET /api/v2/ontology/:ontologyId/interfaces`

This returns all Interfaces defined in the specified Ontology. The response must include the complete property list for each Interface and the list of implementing Object Types.

The SQL query must perform a three-way join to gather all the data in a single database round-trip. Do NOT make separate queries for each Interface — that would be an N+1 query problem that degrades performance as the number of Interfaces grows. The query structure should be:

```sql
SELECT 
  i.interface_id,
  i.api_name AS interface_api_name,
  i.display_name AS interface_display_name,
  i.description AS interface_description,
  i.created_at,
  i.updated_at,
  ip.interface_property_id,
  ip.api_name AS property_api_name,
  ip.display_name AS property_display_name,
  ip.base_type,
  ip.is_required,
  ip.ordinal,
  ot.api_name AS implementing_object_type,
  oti.property_mapping
FROM interface i
LEFT JOIN interface_property ip ON ip.interface_id = i.interface_id
LEFT JOIN object_type_interface oti ON oti.interface_id = i.interface_id
LEFT JOIN object_type ot ON ot.object_type_id = oti.object_type_id
WHERE i.ontology_id = $1
ORDER BY i.api_name, ip.ordinal, ot.api_name
```

**Dependency note:** This query references the `object_type_interface` table created in Task 5. Until Task 5 is completed, the LEFT JOINs on `object_type_interface` and `object_type` will return no rows, and `implementingObjectTypes` will always be an empty array. This is by design — the LEFT JOINs handle the missing table gracefully.

Note the LEFT JOINs — an Interface with no properties (shouldn't happen due to validation, but be defensive) or no implementing Object Types must still appear in the results. The ORDER BY ensures consistent ordering: Interfaces alphabetically, properties by ordinal within each Interface, and implementing Object Types alphabetically.

After executing this query, you must transform the flat result rows into a nested JSON structure. This is the critical part — the raw SQL result will have one row per (Interface × Property × ImplementingType) combination. You need to group these into the correct hierarchical shape.

The grouping algorithm must:
1. Create a Map keyed by `interface_id`
2. For each row, get or create the Interface entry in the Map
3. Add the property to the Interface's properties array (deduplicate by `interface_property_id` because the same property appears in multiple rows if there are multiple implementing types)
4. Add the implementing Object Type to the Interface's `implementingObjectTypes` array (deduplicate by `implementing_object_type` because the same implementing type appears in multiple rows if there are multiple properties)
5. Convert the Map values to an array for the response

**Response (HTTP 200):**
```json
{
  "data": [
    {
      "interfaceId": "a1b2c3d4-...",
      "apiName": "HasLocation",
      "displayName": "Has Geographic Location",
      "description": "...",
      "properties": [
        { "apiName": "latitude", "displayName": "Latitude", "baseType": "double", "isRequired": true, "ordinal": 0 },
        { "apiName": "longitude", "displayName": "Longitude", "baseType": "double", "isRequired": true, "ordinal": 1 }
      ],
      "implementingObjectTypes": [
        {
          "objectTypeApiName": "Airport",
          "propertyMapping": { "latitude": "airportLatitude", "longitude": "airportLongitude" }
        },
        {
          "objectTypeApiName": "Warehouse",
          "propertyMapping": { "latitude": "warehouseLat", "longitude": "warehouseLng" }
        }
      ],
      "createdAt": "2025-03-16T10:00:00.000Z",
      "updatedAt": "2025-03-16T10:00:00.000Z"
    }
  ],
  "totalCount": 1
}
```

**Endpoint 2:** `GET /api/v2/ontology/:ontologyId/interfaces/:interfaceApiName`

Returns a single Interface by its API name. The query is the same as above but with an additional WHERE clause: `AND i.api_name = $2`. If no Interface is found with this API name, return HTTP 404 with error code "NOT_FOUND" and message "Interface with apiName '{interfaceApiName}' not found in this Ontology".

The response shape is the same as a single element from the list endpoint, but wrapped in `{ "data": { ... } }` (object, not array).

**Validation for both endpoints:**
1. `ontologyId` must be a valid UUID → 400 if not
2. The Ontology must exist → 404 if not
3. For the single-get endpoint, the Interface must exist → 404 if not

**Performance considerations:**
- For the list endpoint, if an Ontology has many Interfaces (50+), the three-way JOIN can produce a large result set. This is acceptable for now (we'll add pagination in a future task if needed). But log a warning using `console.warn` if the result set exceeds 10,000 rows to help identify performance issues early.
- Cache the list of valid base types in a module-level constant rather than querying the database for validation on each request.

## Verification
1. Create 3 Interfaces with different numbers of properties (1, 3, 5)
2. GET the list → verify all 3 appear with correct property counts
3. GET a single Interface by apiName → verify complete response
4. GET a non-existent Interface → verify 404
5. Create an Interface, then have an Object Type implement it (Task 6), then GET the Interface again → verify `implementingObjectTypes` is populated
6. Verify that properties are ordered by `ordinal` in the response, not by insertion order or alphabetical order
