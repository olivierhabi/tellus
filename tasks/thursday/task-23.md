# TASK 23: Build the Link Type Impact Analysis Function

**Objective:** Create a function that analyzes the impact of a link type — how many objects on each side, how many actual links exist, distribution of link counts (e.g., "most Companies have 10-50 Employees, max is 2,340"). This is used by the Ontology Manager to show link health and by the Object Backend to optimize query planning.

**Prerequisites:** Tasks 1-10 must be complete (link type table, resolvers, and OpenSearch indices).

**Implementation:** Create `analyzeLinkType(ontologyId, linkTypeApiName)` in `src/services/linkAnalyzer.js`:

```javascript
const db = require('../db/pool');
const { opensearchClient } = require('./opensearchClient');

/**
 * Analyzes a link type to produce impact statistics.
 *
 * @param {string} ontologyId - The ontology ID
 * @param {string} linkTypeApiName - The link type api_name
 * @returns {Object} Analysis report with counts and distribution
 */
async function analyzeLinkType(ontologyId, linkTypeApiName) {
    // Step 1: Fetch link type definition
    const ltRow = await db.query(
        'SELECT * FROM link_type WHERE ontology_id = $1 AND api_name = $2',
        [ontologyId, linkTypeApiName]
    );
    if (ltRow.rows.length === 0) {
        throw new NotFoundError(`Link type '${linkTypeApiName}' not found.`);
    }
    const linkType = ltRow.rows[0];

    const sourceIndex = `ontology-${linkType.source_object_type_api_name.toLowerCase()}`;
    const targetIndex = `ontology-${linkType.target_object_type_api_name.toLowerCase()}`;

    // Step 2: Count total objects on each side
    const [sourceCountRes, targetCountRes] = await Promise.all([
        opensearchClient.count({ index: sourceIndex, body: { query: { match_all: {} } } }),
        opensearchClient.count({ index: targetIndex, body: { query: { match_all: {} } } }),
    ]);
    const totalSourceObjects = sourceCountRes.body.count;
    const totalTargetObjects = targetCountRes.body.count;

    let totalLinks, objectsWithNoLink, linkCountDistribution;

    if (linkType.cardinality !== 'MANY_TO_MANY') {
        // Step 3a: FK-based link analysis
        const fkField = linkType.foreign_key_property_api_name;
        const fkSide = linkType.foreign_key_side;
        const fkIndex = fkSide === 'target' ? targetIndex : sourceIndex;

        // Count objects with non-null FK (i.e., objects that have a link)
        const linkedCountRes = await opensearchClient.count({
            index: fkIndex,
            body: { query: { exists: { field: fkField } } }
        });
        totalLinks = linkedCountRes.body.count;

        // Count objects with no FK value (no link)
        const totalInFkIndex = fkSide === 'target' ? totalTargetObjects : totalSourceObjects;
        objectsWithNoLink = totalInFkIndex - totalLinks;

        // Use terms aggregation on FK field to get distribution of link counts per unique FK value
        // This gives us: for each unique FK value, how many objects share that FK value
        const aggResult = await opensearchClient.search({
            index: fkIndex,
            body: {
                size: 0,
                aggs: {
                    fk_distribution: {
                        terms: {
                            field: `${fkField}.keyword`,
                            size: 65536  // max buckets
                        }
                    }
                }
            }
        });

        const buckets = aggResult.body.aggregations.fk_distribution.buckets;
        const counts = buckets.map(b => b.doc_count).sort((a, b) => a - b);

        linkCountDistribution = calculateDistribution(counts);
    } else {
        // Step 3b: M2M link analysis via join table
        const fs = require('fs');
        const { parse } = require('csv-parse/sync');
        const joinFilePath = linkType.join_table_file_path;

        if (!fs.existsSync(joinFilePath)) {
            return {
                linkType: linkTypeApiName,
                sourceObjectType: linkType.source_object_type_api_name,
                targetObjectType: linkType.target_object_type_api_name,
                totalSourceObjects,
                totalTargetObjects,
                totalLinks: 0,
                objectsWithNoLink: totalSourceObjects,
                linkCountDistribution: { min: 0, max: 0, avg: 0, p50: 0, p90: 0, p99: 0 }
            };
        }

        const fileContent = fs.readFileSync(joinFilePath, 'utf-8');
        const records = parse(fileContent, { columns: true, skip_empty_lines: true });
        totalLinks = records.length;

        // Group by source column to get counts per source
        const sourceGroups = {};
        for (const record of records) {
            const key = String(record[linkType.join_table_source_column]);
            sourceGroups[key] = (sourceGroups[key] || 0) + 1;
        }

        objectsWithNoLink = totalSourceObjects - Object.keys(sourceGroups).length;
        const counts = Object.values(sourceGroups).sort((a, b) => a - b);

        linkCountDistribution = calculateDistribution(counts);
    }

    return {
        linkType: linkTypeApiName,
        sourceObjectType: linkType.source_object_type_api_name,
        targetObjectType: linkType.target_object_type_api_name,
        totalSourceObjects,
        totalTargetObjects,
        totalLinks,
        objectsWithNoLink,
        linkCountDistribution
    };
}

/**
 * Calculates percentile distribution from a sorted array of counts.
 * @param {number[]} sortedCounts - Array of counts, sorted ascending
 * @returns {Object} { min, max, avg, p50, p90, p99 }
 */
function calculateDistribution(sortedCounts) {
    if (sortedCounts.length === 0) {
        return { min: 0, max: 0, avg: 0, p50: 0, p90: 0, p99: 0 };
    }
    const min = sortedCounts[0];
    const max = sortedCounts[sortedCounts.length - 1];
    const sum = sortedCounts.reduce((a, b) => a + b, 0);
    const avg = Math.round(sum / sortedCounts.length);

    // Percentile calculation using nearest-rank method
    const percentile = (arr, p) => {
        const index = Math.ceil((p / 100) * arr.length) - 1;
        return arr[Math.max(0, index)];
    };

    return {
        min,
        max,
        avg,
        p50: percentile(sortedCounts, 50),
        p90: percentile(sortedCounts, 90),
        p99: percentile(sortedCounts, 99)
    };
}
```

**Return shape:**
```json
{
    "linkType": "companyEmployees",
    "sourceObjectType": "Company",
    "targetObjectType": "Employee",
    "totalSourceObjects": 200,
    "totalTargetObjects": 10000,
    "totalLinks": 9800,
    "objectsWithNoLink": 200,
    "linkCountDistribution": {
        "min": 1,
        "max": 2340,
        "avg": 49,
        "p50": 35,
        "p90": 120,
        "p99": 890
    }
}
```

**Error handling:**
- Link type not found: throw `NotFoundError`.
- Join table file doesn't exist for M2M: return report with `totalLinks: 0` and zeroed distribution (not an error).
- OpenSearch index doesn't exist: catch the error and return `totalSourceObjects: 0` or `totalTargetObjects: 0` as applicable.

**Dependencies:** Import `db` from `src/db/pool.js`, `opensearchClient` from `src/services/opensearchClient.js`, `NotFoundError` from `src/errors.js`.

**Module export:** Export `analyzeLinkType` and `calculateDistribution` from `src/services/linkAnalyzer.js`.

**File to create:** `src/services/linkAnalyzer.js`

**Note:** This function is NOT exposed as an HTTP endpoint in this task. It is a service-layer function called by other services (Task 4's enriched GET endpoint uses the `estimatedLinkCount` concept). An HTTP endpoint for analytics can be added in a future task.

**Testing:**
1. Create a Company → Employee ONE_TO_MANY link with 3 Companies and 10 Employees (COMP-001: 5 employees, COMP-002: 3 employees, COMP-003: 2 employees).
2. Call `analyzeLinkType(ontologyId, 'companyEmployees')`.
3. Verify: `totalSourceObjects: 3`, `totalTargetObjects: 10`, `totalLinks: 10`, `objectsWithNoLink: 0`.
4. Verify distribution: `min: 2`, `max: 5`, `avg: 3`, `p50: 3`.
5. Create a M2M link with a join table of 15 rows. Call `analyzeLinkType`. Verify `totalLinks: 15` and correct distribution.
6. Test with a link type whose join table file doesn't exist — verify `totalLinks: 0` without error.
