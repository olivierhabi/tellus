# TASK 21: Create Self-Referential Link Support

**Objective:** Ensure that link types where `sourceObjectType === targetObjectType` work correctly for all resolvers and endpoints. Self-referential links are common: Employee manages Employees, Category is parent of Category, Person is friend of Person.

**Prerequisites:** Tasks 7-12 must be complete (all resolvers, dispatcher, and linked objects endpoint).

**The Problem:** When both source and target are the same object type, two issues arise:
1. The same OpenSearch index is queried for both sides, so the starting object could appear in its own results (self-linking).
2. The direction detection in Task 11's `resolveLink` dispatcher cannot distinguish forward from reverse traversal because `objectTypeApiName === linkType.source_object_type_api_name` AND `objectTypeApiName === linkType.target_object_type_api_name` are both true. The first `if` branch always matches, making reverse traversal unreachable.

**Implementation — 3 changes required:**

**Change 1: Add self-exclusion filter to `resolveOneToMany` in `src/services/linkResolver.js`**

In the `resolveOneToMany` function (Task 7), after building the FK filter in the `must` array (around line 75), add a filter to exclude the starting object from results when the source and target object types are the same:

```javascript
// Exclude the source object itself from results (prevent self-linking)
// Only needed for self-referential links where source and target are the same index
if (linkType.source_object_type_api_name === linkType.target_object_type_api_name) {
    must.push({ bool: { must_not: [{ term: { '__pk': sourcePrimaryKey } }] } });
}
```

This ensures that when resolving Employee → Employee (manages), EMP-001's results do not include EMP-001 itself.

**Change 2: Add `direction` override parameter to `resolveLink` in `src/services/linkResolver.js`**

Modify the `resolveLink` function signature to accept an optional `direction` parameter:

```javascript
async function resolveLink({ objectTypeApiName, primaryKey, linkTypeApiName, ontologyId,
                             direction: requestedDirection, // NEW: 'forward' | 'reverse' | undefined
                             targetFilter, orderBy, pageSize, pageToken }) {
```

Replace the direction detection logic (Step 2) with:

```javascript
// Step 2: Determine traversal direction
let direction;

if (requestedDirection === 'forward' || requestedDirection === 'reverse') {
    // Explicit direction provided (required for self-referential links)
    direction = requestedDirection;
    if (direction === 'reverse' && !linkType.is_bidirectional) {
        throw new BadRequestError(`Link type '${linkTypeApiName}' is not bidirectional. Cannot traverse in reverse.`);
    }
} else if (linkType.source_object_type_api_name === linkType.target_object_type_api_name) {
    // Self-referential link with no explicit direction — default to forward
    direction = 'forward';
} else if (objectTypeApiName === linkType.source_object_type_api_name) {
    direction = 'forward';
} else if (objectTypeApiName === linkType.target_object_type_api_name) {
    if (!linkType.is_bidirectional) {
        throw new BadRequestError(`Link type '${linkTypeApiName}' is not bidirectional. Cannot traverse from target to source.`);
    }
    direction = 'reverse';
} else {
    throw new BadRequestError(`Object type '${objectTypeApiName}' is not part of link type '${linkTypeApiName}'. Source is '${linkType.source_object_type_api_name}', target is '${linkType.target_object_type_api_name}'.`);
}
```

**Change 3: Add `$direction` query parameter to the linked objects endpoint in `src/routes/linkTraversal.js`**

In the GET `/api/v2/objects/:objectType/:primaryKey/links/:linkType` handler (Task 12), parse the `$direction` query parameter:

```javascript
const direction = req.query.$direction; // 'forward', 'reverse', or undefined
if (direction && direction !== 'forward' && direction !== 'reverse') {
    return res.status(400).json({ error: "Invalid $direction. Must be 'forward' or 'reverse'." });
}
```

Pass `direction` through to `resolveLink`:

```javascript
const result = await resolveLink({
    objectTypeApiName: objectType,
    primaryKey,
    linkTypeApiName: linkType,
    ontologyId,
    direction,  // NEW
    targetFilter, orderBy, pageSize, pageToken
});
```

**File to modify:** `src/services/linkResolver.js` (Changes 1 and 2), `src/routes/linkTraversal.js` (Change 3).

**Testing:**
1. Create an Employee → Employee "manages" link type (ONE_TO_MANY, FK: `managerId` on target side, bidirectional: true).
2. Create employees: EMP-001 (manager, managerId=null), EMP-002 (managerId=EMP-001), EMP-003 (managerId=EMP-001), EMP-004 (managerId=EMP-001).
3. **Forward traversal (default):** `GET /api/v2/objects/Employee/EMP-001/links/manages` — returns EMP-002, EMP-003, EMP-004. Does NOT return EMP-001 itself. `totalCount: 3`.
4. **Forward traversal (explicit):** `GET /api/v2/objects/Employee/EMP-001/links/manages?$direction=forward` — same result as above.
5. **Reverse traversal:** `GET /api/v2/objects/Employee/EMP-002/links/manages?$direction=reverse` — returns EMP-001 (the manager). `totalCount: 1`.
6. **No direction on self-referential:** `GET /api/v2/objects/Employee/EMP-002/links/manages` (no `$direction`) — defaults to forward. Returns employees where managerId=EMP-002 (should be empty if EMP-002 manages nobody). `totalCount: 0`.
7. **Invalid direction:** `GET /api/v2/objects/Employee/EMP-001/links/manages?$direction=sideways` — returns HTTP 400 with `{ "error": "Invalid $direction. Must be 'forward' or 'reverse'." }`.
