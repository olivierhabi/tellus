# TASK 20: Build Link Existence Check for Actions

**Objective:** When creating or modifying objects via Actions (built on Day 5), the Action engine should be able to verify that foreign key values reference existing objects. This is a referential integrity check. Create a reusable function that validates FK values against the Ontology.

**Prerequisites:** Tasks 1 and 7-10 must be complete.

**Implementation:** Create `validateForeignKeys(objectTypeApiName, propertyValues, ontologyId)` in `src/services/linkValidator.js`:

```javascript
const db = require('../db/pool');
const { opensearchClient } = require('./opensearchClient');

/**
 * Validates that FK property values in an object reference existing target objects.
 * This is a WARNING-level check — orphaned FKs are allowed (Palantir behavior).
 *
 * @param {string} objectTypeApiName - The api_name of the object type being created/modified
 * @param {Object} propertyValues - Key-value pairs of property values being set (e.g., { companyId: "COMP-001", department: "Engineering" })
 * @param {string} ontologyId - The ontology ID
 *
 * @returns {Object} { valid: boolean, warnings: Array<{ property, value, linkType, targetType, exists, message }> }
 *   - valid is ALWAYS true (orphaned FKs don't block the operation — Palantir behavior)
 *   - warnings contain entries for each FK property where the target object doesn't exist
 */
async function validateForeignKeys(objectTypeApiName, propertyValues, ontologyId) {
    // Step 1: Find all link types where this object type has FK properties
    // FK is on this object type if:
    //   - source_object_type_api_name === objectTypeApiName AND foreign_key_side === 'source'
    //   - target_object_type_api_name === objectTypeApiName AND foreign_key_side === 'target'
    const linkTypeRows = await db.query(
        `SELECT * FROM link_type
         WHERE ontology_id = $1
         AND cardinality != 'MANY_TO_MANY'
         AND (
             (source_object_type_api_name = $2 AND foreign_key_side = 'source')
             OR
             (target_object_type_api_name = $2 AND foreign_key_side = 'target')
         )`,
        [ontologyId, objectTypeApiName]
    );

    const warnings = [];

    // Step 2: For each link type, check if the FK property is being set and if the target exists
    for (const lt of linkTypeRows.rows) {
        const fkProp = lt.foreign_key_property_api_name;

        // Only check if this FK property is in the provided propertyValues
        if (!(fkProp in propertyValues)) continue;

        const fkValue = propertyValues[fkProp];

        // Skip null/undefined values (no link intended)
        if (fkValue === null || fkValue === undefined || fkValue === '') continue;

        // Determine the target object type (the other side of the link)
        const targetType = (lt.foreign_key_side === 'source')
            ? lt.target_object_type_api_name
            : lt.source_object_type_api_name;

        // Check if the target object exists in OpenSearch
        const targetIndex = `ontology-${targetType.toLowerCase()}`;
        const countResult = await opensearchClient.count({
            index: targetIndex,
            body: { query: { term: { '__pk': String(fkValue) } } }
        });

        const exists = countResult.body.count > 0;

        if (!exists) {
            warnings.push({
                property: fkProp,
                value: String(fkValue),
                linkType: lt.api_name,
                targetType: targetType,
                exists: false,
                message: `Referenced ${targetType} '${fkValue}' does not exist.`
            });
        }
    }

    return {
        valid: true,  // Always true — Palantir allows orphaned FKs
        warnings
    };
}
```

**Return shape:**
```json
{
    "valid": true,
    "warnings": [
        {
            "property": "companyId",
            "value": "COMP-999",
            "linkType": "employeeCompany",
            "targetType": "Company",
            "exists": false,
            "message": "Referenced Company 'COMP-999' does not exist."
        }
    ]
}
```

**Behavior:** FK validation is a WARNING, not a blocking error. Palantir allows orphaned FKs (you can set companyId to a value that doesn't match any Company). The data quality is surfaced as a warning in the Ontology Manager UI but doesn't prevent the action. In our implementation, return `valid: true` even if orphans exist, but include the warnings.

**Integration with Day 5:** Call this function inside the Action Execution Engine (Stage 3 of the pipeline from Day 5) after resolving object references but before applying edits. Include the warnings in the action audit log:
```javascript
const fkValidation = await validateForeignKeys(objectType, propertyValues, ontologyId);
if (fkValidation.warnings.length > 0) {
    auditLog.push({ type: 'FK_ORPHAN_WARNING', details: fkValidation.warnings });
}
// Proceed with the action regardless — valid is always true
```

**Error handling:**
- If the OpenSearch index for the target type doesn't exist, catch the error and treat the FK as orphaned (add a warning).
- If no link types have FK properties on this object type, return `{ valid: true, warnings: [] }` immediately.

**Dependencies:** Import `db` from `src/db/pool.js`, `opensearchClient` from `src/services/opensearchClient.js`.

**File to modify:** `src/services/linkValidator.js` — add `validateForeignKeys` alongside `validateJoinTable` (Task 18).

**Testing:**
1. Create Employee and Company object types. Create a MANY_TO_ONE link (Employee → Company, FK: companyId on source). Create Company COMP-001.
2. Call `validateForeignKeys('Employee', { companyId: 'COMP-001', department: 'Engineering' }, ontologyId)` — expect `{ valid: true, warnings: [] }` (COMP-001 exists).
3. Call `validateForeignKeys('Employee', { companyId: 'COMP-999', department: 'Engineering' }, ontologyId)` — expect `{ valid: true, warnings: [{ property: 'companyId', value: 'COMP-999', ... exists: false }] }`.
4. Call `validateForeignKeys('Employee', { companyId: null, department: 'Engineering' }, ontologyId)` — expect `{ valid: true, warnings: [] }` (null FK is fine, not checked).
5. Call `validateForeignKeys('Company', { companyName: 'Test' }, ontologyId)` — expect `{ valid: true, warnings: [] }` (Company has no FK properties).
