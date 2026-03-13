# TASK 12: Object View API — Linked Objects Full Retrieval

## Objective
Build the endpoint that returns the full paginated list of objects linked to a given object via a specific link type. This is used when a user clicks "See all 12 tickets" from the Object View (Task 11) — they need the full list, not just the 3-item preview.

## Exact Specification

**Endpoint:** `GET /api/v2/objects/:objectType/:primaryKey/links/:linkTypeApiName`

This endpoint already exists from Day 4 (the Search Around work). However, the Day 4 implementation may be basic. This task ENHANCES it with:

The enhanced endpoint is backward-compatible with Day 4. If no `$pageSize`, `$pageToken`, `$filter`, `$orderBy`, or `$select` parameters are provided, the endpoint returns the same response as the Day 4 implementation with the addition of `nextPageToken: null` and `totalCount` fields.

1. **Pagination support:** Add `$pageSize` (default 100, max 10000) and `$pageToken` query parameters. The `$pageToken` should be an opaque base64-encoded cursor containing the `search_after` value for OpenSearch cursor-based pagination (NOT offset-based — offset pagination degrades on large datasets). Implement cursor-based pagination as follows:

```javascript
// Encoding a page token
const cursor = { searchAfter: lastDoc.sort, linkType: linkTypeApiName };
const pageToken = Buffer.from(JSON.stringify(cursor)).toString('base64');

// Decoding a page token
const cursor = JSON.parse(Buffer.from(pageToken, 'base64').toString());
const searchAfter = cursor.searchAfter;
```

2. **Filtering on linked objects:** Add optional `$filter` query parameter that accepts the same filter DSL (URL-encoded JSON). This allows: "Show me all tickets linked to this employee WHERE ticket status = 'open'." The filter is applied to the TARGET object type, not the source.

3. **Sorting:** Add `$orderBy` query parameter. Format: comma-separated `field:direction` pairs (e.g., `$orderBy=priority:asc,createdAt:desc`). If direction is omitted, default to ascending. The sort fields refer to properties on the TARGET object type.

4. **Select:** Add `$select` query parameter (comma-separated property names) to return only specific properties of the linked objects. This reduces response size when the caller only needs a few fields.

5. **Include reverse direction:** If the link type's cardinality is MANY_TO_MANY or if the object type is on the "wrong side" of a ONE_TO_MANY link, the traversal direction must be automatically determined. The endpoint should work regardless of whether the caller provides the source or target object type — it should figure out the direction from the link type definition.

**Direction resolution logic:**
```javascript
function resolveDirection(linkType, requestedObjectType) {
  if (linkType.source_object_type === requestedObjectType) {
    return { from: 'source', toObjectType: linkType.target_object_type, toIndex: `ontology-${linkType.target_object_type.toLowerCase()}` };
  } else if (linkType.target_object_type === requestedObjectType) {
    return { from: 'target', toObjectType: linkType.source_object_type, toIndex: `ontology-${linkType.source_object_type.toLowerCase()}` };
  } else {
    throw new NotFoundError(`Link type '${linkType.api_name}' does not connect to Object Type '${requestedObjectType}'`);
  }
}
```

6. **Count header:** Return the total count of linked objects in a response header `X-Total-Count` so the UI can show "12 tickets" without making a separate count query. Use OpenSearch's `track_total_hits: true` option in the search request.

**Response (HTTP 200):**
```json
{
  "data": [
    {
      "__primaryKey": "TKT-101",
      "__objectType": "Ticket",
      "ticketId": "TKT-101",
      "title": "Fix login bug",
      "status": "open",
      "priority": "high"
    }
  ],
  "nextPageToken": "eyJzZWFyY2hBZnRlciI6Wy...",
  "totalCount": 12
}
```

**Error cases:**
- Object not found → 404
- Link type not found → 404
- Link type doesn't connect to this Object Type → 400 with message "Link type '{name}' does not connect to Object Type '{name}'"
- Invalid $pageToken → 400 with message "Invalid page token"
- Source object not found → 404. Before querying linked objects, verify the source object exists by querying its OpenSearch index for the given `primaryKey`. If not found, return 404 with error code `OBJECT_NOT_FOUND`.

**MANY_TO_MANY link pagination:** For MANY_TO_MANY links backed by a PostgreSQL join table, cursor-based pagination uses a different mechanism than OpenSearch `search_after`. First query the join table to get the linked object primary keys (with `LIMIT`/`OFFSET` pagination on the join table query), then fetch those objects from OpenSearch. The cursor for MANY_TO_MANY encodes `{ offset: <number>, linkType: <string> }` instead of `searchAfter`.

## Verification
1. Create Employee with 25 linked Tickets via a ONE_TO_MANY link
2. GET links with $pageSize=10 → get first 10, verify nextPageToken exists
3. Use nextPageToken → get next 10
4. Continue → get last 5, verify nextPageToken is null
5. GET links with $filter={"type":"eq","field":"status","value":"open"} → verify only open tickets returned
6. GET links with $orderBy=priority → verify sorted
7. GET links with $select=ticketId,title → verify only those fields in response
8. Verify X-Total-Count header matches actual count
9. Test reverse direction: GET /objects/Company/COMP-001/links/employeeCompany → returns employees (even though Company is the target side of the link)
