# TASK 17: Create the OpenSearch Query Builder Wrapper

**File to create:** `/src/services/opensearchQueryBuilder.js`

**Dependencies:** Tasks 1 (PropertyResolver), 3-5 (queryTranslator), 6 (paginationService), 8 (aggregationBuilder), 9 (fullTextSearchService).

**Purpose:** This is the orchestration layer that combines all the individual services (query translator, pagination, aggregation builder, full-text search) into complete OpenSearch request bodies ready to be sent to the OpenSearch client. Each endpoint (list, search, aggregate, searchFullText) needs a slightly different OpenSearch query structure. This service provides a clean function for each case, so the route handlers remain simple and focused on HTTP concerns rather than OpenSearch internals.

**Functions to implement:**

1. **`buildListQuery({ objectTypeApiName, pageSize, pageToken, orderBy, select, propertyResolver })`**

   For the GET list endpoint. Assembles a complete OpenSearch request:
   - Query: `{ match_all: {} }`
   - Sort: call `paginationService.buildSortClause(orderBy, objectTypeApiName, propertyResolver)`. If `orderBy` is empty/absent, defaults to `[{ "__pk": { "order": "asc" } }]`.
   - Size: `pageSize + 1` (the +1 is for next-page detection — if we get pageSize+1 results, there's a next page)
   - `_source`: if `select` is provided, include only those fields plus `__pk` and `__objectType`. Otherwise omit `_source` to return all fields.
   - `search_after`: if `pageToken` is provided, call `paginationService.decodePageToken(pageToken, objectTypeApiName)` to extract the sort values.

   Returns: `{ index: "ontology-" + objectTypeApiName.toLowerCase(), body: { query, sort, size, track_total_hits: true, timeout: "30s", _source?, search_after? } }`

2. **`buildSearchQuery({ objectTypeApiName, where, pageSize, pageToken, orderBy, select, propertyResolver })`**

   For the POST search endpoint. Same as `buildListQuery` except:
   - Query: if `where` is present, call `queryTranslator.translateFilter(where, objectTypeApiName, propertyResolver)` to translate the filter DSL into OpenSearch query DSL. If `where` is absent, use `{ match_all: {} }`.
   - All other fields (sort, size, _source, search_after) are assembled identically to `buildListQuery`.

   Returns: `{ index, body }` with same structure.

3. **`buildAggregateQuery({ objectTypeApiName, where, aggregations, propertyResolver })`**

   For the POST aggregate endpoint:
   - Query: if `where` is present, call `queryTranslator.translateFilter()`. If absent, use `{ match_all: {} }`.
   - Aggregations: call `aggregationBuilder.buildAggregations(aggregations, objectTypeApiName, propertyResolver)` to build the `aggs` clause.
   - Size: `0` (never return hits, only aggregation results)

   Returns: `{ index: "ontology-" + objectTypeApiName.toLowerCase(), body: { query, aggs, size: 0, track_total_hits: true, timeout: "30s" } }`

4. **`buildFullTextQuery({ objectTypeApiName, queryString, where, pageSize, pageToken, select, propertyResolver })`**

   For the POST searchFullText endpoint:
   - Full-text query: call `fullTextSearchService.buildFullTextSearchQuery(queryString, objectTypeApiName, propertyResolver)` which returns `{ query: multiMatchQuery, highlight: highlightClause }`.
   - Query combination: if `where` is present, translate it via `queryTranslator.translateFilter()`, then combine: `{ bool: { must: [multiMatchQuery], filter: [translatedWhereQuery] } }`. If `where` is absent, use `multiMatchQuery` directly.
   - Sort: if no explicit `orderBy` is provided, default to `[{ "_score": { "order": "desc" } }, { "__pk": { "order": "asc" } }]` (relevance sorting). If `orderBy` is provided, use `paginationService.buildSortClause()` instead.
   - Size: `pageSize + 1` for next-page detection.
   - Highlight: include the `highlightClause` from the full-text search service in the body.
   - `_source`: same logic as `buildListQuery`.
   - `search_after`: same logic as `buildListQuery`.

   Returns: `{ index, body: { query, sort, size, highlight, track_total_hits: true, timeout: "30s", _source?, search_after? } }`

**Important parameters always included in every query body:**
- `track_total_hits: true` — always get exact counts, not approximations
- `timeout: "30s"` — prevent indefinitely running queries

**Logging:** Log the complete OpenSearch query body at DEBUG level for troubleshooting using `console.debug(JSON.stringify({ type: "opensearch_query", function: functionName, index, body }))`. This is useful when queries return unexpected results.

**Export:** `{ buildListQuery, buildSearchQuery, buildAggregateQuery, buildFullTextQuery }`

**Acceptance criteria:**
1. `buildListQuery({ objectTypeApiName: "Employee", pageSize: 10, propertyResolver })` returns `{ index: "ontology-employee", body: { query: { match_all: {} }, sort: [{ __pk: { order: "asc" } }], size: 11, track_total_hits: true, timeout: "30s" } }`.
2. `buildSearchQuery` with a `where` clause returns the translated filter in `body.query` (not `match_all`).
3. `buildAggregateQuery` returns `body.size: 0` and includes `body.aggs`.
4. `buildFullTextQuery` without `where` returns `body.query` as the `multi_match` query directly.
5. `buildFullTextQuery` with `where` returns `body.query` as a `bool` with `must: [multi_match]` and `filter: [translatedWhere]`.
6. `buildFullTextQuery` without explicit `orderBy` returns `body.sort` as `[{ _score: { order: "desc" } }, { __pk: { order: "asc" } }]`.
7. `buildFullTextQuery` returns `body.highlight` from the full-text search service.
8. All functions include `track_total_hits: true` and `timeout: "30s"` in the body.
