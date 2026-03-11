# TASK 11: Create the Edit Merger

**File to create:** `/src/services/indexing/editMerger.js`

**Purpose:** This module merges user edits (from the `ontology_edit` table, created by the Action execution engine on Day 5) with datasource data during reindexing. In Palantir's Object Storage V2, user edits take precedence over datasource data. When a reindex occurs, the Funnel merges the latest datasource data with any pending user edits, and user edits win for any property where both the datasource and a user edit provide a value for the same primary key. This is a critical behavior documented by Palantir: objects can be edited via Actions, and those edits must survive datasource updates.

**Detailed specification:**

The module must export a single function: `mergeEditsWithDatasource(documents, objectTypeApiName)` where:
- `documents` — Array of transformed documents from the batch builder (Task 9). Each has `__pk` and all property values from the datasource.
- `objectTypeApiName` — The object type API name, used to query the edit store.

**Step-by-step logic:**

1. Query PostgreSQL to get all un-indexed edits for this object type: `SELECT * FROM ontology_edit WHERE object_type_api_name = $1 AND indexed = false ORDER BY executed_at ASC`.

2. Also get all previously indexed edits that might still need to be applied (because the datasource might have been re-uploaded with original values, and the edit should still win): `SELECT * FROM ontology_edit WHERE object_type_api_name = $1 AND operation IN ('update', 'create') ORDER BY executed_at ASC`.

3. Combine the results of both queries into a single array. Steps 1 and 2 may return overlapping rows; deduplication happens here where the latest `executed_at` wins for each PK. Build a Map<primaryKey, editRecord> from the combined edits. If multiple edits exist for the same PK, the one with the latest `executed_at` wins. The edit record contains: `{ edit_id, operation, property_values, executed_by, executed_at }`.

4. Iterate through the `documents` array:

   a) **For each document, check if there's an edit for its `__pk`:**
   
   - If edit.operation is `"update"`: Merge the edit's `property_values` into the document. For each property in the edit, overwrite the datasource value. Properties NOT in the edit are left as-is from the datasource. Update `__editedBy` to the edit's `executed_by`. Update `__lastModified` to the edit's `executed_at`. Increment `__version` (if the document does not have a `__version` field, initialize it to 1; if it already has `__version`, increment by 1).
   
   - If edit.operation is `"delete"`: Remove this document from the batch entirely. It should not be indexed. Track it in the return value as a deleted document.

   b) **Check for "create" edits that don't have a matching datasource row:** After processing all datasource documents, iterate through remaining edits. If an edit with operation `"create"` exists and its PK was NOT found in any datasource document, this is an Action-created object with no datasource backing. Create a new document from the edit's `property_values` and add it to the batch.

5. Mark processed edits as indexed: `UPDATE ontology_edit SET indexed = true, indexed_at = now() WHERE edit_id = ANY($1)`.

**Forward dependency note:** This task depends on the `ontology_edit` table schema defined in Day 5. The column names used here (`object_type_api_name`, `indexed`, `executed_at`, `operation`, `property_values`, `executed_by`, `edit_id`, `indexed_at`) must match the Day 5 migration. If the Day 5 schema changes, the SQL queries in steps 1 and 2 must be updated to match.

6. Return:
   ```javascript
   {
     mergedDocuments: [...],  // the final document array ready for indexing
     stats: {
       totalDatasourceDocuments: 1000,
       editsApplied: 15,
       updateEdits: 10,        // datasource rows with values overridden by edits
       deleteEdits: 3,         // datasource rows removed because of delete edits
       createEdits: 2,         // new documents added from create edits with no datasource row
       finalDocumentCount: 999  // 1000 - 3 deletes + 2 creates
     }
   }
   ```

**Why "user edits win" matters (Palantir context):** Imagine a tax auditor uses an Action to change a taxpayer's risk score from "low" to "high" based on their investigation. That night, the datasource is refreshed from the e-tax system, which still has the risk score as "low". Without edit precedence, the auditor's change would be silently overwritten. Palantir's architecture ensures user edits are preserved across reindexes — this is fundamental to the Ontology being an operational system, not just a read-only data warehouse.

**Test to verify:** Create 10 documents from datasource. Create edits: update 2, delete 1, create 1 (new PK not in datasource). Run mergeEditsWithDatasource. Verify: 10 - 1 delete + 1 create = 10 final documents, 2 have updated values from edits, the created document has Action-provided values, the deleted document is absent.
