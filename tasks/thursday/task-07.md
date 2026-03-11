# TASK 7: Build the ONE_TO_MANY Link Resolver

**Objective:** Implement the core link resolution logic for ONE_TO_MANY cardinality links. This is the function that, given a single source object's primary key and a link type definition, returns all target objects linked to that source. This is the most common link cardinality in practice — for example, a Company has many Employees, or a Customer has many Orders.

**Why this is critical in Palantir:** The Search Around feature, Object Explorer's linked objects section, Workshop's linked object table widget, and OSDK's `.pivotTo()` method all depend on link resolution. The resolver must be fast (queries should complete in < 100ms for most cases) because it's called on every object detail page load and every Search Around query.

**In Palantir's architecture, ONE_TO_MANY works as follows:**
- Source: Company (the "one" side)
- Target: Employee (the "many" side)
- The foreign key is on the TARGET side: `Employee.companyId` holds the Company's primary key
- To find all Employees for Company "COMP-001": query the Employee index for all documents where `companyId = "COMP-001"`

**Implementation:**

Create a new module `src/services/linkResolver.js` (or `linkResolver.ts`). This module exports a function `resolveOneToMany` with the following signature:

```javascript
/**
 * Resolves a ONE_TO_MANY link from a single source object to multiple target objects.
 *
 * @param {Object} params
 * @param {string} params.sourcePrimaryKey - The primary key value of the source object
 * @param {Object} params.linkType - The full link type definition from the database
 * @param {Object} params.targetFilter - Optional additional filter to apply to the target objects (same DSL as the search endpoint)
 * @param {string[]} params.select - Optional list of property api_names to include in the response (default: all)
 * @param {Object[]} params.orderBy - Optional sort specification (e.g., [{ field: "fullName", direction: "asc" }])
 * @param {number} params.pageSize - Number of results to return (default: 100, max: 10000)
 * @param {string} params.pageToken - Opaque pagination cursor (OpenSearch's search_after value, base64-encoded)
 *
 * @returns {Object} { data: Object[], nextPageToken: string|null, totalCount: number }
 */
async function resolveOneToMany({ sourcePrimaryKey, linkType, targetFilter, select, orderBy, pageSize, pageToken }) {
    // Step 1: Determine which index to query and which field to match
    const targetIndex = `ontology-${linkType.target_object_type_api_name.toLowerCase()}`;
    
    // Step 2: Determine the FK field name
    // For ONE_TO_MANY with FK on target side:
    //   The target objects have a property whose value = source PK
    // For ONE_TO_MANY with FK on source side:
    //   This shouldn't happen for ONE_TO_MANY. ONE_TO_MANY means "one source, many targets"
    //   The FK is ALWAYS on the target side for ONE_TO_MANY.
    //   If the link type was defined with FK on source side, that's actually MANY_TO_ONE.
    //   But handle both cases defensively.
    
    let fkField, fkValue;
    if (linkType.foreign_key_side === 'target') {
        // Target objects have a property pointing to source PK
        fkField = linkType.foreign_key_property_api_name;
        fkValue = sourcePrimaryKey;
        // Query: find all targets where target.fkProperty = source.PK
    } else {
        // FK is on source side — this means source has a property pointing to target PK
        // For ONE_TO_MANY this is unusual, but handle it:
        // We need the source object's FK property value to find the targets
        // Actually, if FK is on source side, this is really a lookup — source has one FK value
        // So there's at most one target. This is effectively ONE_TO_ONE.
        // Handle it anyway by reading the source object's FK value first.
        throw new Error('ONE_TO_MANY with FK on source side is not valid. Use MANY_TO_ONE instead.');
    }
    
    // Step 3: Build the OpenSearch query
    const must = [];
    
    // The core link filter: target.fkProperty = source PK
    // Use .keyword subfield for exact matching on text fields
    must.push({
        bool: {
            should: [
                { term: { [`${fkField}.keyword`]: fkValue } },
                { term: { [fkField]: fkValue } }
            ],
            minimum_should_match: 1
        }
    });
    
    // Step 4: If targetFilter is provided, translate it to OpenSearch DSL
    // Reuse the same filter translation function from the Object Set Service (Day 3)
    if (targetFilter) {
        const translatedFilter = translateFilterToOpenSearch(targetFilter);
        must.push(translatedFilter);
    }
    
    // Step 5: Build the full query
    const query = {
        bool: {
            must: must
        }
    };
    
    // Step 6: Build sort
    const sort = [];
    if (orderBy && orderBy.length > 0) {
        for (const ob of orderBy) {
            const sortField = ob.field.endsWith('.keyword') ? ob.field : `${ob.field}.keyword`;
            sort.push({ [sortField]: { order: ob.direction || 'asc', missing: '_last' } });
        }
    }
    sort.push({ '__pk': 'asc' }); // tiebreaker for consistent pagination
    
    // Step 7: Handle pagination using search_after
    let searchAfter = null;
    if (pageToken) {
        try {
            searchAfter = JSON.parse(Buffer.from(pageToken, 'base64').toString('utf-8'));
        } catch (e) {
            throw new Error('Invalid pageToken');
        }
    }
    
    // Step 8: Execute the search
    const searchBody = {
        query: query,
        sort: sort,
        size: (pageSize || 100) + 1, // fetch one extra to detect next page
        _source: select ? ['__pk', '__objectType', '__lastModified', ...select] : true,
    };
    if (searchAfter) {
        searchBody.search_after = searchAfter;
    }
    
    const result = await opensearchClient.search({
        index: targetIndex,
        body: searchBody,
    });
    
    // Step 9: Process results
    const hits = result.body.hits.hits;
    const effectivePageSize = pageSize || 100;
    const hasNextPage = hits.length > effectivePageSize;
    const pageHits = hasNextPage ? hits.slice(0, effectivePageSize) : hits;
    
    const data = pageHits.map(hit => ({
        __primaryKey: hit._source.__pk,
        __objectType: hit._source.__objectType,
        ...hit._source,
    }));
    
    let nextPageToken = null;
    if (hasNextPage) {
        const lastHit = pageHits[pageHits.length - 1];
        nextPageToken = Buffer.from(JSON.stringify(lastHit.sort)).toString('base64');
    }
    
    // Step 10: Get total count (separate count query for accuracy)
    const countResult = await opensearchClient.count({
        index: targetIndex,
        body: { query: query },
    });
    const totalCount = countResult.body.count;
    
    return { data, nextPageToken, totalCount };
}
```

**Key Palantir behaviors to replicate exactly:**

1. The foreign key match must be EXACT (not fuzzy/full-text). Use `term` query, not `match`. The `.keyword` subfield ensures exact matching for string fields.

2. The target filter is ADDITIVE — it further restricts the results, it doesn't replace the link filter. Both the link condition AND the target filter must be satisfied (they are joined with `bool.must`).

3. Pagination must be stable — if objects are added or removed between page requests, the pagination should still work correctly. OpenSearch's `search_after` provides this stability (unlike `from`/`size` which can skip or duplicate results).

4. The default page size is 100. The maximum is 10,000. If the caller requests more than 10,000, cap at 10,000 and do NOT error.

5. The `totalCount` must reflect the total number of linked objects matching the filter, not just the current page. This is used by the UI to display "Showing 1–100 of 4,523 linked objects."

**Dependencies:**
- Import `opensearchClient` from `src/services/opensearchClient.js`.
- Import `translateFilterToOpenSearch` from `src/services/objectSetService.js` (built on Day 3).

**Export:** Export `resolveOneToMany` from `src/services/linkResolver.js`.

**File to create:** `src/services/linkResolver.js` — this is the first function in the module. Tasks 8, 9, 10, and 11 will add additional functions to the same file.

**Testing:**
1. Create Company COMP-001 and 5 Employee objects with companyId=COMP-001. Create a ONE_TO_MANY link type (Company → Employee, FK: companyId on target, bidirectional).
2. Call `resolveOneToMany({ sourcePrimaryKey: 'COMP-001', linkType, pageSize: 100 })` — verify `data` contains all 5 employees, `totalCount: 5`, `nextPageToken: null`.
3. Test with `targetFilter: { type: "eq", field: "department", value: "Engineering" }` — verify only Engineering employees returned.
4. Test pagination: create 150 employees for COMP-002, call with `pageSize: 100` — verify `data.length: 100`, `nextPageToken` is not null, `totalCount: 150`. Follow the `nextPageToken` — verify remaining 50 returned.
5. Test with pageSize > 10000 — verify it's silently capped to 10000 (no error).
6. Test with a Company that has 0 employees — verify `{ data: [], nextPageToken: null, totalCount: 0 }`.
