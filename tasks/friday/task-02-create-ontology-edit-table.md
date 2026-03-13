# TASK 2: Create the `ontology_edit` PostgreSQL Table

**Objective:** Create the table that stores every individual edit (create, update, delete) applied to Ontology objects through Actions. This is the edit store — the write-ahead log for the Ontology. When an Action is executed, each object modification is recorded as a row in this table. The Object Data Funnel (indexer) then reads pending edits from this table and indexes them into OpenSearch. This separation between "recording the edit" and "indexing the edit" is a fundamental architectural choice in Palantir's Object Storage V2 — it allows the write path (Actions) and the indexing path (Funnel) to operate independently and at different speeds.

In Palantir's documentation, this is described as: "Object Storage V2 does not require materialized datasets to enable user edits. User edits are stored separately and merged with datasource data during indexing." (https://www.palantir.com/docs/foundry/object-edits/materializations/)

The key behavior to replicate: when a backing datasource is reindexed, user edits (from Actions) take precedence over datasource data for the same primary key. This means if a CSV says Employee EMP-001 has salary 100,000, but an Action previously changed the salary to 150,000, the reindexed object should show salary 150,000. The edit store is the source of truth for user modifications.

**Exact SQL to execute:**

```sql
CREATE TABLE IF NOT EXISTS ontology_edit (
    edit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Which object type this edit targets. Stored as the api_name string (e.g., 'Employee')
    -- rather than a foreign key, because we need to be able to process edits even if the
    -- object type schema changes between when the edit was created and when it's indexed.
    object_type_api_name TEXT NOT NULL,
    
    -- The primary key of the specific object being edited.
    -- For 'create' operations, this is the PK of the new object.
    -- For 'update' and 'delete' operations, this is the PK of the existing object.
    primary_key TEXT NOT NULL,
    
    -- The type of edit operation. Exactly three types, matching Palantir's action rule types:
    --   'create': A new object is being created with the specified property values.
    --             If an object with this PK already exists, the action should fail.
    --   'update': An existing object's properties are being modified.
    --             Only the properties specified in property_values are changed; all other
    --             properties retain their current values. If the object doesn't exist, the action should fail.
    --   'delete': An existing object is being removed from the Ontology.
    --             If the object doesn't exist, the action should fail.
    operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
    
    -- The property values being set by this edit. This is a JSON object where keys are
    -- property api_names and values are the new values.
    -- For 'create': Contains all properties of the new object (at minimum, the primary key and any required properties).
    -- For 'update': Contains only the properties being changed (partial update, not full replacement).
    -- For 'delete': Should be NULL or empty object — no properties are relevant for a deletion.
    -- Example for create: {"employeeId": "EMP-999", "fullName": "New Hire", "salary": 120000, "department": "Engineering"}
    -- Example for update: {"salary": 150000} — only salary changes, everything else stays the same
    property_values JSONB DEFAULT '{}'::jsonb,
    
    -- Link edits associated with this object edit. This is a JSON array of link operations.
    -- Each element has: { "linkTypeApiName": "...", "targetPrimaryKey": "...", "operation": "add" | "remove" }
    -- This is used for many-to-many links where the link itself has no backing foreign key property.
    -- For one-to-many links, the link is implicit in the foreign key property and is handled via property_values.
    link_edits JSONB DEFAULT '[]'::jsonb,
    
    -- Which action type produced this edit. Stored as api_name for traceability.
    -- Can be NULL for system-generated edits (e.g., from data pipeline reprocessing).
    action_type_api_name TEXT,
    
    -- The full action execution ID — groups all edits from a single action execution together.
    -- Multiple edits can share the same execution_id if one action creates/modifies multiple objects.
    execution_id UUID,
    
    -- The snapshot of parameters that were passed to the action when this edit was produced.
    -- Stored for full auditability — you can always reconstruct exactly what inputs led to this edit.
    action_parameters JSONB DEFAULT '{}'::jsonb,
    
    -- Who executed the action that produced this edit.
    -- In week 1, this will always be 'system' since there's no auth.
    -- In production, this would be a user ID from the authentication system.
    executed_by TEXT NOT NULL DEFAULT 'system',
    
    -- When this edit was created (not when it was indexed).
    executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    -- Whether this edit has been indexed into OpenSearch.
    -- The indexer sets this to true after successfully processing the edit.
    -- This flag is how the Funnel knows which edits are "pending" and need to be indexed.
    indexed BOOLEAN NOT NULL DEFAULT false,
    
    -- When the edit was indexed into OpenSearch. NULL until indexed.
    indexed_at TIMESTAMPTZ DEFAULT NULL,
    
    -- The branch this edit belongs to. NULL means the Main branch (production).
    -- Non-null values represent edits made on a proposal branch that haven't been merged yet.
    -- In week 1, this will always be NULL since branching isn't implemented yet.
    branch_id UUID DEFAULT NULL
);

-- Index for the most critical query: "get all pending edits for an object type"
-- The Funnel uses this to find edits that need to be indexed.
CREATE INDEX IF NOT EXISTS idx_edit_pending 
    ON ontology_edit(object_type_api_name, indexed) 
    WHERE indexed = false;

-- Index for looking up all edits for a specific object (for edit history)
CREATE INDEX IF NOT EXISTS idx_edit_object 
    ON ontology_edit(object_type_api_name, primary_key, executed_at DESC);

-- Index for looking up all edits from a specific action execution
CREATE INDEX IF NOT EXISTS idx_edit_execution 
    ON ontology_edit(execution_id);

-- Index for looking up edits by the user who made them
CREATE INDEX IF NOT EXISTS idx_edit_user 
    ON ontology_edit(executed_by, executed_at DESC);

COMMENT ON TABLE ontology_edit IS 'Write-ahead log for all Ontology object modifications made through Actions. Each row represents a single create, update, or delete operation on one object. Pending edits (indexed=false) are processed by the indexer and merged with datasource data in OpenSearch. Mirrors Palantir Object Storage V2 edit handling.';
```

**Create a database access module** at `src/db/ontologyEdits.js` that exports:

1. `createEdit(edit)` — Inserts a new edit record. The `edit` parameter is an object with fields matching the table columns. Returns the full row including the generated `edit_id`.

2. `createEdits(edits)` — Batch inserts multiple edit records in a single transaction. This is used when an action produces multiple edits (e.g., creating an object AND adding a link). All edits in the batch share the same `execution_id`. The entire batch must succeed or fail atomically (use a PostgreSQL transaction with BEGIN/COMMIT/ROLLBACK).

3. `getPendingEdits(objectTypeApiName)` — Returns all edits where `indexed = false` for the given object type, ordered by `executed_at` ascending. This is what the indexer calls to find work to do.

4. `markEditsAsIndexed(editIds)` — Sets `indexed = true` and `indexed_at = now()` for the specified edit IDs. Called by the indexer after successfully writing to OpenSearch.

5. `getEditHistory(objectTypeApiName, primaryKey)` — Returns the full edit history for a specific object, ordered by `executed_at` descending (newest first). This is used in Object Views to show the audit trail for a single object.

6. `getEditsByExecution(executionId)` — Returns all edits produced by a single action execution.

7. `getLatestEditsForObject(objectTypeApiName, primaryKey)` — Returns the cumulative property values set by edits for this object. This is used by the reindex process (Task 16): when the Funnel (the indexer component that reads pending edits and indexes them into OpenSearch) reindexes from a backing datasource, it overlays these edit values on top of datasource values to produce the final object state.

   **Implementation:** Query all edits for this object ordered by `executed_at ASC`, then merge all `property_values` objects with later edits overriding earlier ones (last write wins).

   **Edge cases:**
   - Zero edits for the object: return `null`.
   - `create` followed by multiple `update` edits: merge all `property_values` chronologically. The result contains all properties from the create plus any overrides from updates.
   - `create` → `update` → `delete`: return `{ __deleted: true }` to indicate the object should not appear in the index.
   - `create` → `delete` → `create` (re-creation with same PK): the second `create` resets the property state. Return the second create's properties merged with any subsequent updates.
   - Most recent edit is `delete` (regardless of prior history): return `{ __deleted: true }`.

   **Note:** This function provides per-object edit accumulation. Task 16's `reindexObjectType` performs a similar accumulation across ALL objects of a type in a batch. This function is for single-object lookups; Task 16 handles bulk reindex.

8. `getAllEditsByObjectType(objectTypeApiName)` — Returns ALL edits (not just pending) for the given object type, ordered by `executed_at ASC`. This is used by Task 16's reindex function. SQL: `SELECT * FROM ontology_edit WHERE object_type_api_name = $1 ORDER BY executed_at ASC`.

**Test cases:**
```javascript
// Create an edit
const edit = await createEdit({
    object_type_api_name: 'Employee',
    primary_key: 'EMP-001',
    operation: 'update',
    property_values: { salary: 150000 },
    action_type_api_name: 'updateSalary',
    execution_id: 'exec-uuid-here',
    executed_by: 'system'
});
assert(edit.indexed === false);

// Get pending edits
const pending = await getPendingEdits('Employee');
assert(pending.length >= 1);
assert(pending[0].primary_key === 'EMP-001');

// Mark as indexed
await markEditsAsIndexed([edit.edit_id]);
const pendingAfter = await getPendingEdits('Employee');
assert(pendingAfter.length === 0);

// Get latest edits (for reindex merge)
const latest = await getLatestEditsForObject('Employee', 'EMP-001');
assert(latest.salary === 150000);

// Edge case: no edits for an object
const noEdits = await getLatestEditsForObject('Employee', 'NONEXISTENT');
assert(noEdits === null);

// Edge case: delete marks object as deleted
await createEdit({
    object_type_api_name: 'Employee', primary_key: 'EMP-DEL',
    operation: 'create', property_values: { name: 'To Delete' },
    execution_id: 'exec-uuid-2', executed_by: 'system'
});
await createEdit({
    object_type_api_name: 'Employee', primary_key: 'EMP-DEL',
    operation: 'delete', property_values: null,
    execution_id: 'exec-uuid-3', executed_by: 'system'
});
const deleted = await getLatestEditsForObject('Employee', 'EMP-DEL');
assert(deleted.__deleted === true);

// Test getAllEditsByObjectType
const allEdits = await getAllEditsByObjectType('Employee');
assert(allEdits.length >= 1);
assert(allEdits[0].executed_at <= allEdits[allEdits.length - 1].executed_at); // ASC order
```
