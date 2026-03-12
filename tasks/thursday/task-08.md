# TASK 8: Build the MANY_TO_ONE Link Resolver

**Objective:** Implement the link resolution logic for MANY_TO_ONE cardinality links. This is the reverse of ONE_TO_MANY. Given a single source object (the "many" side), find the ONE target object it links to. For example, given an Employee, find their Company. This always returns at most one object (or zero, if the FK value is null or references a non-existent target).

**Why this is different from ONE_TO_MANY:** In MANY_TO_ONE, the foreign key is on the SOURCE side. The source object has a property whose value is the primary key of the target. So the resolution is: (1) read the source object from OpenSearch to get the FK property value, (2) look up the target object by that value.

**Implementation:**

In `src/services/linkResolver.js`, add a new exported function `resolveManyToOne`:

```javascript
/**
 * Resolves a MANY_TO_ONE link from a single source object to its one target object.
 *
 * @param {Object} params
 * @param {string} params.sourcePrimaryKey - PK of the source object
 * @param {Object} params.linkType - Full link type definition from database
 *
 * @returns {Object|null} The target object, or null if not linked
 */
async function resolveManyToOne({ sourcePrimaryKey, linkType }) {
    // Step 1: Determine source and target indices
    const sourceIndex = `ontology-${linkType.source_object_type_api_name.toLowerCase()}`;
    const targetIndex = `ontology-${linkType.target_object_type_api_name.toLowerCase()}`;
    
    // Step 2: Get the FK property name
    // For MANY_TO_ONE, FK is on the source side
    const fkPropertyApiName = linkType.foreign_key_property_api_name;
    
    // Step 3: Fetch the source object to read its FK value
    const sourceResult = await opensearchClient.search({
        index: sourceIndex,
        body: {
            query: { term: { '__pk': sourcePrimaryKey } },
            _source: [fkPropertyApiName],
            size: 1,
        },
    });
    
    if (sourceResult.body.hits.hits.length === 0) {
        throw new Error(`Source object '${sourcePrimaryKey}' not found in '${linkType.source_object_type_api_name}'.`);
    }
    
    const sourceObject = sourceResult.body.hits.hits[0]._source;
    const targetPrimaryKey = sourceObject[fkPropertyApiName];
    
    // Step 4: If FK value is null/undefined, there's no link
    if (targetPrimaryKey === null || targetPrimaryKey === undefined) {
        return { data: null, linked: false, reason: 'Foreign key property value is null.' };
    }
    
    // Step 5: Fetch the target object by its PK
    const targetResult = await opensearchClient.search({
        index: targetIndex,
        body: {
            query: { term: { '__pk': String(targetPrimaryKey) } },
            size: 1,
        },
    });
    
    if (targetResult.body.hits.hits.length === 0) {
        return { data: null, linked: false, reason: `Target object '${targetPrimaryKey}' not found.` };
    }
    
    const targetObject = targetResult.body.hits.hits[0]._source;
    
    return {
        data: {
            __primaryKey: targetObject.__pk,
            __objectType: targetObject.__objectType,
            ...targetObject,
        },
        linked: true,
    };
}
```

**Key difference from ONE_TO_MANY:** This resolver does TWO OpenSearch queries instead of one: first to read the source object's FK value, then to look up the target by that value. This is because the FK is on the source side — we don't know the target PK without reading the source first.

**Optimization note for future:** In Palantir, when the Object Explorer renders an object's detail page, it batch-resolves all links for that object in parallel. For a MANY_TO_ONE link, this means the source object has already been fetched (it's the object being displayed), so the FK value is already known. In that context, you can skip Step 3 and pass the FK value directly. For now, implement the full two-query version for correctness.

**Edge cases to handle:**
1. Source object not found → throw error (the source PK is invalid)
2. FK property value is null → return `{ data: null, linked: false }` (the relationship doesn't exist for this object)
3. FK property value is non-null but target object doesn't exist → return `{ data: null, linked: false }` (orphaned FK — the target was deleted but the source still references it)
4. FK property value is a number but the target PK is stored as a string → coerce to string before querying. Palantir's PKs are always stored as strings in OpenSearch (the `__pk` field is keyword type).

**Dependencies:**
- Import `opensearchClient` from `src/services/opensearchClient.js`.

**File to modify:** `src/services/linkResolver.js` — add `resolveManyToOne` alongside `resolveOneToMany` from Task 7.

**Testing:**
1. Create Employee EMP-001 with companyId="COMP-001". Create Company COMP-001. Create a MANY_TO_ONE link (Employee → Company, FK: companyId on source).
2. Call `resolveManyToOne({ sourcePrimaryKey: 'EMP-001', linkType })` — verify `{ data: { __primaryKey: 'COMP-001', ... }, linked: true }`.
3. Create Employee EMP-002 with companyId=null. Resolve — verify `{ data: null, linked: false, reason: 'Foreign key property value is null.' }`.
4. Create Employee EMP-003 with companyId="COMP-999" (non-existent). Resolve — verify `{ data: null, linked: false, reason: "Target object 'COMP-999' not found." }`.
5. Create Employee EMP-004 with companyId=12345 (numeric). Resolve — verify it coerces to string "12345" before querying.
