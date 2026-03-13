# TASK 16: Build the Reindex-with-Edit-Merge Function

**Objective:** Modify the existing indexer (built on Day 2) to merge user edits from the `ontology_edit` table with datasource data when reindexing. This is the core behavior that makes Palantir's Object Storage V2 work: datasource data provides the baseline, and user edits override specific properties on top.

Palantir's documentation states: "Object Storage V2 does not require materialized datasets to enable user edits. With optional materialized datasets in OSv2, you only need to create materializations if they are required for downstream usage." This means the Ontology's indexed state is ALWAYS the merge of datasource + edits, computed at index time.

**Modify the existing indexer** at `src/indexer.js`. Specifically, update or replace the `reindexObjectType` function to add edit-merge capability. Preserve all other existing indexer functions unchanged.

**The updated indexing logic for a single object type:**

```javascript
/**
 * Reindexes an object type from its backing datasource, merging with user edits.
 *
 * @param {string} ontologyId
 * @param {string} objectTypeApiName
 * @returns {Object} { objectsIndexed, editsApplied, deletions, durationMs }
 */
async function reindexObjectType(ontologyId, objectTypeApiName) {
    const startTime = Date.now();
    
    // Step 1: Load object type definition and backing datasource config
    const objectType = await getObjectType(ontologyId, objectTypeApiName);
    const datasource = await getBackingDatasource(objectTypeApiName);
    const propertyDefs = await getProperties(objectType.object_type_id);
    const primaryKeyPropName = propertyDefs.find(p => p.property_id === objectType.primary_key_property_id)?.api_name;
    
    // Step 2: Read all rows from backing datasource (CSV/Parquet file)
    const rows = await readDatasetFile(datasource.file_path);
    
    // Step 3: Build a map of PK → row from datasource
    const datasourceMap = new Map();
    for (const row of rows) {
        const pk = String(row[datasource.primary_key_column]);
        if (datasourceMap.has(pk)) {
            // Palantir: "most recent transaction wins" — but within a single file, 
            // duplicates are an error in OSv2
            throw new Error(`Duplicate primary key '${pk}' in backing datasource for ${objectTypeApiName}`);
        }
        // Map CSV columns to property api_names
        const mapped = {};
        for (const [propName, colName] of Object.entries(datasource.column_mapping)) {
            mapped[propName] = row[colName];
        }
        datasourceMap.set(pk, mapped);
    }
    
    // Step 4: Get ALL user edits for this object type (ordered by executed_at)
    // This requires a new function in src/db/ontologyEdits.js (Task 2's module).
    // Add this function to src/db/ontologyEdits.js:
    //   getAllEditsByObjectType(objectTypeApiName) — Returns ALL edits (not just pending)
    //   for the given object type, ordered by executed_at ASC.
    //   SQL: SELECT * FROM ontology_edit WHERE object_type_api_name = $1 ORDER BY executed_at ASC
    const allEdits = await getAllEditsByObjectType(objectTypeApiName); // not just pending — ALL edits
    
    // Step 5: Build a map of PK → latest edit state
    // For each PK that has edits, compute the cumulative effect
    const editMap = new Map(); // pk → { operation, propertyOverrides }
    for (const edit of allEdits) {
        if (!editMap.has(edit.primary_key)) {
            editMap.set(edit.primary_key, { operation: edit.operation, properties: {} });
        }
        const entry = editMap.get(edit.primary_key);
        
        if (edit.operation === 'delete') {
            entry.operation = 'delete'; // delete overrides everything
            entry.properties = {}; // clear properties on delete
        } else if (edit.operation === 'create') {
            // Create resets the object state. If preceded by a delete, this is a re-creation.
            // If an object is created, then deleted, then re-created (same PK), the final
            // state should reflect the re-creation.
            entry.operation = 'create';
            entry.properties = { ...edit.property_values }; // reset to create's properties only
        } else if (edit.operation === 'update') {
            if (entry.operation !== 'delete') { // don't apply updates after a delete
                entry.properties = { ...entry.properties, ...edit.property_values };
            }
        }
    }
    
    // Step 6: Merge datasource + edits → final objects to index
    const bulkOps = [];
    let objectsIndexed = 0;
    let editsApplied = 0;
    let deletions = 0;
    const indexName = `ontology-${objectTypeApiName.toLowerCase()}`;
    
    // 6a: Process datasource rows (potentially overridden by edits)
    for (const [pk, dsProps] of datasourceMap) {
        if (editMap.has(pk)) {
            const edit = editMap.get(pk);
            if (edit.operation === 'delete') {
                // Object was deleted via action — do NOT index it even though datasource has it
                bulkOps.push({ delete: { _index: indexName, _id: pk } });
                deletions++;
                continue;
            }
            // Merge: datasource props as base, edit props override
            const merged = { ...dsProps, ...edit.properties };
            bulkOps.push({ index: { _index: indexName, _id: pk } });
            bulkOps.push({ __pk: pk, __objectType: objectTypeApiName, __lastModified: new Date().toISOString(), ...merged });
            editsApplied++;
        } else {
            // No edits — pure datasource data
            bulkOps.push({ index: { _index: indexName, _id: pk } });
            bulkOps.push({ __pk: pk, __objectType: objectTypeApiName, __lastModified: new Date().toISOString(), ...dsProps });
        }
        objectsIndexed++;
    }
    
    // 6b: Process edit-only objects (created via actions, not in datasource)
    for (const [pk, edit] of editMap) {
        if (!datasourceMap.has(pk) && edit.operation !== 'delete') {
            // Object was created via action and doesn't exist in datasource
            bulkOps.push({ index: { _index: indexName, _id: pk } });
            bulkOps.push({ __pk: pk, __objectType: objectTypeApiName, __lastModified: new Date().toISOString(), ...edit.properties });
            objectsIndexed++;
            editsApplied++;
        }
    }
    
    // Step 7: Delete stale objects (in OpenSearch but not in datasource or edits)
    // DEFERRED to a future iteration. For week 1, stale object cleanup is out of scope.
    // TODO: Implement stale object cleanup — get all current PKs in the index,
    // then delete any that aren't in datasourceMap or editMap.
    // (This handles the case where rows are removed from the datasource)
    
    // Step 8: Execute bulk write to OpenSearch
    if (bulkOps.length > 0) {
        await opensearchClient.bulk({ body: bulkOps, refresh: 'wait_for' });
    }
    
    // Step 9: Mark all pending edits as indexed
    const pendingEdits = await getPendingEdits(objectTypeApiName);
    if (pendingEdits.length > 0) {
        await markEditsAsIndexed(pendingEdits.map(e => e.edit_id));
    }
    
    return { objectsIndexed, editsApplied, deletions, durationMs: Date.now() - startTime };
}
```

**The critical behavior to verify:** After reindexing, an object that was modified via an Action should still reflect the Action's changes, even if the backing datasource has different values for those properties. The datasource provides the base; edits override on top.

**Test case:**
```javascript
// Setup: Upload CSV with Employee EMP-001 salary=100000
// Execute action: updateSalary EMP-001 to 150000
// Trigger reindex
const result = await reindexObjectType('ont-1', 'Employee');
// Verify: EMP-001 in OpenSearch has salary=150000 (from edit), not 100000 (from CSV)
const obj = await fetchObject('Employee', 'EMP-001');
assert(obj.salary === 150000); // edit wins over datasource
```
