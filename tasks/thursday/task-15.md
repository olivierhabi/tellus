# TASK 15: Create the Link Count API Endpoint

**Objective:** Build an endpoint that returns the COUNT of linked objects for a given object, without returning the actual objects. This is used by the Object Explorer and Object Views to display badges like "5 Tickets" next to each link type in the sidebar, and by Workshop to show link counts in summary cards.

**Prerequisites:** Tasks 1, 7-11 must be complete.

**HTTP method and path:** `GET /api/v1/objects/:objectType/:primaryKey/links/:linkType/count`

**Implementation:**

1. Determine the ontology ID from the `objectType`: `SELECT ontology_id FROM object_type WHERE api_name = $1`. If not found, return HTTP 404 with `{ "error": "Object type '${objectType}' not found." }`.

2. Fetch the link type definition: `SELECT * FROM link_type WHERE ontology_id = $1 AND api_name = $2`. If not found, return HTTP 404 with `{ "error": "Link type '${linkType}' not found." }`.

3. Determine traversal direction using the same logic as Task 11's dispatcher (check if objectType matches source or target, handle self-referential links via optional `$direction` query parameter).

4. Count linked objects based on cardinality:

**For FK-based links (ONE_TO_ONE, ONE_TO_MANY, MANY_TO_ONE):**

Use the OpenSearch `_count` API (NOT `_search`):

```javascript
// Determine the target index and FK field based on direction
const targetIndex = `ontology-${effectiveTargetType.toLowerCase()}`;
const fkField = effectiveFkField;

const countResult = await opensearchClient.count({
    index: targetIndex,
    body: {
        query: {
            bool: {
                should: [
                    { term: { [`${fkField}.keyword`]: primaryKey } },
                    { term: { [fkField]: primaryKey } }
                ],
                minimum_should_match: 1
            }
        }
    }
});
const count = countResult.body.count;
```

For MANY_TO_ONE forward (FK on source side): the count is always 0 or 1. Read the source object's FK value and check if the target exists:
```javascript
// Simplified: just check if FK value is non-null on the source object
const sourceResult = await opensearchClient.search({
    index: sourceIndex,
    body: { query: { term: { '__pk': primaryKey } }, _source: [fkField], size: 1 }
});
const fkValue = sourceResult.body.hits.hits[0]?._source?.[fkField];
const count = (fkValue !== null && fkValue !== undefined) ? 1 : 0;
```

**For M2M links:**

Count the matching rows in the join table (don't fetch the actual target objects):
```javascript
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const filePath = linkType.join_table_file_path;

if (!fs.existsSync(filePath)) {
    count = 0;
} else {
    const records = parse(fs.readFileSync(filePath, 'utf-8'), { columns: true, skip_empty_lines: true });
    const lookupColumn = isReverse ? linkType.join_table_target_column : linkType.join_table_source_column;
    count = records.filter(r => String(r[lookupColumn]) === String(primaryKey)).length;
}
```

**Response:**
```json
{
    "count": 42,
    "linkType": "assignedTickets",
    "objectType": "Employee",
    "primaryKey": "EMP-001"
}
```

**Error responses:**
- HTTP 404 — Object type not found: `{ "error": "Object type '${objectType}' not found." }`.
- HTTP 404 — Link type not found: `{ "error": "Link type '${linkType}' not found." }`.
- HTTP 400 — Object type not part of link: `{ "error": "Object type '${objectType}' is not part of link type '${linkType}'." }`.
- HTTP 500 — Internal error: `{ "error": "Internal server error" }`.

**Performance requirement:** This endpoint MUST complete in < 50ms for FK-based links. It's called multiple times per object detail page load (once per link type). Use `_count` not `_search` for efficiency.

**File to modify:** `src/routes/linkTraversal.js` — add the GET `/:objectType/:primaryKey/links/:linkType/count` handler. Register this route BEFORE the `GET /:objectType/:primaryKey/links/:linkType` route to prevent Express from treating "count" as a `linkType` parameter.

**Testing:**
1. Create Employee EMP-001 with 5 Tickets linked via `assigneeEmployeeId`. Call count endpoint — verify `count: 5`.
2. Create Employee EMP-002 with 0 Tickets. Call count endpoint — verify `count: 0`.
3. Create M2M link (Employee → Courses) with EMP-001 linked to 3 courses in join table. Call count endpoint — verify `count: 3`.
4. Test with non-existent link type — verify HTTP 404.
5. Test with object type not part of link — verify HTTP 400.
