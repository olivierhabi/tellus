# TASK 13: Object View API — Batch Object Views

## Objective
Build an endpoint that returns Object Views for multiple objects in a single request. This is used by application grids/tables that need to show link counts and available actions for each row without making N separate API calls.

## Exact Specification

**Endpoint:** `POST /api/v1/objects/:objectType/views/batch`

**Request Body:**
```json
{
  "primaryKeys": ["EMP-001", "EMP-002", "EMP-003", "EMP-004", "EMP-005"],
  "include": ["links", "actions", "interfaces"],
  "$select": ["employeeId", "fullName", "department"]
}
```

The `include` field controls which enrichments are returned. If omitted, all enrichments are included. If set to an empty array, only the raw object properties are returned (like a batch GET). This allows the caller to control the performance cost — link counts are expensive, and if the caller only needs actions, they shouldn't pay the cost of counting links.

Valid `include` values: `"links"`, `"actions"`, `"interfaces"`, `"properties_metadata"`. Any invalid value → 400 error.

**`properties_metadata` behavior:** When `"properties_metadata"` is included in the `include` array, each property in the response is enriched with `displayName`, `description`, `baseType`, `isRequired`, `ordinal`, and `isFromInterface` fields (as produced by the `enrichObjectProperties` function from Task 14). When `"properties_metadata"` is NOT included, properties are returned as simple `{ "value": ... }` objects without metadata.

The `$select` field controls which properties are returned on each object (same as the single-object query).

**Depends on:** Task 14 (`propertyEnricher` service). Use the `enrichObjectProperties` and `buildPropertyMetadataCache` functions from `/src/services/propertyEnricher.js` (Task 14) to enrich properties. Build the metadata cache once per batch request, not per object.

**Limits:**
- Maximum 100 primary keys per request. If exceeded, return HTTP 400 with error code "LIMIT_EXCEEDED" and message "Batch view supports a maximum of 100 objects per request. You requested {n}."
- Primary keys that don't exist are silently omitted from the response (no error). The `notFound` field in the response lists the missing keys.

**Implementation:**

Step 1: Batch-fetch all objects from OpenSearch using a `_mget` request (multi-get):
```json
POST /ontology-employee/_mget
{
  "ids": ["EMP-001", "EMP-002", "EMP-003", "EMP-004", "EMP-005"]
}
```
This is a single OpenSearch request that fetches multiple documents by ID, far more efficient than 5 separate GET requests.

Step 2: If "links" is in the include list, fetch link counts for ALL objects in parallel. For foreign-key-based links, you can use a single OpenSearch aggregation query instead of N separate count queries:
```json
POST /ontology-ticket/_search
{
  "size": 0,
  "query": { "terms": { "assignedEmployeeId.keyword": ["EMP-001", "EMP-002", "EMP-003", "EMP-004", "EMP-005"] } },
  "aggs": {
    "by_employee": {
      "terms": { "field": "assignedEmployeeId.keyword", "size": 100 }
    }
  }
}
```
This returns the count of linked tickets PER employee in a single query. Map the aggregation buckets back to the correct objects.

For MANY_TO_MANY links (join-table-based), count linked objects by querying the join table with `WHERE source_pk IN (...)` using all primary keys in the batch. Group results by source primary key.

Step 3: Actions and Interfaces are the same for all objects of the same type, so only fetch them once (not per object).

Step 4: Assemble the response.

**Response (HTTP 200):**
```json
{
  "data": [
    {
      "object": {
        "__primaryKey": "EMP-001",
        "__objectType": "Employee",
        "properties": {
          "employeeId": { "value": "EMP-001" },
          "fullName": { "value": "Melissa Chang" },
          "department": { "value": "Engineering" }
        }
      },
      "links": [
        { "linkTypeApiName": "assignedTickets", "count": 12 },
        { "linkTypeApiName": "employeeCompany", "count": 1 }
      ],
      "actions": ["updateSalary", "transferDepartment", "terminateEmployee"],
      "interfaces": ["Auditable"]
    },
    {
      "object": {
        "__primaryKey": "EMP-002",
        "__objectType": "Employee",
        "properties": { "..." : "..." }
      },
      "links": [
        { "linkTypeApiName": "assignedTickets", "count": 5 },
        { "linkTypeApiName": "employeeCompany", "count": 1 }
      ],
      "actions": ["updateSalary", "transferDepartment", "terminateEmployee"],
      "interfaces": ["Auditable"]
    }
  ],
  "notFound": ["EMP-999"]
}
```

Note that `actions` and `interfaces` are simplified to just API name arrays (not full objects) in the batch response to reduce payload size. The full details are available from the single Object View endpoint.

## Verification
1. Create 10 Employee objects with varying numbers of linked tickets (0, 1, 5, 12, etc.)
2. Batch view with all 10 PKs → verify all returned with correct link counts
3. Include a non-existent PK → verify it appears in notFound
4. Batch view with include=["actions"] only → verify no links section
5. Batch view with include=[] → verify only raw properties returned
6. Batch view with 101 PKs → verify 400 LIMIT_EXCEEDED
7. Verify the OpenSearch _mget is used (check server logs or OpenSearch slow logs) instead of N separate GETs
8. Verify link counts use aggregation query (single query for all objects) instead of N count queries
