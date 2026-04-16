# TASK 19: Create Link Type List on Object Type Detail Endpoint

**Objective:** Modify the existing `GET /api/v1/ontology/:ontologyId/objectTypes/:apiName` endpoint (built on Day 1) to include the link types associated with this object type. When a caller fetches an object type's definition, they should also see all link types where this object type is the source or target.

**Prerequisites:** Tasks 1 and the Day 1 object type detail endpoint must be complete.

**Implementation:** In the existing object type GET handler (`src/routes/objectTypes.js` or wherever the Day 1 endpoint was created), after fetching the object type and its properties from PostgreSQL, also query the `link_type` table:

```sql
SELECT api_name, display_name, description, source_object_type_api_name, target_object_type_api_name,
       cardinality, is_bidirectional
FROM link_type
WHERE ontology_id = $1
AND (source_object_type_api_name = $2 OR target_object_type_api_name = $2)
ORDER BY api_name ASC
```

For each link type returned, determine the direction and effective target:

```javascript
const linkTypes = linkTypeRows.map(lt => {
    const isSource = lt.source_object_type_api_name === apiName;
    const isTarget = lt.target_object_type_api_name === apiName;

    if (isSource && isTarget) {
        // Self-referential link — show as forward
        return {
            apiName: lt.api_name,
            displayName: lt.display_name,
            targetObjectType: lt.target_object_type_api_name,
            cardinality: lt.cardinality,
            direction: 'forward'
        };
    } else if (isSource) {
        return {
            apiName: lt.api_name,
            displayName: lt.display_name,
            targetObjectType: lt.target_object_type_api_name,
            cardinality: lt.cardinality,
            direction: 'forward'
        };
    } else if (isTarget && lt.is_bidirectional) {
        // Reverse direction — the "target" from this object's perspective is the link's source
        return {
            apiName: lt.api_name,
            displayName: lt.display_name,
            targetObjectType: lt.source_object_type_api_name,
            cardinality: invertCardinality(lt.cardinality),
            direction: 'reverse'
        };
    }
    // Non-bidirectional link where this object is the target — skip
    return null;
}).filter(Boolean);
```

**Cardinality inversion helper** (for displaying the effective cardinality from the reverse side):
```javascript
function invertCardinality(cardinality) {
    switch (cardinality) {
        case 'ONE_TO_MANY': return 'MANY_TO_ONE';
        case 'MANY_TO_ONE': return 'ONE_TO_MANY';
        default: return cardinality; // ONE_TO_ONE and MANY_TO_MANY stay the same
    }
}
```

Add a `linkTypes` field to the existing response:

```json
{
    "objectType": {
        "apiName": "Employee",
        "displayName": "Employee",
        "properties": { ... },
        "linkTypes": [
            {
                "apiName": "employeeCompany",
                "displayName": "Employer",
                "targetObjectType": "Company",
                "cardinality": "MANY_TO_ONE",
                "direction": "forward"
            },
            {
                "apiName": "assignedTickets",
                "displayName": "Assigned Tickets",
                "targetObjectType": "Ticket",
                "cardinality": "ONE_TO_MANY",
                "direction": "forward"
            },
            {
                "apiName": "manages",
                "displayName": "Manager",
                "targetObjectType": "Employee",
                "cardinality": "ONE_TO_MANY",
                "direction": "forward"
            },
            {
                "apiName": "companyEmployees",
                "displayName": "Company Employees",
                "targetObjectType": "Company",
                "cardinality": "MANY_TO_ONE",
                "direction": "reverse"
            }
        ]
    }
}
```

**Edge cases:**
- Object type has no link types: return `"linkTypes": []`.
- Non-bidirectional links where this object type is the target: do NOT include them in the response (the link cannot be traversed from this side).
- Self-referential links: include once with direction `"forward"`.

**File to modify:** The existing object type detail endpoint file from Day 1 (likely `src/routes/objectTypes.js`). Add the link type query and response enrichment.

**Testing:**
1. Create object types Company, Employee, Ticket. Create link types: `employeeCompany` (Employee → Company, MANY_TO_ONE), `companyEmployees` (Company → Employee, ONE_TO_MANY), `employeeTickets` (Employee → Ticket, ONE_TO_MANY).
2. Fetch Employee object type detail: `GET /api/v1/ontology/{id}/objectTypes/Employee`.
3. Verify `linkTypes` array contains:
   - `employeeCompany` with direction `"forward"`, targetObjectType `"Company"`, cardinality `"MANY_TO_ONE"`
   - `employeeTickets` with direction `"forward"`, targetObjectType `"Ticket"`, cardinality `"ONE_TO_MANY"`
   - `companyEmployees` with direction `"reverse"`, targetObjectType `"Company"`, cardinality `"MANY_TO_ONE"` (inverted from ONE_TO_MANY)
4. Create a non-bidirectional link type where Employee is the target — verify it does NOT appear in the Employee's `linkTypes`.
5. Test with an object type that has no link types — verify `"linkTypes": []`.
