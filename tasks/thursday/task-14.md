# TASK 14: Build the Reverse Search Around for Bidirectional Links

**Objective:** Extend the Search Around endpoint (Task 13) to support reverse direction traversal. When the caller's `objectType` is the TARGET of the link type (not the source), the Search Around should work in reverse — finding source objects linked to matching target objects.

**Prerequisites:** Task 13 must be complete.

**Implementation:** In the Search Around handler (`src/routes/linkTraversal.js`), after fetching the link type definition, check whether the caller's objectType matches the source or the target. If it matches the target, swap the direction:

- Phase 1 searches the TARGET index (the caller's type, which would normally be the source)
- Phase 2 searches the SOURCE index (the opposite side, which becomes the effective target)
- The FK direction is reversed

Add this logic at the beginning of the Search Around handler, before Phase 1 begins:

```javascript
let effectiveSourceType, effectiveTargetType, effectiveFkField, effectiveFkSide, isReverse;

if (objectType === linkType.source_object_type_api_name) {
    // Normal forward Search Around
    effectiveSourceType = linkType.source_object_type_api_name;
    effectiveTargetType = linkType.target_object_type_api_name;
    effectiveFkField = linkType.foreign_key_property_api_name;
    effectiveFkSide = linkType.foreign_key_side;
    isReverse = false;
} else if (objectType === linkType.target_object_type_api_name && linkType.is_bidirectional) {
    // Reverse Search Around
    effectiveSourceType = linkType.target_object_type_api_name;
    effectiveTargetType = linkType.source_object_type_api_name;
    effectiveFkField = linkType.foreign_key_property_api_name;
    effectiveFkSide = linkType.foreign_key_side === 'source' ? 'target' : 'source';
    isReverse = true;
} else if (objectType === linkType.target_object_type_api_name && !linkType.is_bidirectional) {
    return res.status(400).json({ error: `Link type '${linkTypeApiName}' is not bidirectional. Cannot Search Around from target type '${objectType}'.` });
} else {
    return res.status(400).json({ error: `Cannot search around: '${objectType}' is not part of link '${linkTypeApiName}'.` });
}
```

Then use `effectiveSourceType` and `effectiveTargetType` throughout both phases:
- Phase 1: Search `ontology-${effectiveSourceType.toLowerCase()}` with `sourceFilter`.
- Phase 2: Search `ontology-${effectiveTargetType.toLowerCase()}` using the FK relationship in the reversed direction.

**For M2M links in reverse:** When `isReverse` is true, swap the join table columns — use `join_table_target_column` as the lookup column and `join_table_source_column` as the result column.

**Self-referential links:** When `source === target`, use the `$direction` field from the request body (if provided) to determine `isReverse`. If not provided, default to forward (`isReverse = false`).

**Error responses:**
- HTTP 400 — Object type is not part of the link: `{ "error": "Cannot search around: '${objectType}' is not part of link '${linkTypeApiName}'." }`.
- HTTP 400 — Non-bidirectional reverse: `{ "error": "Link type '${linkTypeApiName}' is not bidirectional. Cannot Search Around from target type '${objectType}'." }`.

**File to modify:** `src/routes/linkTraversal.js` — modify the existing Search Around handler from Task 13.

**Testing:**
1. Using the Employee → Ticket link (ONE_TO_MANY, FK: `assigneeEmployeeId` on Ticket):
   - Forward: `POST /api/v2/objects/Employee/searchAround` with `sourceFilter: { type: "eq", field: "department", value: "Engineering" }`, `linkType: "assignedTickets"` → returns Tickets assigned to Engineering employees.
   - Reverse: `POST /api/v2/objects/Ticket/searchAround` with `sourceFilter: { type: "eq", field: "status", value: "open" }`, `linkType: "assignedTickets"` → returns Employees who have open tickets assigned to them.
2. Test with a non-bidirectional link type in reverse — verify HTTP 400.
3. Test with an object type not part of the link — verify HTTP 400.
