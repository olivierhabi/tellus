# TASK 24: Create Link Type Migration Validation

**Objective:** Build a function that validates whether a link type's cardinality can be changed safely. For example, changing from ONE_TO_MANY to MANY_TO_MANY requires providing a join table. Changing from MANY_TO_MANY to ONE_TO_MANY requires verifying that the data actually conforms to the one-to-many constraint (no target should be linked to more than one source via FK). This supports the PUT endpoint (Task 5) and future Ontology Manager UI.

**Prerequisites:** Tasks 1, 5, and 7-10 must be complete.

**Implementation:** Create `validateCardinalityChange(ontologyId, linkTypeApiName, toCardinality, newForeignKey, newJoinTable)` in `src/services/linkValidator.js`:

```javascript
const db = require('../db/pool');
const { opensearchClient } = require('./opensearchClient');

/**
 * Validates whether a link type's cardinality can be safely changed.
 *
 * @param {string} ontologyId
 * @param {string} linkTypeApiName - The existing link type to migrate
 * @param {string} toCardinality - The target cardinality (ONE_TO_ONE, ONE_TO_MANY, MANY_TO_ONE, MANY_TO_MANY)
 * @param {Object|null} newForeignKey - { propertyApiName, side } if migrating TO a FK-based cardinality
 * @param {Object|null} newJoinTable - { filePath, sourceColumn, targetColumn } if migrating TO M2M
 *
 * @returns {Object} { canMigrate: boolean, warnings: string[], errors: string[] }
 */
async function validateCardinalityChange(ontologyId, linkTypeApiName, toCardinality, newForeignKey, newJoinTable) {
    const ltRow = await db.query(
        'SELECT * FROM link_type WHERE ontology_id = $1 AND api_name = $2',
        [ontologyId, linkTypeApiName]
    );
    if (ltRow.rows.length === 0) {
        throw new NotFoundError(`Link type '${linkTypeApiName}' not found.`);
    }
    const linkType = ltRow.rows[0];
    const fromCardinality = linkType.cardinality;

    if (fromCardinality === toCardinality) {
        return { canMigrate: true, warnings: [], errors: [] };
    }

    const warnings = [];
    const errors = [];

    // Case 1: Changing TO MANY_TO_MANY
    if (toCardinality === 'MANY_TO_MANY') {
        if (!newJoinTable || !newJoinTable.filePath || !newJoinTable.sourceColumn || !newJoinTable.targetColumn) {
            errors.push('Changing to MANY_TO_MANY requires joinTable configuration (filePath, sourceColumn, targetColumn).');
        }
        warnings.push('Existing FK-based link data will NOT be automatically migrated to the join table. You must create the join table CSV manually with the current link pairs.');
    }

    // Case 2: Changing FROM MANY_TO_MANY to FK-based
    if (fromCardinality === 'MANY_TO_MANY' && toCardinality !== 'MANY_TO_MANY') {
        if (!newForeignKey || !newForeignKey.propertyApiName || !newForeignKey.side) {
            errors.push(`Changing from MANY_TO_MANY to ${toCardinality} requires foreignKey configuration (propertyApiName, side).`);
        } else {
            // Verify the FK property exists on the correct object type
            const fkObjectType = newForeignKey.side === 'source'
                ? linkType.source_object_type_api_name
                : linkType.target_object_type_api_name;
            const propCheck = await db.query(
                `SELECT 1 FROM property p JOIN object_type ot ON p.object_type_id = ot.object_type_id
                 WHERE ot.ontology_id = $1 AND ot.api_name = $2 AND p.api_name = $3`,
                [ontologyId, fkObjectType, newForeignKey.propertyApiName]
            );
            if (propCheck.rows.length === 0) {
                errors.push(`Foreign key property '${newForeignKey.propertyApiName}' does not exist on object type '${fkObjectType}'.`);
            }
        }

        // Check if the join table data can be represented as FK values
        // For ONE_TO_ONE or MANY_TO_ONE: verify no target is linked to multiple sources
        if (toCardinality === 'ONE_TO_ONE' || toCardinality === 'MANY_TO_ONE') {
            const fs = require('fs');
            const { parse } = require('csv-parse/sync');
            if (linkType.join_table_file_path && fs.existsSync(linkType.join_table_file_path)) {
                const fileContent = fs.readFileSync(linkType.join_table_file_path, 'utf-8');
                const records = parse(fileContent, { columns: true, skip_empty_lines: true });
                const targetCounts = {};
                for (const r of records) {
                    const targetKey = String(r[linkType.join_table_target_column]);
                    targetCounts[targetKey] = (targetCounts[targetKey] || 0) + 1;
                }
                const violations = Object.entries(targetCounts).filter(([, count]) => count > 1);
                if (violations.length > 0) {
                    errors.push(`Cannot migrate to ${toCardinality}: ${violations.length} target objects are linked to multiple sources. Example: target '${violations[0][0]}' is linked to ${violations[0][1]} sources.`);
                }
            }
        }

        warnings.push('Existing join table data will NOT be automatically migrated to FK properties. You must update the FK property values on objects manually.');
    }

    // Case 3: Changing ONE_TO_MANY to ONE_TO_ONE
    if (fromCardinality === 'ONE_TO_MANY' && toCardinality === 'ONE_TO_ONE') {
        // Verify no source has more than one linked target
        const fkField = linkType.foreign_key_property_api_name;
        const targetIndex = `ontology-${linkType.target_object_type_api_name.toLowerCase()}`;

        const aggResult = await opensearchClient.search({
            index: targetIndex,
            body: {
                size: 0,
                aggs: {
                    fk_counts: {
                        terms: { field: `${fkField}.keyword`, size: 65536, min_doc_count: 2 }
                    }
                }
            }
        });
        const violatingBuckets = aggResult.body.aggregations.fk_counts.buckets;
        if (violatingBuckets.length > 0) {
            errors.push(`Cannot migrate to ONE_TO_ONE: ${violatingBuckets.length} source objects have more than one linked target. Example: source '${violatingBuckets[0].key}' has ${violatingBuckets[0].doc_count} targets.`);
        }
    }

    // Case 4: Changing MANY_TO_ONE to ONE_TO_ONE
    if (fromCardinality === 'MANY_TO_ONE' && toCardinality === 'ONE_TO_ONE') {
        // Verify no target has more than one source pointing to it
        const fkField = linkType.foreign_key_property_api_name;
        const sourceIndex = `ontology-${linkType.source_object_type_api_name.toLowerCase()}`;

        const aggResult = await opensearchClient.search({
            index: sourceIndex,
            body: {
                size: 0,
                aggs: {
                    fk_counts: {
                        terms: { field: `${fkField}.keyword`, size: 65536, min_doc_count: 2 }
                    }
                }
            }
        });
        const violatingBuckets = aggResult.body.aggregations.fk_counts.buckets;
        if (violatingBuckets.length > 0) {
            errors.push(`Cannot migrate to ONE_TO_ONE: ${violatingBuckets.length} target objects are linked to multiple sources. Example: target '${violatingBuckets[0].key}' has ${violatingBuckets[0].doc_count} sources.`);
        }
    }

    return {
        canMigrate: errors.length === 0,
        warnings,
        errors
    };
}
```

**Return shape:**
```json
{
    "canMigrate": false,
    "warnings": [
        "Existing FK-based link data will NOT be automatically migrated to the join table."
    ],
    "errors": [
        "Cannot migrate to ONE_TO_ONE: 3 source objects have more than one linked target. Example: source 'COMP-001' has 5 targets."
    ]
}
```

**Error handling:**
- Link type not found: throw `NotFoundError`.
- OpenSearch query failures: let them propagate (caller handles).
- Join table file doesn't exist: skip data validation checks, only check configuration.

**Dependencies:** Import `db` from `src/db/pool.js`, `opensearchClient` from `src/services/opensearchClient.js`, `NotFoundError` from `src/errors.js`.

**File to modify:** `src/services/linkValidator.js` (add `validateCardinalityChange` alongside `validateJoinTable` from Task 18 and `validateForeignKeys` from Task 20).

**Testing:**
1. Create a ONE_TO_MANY link (Company → Employee) with COMP-001 having 5 employees and COMP-002 having 3 employees.
2. Call `validateCardinalityChange(ontologyId, 'companyEmployees', 'ONE_TO_ONE', null, null)` — should return `canMigrate: false` with error about COMP-001 having 5 targets.
3. Create a ONE_TO_ONE link with each source having exactly 1 target. Call `validateCardinalityChange(..., 'ONE_TO_MANY', null, null)` — should return `canMigrate: true`.
4. Call `validateCardinalityChange(..., 'MANY_TO_MANY', null, null)` without providing joinTable — should return `canMigrate: false` with error about missing joinTable configuration.
5. Call `validateCardinalityChange(..., 'MANY_TO_MANY', null, { filePath: 'data/join.csv', sourceColumn: 'src', targetColumn: 'tgt' })` — should return `canMigrate: true` with a warning about manual data migration.
