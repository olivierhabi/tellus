# TASK 18: Build Join Table Validation Function

**Objective:** Create a reusable function that validates a join table CSV against the object types on both sides of the link. Specifically, it checks whether the primary keys in the join table actually exist as objects in the Ontology. This is a data quality check — orphaned references in the join table are valid (Palantir allows them) but should be surfaced as warnings.

**Prerequisites:** Tasks 1 and 10 must be complete.

**Implementation:** Create `validateJoinTable(ontologyId, linkTypeApiName)` in `src/services/linkValidator.js`:

```javascript
const db = require('../db/pool');
const { opensearchClient } = require('./opensearchClient');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { NotFoundError } = require('../errors');

/**
 * Validates a join table CSV against the actual objects in OpenSearch.
 *
 * @param {string} ontologyId - The ontology ID
 * @param {string} linkTypeApiName - The M2M link type api_name
 * @returns {Object} Validation report
 */
async function validateJoinTable(ontologyId, linkTypeApiName) {
    // Fetch link type
    const ltRow = await db.query(
        'SELECT * FROM link_type WHERE ontology_id = $1 AND api_name = $2',
        [ontologyId, linkTypeApiName]
    );
    if (ltRow.rows.length === 0) {
        throw new NotFoundError(`Link type '${linkTypeApiName}' not found.`);
    }
    const linkType = ltRow.rows[0];

    if (linkType.cardinality !== 'MANY_TO_MANY') {
        throw new Error(`Link type '${linkTypeApiName}' is not MANY_TO_MANY. This function only validates join tables.`);
    }

    const filePath = linkType.join_table_file_path;
    if (!filePath || !fs.existsSync(filePath)) {
        return {
            totalRows: 0,
            validLinks: 0,
            orphanedSourceKeys: [],
            orphanedTargetKeys: [],
            duplicateRows: 0,
            isValid: true,
            warnings: ['Join table file does not exist yet.']
        };
    }

    // Parse CSV
    const records = parse(fs.readFileSync(filePath, 'utf-8'), { columns: true, skip_empty_lines: true });
    const sourceCol = linkType.join_table_source_column;
    const targetCol = linkType.join_table_target_column;

    // Extract unique PKs
    const allSourcePKs = [...new Set(records.map(r => String(r[sourceCol])))];
    const allTargetPKs = [...new Set(records.map(r => String(r[targetCol])))];

    // Check for duplicates
    const seen = new Set();
    let duplicateRows = 0;
    for (const r of records) {
        const key = `${r[sourceCol]}::${r[targetCol]}`;
        if (seen.has(key)) duplicateRows++;
        seen.add(key);
    }

    // Query OpenSearch for source PKs existence (batch in chunks of 10000 to stay within terms query limit)
    const sourceIndex = `ontology-${linkType.source_object_type_api_name.toLowerCase()}`;
    const targetIndex = `ontology-${linkType.target_object_type_api_name.toLowerCase()}`;

    const existingSourcePKs = await batchCheckExistence(sourceIndex, allSourcePKs);
    const existingTargetPKs = await batchCheckExistence(targetIndex, allTargetPKs);

    const orphanedSourceKeys = allSourcePKs.filter(pk => !existingSourcePKs.has(pk));
    const orphanedTargetKeys = allTargetPKs.filter(pk => !existingTargetPKs.has(pk));

    const totalOrphans = orphanedSourceKeys.length + orphanedTargetKeys.length;
    const validLinks = records.length - duplicateRows;

    const warnings = [];
    if (totalOrphans > 0) {
        warnings.push(`${totalOrphans} primary keys in the join table do not match any existing objects.`);
    }
    if (duplicateRows > 0) {
        warnings.push(`${duplicateRows} duplicate rows detected (same source-target pair appears more than once).`);
    }

    return {
        totalRows: records.length,
        validLinks,
        orphanedSourceKeys,
        orphanedTargetKeys,
        duplicateRows,
        isValid: true,  // Always true — orphans are warnings, not errors (Palantir behavior)
        warnings
    };
}

/**
 * Checks which PKs from a list exist in an OpenSearch index.
 * Batches in chunks of 10000 to stay within OpenSearch terms query limit.
 *
 * @param {string} index - OpenSearch index name
 * @param {string[]} pks - Array of primary keys to check
 * @returns {Set<string>} Set of PKs that exist in the index
 */
async function batchCheckExistence(index, pks) {
    const existing = new Set();
    const BATCH_SIZE = 10000;

    for (let i = 0; i < pks.length; i += BATCH_SIZE) {
        const batch = pks.slice(i, i + BATCH_SIZE);
        const result = await opensearchClient.search({
            index,
            body: {
                query: { terms: { '__pk': batch } },
                _source: ['__pk'],
                size: BATCH_SIZE,
            },
        });
        for (const hit of result.body.hits.hits) {
            existing.add(String(hit._source.__pk));
        }
    }

    return existing;
}
```

**Return shape:**
```json
{
    "totalRows": 15000,
    "validLinks": 14800,
    "orphanedSourceKeys": ["STU-999", "STU-888"],
    "orphanedTargetKeys": ["CRS-999"],
    "duplicateRows": 5,
    "isValid": true,
    "warnings": [
        "3 primary keys in the join table do not match any existing objects.",
        "5 duplicate rows detected (same source-target pair appears more than once)."
    ]
}
```

**Error handling:**
- Link type not found: throw `NotFoundError`.
- Link type not M2M: throw `Error` with descriptive message.
- Join table file doesn't exist: return valid report with `totalRows: 0` and a warning.
- OpenSearch index doesn't exist: let the error propagate (caller should ensure indices exist).

**Dependencies:** Import `db` from `src/db/pool.js`, `opensearchClient` from `src/services/opensearchClient.js`, `NotFoundError` from `src/errors.js`.

**Module exports:** Export both `validateJoinTable` and `batchCheckExistence` from `src/services/linkValidator.js`.

**File to create or modify:** `src/services/linkValidator.js`

**Testing:**
1. Create a M2M link (Student → Course). Upload a join table with 10 rows, where 2 source PKs don't exist as Student objects and 1 target PK doesn't exist as a Course object. Run `validateJoinTable`. Verify `orphanedSourceKeys` contains the 2 missing PKs, `orphanedTargetKeys` contains the 1 missing PK, `isValid` is `true`, and warnings mention "3 primary keys".
2. Upload a join table with 3 duplicate rows (same student-course pair). Verify `duplicateRows: 3`.
3. Test with a join table file that doesn't exist — verify `totalRows: 0` and warning about missing file.
4. Test with a non-M2M link type — verify error thrown.
