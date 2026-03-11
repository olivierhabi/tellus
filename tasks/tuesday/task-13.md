# TASK 13: Create the Funnel Pipeline State Table

**File to create:** `/src/models/funnelState.js`

**Migration to add:** Append the `CREATE TABLE` statement below to `/src/migrate.js`, following the same pattern used for Monday's tables.

**Purpose:** This table tracks the state of the indexing pipeline for each object type — when it was last indexed, how many objects were indexed, whether it succeeded or failed, and what datasource version was indexed. In Palantir's architecture, the Funnel maintains pipeline state to support incremental indexing (only index what changed since last run). For Week 1 we do full reindexing, but we still track state for monitoring and to lay groundwork for incremental indexing in Week 3.

**Relationship to Monday's `funnel_state` table:** Monday's Task 6 created a `funnel_state` table that tracks lightweight status for the Ontology Manager UI (with values `not_indexed/indexing/indexed/failed/stale`). This table (`funnel_pipeline_state`) tracks detailed pipeline execution metrics for the indexing engine. They coexist and serve different purposes:
- `funnel_state` — Simple UI-facing status, references `object_type_id` as UUID FK
- `funnel_pipeline_state` — Detailed engine metrics, references `object_type_api_name` as TEXT PK

**SQL migration (append to `/src/migrate.js`):**
```sql
CREATE TABLE IF NOT EXISTS funnel_pipeline_state (
  object_type_api_name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'success', 'failed')),
  last_indexed_at TIMESTAMPTZ,
  objects_indexed INT,
  duration_ms INT,
  datasource_version TEXT,
  error_message TEXT,
  retry_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

**Model functions to export from `/src/models/funnelState.js`:**

1. **`getState(objectTypeApiName)`** — Returns the pipeline state row for an object type, or `null` if no state exists yet.

2. **`setState(objectTypeApiName, state)`** — Updates the pipeline state. `state` is a partial object containing any combination of: `{ status, objects_indexed, duration_ms, datasource_version, error_message, retry_count }`. Only provided fields are updated; omitted fields are not changed. Uses `INSERT ... ON CONFLICT (object_type_api_name) DO UPDATE SET` to handle both insert and update cases. Always sets `updated_at = now()`.

3. **`getAllStates()`** — Returns pipeline states for all object types (for the status dashboard). Returns an array of state objects.

4. **`setRunning(objectTypeApiName)`** — Sets status to `'running'` and increments `retry_count` only if the current status is `'failed'` (indicating a retry). If the current status is `'idle'` or `'success'`, `retry_count` is reset to 0 before the run begins. Sets `updated_at = now()`. Uses `INSERT ... ON CONFLICT` to handle first-time runs.

5. **`setSuccess(objectTypeApiName, objectsIndexed, durationMs, datasourceVersion)`** — Sets status to `'success'`, `last_indexed_at = now()`, `objects_indexed`, `duration_ms`, `datasource_version`, clears `error_message` to null, and sets `updated_at = now()`.

6. **`setFailed(objectTypeApiName, errorMessage)`** — Sets status to `'failed'`, `error_message`, and `updated_at = now()`. Does not modify `objects_indexed`, `duration_ms`, or `datasource_version` (preserves the last successful values).

**The orchestrator (Task 12) must call** `setRunning` before Stage 1, `setSuccess` after Stage 7, and `setFailed` on any error. The orchestrator must NOT use raw SQL for state updates — it must use these model functions exclusively. This ensures all state management logic is centralized in this module.

**Test to verify:** Run indexing, verify state is `'success'` with correct metrics. Simulate a failure, verify state is `'failed'` with error message. Re-run after failure, verify `retry_count` increments.
