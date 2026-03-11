# TASK 22: Create Multi-Hop Link Traversal Utility

**Objective:** Build a utility function that performs multi-hop link traversal — following a chain of links across multiple object types. For example: "Starting from Company 'Acme', follow companyEmployees → assignedTickets to find all Tickets for Acme employees." This is a depth-2 traversal. Palantir supports this in Object Explorer and Quiver.

**Prerequisites:** Tasks 7-11 must be complete (all resolvers and the unified dispatcher).

**Implementation:** Create `resolveMultiHop` in `src/services/linkResolver.js`:

```javascript
/**
 * Resolves a chain of links starting from a single object.
 *
 * @param {Object} params
 * @param {string} params.ontologyId - The ontology ID
 * @param {string} params.startObjectType - The starting object's type api_name
 * @param {string} params.startPrimaryKey - The starting object's PK
 * @param {string[]} params.linkChain - Ordered array of link type api_names to traverse
 * @param {Object} params.finalFilter - Optional filter applied ONLY to the final hop's results
 * @param {Object[]} params.orderBy - Optional sort applied ONLY to the final hop's results
 * @param {number} params.pageSize - Page size for the final hop (default 100, max 10000)
 * @param {string} params.pageToken - Pagination cursor for the final hop
 *
 * @returns {Object} { data: Object[], nextPageToken: string|null, totalCount: number, hops: number }
 */
async function resolveMultiHop({ ontologyId, startObjectType, startPrimaryKey, linkChain, finalFilter, orderBy, pageSize, pageToken }) {
    // Validation
    if (!linkChain || linkChain.length === 0) {
        throw new BadRequestError('linkChain must contain at least 1 link type api_name.');
    }
    if (linkChain.length > 5) {
        throw new BadRequestError(`linkChain length ${linkChain.length} exceeds maximum of 5 hops.`);
    }

    let currentPKs = [startPrimaryKey];
    let currentObjectType = startObjectType;
    const visitedTypes = new Set(); // cycle detection
    visitedTypes.add(`${currentObjectType}:${startPrimaryKey}`);

    // Traverse all hops except the last
    for (let i = 0; i < linkChain.length - 1; i++) {
        const linkApiName = linkChain[i];
        const intermediatePKs = [];

        // Cap intermediate PKs at 100,000 to prevent memory explosion
        for (const pk of currentPKs.slice(0, 100000)) {
            const result = await resolveLink({
                objectTypeApiName: currentObjectType,
                primaryKey: pk,
                linkTypeApiName: linkApiName,
                ontologyId,
                pageSize: 10000,
            });

            if (Array.isArray(result.data)) {
                intermediatePKs.push(...result.data.map(o => o.__primaryKey));
            } else if (result.data) {
                intermediatePKs.push(result.data.__primaryKey);
            }
        }

        currentPKs = [...new Set(intermediatePKs)]; // deduplicate

        // Determine the next object type by fetching the link type definition
        const linkTypeRow = await db.query(
            'SELECT * FROM link_type WHERE ontology_id = $1 AND api_name = $2',
            [ontologyId, linkApiName]
        );
        if (linkTypeRow.rows.length === 0) {
            throw new NotFoundError(`Link type '${linkApiName}' not found at hop ${i + 1}.`);
        }
        const linkType = linkTypeRow.rows[0];
        currentObjectType = (currentObjectType === linkType.source_object_type_api_name)
            ? linkType.target_object_type_api_name
            : linkType.source_object_type_api_name;

        if (currentPKs.length === 0) {
            return { data: [], nextPageToken: null, totalCount: 0, hops: i + 1 };
        }
    }

    // Last hop: apply finalFilter, orderBy, and pagination
    const lastLinkApiName = linkChain[linkChain.length - 1];

    // For the last hop, we need to resolve from ALL currentPKs and aggregate results.
    // Use a terms query approach similar to Search Around (Task 13 Phase 2).
    const lastLinkTypeRow = await db.query(
        'SELECT * FROM link_type WHERE ontology_id = $1 AND api_name = $2',
        [ontologyId, lastLinkApiName]
    );
    if (lastLinkTypeRow.rows.length === 0) {
        throw new NotFoundError(`Link type '${lastLinkApiName}' not found at final hop.`);
    }
    const lastLinkType = lastLinkTypeRow.rows[0];
    const targetObjectType = (currentObjectType === lastLinkType.source_object_type_api_name)
        ? lastLinkType.target_object_type_api_name
        : lastLinkType.source_object_type_api_name;
    const targetIndex = `ontology-${targetObjectType.toLowerCase()}`;

    // Build target query based on cardinality
    let targetQuery;
    if (lastLinkType.cardinality !== 'MANY_TO_MANY') {
        const fkField = lastLinkType.foreign_key_property_api_name;
        const must = [{ terms: { [`${fkField}.keyword`]: currentPKs.slice(0, 100000) } }];
        if (finalFilter) {
            must.push(translateFilterToOpenSearch(finalFilter));
        }
        targetQuery = { bool: { must } };
    } else {
        // M2M: read join table, extract target PKs
        const joinRecords = readJoinTable(lastLinkType.join_table_file_path);
        const targetPKs = joinRecords
            .filter(r => currentPKs.includes(String(r[lastLinkType.join_table_source_column])))
            .map(r => String(r[lastLinkType.join_table_target_column]));
        const uniqueTargetPKs = [...new Set(targetPKs)].slice(0, 100000);
        const must = [{ terms: { '__pk': uniqueTargetPKs } }];
        if (finalFilter) {
            must.push(translateFilterToOpenSearch(finalFilter));
        }
        targetQuery = { bool: { must } };
    }

    // Execute with pagination (same pattern as resolveOneToMany)
    const sort = [];
    if (orderBy && orderBy.length > 0) {
        for (const ob of orderBy) {
            sort.push({ [`${ob.field}.keyword`]: { order: ob.direction || 'asc', missing: '_last' } });
        }
    }
    sort.push({ '__pk': 'asc' });

    const effectivePageSize = Math.min(pageSize || 100, 10000);
    let searchAfter = null;
    if (pageToken) {
        searchAfter = JSON.parse(Buffer.from(pageToken, 'base64').toString('utf-8'));
    }

    const searchBody = {
        query: targetQuery,
        sort,
        size: effectivePageSize + 1,
    };
    if (searchAfter) searchBody.search_after = searchAfter;

    const result = await opensearchClient.search({ index: targetIndex, body: searchBody });
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
        nextPageTokenResult = Buffer.from(JSON.stringify(pageHits[pageHits.length - 1].sort)).toString('base64');
    }

    const countResult = await opensearchClient.count({ index: targetIndex, body: { query: targetQuery } });

    return { data, nextPageToken: nextPageTokenResult, totalCount: countResult.body.count, hops: linkChain.length };
}
```

**Constraints:**
- Maximum chain length: 5 hops. Return HTTP 400 if `linkChain.length > 5`.
- Maximum intermediate PKs per hop: 100,000 (same as Search Around limit). If more PKs are collected, truncate silently.
- Palantir doesn't expose multi-hop as a single API call — it's done client-side in the OSDK or in Functions. But having the utility server-side enables efficient implementation for Workshop and Agent Studio.

**Dependencies:** Import `db` from `src/db/pool.js`, `opensearchClient` from `src/services/opensearchClient.js`, `resolveLink` from same file, `translateFilterToOpenSearch` from `src/services/objectSetService.js`, `readJoinTable` from same file (Task 10 helper).

**Error handling:**
- `linkChain` is empty: throw `BadRequestError('linkChain must contain at least 1 link type api_name.')`.
- `linkChain` exceeds 5: throw `BadRequestError('linkChain length N exceeds maximum of 5 hops.')`.
- Any link type in the chain not found: throw `NotFoundError('Link type X not found at hop N.')`.
- Empty results at any intermediate hop: return `{ data: [], nextPageToken: null, totalCount: 0, hops: N }` immediately.

**Module export:** Export `resolveMultiHop` from `src/services/linkResolver.js` alongside the other resolver functions. This is a separate function from `resolveLink` — it is NOT called by the dispatcher.

**File to modify:** `src/services/linkResolver.js`

**Testing:**
1. Create Company → Employee (ONE_TO_MANY, FK: companyId on target) and Employee → Ticket (ONE_TO_MANY, FK: assigneeEmployeeId on target).
2. Create Company COMP-001 with 3 Employees (EMP-001, EMP-002, EMP-003). Create 5 Tickets: TKT-001 and TKT-002 assigned to EMP-001, TKT-003 assigned to EMP-002, TKT-004 and TKT-005 assigned to EMP-003.
3. Call `resolveMultiHop({ ontologyId, startObjectType: 'Company', startPrimaryKey: 'COMP-001', linkChain: ['companyEmployees', 'assignedTickets'] })`.
4. Verify result: `data` contains TKT-001 through TKT-005, `totalCount: 5`, `hops: 2`.
5. Test with `finalFilter: { type: 'eq', field: 'assigneeEmployeeId', value: 'EMP-001' }` — should return only TKT-001, TKT-002.
6. Test with `linkChain` of length 6 — verify `BadRequestError`.
7. Test with a non-existent link type in the chain — verify `NotFoundError`.
8. Test with a Company that has no Employees — verify empty result with `hops: 1`.
