# TASK 13: Create the POST `/api/v1/objects/:objectType/searchAround` Endpoint

**Objective:** Build the Search Around endpoint — the most powerful link traversal feature. Given a FILTER on source objects (not a single PK), traverse a link type and return all target objects linked to any of the matching source objects. This is how Palantir enables queries like: "Find all open Tickets assigned to Employees in the Engineering department."

**Palantir doc reference:** The Object Set Service's Search Around feature. Default limit: 100,000 objects.

**HTTP method and path:** `POST /api/v1/objects/:objectType/searchAround`

**Request body:**

```json
{
    "sourceFilter": {
        "type": "eq",
        "field": "department",
        "value": "Engineering"
    },
    "linkType": "assignedTickets",
    "targetFilter": {
        "type": "eq",
        "field": "status",
        "value": "open"
    },
    "$orderBy": [{ "field": "priority", "direction": "desc" }],
    "$pageSize": 100,
    "$pageToken": null,
    "$select": ["ticketId", "title", "status", "priority"]
}
```

**Implementation:**

This is a TWO-PHASE query:

**Phase 1: Find all matching source objects' PKs**

Execute a search on the source object type's OpenSearch index with the `sourceFilter`. But instead of returning full objects, only return the primary key values. Use `_source: ["__pk"]` and scroll through ALL results (up to 100,000). This gives you the set of source PKs that match the filter.

```javascript
// Phase 1: Get source PKs
const sourceIndex = `ontology-${objectType.toLowerCase()}`;
const sourcePKs = [];
let searchAfter = null;

while (sourcePKs.length < 100000) {
    const body = {
        query: translateFilterToOpenSearch(sourceFilter),
        _source: ['__pk'],
        sort: [{ '__pk': 'asc' }],
        size: 10000, // batch size for scrolling
    };
    if (searchAfter) body.search_after = searchAfter;
    
    const result = await opensearch.search({ index: sourceIndex, body });
    const hits = result.body.hits.hits;
    if (hits.length === 0) break;
    
    for (const hit of hits) {
        sourcePKs.push(hit._source.__pk);
    }
    searchAfter = hits[hits.length - 1].sort;
    
    if (hits.length < 10000) break; // no more results
}
```

**Phase 2: For each source PK, find linked target objects**

Now, depending on the link type cardinality:

For FK-based links (ONE_TO_MANY, MANY_TO_ONE, ONE_TO_ONE):
- Build a single OpenSearch query on the target index: `{ terms: { "fkField.keyword": sourcePKs } }` + targetFilter
- This finds all target objects that link to ANY of the source PKs in one query
- This is much more efficient than calling resolveLink per source PK

For MANY_TO_MANY:
- Read the join table, find all rows where source_column is in sourcePKs
- Collect all target PKs
- Query target index with `{ terms: { "__pk": targetPKs } }` + targetFilter

**Phase 2 implementation:**

```javascript
// Phase 2: Find all linked targets
const linkType = await getLinkType(ontologyId, linkTypeApiName);
const targetIndex = `ontology-${linkType.target_object_type_api_name.toLowerCase()}`;

let targetQuery;

if (linkType.cardinality !== 'MANY_TO_MANY') {
    // FK-based: query target index for all objects whose FK is in sourcePKs
    const fkField = linkType.foreign_key_property_api_name;
    const must = [
        { terms: { [`${fkField}.keyword`]: sourcePKs } }
    ];
    if (targetFilter) {
        must.push(translateFilterToOpenSearch(targetFilter));
    }
    targetQuery = { bool: { must } };
} else {
    // M2M: read join table, extract target PKs
    const joinRecords = readJoinTable(linkType.join_table_file_path);
    const targetPKs = joinRecords
        .filter(r => sourcePKs.includes(String(r[linkType.join_table_source_column])))
        .map(r => String(r[linkType.join_table_target_column]));
    
    const uniqueTargetPKs = [...new Set(targetPKs)].slice(0, 100000);
    
    const must = [
        { terms: { '__pk': uniqueTargetPKs } }
    ];
    if (targetFilter) {
        must.push(translateFilterToOpenSearch(targetFilter));
    }
    targetQuery = { bool: { must } };
}

// Execute the target query with pagination
const sort = buildSort(orderBy);
const searchBody = {
    query: targetQuery,
    sort,
    size: effectivePageSize + 1,
    _source: select || true,
};
if (pageToken) {
    searchBody.search_after = decodePageToken(pageToken);
}

const targetResult = await opensearch.search({ index: targetIndex, body: searchBody });
// ... process results same as other endpoints
```

**The 100,000 object limit:** Palantir enforces a default Search Around limit of 100,000 objects. This applies to the number of source PKs in Phase 1. If the source filter matches more than 100,000 objects, cap at 100,000 and include a warning in the response:

```json
{
    "data": [...],
    "nextPageToken": "...",
    "totalCount": 4523,
    "warnings": [
        {
            "type": "SEARCH_AROUND_LIMIT",
            "message": "Source filter matched 250,000 objects but Search Around is limited to 100,000. Results may be incomplete."
        }
    ]
}
```

**sourceFilter and targetFilter interaction:** Both filters are applied simultaneously but at different phases:
- `sourceFilter` is applied in Phase 1 to select which source objects participate in the traversal.
- `targetFilter` is applied in Phase 2 to further restrict which target objects are returned.
- They are independent — `sourceFilter` never affects target results directly, and `targetFilter` never affects which source objects are considered.

**Self-referential links:** When the link type is self-referential (`sourceObjectType === targetObjectType`), the `objectType` in the URL determines Phase 1's index. Direction detection uses the same logic as Task 11's dispatcher (with the `$direction` parameter if present in the request body as an optional field). If no direction is provided and the link is self-referential, default to forward.

**Error responses:**
- HTTP 400 — Missing `linkType` in request body: `{ "error": "linkType is required." }`.
- HTTP 400 — Object type not part of link: `{ "error": "Object type '${objectType}' is not part of link type '${linkType}'." }`.
- HTTP 400 — Non-bidirectional reverse: `{ "error": "Link type '${linkType}' is not bidirectional." }`.
- HTTP 404 — Object type not found: `{ "error": "Object type '${objectType}' not found." }`.
- HTTP 404 — Link type not found: `{ "error": "Link type '${linkType}' not found." }`.
- HTTP 500 — Internal error: `{ "error": "Internal server error" }`.

**Prerequisites:** Tasks 1-11 must be complete.

**File to create:** `src/routes/linkTraversal.js` — add the POST `/:objectType/searchAround` handler alongside the GET link traversal route from Task 12.

**Testing:**
1. Create 10 Employees across 3 departments (Engineering: 4, Sales: 3, Marketing: 3). Create 20 Tickets linked to Employees via `assigneeEmployeeId` with mixed statuses (open/closed).
2. Search Around: `POST /api/v1/objects/Employee/searchAround` with `sourceFilter: { type: "eq", field: "department", value: "Engineering" }`, `linkType: "assignedTickets"` — verify only tickets assigned to Engineering employees are returned.
3. Add `targetFilter: { type: "eq", field: "status", value: "open" }` — verify only open tickets for Engineering employees are returned.
4. Test with a sourceFilter that matches 0 employees — verify empty result `{ "data": [], "totalCount": 0 }`.
5. Test with missing `linkType` in body — verify HTTP 400.
6. Test with a link type that doesn't exist — verify HTTP 404.
