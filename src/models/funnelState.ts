// ---------------------------------------------------------------------------
// Funnel Pipeline State Model
//
// Manages the `funnel_pipeline_state` table — detailed pipeline execution
// metrics for the indexing engine. This table tracks when each object type
// was last indexed, how many objects were indexed, whether it succeeded or
// failed, and what datasource version was indexed.
//
// Coexists with Monday's `funnel_state` table (lightweight UI-facing status).
// - `funnel_state` — references object_type_id (UUID FK), status values:
//   not_indexed/indexing/indexed/failed/stale
// - `funnel_pipeline_state` — references object_type_api_name (TEXT PK),
//   status values: idle/running/success/failed
//
// All state management for the indexing pipeline is centralized here.
// The orchestrator (Task 12) must use these functions exclusively — no raw
// SQL for pipeline state updates.
// ---------------------------------------------------------------------------

import { query } from "../db";
import type { QueryResult } from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A row from the funnel_pipeline_state table. */
export interface FunnelPipelineState {
  object_type_api_name: string;
  status: "idle" | "running" | "success" | "failed";
  last_indexed_at: string | null;
  objects_indexed: number | null;
  duration_ms: number | null;
  datasource_version: string | null;
  error_message: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

/** Partial state update for setState(). */
export interface FunnelPipelineStateUpdate {
  status?: "idle" | "running" | "success" | "failed";
  objects_indexed?: number | null;
  duration_ms?: number | null;
  datasource_version?: string | null;
  error_message?: string | null;
  retry_count?: number;
}

/**
 * Query function signature — matches db.query() but allows injection
 * for testing without a live PostgreSQL connection.
 */
export type QueryFn = (
  text: string,
  values?: unknown[]
) => Promise<QueryResult>;

// ---------------------------------------------------------------------------
// 1. getState()
// ---------------------------------------------------------------------------

/**
 * Returns the pipeline state row for an object type, or null if no state
 * exists yet.
 *
 * @param objectTypeApiName - The API name of the object type.
 * @param queryFn           - Optional injected query function for testing.
 * @returns The state row or null.
 */
export async function getState(
  objectTypeApiName: string,
  queryFn: QueryFn = query
): Promise<FunnelPipelineState | null> {
  const result = await queryFn(
    "SELECT * FROM funnel_pipeline_state WHERE object_type_api_name = $1",
    [objectTypeApiName]
  );
  return (result.rows[0] as FunnelPipelineState) ?? null;
}

// ---------------------------------------------------------------------------
// 2. setState()
// ---------------------------------------------------------------------------

/**
 * Updates the pipeline state. Uses INSERT ... ON CONFLICT to handle both
 * insert and update cases. Only provided fields are updated; omitted fields
 * are not changed. Always sets `updated_at = now()`.
 *
 * @param objectTypeApiName - The API name of the object type.
 * @param state             - Partial state update.
 * @param queryFn           - Optional injected query function for testing.
 * @returns The updated state row.
 */
export async function setState(
  objectTypeApiName: string,
  state: FunnelPipelineStateUpdate,
  queryFn: QueryFn = query
): Promise<FunnelPipelineState> {
  // Build the SET clause dynamically from provided fields
  const setClauses: string[] = ["updated_at = now()"];
  const values: unknown[] = [objectTypeApiName];
  let paramIndex = 2;

  if (state.status !== undefined) {
    setClauses.push(`status = $${paramIndex}`);
    values.push(state.status);
    paramIndex++;
  }
  if (state.objects_indexed !== undefined) {
    setClauses.push(`objects_indexed = $${paramIndex}`);
    values.push(state.objects_indexed);
    paramIndex++;
  }
  if (state.duration_ms !== undefined) {
    setClauses.push(`duration_ms = $${paramIndex}`);
    values.push(state.duration_ms);
    paramIndex++;
  }
  if (state.datasource_version !== undefined) {
    setClauses.push(`datasource_version = $${paramIndex}`);
    values.push(state.datasource_version);
    paramIndex++;
  }
  if (state.error_message !== undefined) {
    setClauses.push(`error_message = $${paramIndex}`);
    values.push(state.error_message);
    paramIndex++;
  }
  if (state.retry_count !== undefined) {
    setClauses.push(`retry_count = $${paramIndex}`);
    values.push(state.retry_count);
    paramIndex++;
  }

  const result = await queryFn(
    `INSERT INTO funnel_pipeline_state (object_type_api_name, ${
      state.status !== undefined ? "status, " : ""
    }updated_at)
     VALUES ($1, ${state.status !== undefined ? `'${state.status}', ` : ""}now())
     ON CONFLICT (object_type_api_name) DO UPDATE SET
       ${setClauses.join(",\n       ")}
     RETURNING *`,
    values
  );

  return result.rows[0] as FunnelPipelineState;
}

// ---------------------------------------------------------------------------
// 3. getAllStates()
// ---------------------------------------------------------------------------

/**
 * Returns pipeline states for all object types (for the status dashboard).
 *
 * @param queryFn - Optional injected query function for testing.
 * @returns Array of state rows.
 */
export async function getAllStates(
  queryFn: QueryFn = query
): Promise<FunnelPipelineState[]> {
  const result = await queryFn(
    "SELECT * FROM funnel_pipeline_state ORDER BY updated_at DESC"
  );
  return result.rows as FunnelPipelineState[];
}

// ---------------------------------------------------------------------------
// 4. setRunning()
// ---------------------------------------------------------------------------

/**
 * Sets status to 'running'. Handles retry_count logic:
 * - If current status is 'failed', increment retry_count (retry)
 * - If current status is 'idle' or 'success', reset retry_count to 0
 * - If no state exists yet, creates one with retry_count = 0
 *
 * @param objectTypeApiName - The API name of the object type.
 * @param queryFn           - Optional injected query function for testing.
 */
export async function setRunning(
  objectTypeApiName: string,
  queryFn: QueryFn = query
): Promise<void> {
  // Use a single upsert that conditionally increments retry_count
  // based on the existing status
  await queryFn(
    `INSERT INTO funnel_pipeline_state (object_type_api_name, status, retry_count, updated_at)
     VALUES ($1, 'running', 0, now())
     ON CONFLICT (object_type_api_name) DO UPDATE SET
       status = 'running',
       retry_count = CASE
         WHEN funnel_pipeline_state.status = 'failed'
           THEN funnel_pipeline_state.retry_count + 1
         ELSE 0
       END,
       updated_at = now()`,
    [objectTypeApiName]
  );
}

// ---------------------------------------------------------------------------
// 5. setSuccess()
// ---------------------------------------------------------------------------

/**
 * Sets status to 'success' with all pipeline metrics. Clears error_message.
 *
 * @param objectTypeApiName - The API name of the object type.
 * @param objectsIndexed    - Number of objects indexed.
 * @param durationMs        - Pipeline duration in milliseconds.
 * @param datasourceVersion - The datasource version identifier.
 * @param queryFn           - Optional injected query function for testing.
 */
export async function setSuccess(
  objectTypeApiName: string,
  objectsIndexed: number,
  durationMs: number,
  datasourceVersion: string | null,
  queryFn: QueryFn = query
): Promise<void> {
  await queryFn(
    `INSERT INTO funnel_pipeline_state
       (object_type_api_name, status, last_indexed_at, objects_indexed,
        duration_ms, datasource_version, error_message, updated_at)
     VALUES ($1, 'success', now(), $2, $3, $4, NULL, now())
     ON CONFLICT (object_type_api_name) DO UPDATE SET
       status = 'success',
       last_indexed_at = now(),
       objects_indexed = $2,
       duration_ms = $3,
       datasource_version = $4,
       error_message = NULL,
       updated_at = now()`,
    [objectTypeApiName, objectsIndexed, durationMs, datasourceVersion]
  );
}

// ---------------------------------------------------------------------------
// 6. setFailed()
// ---------------------------------------------------------------------------

/**
 * Sets status to 'failed' with error message. Does NOT modify
 * objects_indexed, duration_ms, or datasource_version (preserves last
 * successful values).
 *
 * @param objectTypeApiName - The API name of the object type.
 * @param errorMessage      - The error message describing the failure.
 * @param queryFn           - Optional injected query function for testing.
 */
export async function setFailed(
  objectTypeApiName: string,
  errorMessage: string,
  queryFn: QueryFn = query
): Promise<void> {
  await queryFn(
    `INSERT INTO funnel_pipeline_state
       (object_type_api_name, status, error_message, updated_at)
     VALUES ($1, 'failed', $2, now())
     ON CONFLICT (object_type_api_name) DO UPDATE SET
       status = 'failed',
       error_message = $2,
       updated_at = now()`,
    [objectTypeApiName, errorMessage]
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default {
  getState,
  setState,
  getAllStates,
  setRunning,
  setSuccess,
  setFailed,
};

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/models/funnelState.ts)
// ---------------------------------------------------------------------------

export async function runSelfTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
    } else {
      /* v8 ignore next 2 */
      failed++;
      console.error(`  FAIL: ${label}`);
    }
  }

  console.log("Running funnelState model self-tests...\n");

  // =======================================================================
  // Mock in-memory database
  // =======================================================================

  /** In-memory store simulating the funnel_pipeline_state table. */
  const store = new Map<string, Record<string, unknown>>();

  function createMockQueryFn(): QueryFn {
    return async (text: string, values?: unknown[]): Promise<QueryResult> => {
      const apiName = values?.[0] as string;

      // SELECT * FROM funnel_pipeline_state WHERE object_type_api_name = $1
      if (text.includes("SELECT") && text.includes("WHERE object_type_api_name")) {
        const row = store.get(apiName);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 } as unknown as QueryResult;
      }

      // SELECT * FROM funnel_pipeline_state ORDER BY ...
      if (text.includes("SELECT") && text.includes("ORDER BY")) {
        const rows = Array.from(store.values()).map((r) => ({ ...r }));
        return { rows, rowCount: rows.length } as unknown as QueryResult;
      }

      // INSERT ... ON CONFLICT ... for setRunning
      if (text.includes("INSERT") && text.includes("'running'") && text.includes("CASE")) {
        const existing = store.get(apiName);
        const now = new Date().toISOString();

        if (!existing) {
          const row: Record<string, unknown> = {
            object_type_api_name: apiName,
            status: "running",
            last_indexed_at: null,
            objects_indexed: null,
            duration_ms: null,
            datasource_version: null,
            error_message: null,
            retry_count: 0,
            created_at: now,
            updated_at: now,
          };
          store.set(apiName, row);
        } else {
          existing.status = "running";
          existing.retry_count =
            existing.status === "failed"
              ? (existing.retry_count as number) + 1
              : 0;
          // Need to re-check: at this point existing.status is already 'running'
          // The SQL uses the OLD value of status. Let me simulate correctly.
          existing.updated_at = now;
        }
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }

      // INSERT ... ON CONFLICT ... for setSuccess
      if (text.includes("INSERT") && text.includes("'success'")) {
        const existing = store.get(apiName);
        const now = new Date().toISOString();
        const objectsIndexed = values?.[1] as number;
        const durationMs = values?.[2] as number;
        const datasourceVersion = values?.[3] as string | null;

        if (!existing) {
          store.set(apiName, {
            object_type_api_name: apiName,
            status: "success",
            last_indexed_at: now,
            objects_indexed: objectsIndexed,
            duration_ms: durationMs,
            datasource_version: datasourceVersion,
            error_message: null,
            retry_count: 0,
            created_at: now,
            updated_at: now,
          });
        } else {
          existing.status = "success";
          existing.last_indexed_at = now;
          existing.objects_indexed = objectsIndexed;
          existing.duration_ms = durationMs;
          existing.datasource_version = datasourceVersion;
          existing.error_message = null;
          existing.updated_at = now;
        }
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }

      // INSERT ... ON CONFLICT ... for setFailed
      if (text.includes("INSERT") && text.includes("'failed'")) {
        const existing = store.get(apiName);
        const now = new Date().toISOString();
        const errorMessage = values?.[1] as string;

        if (!existing) {
          store.set(apiName, {
            object_type_api_name: apiName,
            status: "failed",
            last_indexed_at: null,
            objects_indexed: null,
            duration_ms: null,
            datasource_version: null,
            error_message: errorMessage,
            retry_count: 0,
            created_at: now,
            updated_at: now,
          });
        } else {
          existing.status = "failed";
          existing.error_message = errorMessage;
          existing.updated_at = now;
        }
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }

      // INSERT ... ON CONFLICT ... for setState (generic)
      if (text.includes("INSERT") && text.includes("ON CONFLICT")) {
        const existing = store.get(apiName);
        const now = new Date().toISOString();

        if (!existing) {
          const row: Record<string, unknown> = {
            object_type_api_name: apiName,
            status: "idle",
            last_indexed_at: null,
            objects_indexed: null,
            duration_ms: null,
            datasource_version: null,
            error_message: null,
            retry_count: 0,
            created_at: now,
            updated_at: now,
          };
          // Apply SET clauses from values
          applySetStateValues(row, text, values ?? []);
          store.set(apiName, row);
          return { rows: [{ ...row }], rowCount: 1 } as unknown as QueryResult;
        } else {
          applySetStateValues(existing, text, values ?? []);
          existing.updated_at = now;
          return { rows: [{ ...existing }], rowCount: 1 } as unknown as QueryResult;
        }
      }

      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    };
  }

  /** Parse the SET clause values from setState's dynamic SQL. */
  function applySetStateValues(
    row: Record<string, unknown>,
    text: string,
    values: unknown[]
  ): void {
    // The values array is [objectTypeApiName, ...dynamicValues]
    // The SQL has $2, $3, etc. matching the order of fields in the SET clause
    const fields = ["status", "objects_indexed", "duration_ms", "datasource_version", "error_message", "retry_count"];
    let paramIdx = 2;
    for (const field of fields) {
      if (text.includes(`${field} = $${paramIdx}`)) {
        row[field] = values[paramIdx - 1];
        paramIdx++;
      }
    }
  }

  // =======================================================================
  // Improved mock that tracks state transitions properly for setRunning
  // =======================================================================

  /** A more accurate mock specifically for testing retry_count logic. */
  function createStatefulMockQueryFn(): {
    queryFn: QueryFn;
    getStore: () => Map<string, Record<string, unknown>>;
  } {
    const stateStore = new Map<string, Record<string, unknown>>();

    const queryFn: QueryFn = async (text: string, values?: unknown[]): Promise<QueryResult> => {
      const apiName = values?.[0] as string;
      const now = new Date().toISOString();

      // SELECT single
      if (text.includes("SELECT") && text.includes("WHERE object_type_api_name")) {
        const row = stateStore.get(apiName);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 } as unknown as QueryResult;
      }

      // SELECT all
      if (text.includes("SELECT") && text.includes("ORDER BY")) {
        const rows = Array.from(stateStore.values()).map((r) => ({ ...r }));
        return { rows, rowCount: rows.length } as unknown as QueryResult;
      }

      // setRunning
      if (text.includes("'running'") && text.includes("CASE")) {
        const existing = stateStore.get(apiName);
        if (!existing) {
          stateStore.set(apiName, {
            object_type_api_name: apiName,
            status: "running",
            last_indexed_at: null,
            objects_indexed: null,
            duration_ms: null,
            datasource_version: null,
            error_message: null,
            retry_count: 0,
            created_at: now,
            updated_at: now,
          });
        } else {
          // CASE: increment retry_count only if status WAS 'failed'
          const wasStatus = existing.status;
          existing.retry_count =
            wasStatus === "failed"
              ? (existing.retry_count as number) + 1
              : 0;
          existing.status = "running";
          existing.updated_at = now;
        }
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }

      // setSuccess
      if (text.includes("'success'")) {
        const existing = stateStore.get(apiName);
        const objectsIndexed = values?.[1] as number;
        const durationMs = values?.[2] as number;
        const datasourceVersion = values?.[3] as string | null;

        if (!existing) {
          stateStore.set(apiName, {
            object_type_api_name: apiName,
            status: "success",
            last_indexed_at: now,
            objects_indexed: objectsIndexed,
            duration_ms: durationMs,
            datasource_version: datasourceVersion,
            error_message: null,
            retry_count: 0,
            created_at: now,
            updated_at: now,
          });
        } else {
          existing.status = "success";
          existing.last_indexed_at = now;
          existing.objects_indexed = objectsIndexed;
          existing.duration_ms = durationMs;
          existing.datasource_version = datasourceVersion;
          existing.error_message = null;
          existing.updated_at = now;
        }
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }

      // setFailed
      if (text.includes("'failed'")) {
        const existing = stateStore.get(apiName);
        const errorMessage = values?.[1] as string;

        if (!existing) {
          stateStore.set(apiName, {
            object_type_api_name: apiName,
            status: "failed",
            last_indexed_at: null,
            objects_indexed: null,
            duration_ms: null,
            datasource_version: null,
            error_message: errorMessage,
            retry_count: 0,
            created_at: now,
            updated_at: now,
          });
        } else {
          existing.status = "failed";
          existing.error_message = errorMessage;
          existing.updated_at = now;
          // Does NOT modify objects_indexed, duration_ms, datasource_version
        }
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }

      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    };

    return { queryFn, getStore: () => stateStore };
  }

  // =======================================================================
  // Test 1: getState — non-existent returns null
  // =======================================================================
  {
    const { queryFn } = createStatefulMockQueryFn();
    const state = await getState("NonExistent", queryFn);
    assert(state === null, "getState null: returns null for non-existent");
  }

  // =======================================================================
  // Test 2: setRunning — first-time run creates state
  // =======================================================================
  {
    const { queryFn, getStore } = createStatefulMockQueryFn();

    await setRunning("Employee", queryFn);

    const row = getStore().get("Employee");
    assert(row !== undefined, "setRunning first: row created");
    assert(row!.status === "running", "setRunning first: status is running");
    assert(row!.retry_count === 0, "setRunning first: retry_count is 0");
  }

  // =======================================================================
  // Test 3: setSuccess — sets all metrics
  // =======================================================================
  {
    const { queryFn, getStore } = createStatefulMockQueryFn();

    await setRunning("Employee", queryFn);
    await setSuccess("Employee", 1000, 2500, "ds-12345", queryFn);

    const row = getStore().get("Employee");
    assert(row!.status === "success", "setSuccess: status is success");
    assert(row!.objects_indexed === 1000, "setSuccess: objects_indexed");
    assert(row!.duration_ms === 2500, "setSuccess: duration_ms");
    assert(row!.datasource_version === "ds-12345", "setSuccess: datasource_version");
    assert(row!.error_message === null, "setSuccess: error_message cleared");
    assert(row!.last_indexed_at !== null, "setSuccess: last_indexed_at set");
  }

  // =======================================================================
  // Test 4: setFailed — sets error, preserves last successful values
  // =======================================================================
  {
    const { queryFn, getStore } = createStatefulMockQueryFn();

    // First: successful run
    await setRunning("Employee", queryFn);
    await setSuccess("Employee", 500, 1200, "ds-111", queryFn);

    // Then: failed run
    await setRunning("Employee", queryFn);
    await setFailed("Employee", "CSV parse error on line 42", queryFn);

    const row = getStore().get("Employee");
    assert(row!.status === "failed", "setFailed: status is failed");
    assert(row!.error_message === "CSV parse error on line 42", "setFailed: error_message set");
    // Preserved from last success:
    assert(row!.objects_indexed === 500, "setFailed: objects_indexed preserved");
    assert(row!.duration_ms === 1200, "setFailed: duration_ms preserved");
    assert(row!.datasource_version === "ds-111", "setFailed: datasource_version preserved");
  }

  // =======================================================================
  // Test 5: setRunning after failure — retry_count increments
  // =======================================================================
  {
    const { queryFn, getStore } = createStatefulMockQueryFn();

    await setRunning("Taxpayer", queryFn);       // First run: idle -> running (rc=0)
    await setFailed("Taxpayer", "Error 1", queryFn);  // running -> failed
    await setRunning("Taxpayer", queryFn);        // Retry 1: failed -> running (rc=1)

    let row = getStore().get("Taxpayer");
    assert(row!.retry_count === 1, `retry: retry_count is 1 after first retry (got ${row!.retry_count})`);

    await setFailed("Taxpayer", "Error 2", queryFn);  // running -> failed
    await setRunning("Taxpayer", queryFn);        // Retry 2: failed -> running (rc=2)

    row = getStore().get("Taxpayer");
    assert(row!.retry_count === 2, `retry: retry_count is 2 after second retry (got ${row!.retry_count})`);
  }

  // =======================================================================
  // Test 6: setRunning after success — retry_count resets to 0
  // =======================================================================
  {
    const { queryFn, getStore } = createStatefulMockQueryFn();

    await setRunning("Employee", queryFn);
    await setFailed("Employee", "Error", queryFn);
    await setRunning("Employee", queryFn);  // retry_count = 1
    await setSuccess("Employee", 100, 500, "v1", queryFn);
    await setRunning("Employee", queryFn);  // re-index after success: retry_count resets

    const row = getStore().get("Employee");
    assert(row!.retry_count === 0, `retry reset: retry_count is 0 after success re-run (got ${row!.retry_count})`);
  }

  // =======================================================================
  // Test 7: setFailed on first run (no prior state)
  // =======================================================================
  {
    const { queryFn, getStore } = createStatefulMockQueryFn();

    await setFailed("NewType", "Immediate failure", queryFn);

    const row = getStore().get("NewType");
    assert(row !== undefined, "first fail: row created");
    assert(row!.status === "failed", "first fail: status is failed");
    assert(row!.error_message === "Immediate failure", "first fail: error_message");
    assert(row!.objects_indexed === null, "first fail: objects_indexed null");
    assert(row!.retry_count === 0, "first fail: retry_count 0");
  }

  // =======================================================================
  // Test 8: getState after setSuccess — returns full row
  // =======================================================================
  {
    const { queryFn } = createStatefulMockQueryFn();

    await setRunning("Employee", queryFn);
    await setSuccess("Employee", 750, 3000, "ds-abc", queryFn);

    const state = await getState("Employee", queryFn);
    assert(state !== null, "getState after success: not null");
    assert(state!.status === "success", "getState after success: status");
    assert(state!.objects_indexed === 750, "getState after success: objects_indexed");
    assert(state!.duration_ms === 3000, "getState after success: duration_ms");
    assert(state!.datasource_version === "ds-abc", "getState after success: datasource_version");
    assert(state!.error_message === null, "getState after success: error_message null");
  }

  // =======================================================================
  // Test 9: getAllStates — returns all tracked object types
  // =======================================================================
  {
    const { queryFn } = createStatefulMockQueryFn();

    await setRunning("TypeA", queryFn);
    await setSuccess("TypeA", 100, 500, "v1", queryFn);

    await setRunning("TypeB", queryFn);
    await setFailed("TypeB", "Some error", queryFn);

    await setRunning("TypeC", queryFn);

    const allStates = await getAllStates(queryFn);
    assert(allStates.length === 3, `getAllStates: 3 entries (got ${allStates.length})`);

    const names = allStates.map((s) => s.object_type_api_name).sort();
    assert(
      names[0] === "TypeA" && names[1] === "TypeB" && names[2] === "TypeC",
      "getAllStates: all three types present"
    );
  }

  // =======================================================================
  // Test 10: setSuccess clears error_message from prior failure
  // =======================================================================
  {
    const { queryFn, getStore } = createStatefulMockQueryFn();

    await setRunning("Employee", queryFn);
    await setFailed("Employee", "First error", queryFn);

    let row = getStore().get("Employee");
    assert(row!.error_message === "First error", "clear error: error set");

    await setRunning("Employee", queryFn);
    await setSuccess("Employee", 200, 800, "v2", queryFn);

    row = getStore().get("Employee");
    assert(row!.error_message === null, "clear error: error_message cleared after success");
  }

  // =======================================================================
  // Test 11: Full lifecycle — idle → running → success → running → failed → running (retry)
  // =======================================================================
  {
    const { queryFn, getStore } = createStatefulMockQueryFn();

    // Step 1: First run
    await setRunning("Lifecycle", queryFn);
    let row = getStore().get("Lifecycle")!;
    assert(row.status === "running", "lifecycle: step 1 running");
    assert(row.retry_count === 0, "lifecycle: step 1 rc=0");

    // Step 2: Success
    await setSuccess("Lifecycle", 500, 1000, "v1", queryFn);
    row = getStore().get("Lifecycle")!;
    assert(row.status === "success", "lifecycle: step 2 success");
    assert(row.objects_indexed === 500, "lifecycle: step 2 indexed=500");

    // Step 3: Re-index (after datasource refresh)
    await setRunning("Lifecycle", queryFn);
    row = getStore().get("Lifecycle")!;
    assert(row.status === "running", "lifecycle: step 3 running again");
    assert(row.retry_count === 0, "lifecycle: step 3 rc=0 (from success)");

    // Step 4: Failure
    await setFailed("Lifecycle", "Connection timeout", queryFn);
    row = getStore().get("Lifecycle")!;
    assert(row.status === "failed", "lifecycle: step 4 failed");
    assert(row.objects_indexed === 500, "lifecycle: step 4 indexed preserved");

    // Step 5: Retry
    await setRunning("Lifecycle", queryFn);
    row = getStore().get("Lifecycle")!;
    assert(row.status === "running", "lifecycle: step 5 retry running");
    assert(row.retry_count === 1, "lifecycle: step 5 rc=1 (from failed)");

    // Step 6: Success on retry
    await setSuccess("Lifecycle", 600, 1100, "v2", queryFn);
    row = getStore().get("Lifecycle")!;
    assert(row.status === "success", "lifecycle: step 6 success on retry");
    assert(row.objects_indexed === 600, "lifecycle: step 6 indexed=600");
    assert(row.error_message === null, "lifecycle: step 6 error cleared");
  }

  // =======================================================================
  // Test 12: setSuccess with null datasourceVersion
  // =======================================================================
  {
    const { queryFn, getStore } = createStatefulMockQueryFn();

    await setRunning("NullVersion", queryFn);
    await setSuccess("NullVersion", 50, 200, null, queryFn);

    const row = getStore().get("NullVersion")!;
    assert(row.datasource_version === null, "null version: datasource_version is null");
    assert(row.objects_indexed === 50, "null version: objects_indexed set");
  }

  // =======================================================================
  // Test 13: Multiple concurrent object types — isolation
  // =======================================================================
  {
    const { queryFn, getStore } = createStatefulMockQueryFn();

    await setRunning("TypeA", queryFn);
    await setRunning("TypeB", queryFn);
    await setSuccess("TypeA", 100, 500, "v1", queryFn);
    await setFailed("TypeB", "Network error", queryFn);

    const rowA = getStore().get("TypeA")!;
    const rowB = getStore().get("TypeB")!;

    assert(rowA.status === "success", "isolation: TypeA success");
    assert(rowB.status === "failed", "isolation: TypeB failed");
    assert(rowA.objects_indexed === 100, "isolation: TypeA indexed");
    assert(rowB.error_message === "Network error", "isolation: TypeB error");
  }

  // =======================================================================
  // Summary
  // =======================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll funnelState model tests passed");
  } else {
    /* v8 ignore next */
    process.exit(1);
  }
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
