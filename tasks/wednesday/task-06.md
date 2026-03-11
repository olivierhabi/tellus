# TASK 6: Create the Pagination Service

**File to create:** `/src/services/paginationService.js`

**Purpose:** Pagination is how the API returns large result sets in manageable chunks. Palantir's Ontology API uses cursor-based pagination with opaque page tokens (not offset-based pagination). The page token encodes enough information to resume the query from where the previous page left off, without the server needing to maintain any session state. This is critical for scalability — the Object Set Service must be stateless.

**Why cursor-based, not offset-based:** Offset pagination (e.g., `LIMIT 100 OFFSET 500`) has a fundamental problem: if objects are created or deleted between page requests, the offset shifts and the user either misses objects or sees duplicates. Cursor-based pagination uses the last object's sort values as a resume point, which is stable even as the data changes. OpenSearch's `search_after` parameter implements this pattern.

**How it works end-to-end:**

1. Client sends first request: `{ "$pageSize": 50 }` (no `$pageToken`)
2. Server queries OpenSearch with `size: 51` (one extra to detect if more pages exist)
3. If OpenSearch returns 51 results, there are more pages. Take the first 50, extract the sort values from the 50th result, encode them into a page token, and return: `{ "data": [...50 objects...], "nextPageToken": "eyJ...", "totalCount": 1523 }`
4. If OpenSearch returns 50 or fewer results, this is the last page. Return: `{ "data": [...results...], "nextPageToken": null, "totalCount": 1523 }`
5. Client sends next request: `{ "$pageSize": 50, "$pageToken": "eyJ..." }`
6. Server decodes the page token, extracts the sort values, and uses OpenSearch's `search_after` parameter to resume from that point.

**The page token structure:**

The page token is a base64-encoded JSON object containing:
```json
{
  "sort": [145000, "EMP-042"],   // sort values from the last document
  "objectType": "Employee",       // to verify the token is for the right object type
  "orderBy": [                    // the original sort order (to ensure consistency)
    { "field": "salary", "direction": "desc" },
    { "field": "__pk", "direction": "asc" }
  ],
  "where": "sha256hash",          // hash of the original where clause (to detect query changes)
  "created": 1710000000000        // timestamp (for optional token expiry)
}
```

**Implementation details:**

1. **`createPageToken(lastDocument, orderByFields, objectTypeApiName, whereClause)`** — Takes the last document from the result set, the sort fields, the object type, and the where clause. Extracts the sort values from the document (the values of the fields specified in `orderBy`, plus the tiebreaker field `__pk`). Encodes everything into a base64 JSON string. Returns the token string.

2. **`decodePageToken(token, objectTypeApiName)`** — Decodes the base64 token, parses the JSON, and validates: (a) the `objectType` matches the current query's object type (if not, throw `"Page token was created for object type '${token.objectType}' but is being used with '${objectTypeApiName}'. Page tokens cannot be used across different object types."`), (b) the token is not expired (optional: reject tokens older than 24 hours to prevent stale cursors), (c) the `sort` array is a valid array of primitive values. Returns the decoded token object.

3. **`buildSearchAfterClause(decodedToken)`** — Returns the `search_after` array that OpenSearch expects. This is simply `decodedToken.sort`. For example, if the user is sorting by salary desc, the search_after might be `[145000, "EMP-042"]` (salary value, then PK as tiebreaker).

4. **`buildSortClause(orderByFields, objectTypeApiName, propertyResolver)`** — Translates the `$orderBy` array from the request into OpenSearch's `sort` clause. CRITICAL: Always append `__pk` as a tiebreaker sort field if it's not already in the list. Without a tiebreaker, documents with the same sort value have undefined order, which breaks pagination (you might skip or repeat documents). The tiebreaker must be a field with unique values — `__pk` (the primary key) is perfect.

   For string properties, sort on the `.keyword` sub-field (you can't sort on analyzed text fields in OpenSearch):
   ```json
   [
     { "salary": { "order": "desc" } },
     { "fullName.keyword": { "order": "asc" } },
     { "__pk": { "order": "asc" } }
   ]
   ```

   For numeric and date properties, sort on the field directly:
   ```json
   [
     { "startDate": { "order": "desc" } },
     { "__pk": { "order": "asc" } }
   ]
   ```

5. **`calculateTotalCount(opensearchClient, indexName, queryBody)`** — Executes a `count` request against OpenSearch to get the total number of matching documents. This is separate from the search request because OpenSearch's `search` response includes `hits.total.value` but it may be an approximation for large result sets (if `track_total_hits` is not set to `true`). Always pass `track_total_hits: true` in the search request to get exact counts. However, for very large result sets (>10,000), this can be expensive. Consider caching the total count for the duration of a pagination session (the page token could include the total count).

**Default sort order:** If the user doesn't specify `$orderBy`, the default sort must be by `__pk` ascending. This ensures deterministic ordering for pagination. Never rely on OpenSearch's default relevance scoring for paginated results — relevance scoring can change between requests if the index is updated.

**Edge cases:**
- Page token from a different query: If the user changes their `where` clause but reuses a page token from a previous query, the results will be wrong. The `where` hash in the token allows detection of this — if the hash doesn't match, reject with `"Page token is from a different query. Please start pagination from the beginning without a pageToken."`.
- Empty result set: If no documents match the query, return `{ "data": [], "nextPageToken": null, "totalCount": 0 }`.
- Last page with exactly `$pageSize` results: If OpenSearch returns exactly `$pageSize + 1` results, the extra result confirms there are more pages. If it returns exactly `$pageSize` results, this MIGHT be the last page OR there might be exactly 0 more results. To handle this correctly, always request `$pageSize + 1` and check the count.
