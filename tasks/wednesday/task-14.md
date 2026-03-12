# TASK 14: Create the POST /objects/:objectType/searchFullText Endpoint

**File to modify:** `/src/routes/objects.js`

**Purpose:** This endpoint provides full-text search across ALL text properties of an object type simultaneously, using a single search string. This is the "search box" endpoint — the user types a few words and the system returns the most relevant objects. It's different from the `search` endpoint's `contains` filter, which searches within a single specified property. The `searchFullText` endpoint searches across ALL text properties at once and returns results ranked by relevance.

**Endpoint specification:**

```
POST /api/v2/objects/:objectType/searchFullText
Content-Type: application/json
```

**Request body:**
```json
{
  "query": "melissa chang engineering",
  "where": {
    "type": "eq",
    "field": "isActive",
    "value": true
  },
  "$pageSize": 20,
  "$pageToken": null,
  "$select": ["employeeId", "fullName", "department", "email"]
}
```

**Implementation step by step:**

1. **Validate the object type.**

2. **Validate the query string.** Must be a non-empty string, max 1000 characters. Reject empty/null/whitespace-only with 400 error.

3. **Build the full-text search query** using `fullTextSearchService.buildFullTextSearchQuery(query, objectType, propertyResolver)` from Task 9. This returns a `multi_match` query with boosted fields.

4. **If `where` is provided, combine with the text query:**
   ```javascript
   const combinedQuery = {
     bool: {
       must: [fullTextQuery],     // text search in must for relevance scoring
       filter: [translatedWhere]   // filters in filter for caching, no scoring
     }
   };
   ```
   If `where` is NOT provided, use just the full-text query.

5. **Build sort clause.** For full-text search, the DEFAULT sort is `_score` descending (relevance), NOT `__pk` ascending. This is different from the list and search endpoints. The user can override with `$orderBy`, but if they don't, the most relevant results should appear first.

   Important pagination difference: When sorting by `_score`, the tiebreaker must still be `__pk` for deterministic pagination. The sort clause becomes:
   ```json
   [
     { "_score": { "order": "desc" } },
     { "__pk": { "order": "asc" } }
   ]
   ```

   And the `search_after` in the page token will contain `[scoreValue, pkValue]`.

6. **Include highlighting** in the OpenSearch request (from Task 9).

7. **Execute, paginate, and format** — same as the search endpoint, but include `__highlights` in the response objects when highlights are present.

**Response format:**
```json
{
  "data": [
    {
      "__primaryKey": "EMP-001",
      "__objectType": "Employee",
      "employeeId": "EMP-001",
      "fullName": "Melissa Chang",
      "department": "Engineering",
      "email": "melissa.chang@acme.com",
      "__highlights": {
        "fullName": ["<mark>Melissa</mark> <mark>Chang</mark>"],
        "department": ["<mark>Engineering</mark>"]
      }
    }
  ],
  "nextPageToken": "eyJ...",
  "totalCount": 3
}
```

**Test cases:**
1. Search "melissa" → finds objects where "melissa" appears in any text property
2. Search "melissa chang" → finds objects containing BOTH terms
3. Search "EMP-001" → finds the object with that ID (boosted PK field)
4. Search with where clause → results are filtered AND relevance-ranked
5. Search "enginering" (typo) → finds "Engineering" via fuzzy matching
6. Search with $select → only selected properties returned, but highlights still work
7. Empty search string → 400 error
8. Very long search string (>1000 chars) → 400 error
9. Search that matches nothing → empty data, totalCount 0
