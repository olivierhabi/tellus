# TASK 10: Build the MANY_TO_MANY Link Resolver

**Objective:** Implement the link resolution logic for MANY_TO_MANY cardinality links. This is the most complex resolver because it uses a separate join table instead of a foreign key property. The join table is a CSV file (or dataset in Palantir) that contains pairs of primary keys from both sides.

**Why this is different:** In Palantir Foundry, many-to-many link types require a backing datasource — a join table dataset with columns mapping to the primary keys of both object types. For example, a Student ↔ Course many-to-many link might have a join table with columns `student_id` and `course_id`. Each row represents one link.

**Implementation:**

Create a function `resolveManyToMany` in `src/services/linkResolver.js`:

```javascript
/**
 * Resolves a MANY_TO_MANY link by reading the join table and looking up target objects.
 *
 * @param {Object} params
 * @param {string} params.sourcePrimaryKey - PK of the source object
 * @param {Object} params.linkType - Full link type definition (must have joinTable config)
 * @param {Object} params.targetFilter - Optional filter on target objects
 * @param {Object[]} params.orderBy - Optional sort
 * @param {number} params.pageSize - Results per page
 * @param {string} params.pageToken - Pagination cursor
 *
 * @returns {Object} { data: Object[], nextPageToken, totalCount }
 */
async function resolveManyToMany({ sourcePrimaryKey, linkType, targetFilter, orderBy, pageSize, pageToken }) {
    // Step 1: Read the join table file
    const joinFilePath = linkType.join_table_file_path;
    const sourceColumn = linkType.join_table_source_column;
    const targetColumn = linkType.join_table_target_column;
    
    // Read and parse the CSV join table
    // For week 1, read the entire file into memory.
    // For production, this should be indexed (either in OpenSearch as its own index
    // or in PostgreSQL as a table). But for now, CSV parsing works for < 1M rows.
    const fs = require('fs');
    const { parse } = require('csv-parse/sync');
    
    if (!fs.existsSync(joinFilePath)) {
        return { data: [], nextPageToken: null, totalCount: 0 };
    }
    
    const fileContent = fs.readFileSync(joinFilePath, 'utf-8');
    const records = parse(fileContent, { columns: true, skip_empty_lines: true });
    
    // Step 2: Find all target PKs linked to the source PK
    const targetPrimaryKeys = [];
    for (const record of records) {
        if (String(record[sourceColumn]) === String(sourcePrimaryKey)) {
            targetPrimaryKeys.push(String(record[targetColumn]));
        }
    }
    
    if (targetPrimaryKeys.length === 0) {
        return { data: [], nextPageToken: null, totalCount: 0 };
    }
    
    // Step 3: Fetch all target objects from OpenSearch using a terms query
    // Palantir's Search Around limit is 100,000 — enforce this
    const cappedPKs = targetPrimaryKeys.slice(0, 100000);
    
    const targetIndex = `ontology-${linkType.target_object_type_api_name.toLowerCase()}`;
    
    const must = [
        { terms: { '__pk': cappedPKs } }
    ];
    
    // Apply target filter if provided
    if (targetFilter) {
        const translatedFilter = translateFilterToOpenSearch(targetFilter);
        must.push(translatedFilter);
    }
    
    // Build sort
    const sort = [];
    if (orderBy && orderBy.length > 0) {
        for (const ob of orderBy) {
            sort.push({ [`${ob.field}.keyword`]: { order: ob.direction || 'asc', missing: '_last' } });
        }
    }
    sort.push({ '__pk': 'asc' });
    
    // Pagination
    let searchAfter = null;
    if (pageToken) {
        searchAfter = JSON.parse(Buffer.from(pageToken, 'base64').toString('utf-8'));
    }
    
    const effectivePageSize = Math.min(pageSize || 100, 10000);
    
    const searchBody = {
        query: { bool: { must } },
        sort,
        size: effectivePageSize + 1,
    };
    if (searchAfter) {
        searchBody.search_after = searchAfter;
    }
    
    const result = await opensearchClient.search({
        index: targetIndex,
        body: searchBody,
    });
    
    // Process results (same as ONE_TO_MANY)
    const hits = result.body.hits.hits;
    const hasNextPage = hits.length > effectivePageSize;
    const pageHits = hasNextPage ? hits.slice(0, effectivePageSize) : hits;
    
    const data = pageHits.map(hit => ({
        __primaryKey: hit._source.__pk,
        __objectType: hit._source.__objectType,
        ...hit._source,
    }));
    
    let nextPageTokenResult = null;
    if (hasNextPage) {
        const lastHit = pageHits[pageHits.length - 1];
        nextPageTokenResult = Buffer.from(JSON.stringify(lastHit.sort)).toString('base64');
    }
    
    // Total count: count of target objects matching the terms + filter
    const countResult = await opensearchClient.count({
        index: targetIndex,
        body: { query: { bool: { must } } },
    });
    
    return { data, nextPageToken: nextPageTokenResult, totalCount: countResult.body.count };
}
```

**Important Palantir behaviors:**

1. The join table is read at query time for week 1. In production Palantir, the join table is indexed into OpenSearch alongside the object types (the Funnel indexes join tables as link data). For week 1, reading the CSV directly is acceptable but MUST be replaced with an indexed approach in week 3 for performance.

2. The Search Around limit of 100,000 applies to the NUMBER OF TARGET PKS extracted from the join table, not the number of results returned. If the join table has 500,000 rows matching the source PK, only the first 100,000 are used.

3. Duplicate entries in the join table are allowed (the same source-target pair can appear multiple times). However, the result should contain each target object at most once. The OpenSearch `terms` query on `__pk` handles deduplication automatically — even if the same target PK appears 5 times in the cappedPKs array, OpenSearch returns it once.

4. If the join table file doesn't exist yet, return an empty result (not an error). In Palantir, you can define a many-to-many link type and upload the join table data later.

**Dependencies:**
- Import `opensearchClient` from `src/services/opensearchClient.js`.
- Import `translateFilterToOpenSearch` from `src/services/objectSetService.js` (built on Day 3).
- Require `fs` and `csv-parse/sync` for join table CSV reading.

**File to modify:** `src/services/linkResolver.js` — add `resolveManyToMany` alongside the other resolvers.

**Testing:**
1. Create Student and Course object types. Upload a join table CSV: `student_id,course_id\nSTU-001,CRS-101\nSTU-001,CRS-102\nSTU-002,CRS-101`. Create a MANY_TO_MANY link (Student → Course, join table columns: student_id, course_id, bidirectional).
2. Call `resolveManyToMany({ sourcePrimaryKey: 'STU-001', linkType, pageSize: 100 })` — verify `data` contains CRS-101 and CRS-102, `totalCount: 2`.
3. Test reverse direction (resolving from CRS-101 via the dispatcher in Task 11 with flipped join table columns) — verify STU-001 and STU-002 are returned.
4. Test with `targetFilter: { type: "eq", field: "courseName", value: "Databases" }` — verify only matching courses returned.
5. Test with a join table file that doesn't exist — verify `{ data: [], nextPageToken: null, totalCount: 0 }` (not an error).
6. Test with duplicate entries in join table (STU-001,CRS-101 appears twice) — verify CRS-101 appears only once in results (OpenSearch deduplicates via `terms` query on `__pk`).
