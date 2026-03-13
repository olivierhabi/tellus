# TASK 7: Build the Edit Applicator — Write Compiled Edits to OpenSearch

**Objective:** Create a module that takes the compiled edits from the Rule Compiler and applies them to both the PostgreSQL edit store and OpenSearch. This is Stage 6 of the execution pipeline — the stage that actually makes the changes visible in the Ontology. This is the most critical module because data corruption here is permanent and visible to all users.

The module must be transactional for the PostgreSQL edit store: either ALL edits are written to `ontology_edit` and `link_edit` tables successfully, or NONE of them are. OpenSearch indexing is best-effort and happens outside the PG transaction — if OpenSearch indexing fails after the PostgreSQL transaction commits, the edits are still durably recorded and will be picked up on the next reindex. This matches Palantir's behavior where actions are atomic — "If the result of one rule updates a property to 'A', but another rule in the same action type updates the same object's property to 'B', the resulting edit would just update the property to 'B'" implies that all rules are applied together as a single atomic unit.

In our week 1 implementation, we achieve atomicity through a PostgreSQL transaction for the edit store (all-or-nothing write), and then a best-effort bulk write to OpenSearch (if OpenSearch indexing fails after the PostgreSQL transaction commits, the edits are still recorded and will be picked up on the next reindex). This is an acceptable tradeoff for week 1 — Palantir's Funnel has the same eventual-consistency model between the edit store and the object database.

**Create the module** at `src/actions/editApplicator.js`.

**The module exports a single function:**

```javascript
/**
 * Applies compiled edits to the PostgreSQL edit store and OpenSearch.
 *
 * @param {Array} edits - The compiled edits from ruleCompiler.compileRules().
 *   Each edit: { objectType, primaryKey, operation, propertyValues, linkEdits }
 * 
 * @param {Object} executionContext - Metadata about this execution:
 *   { executionId, actionTypeApiName, parameters, executedBy }
 *
 * @returns {Object} {
 *   success: boolean,
 *   appliedEdits: Array<{editId, objectType, primaryKey, operation}>,
 *   failedEdits: Array<{objectType, primaryKey, error}>,
 *   indexingStatus: 'success' | 'partial' | 'failed'
 * }
 */
async function applyEdits(edits, executionContext) {
    // Implementation here
}
```

**Implementation steps (in this exact order):**

**Step 1: Start a PostgreSQL transaction.**
```javascript
const client = await pool.connect();
try {
    await client.query('BEGIN');
    // ... all edit store writes ...
    await client.query('COMMIT');
} catch (err) {
    await client.query('ROLLBACK');
    throw err;
} finally {
    client.release();
}
```

**Step 2: For each edit, insert a row into `ontology_edit`.**

For `create` edits:
- Insert with `operation = 'create'`, `property_values` = the full property set.
- The `indexed` flag is set to `false` (will be set to true after OpenSearch indexing).

For `update` edits:
- Insert with `operation = 'update'`, `property_values` = only the changed properties (partial update).

For `delete` edits:
- Insert with `operation = 'delete'`, `property_values` = `null`.

All edits in the batch share the same `execution_id` from `executionContext.executionId`.

**Step 3: Commit the PostgreSQL transaction.** At this point, the edits are durably stored. Even if OpenSearch indexing fails, the edits can be replayed later during a reindex.

**Step 4: Apply changes to OpenSearch (best-effort, outside the PG transaction).**

For each edit, prepare an OpenSearch bulk operation:

For `create`:
```javascript
{ index: { _index: `ontology-${objectType.toLowerCase()}`, _id: primaryKey } }
{
    __pk: primaryKey,
    __objectType: objectType,
    __lastModified: new Date().toISOString(),
    __editedBy: executionContext.executedBy,
    __version: 1,
    ...propertyValues
}
```

For `update`:
```javascript
{ update: { _index: `ontology-${objectType.toLowerCase()}`, _id: primaryKey } }
{ doc: {
    ...propertyValues,
    __lastModified: new Date().toISOString(),
    __editedBy: executionContext.executedBy
}, doc_as_upsert: false }
```
IMPORTANT: Use `doc_as_upsert: false` so that updating a non-existent document fails rather than creating it. The object should already exist (validated in the rule compiler).

For `delete`:
```javascript
{ delete: { _index: `ontology-${objectType.toLowerCase()}`, _id: primaryKey } }
```

Execute the bulk request to OpenSearch. Parse the response to check for individual item failures. OpenSearch's bulk API can have partial failures — some items succeed while others fail.

**Step 5: Process OpenSearch response.** For each item in the bulk response:
- If successful: Mark the corresponding `ontology_edit` row as `indexed = true`, `indexed_at = now()`.
- If failed: Log the error. The edit remains in PostgreSQL with `indexed = false` and will be retried on the next reindex.

**Step 6: Handle link edits (inside the same PG transaction from Step 1).** For many-to-many links, store link edits in the `link_edit` PostgreSQL table. All link_edit inserts MUST happen inside the same PG transaction opened in Step 1 to maintain atomicity with the ontology_edit inserts.

- `add` link: Insert a row with `operation = 'add'` into the `link_edit` table.
- `remove` link: Insert a row with `operation = 'remove'` into the `link_edit` table.

The `link_edit` table DDL (execute as part of this task's database setup):
  ```sql
  CREATE TABLE IF NOT EXISTS link_edit (
      link_edit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      link_type_api_name TEXT NOT NULL,
      source_primary_key TEXT NOT NULL,
      target_primary_key TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('add', 'remove')),
      execution_id UUID,
      executed_at TIMESTAMPTZ DEFAULT now()
  );
  ```
**Handling `systemProperties` from rule handlers:** If an edit contains a `systemProperties` field (produced by createObject/modifyObject rule handlers in Tasks 12-13), merge these into the OpenSearch document during Step 4. The system properties (`__pk`, `__objectType`, `__lastModified`, `__editedBy`, `__version`) are written to OpenSearch but NOT stored in the `ontology_edit` table's `property_values` column. The edit applicator is responsible for adding system properties to the OpenSearch document.

**Step 7: Return the result.**

**Test cases:**
```javascript
// Create a new object
const result = await applyEdits(
    [{ objectType: 'Employee', primaryKey: 'EMP-NEW', operation: 'create',
       propertyValues: { employeeId: 'EMP-NEW', fullName: 'New Person', salary: 80000 },
       linkEdits: [] }],
    { executionId: 'exec-1', actionTypeApiName: 'createEmployee', parameters: {}, executedBy: 'system' }
);
assert(result.success === true);
assert(result.appliedEdits.length === 1);

// Verify the object is in OpenSearch
const doc = await opensearchClient.get({ index: 'ontology-employee', id: 'EMP-NEW' });
assert(doc.body._source.fullName === 'New Person');

// Verify the edit is in PostgreSQL
const edits = await getEditHistory('Employee', 'EMP-NEW');
assert(edits.length === 1);
assert(edits[0].operation === 'create');
```
