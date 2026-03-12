# TASK 11: Build the Unified Link Resolver Dispatcher

**Objective:** Create a single entry-point function `resolveLink` that takes a starting object's primary key, its object type, and a link type api_name, determines the cardinality and traversal direction, and dispatches to the correct resolver (ONE_TO_ONE, ONE_TO_MANY, MANY_TO_ONE, or MANY_TO_MANY). This dispatcher is what all API endpoints and services call — they never call the individual resolvers directly. The dispatcher also handles bidirectional traversal: if the caller is traversing the link from the target side instead of the source side, the dispatcher reverses the direction.

**Prerequisites:** Tasks 1, 7, 8, 9, 10 must be complete (link_type table and all four resolvers).

**Dependencies:**
- Import `db` from `src/db/pool.js` (the PostgreSQL connection pool).
- Import `resolveOneToOne`, `resolveOneToMany`, `resolveManyToOne`, `resolveManyToMany` from the same file (co-located in `src/services/linkResolver.js`).
- Import `NotFoundError` and `BadRequestError` from `src/errors.js` (see Error Classes section below).

**Error Classes:** Create `src/errors.js` if it doesn't exist:

```javascript
class NotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NotFoundError';
        this.statusCode = 404;
    }
}

class BadRequestError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BadRequestError';
        this.statusCode = 400;
    }
}

module.exports = { NotFoundError, BadRequestError };
```

These error classes are used by the dispatcher and consumed by Express error-handling middleware in Task 12 and Task 29. The `statusCode` property allows automatic HTTP status code mapping.

**Implementation:**

Create the main exported function `resolveLink` in `src/services/linkResolver.js`:

```javascript
const db = require('../db/pool');
const { NotFoundError, BadRequestError } = require('../errors');

/**
 * Universal link resolver. Determines cardinality and dispatches to the correct handler.
 * Also handles bidirectional traversal (resolving from target → source).
 *
 * @param {Object} params
 * @param {string} params.objectTypeApiName - The object type of the starting object
 * @param {string} params.primaryKey - PK of the starting object
 * @param {string} params.linkTypeApiName - The api_name of the link type to traverse
 * @param {string} params.ontologyId - The ontology ID
 * @param {string} [params.direction] - Optional explicit direction: 'forward' or 'reverse'. Required for self-referential links to traverse in reverse. If omitted, direction is inferred from objectTypeApiName.
 * @param {Object} [params.targetFilter] - Optional filter on the linked objects
 * @param {Object[]} [params.orderBy] - Optional sort
 * @param {number} [params.pageSize] - Page size (default 100, max 10000, applied by child resolvers)
 * @param {string} [params.pageToken] - Pagination cursor
 *
 * @returns {Object} Result shape depends on effective cardinality:
 *   - ONE_TO_ONE / MANY_TO_ONE: { data: Object|null, linked: boolean, reason?: string, direction: 'forward'|'reverse' }
 *   - ONE_TO_MANY / MANY_TO_MANY: { data: Object[], nextPageToken: string|null, totalCount: number, direction: 'forward'|'reverse' }
 */
async function resolveLink({ objectTypeApiName, primaryKey, linkTypeApiName, ontologyId, direction: requestedDirection, targetFilter, orderBy, pageSize, pageToken }) {
    // Step 1: Fetch the link type definition from PostgreSQL
    const linkTypeRow = await db.query(
        'SELECT * FROM link_type WHERE ontology_id = $1 AND api_name = $2',
        [ontologyId, linkTypeApiName]
    );

    if (linkTypeRow.rows.length === 0) {
        throw new NotFoundError(`Link type '${linkTypeApiName}' not found.`);
    }

    const linkType = linkTypeRow.rows[0];

    // Step 2: Determine traversal direction
    let direction;

    if (requestedDirection === 'forward' || requestedDirection === 'reverse') {
        // Explicit direction provided (needed for self-referential links)
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

    // Step 3: Dispatch based on direction and cardinality
    if (direction === 'forward') {
        switch (linkType.cardinality) {
            case 'ONE_TO_ONE':
                return { ...await resolveOneToOne({ sourcePrimaryKey: primaryKey, linkType }), direction: 'forward' };
            case 'ONE_TO_MANY':
                return { ...await resolveOneToMany({ sourcePrimaryKey: primaryKey, linkType, targetFilter, orderBy, pageSize, pageToken }), direction: 'forward' };
            case 'MANY_TO_ONE':
                return { ...await resolveManyToOne({ sourcePrimaryKey: primaryKey, linkType }), direction: 'forward' };
            case 'MANY_TO_MANY':
                return { ...await resolveManyToMany({ sourcePrimaryKey: primaryKey, linkType, targetFilter, orderBy, pageSize, pageToken }), direction: 'forward' };
            default:
                throw new BadRequestError(`Unknown cardinality '${linkType.cardinality}' for link type '${linkTypeApiName}'.`);
        }
    } else {
        // Reverse traversal — create a "flipped" link type for the resolver
        const flippedLinkType = {
            ...linkType,
            source_object_type_api_name: linkType.target_object_type_api_name,
            target_object_type_api_name: linkType.source_object_type_api_name,
            foreign_key_side: linkType.foreign_key_side === 'source' ? 'target' : 'source',
            join_table_source_column: linkType.join_table_target_column,
            join_table_target_column: linkType.join_table_source_column,
        };

        // Invert cardinality
        let effectiveCardinality;
        switch (linkType.cardinality) {
            case 'ONE_TO_MANY': effectiveCardinality = 'MANY_TO_ONE'; break;
            case 'MANY_TO_ONE': effectiveCardinality = 'ONE_TO_MANY'; break;
            case 'ONE_TO_ONE': effectiveCardinality = 'ONE_TO_ONE'; break;
            case 'MANY_TO_MANY': effectiveCardinality = 'MANY_TO_MANY'; break;
            default: throw new BadRequestError(`Unknown cardinality '${linkType.cardinality}' for link type '${linkTypeApiName}'.`);
        }
        flippedLinkType.cardinality = effectiveCardinality;

        switch (effectiveCardinality) {
            case 'ONE_TO_ONE':
                return { ...await resolveOneToOne({ sourcePrimaryKey: primaryKey, linkType: flippedLinkType }), direction: 'reverse' };
            case 'ONE_TO_MANY':
                return { ...await resolveOneToMany({ sourcePrimaryKey: primaryKey, linkType: flippedLinkType, targetFilter, orderBy, pageSize, pageToken }), direction: 'reverse' };
            case 'MANY_TO_ONE':
                return { ...await resolveManyToOne({ sourcePrimaryKey: primaryKey, linkType: flippedLinkType }), direction: 'reverse' };
            case 'MANY_TO_MANY':
                return { ...await resolveManyToMany({ sourcePrimaryKey: primaryKey, linkType: flippedLinkType, targetFilter, orderBy, pageSize, pageToken }), direction: 'reverse' };
            default:
                throw new BadRequestError(`Unknown cardinality '${effectiveCardinality}' for link type '${linkTypeApiName}'.`);
        }
    }
}
```

**Module exports:** The file `src/services/linkResolver.js` must export `resolveLink` as the primary public API. The individual resolver functions (`resolveOneToOne`, `resolveOneToMany`, `resolveManyToOne`, `resolveManyToMany`) are exported for unit testing purposes only. External callers (endpoints, services) must use `resolveLink` exclusively.

```javascript
// Public API: resolveLink. Internal resolvers exported for unit testing only.
module.exports = { resolveLink, resolveOneToOne, resolveOneToMany, resolveManyToOne, resolveManyToMany };
```

**This is the most critical function in the entire link system.** Every downstream feature (Search Around, Object Explorer links, Workshop linked object tables, OSDK .pivotTo()) calls this function.

**File to modify:** `src/services/linkResolver.js`

**Testing:**

Set up the following test data:
- Ontology with a test ID.
- Object types: Company, Employee (with companyId and managerId properties), User, Profile (with profileId property), Student, Course.
- Link types:
  - `companyEmployees` (Company → Employee, ONE_TO_MANY, FK: companyId on target, bidirectional)
  - `employeeCompany` (Employee → Company, MANY_TO_ONE, FK: companyId on source, bidirectional)
  - `userProfile` (User → Profile, ONE_TO_ONE, FK: profileId on source, bidirectional)
  - `studentCourse` (Student → Course, MANY_TO_MANY, join table, bidirectional)
  - `manages` (Employee → Employee, ONE_TO_MANY, FK: managerId on target, bidirectional, self-referential)

Test all 8 combinations (4 cardinalities x 2 directions). For each:
1. Call `resolveLink` with appropriate parameters.
2. Verify `direction` field is `'forward'` or `'reverse'` as expected.
3. Verify the correct objects are returned (match by PK).

Test error cases:
4. Link type not found — verify `NotFoundError` is thrown (statusCode 404).
5. Object type not part of link — verify `BadRequestError` is thrown (statusCode 400).
6. Non-bidirectional link with reverse traversal — verify `BadRequestError` is thrown (statusCode 400).
7. Unknown cardinality value — verify `BadRequestError` is thrown.

Test self-referential links:
8. Create Employee manages Employee link. Call `resolveLink` with `direction: 'forward'` from EMP-001 — verify reports returned.
9. Call `resolveLink` with `direction: 'reverse'` from EMP-002 — verify manager EMP-001 returned.
10. Call `resolveLink` with no direction from EMP-001 (self-referential default) — verify forward traversal.
