// ---------------------------------------------------------------------------
// Indexer — Reindex-with-Edit-Merge
//
// Provides the `reindexObjectType(ontologyId, objectTypeApiName)` function
// that re-reads a backing datasource, merges ALL user edits from the
// `ontology_edit` table, and bulk-writes the resulting objects to OpenSearch.
//
// In Palantir's Object Storage V2, the indexed state is ALWAYS the merge of
// datasource + edits, computed at index time. User edits take precedence
// over datasource values for the same primary key and property. This means
// a tax auditor's risk score override survives datasource refreshes.
//
// Palantir docs: "Object Storage V2 does not require materialized datasets
// to enable user edits. With optional materialized datasets in OSv2, you
// only need to create materializations if they are required for downstream
// usage."
//
// The 9-step pipeline:
//   1. Load object type definition + backing datasource config
//   2. Read all rows from backing datasource
//   3. Build PK → row map from datasource
//   4. Get ALL user edits for this object type
//   5. Build cumulative edit map (PK → { operation, properties })
//   6. Merge datasource + edits → final objects to index
//   7. (Stale object cleanup — deferred to future iteration)
//   8. Execute bulk write to OpenSearch
//   9. Mark pending edits as indexed
//
// This module is a high-level facade that delegates to existing services:
//   - objectTypeService   for metadata
//   - csvReader           for datasource file reading
//   - ontologyEdit model  for edit records
//   - OpenSearch client   for bulk writes
// ---------------------------------------------------------------------------

import { query } from "./db";
import { readCSV } from "./services/indexing/csvReader";
import { getIndexName } from "./services/opensearch/indexMappingGenerator";
import { getAllEditsByObjectType, getPendingEdits, markEditsAsIndexed } from "./models/ontologyEdit";
import type { OntologyEditRow } from "./models/ontologyEdit";
import client from "./services/opensearch/client";
import { ensureDocumentSecurity } from "./services/security/documentSecurity";
import { deterministicObjectRid } from "./services/objectIdentity";
import type { QueryResult } from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by reindexObjectType(). */
export interface ReindexResult {
  objectsIndexed: number;
  editsApplied: number;
  deletions: number;
  durationMs: number;
}

/**
 * Cumulative edit state for a single primary key, computed by walking
 * all edits chronologically.
 */
interface EditState {
  operation: "create" | "update" | "delete";
  properties: Record<string, unknown>;
}

/**
 * Query function signature — allows injection for testing without a
 * live PostgreSQL connection.
 */
export type QueryFn = (
  text: string,
  values?: unknown[]
) => Promise<QueryResult>;

/** Injected dependencies for testing. */
export interface IndexerDeps {
  queryFn: QueryFn;
  readDatasetFile: (filePath: string) => Promise<Array<Record<string, string>>>;
  getAllEdits: (objectTypeApiName: string) => Promise<OntologyEditRow[]>;
  getPendingEdits: (objectTypeApiName: string) => Promise<OntologyEditRow[]>;
  markEditsAsIndexed: (editIds: string[]) => Promise<number>;
  bulkWrite: (body: Array<Record<string, unknown>>) => Promise<void>;
}

// ---------------------------------------------------------------------------
// reindexObjectType()
// ---------------------------------------------------------------------------

/**
 * Reindexes an object type from its backing datasource, merging with user
 * edits.
 *
 * @param ontologyId         - The ontology UUID.
 * @param objectTypeApiName  - The API name of the object type.
 * @param deps               - Optional injected dependencies for testing.
 * @returns { objectsIndexed, editsApplied, deletions, durationMs }
 */
export async function reindexObjectType(
  ontologyId: string,
  objectTypeApiName: string,
  deps?: Partial<IndexerDeps>
): Promise<ReindexResult> {
  const startTime = Date.now();
  const qfn = deps?.queryFn ?? query;

  // =========================================================================
  // Step 1: Load object type definition and backing datasource config
  // =========================================================================

  const otResult = await qfn(
    `SELECT object_type_id, api_name, primary_key_property_id
     FROM object_type
     WHERE ontology_id = $1 AND api_name = $2`,
    [ontologyId, objectTypeApiName]
  );
  if (otResult.rows.length === 0) {
    throw new Error(
      `Object type '${objectTypeApiName}' not found in ontology '${ontologyId}'.`
    );
  }
  const objectType = otResult.rows[0];

  const dsResult = await qfn(
    `SELECT file_path, column_mapping, primary_key_column
     FROM backing_datasource
     WHERE object_type_id = $1`,
    [objectType.object_type_id]
  );
  if (dsResult.rows.length === 0) {
    throw new Error(
      `No backing datasource registered for object type '${objectTypeApiName}'.`
    );
  }
  const datasource = dsResult.rows[0];

  const propsResult = await qfn(
    `SELECT property_id, api_name FROM property WHERE object_type_id = $1`,
    [objectType.object_type_id]
  );
  const propertyDefs = propsResult.rows as Array<{
    property_id: string;
    api_name: string;
  }>;
  const primaryKeyPropName = propertyDefs.find(
    (p) => p.property_id === objectType.primary_key_property_id
  )?.api_name;

  const columnMapping: Record<string, string> =
    typeof datasource.column_mapping === "string"
      ? JSON.parse(datasource.column_mapping)
      : datasource.column_mapping;

  // =========================================================================
  // Step 2: Read all rows from backing datasource (CSV file)
  // =========================================================================

  let rows: Array<Record<string, string>>;

  if (deps?.readDatasetFile) {
    rows = await deps.readDatasetFile(datasource.file_path);
  } else {
    const csvResult = await readCSV(datasource.file_path);
    if (!csvResult.success) {
      throw new Error(
        `Failed to read datasource file '${datasource.file_path}': ${csvResult.error.message}`
      );
    }
    rows = csvResult.rows;
  }

  // =========================================================================
  // Step 3: Build a map of PK → row from datasource
  // =========================================================================

  const datasourceMap = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const pk = String(row[datasource.primary_key_column]);

    if (datasourceMap.has(pk)) {
      // Palantir: "most recent transaction wins" — but within a single
      // file, duplicates are an error in OSv2
      throw new Error(
        `Duplicate primary key '${pk}' in backing datasource for ${objectTypeApiName}`
      );
    }

    // Map CSV columns to property api_names
    // Defensiveness: Ensure mapped column exists in the row to prevent 
    // silent null values from schema drift or misconfiguration
    const mapped: Record<string, unknown> = {};
    for (const [propName, colName] of Object.entries(columnMapping)) {
      if (!(colName in row)) {
        console.error(
          `[indexer] WARNING: Column '${colName}' mapped to property '${propName}' does not exist ` +
          `in datasource row for PK '${pk}'. Property will be null. ` +
          `This indicates schema drift - run datasource validation immediately.`
        );
      }
      mapped[propName] = row[colName] ?? null;
    }

    datasourceMap.set(pk, mapped);
  }

  // =========================================================================
  // Step 4: Get ALL user edits for this object type (ordered by executed_at)
  //
  // We fetch ALL edits (not just pending) because persistent edits must
  // still override datasource values on re-index.
  // =========================================================================

  const fetchAllEdits = deps?.getAllEdits ?? getAllEditsByObjectType;
  const allEdits = await fetchAllEdits(objectTypeApiName);

  // =========================================================================
  // Step 5: Build a map of PK → latest edit state
  //
  // For each PK that has edits, compute the cumulative effect by walking
  // all edits chronologically (they arrive ordered by executed_at ASC).
  //
  // State machine per PK:
  //   - delete: overrides everything — marks object as deleted, clears props
  //   - create: resets object state (handles re-creation after delete)
  //   - update: merges properties on top (only if not currently deleted)
  // =========================================================================

  const editMap = new Map<string, EditState>();

  for (const edit of allEdits) {
    if (!editMap.has(edit.primary_key)) {
      editMap.set(edit.primary_key, {
        operation: edit.operation,
        properties: {},
      });
    }

    const entry = editMap.get(edit.primary_key)!;

    if (edit.operation === "delete") {
      // Delete overrides everything
      entry.operation = "delete";
      entry.properties = {};
    } else if (edit.operation === "create") {
      // Create resets the object state. If preceded by a delete, this is
      // a re-creation. If an object is created, then deleted, then
      // re-created (same PK), the final state should reflect the
      // re-creation.
      entry.operation = "create";
      entry.properties = { ...(edit.property_values ?? {}) };
    } else if (edit.operation === "update") {
      if (entry.operation !== "delete") {
        // Don't apply updates after a delete
        entry.properties = {
          ...entry.properties,
          ...(edit.property_values ?? {}),
        };
      }
    }
  }

  // =========================================================================
  // Step 6: Merge datasource + edits → final objects to index
  // =========================================================================

  const bulkOps: Array<Record<string, unknown>> = [];
  let objectsIndexed = 0;
  let editsApplied = 0;
  let deletions = 0;
  const indexName = getIndexName(objectTypeApiName);

  // 6a: Process datasource rows (potentially overridden by edits)
  for (const [pk, dsProps] of datasourceMap) {
    if (editMap.has(pk)) {
      const edit = editMap.get(pk)!;

      if (edit.operation === "delete") {
        // Object was deleted via action — do NOT index it even though
        // datasource has it
        bulkOps.push({ delete: { _index: indexName, _id: pk } });
        deletions++;
        continue;
      }

      // Merge: datasource props as base, edit props override
      const merged = { ...dsProps, ...edit.properties };
      bulkOps.push({ index: { _index: indexName, _id: pk } });
      bulkOps.push({
        __pk: pk,
        // Phase 2 (object identity): prefer the rid persisted by the
        // write path; deterministic fallback keeps reindexes stable.
        __rid:
          (merged.__rid as string | undefined) ??
          deterministicObjectRid(ontologyId, objectTypeApiName, pk),
        __objectType: objectTypeApiName,
        __lastModified: new Date().toISOString(),
        ...merged,
      });
      editsApplied++;
    } else {
      // No edits — pure datasource data
      bulkOps.push({ index: { _index: indexName, _id: pk } });
      bulkOps.push({
        __pk: pk,
        __rid:
          (dsProps.__rid as string | undefined) ??
          deterministicObjectRid(ontologyId, objectTypeApiName, pk),
        __objectType: objectTypeApiName,
        __lastModified: new Date().toISOString(),
        ...dsProps,
      });
    }
    objectsIndexed++;
  }

  // 6b: Process edit-only objects (created via actions, not in datasource)
  for (const [pk, edit] of editMap) {
    if (!datasourceMap.has(pk) && edit.operation !== "delete") {
      // Object was created via action and doesn't exist in datasource
      bulkOps.push({ index: { _index: indexName, _id: pk } });
      bulkOps.push({
        __pk: pk,
        __rid:
          (edit.properties.__rid as string | undefined) ??
          deterministicObjectRid(ontologyId, objectTypeApiName, pk),
        __objectType: objectTypeApiName,
        __lastModified: new Date().toISOString(),
        ...edit.properties,
      });
      objectsIndexed++;
      editsApplied++;
    }
  }

  // =========================================================================
  // Step 7: Delete stale objects (in OpenSearch but not in datasource or edits)
  //
  // DEFERRED to a future iteration. For week 1, stale object cleanup is
  // out of scope.
  // TODO: Implement stale object cleanup — get all current PKs in the index,
  // then delete any that aren't in datasourceMap or editMap.
  // (This handles the case where rows are removed from the datasource)
  // =========================================================================

  // =========================================================================
  // Step 8: Execute bulk write to OpenSearch
  // =========================================================================

  if (bulkOps.length > 0) {
    // Phase A4 (F-03) — stamp `_security.markings` on every doc line of the
    // bulk body. OpenSearch bulk bodies alternate action/document pairs;
    // `delete` actions have no accompanying doc line. A doc line is
    // identified as "an entry where the previous entry has a top-level
    // `index` or `create` action key".
    const stamped: Array<Record<string, unknown>> = [];
    for (let i = 0; i < bulkOps.length; i++) {
      const entry = bulkOps[i] as Record<string, unknown>;
      const prev = i > 0 ? (bulkOps[i - 1] as Record<string, unknown>) : null;
      const isDocLine =
        prev && (("index" in prev) || ("create" in prev));
      stamped.push(isDocLine ? ensureDocumentSecurity(entry) : entry);
    }
    if (deps?.bulkWrite) {
      await deps.bulkWrite(stamped);
    } else {
      await client.bulk({ body: stamped as Array<Record<string, any>>, refresh: "wait_for" });
    }
  }

  // =========================================================================
  // Step 9: Mark all pending edits as indexed
  // =========================================================================

  const fetchPending = deps?.getPendingEdits ?? getPendingEdits;
  const markIndexed = deps?.markEditsAsIndexed ?? markEditsAsIndexed;

  const pendingEdits = await fetchPending(objectTypeApiName);
  if (pendingEdits.length > 0) {
    await markIndexed(pendingEdits.map((e) => e.edit_id));
  }

  return {
    objectsIndexed,
    editsApplied,
    deletions,
    durationMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { reindexObjectType };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/indexer.ts)
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

  console.log("Running indexer (reindexObjectType) self-tests...\n");

  // =======================================================================
  // Mock infrastructure
  // =======================================================================

  const ONTOLOGY_ID = "ont-test-001";

  interface MockState {
    objectType: Record<string, unknown>;
    properties: Array<{ property_id: string; api_name: string }>;
    datasource: Record<string, unknown>;
    csvRows: Array<Record<string, string>>;
    editRows: OntologyEditRow[];
    pendingEdits: OntologyEditRow[];
    bulkOps: Array<Array<Record<string, unknown>>>;
    markedEditIds: string[][];
  }

  function createDefaultMockState(): MockState {
    return {
      objectType: {
        object_type_id: "ot-uuid-1",
        api_name: "Employee",
        primary_key_property_id: "pk-uuid-1",
      },
      properties: [
        { property_id: "pk-uuid-1", api_name: "employeeId" },
        { property_id: "uuid-2", api_name: "fullName" },
        { property_id: "uuid-3", api_name: "salary" },
        { property_id: "uuid-4", api_name: "isActive" },
      ],
      datasource: {
        file_path: "/data/employees.csv",
        column_mapping: {
          employeeId: "emp_id",
          fullName: "full_name",
          salary: "salary",
          isActive: "is_active",
        },
        primary_key_column: "emp_id",
      },
      csvRows: [
        { emp_id: "EMP-001", full_name: "Alice", salary: "100000", is_active: "true" },
        { emp_id: "EMP-002", full_name: "Bob", salary: "90000", is_active: "false" },
        { emp_id: "EMP-003", full_name: "Charlie", salary: "110000", is_active: "true" },
        { emp_id: "EMP-004", full_name: "Diana", salary: "95000", is_active: "true" },
        { emp_id: "EMP-005", full_name: "Eve", salary: "120000", is_active: "false" },
      ],
      editRows: [],
      pendingEdits: [],
      bulkOps: [],
      markedEditIds: [],
    };
  }

  function makeEdit(
    editId: string,
    pk: string,
    operation: "create" | "update" | "delete",
    propertyValues: Record<string, unknown> | null,
    executedBy: string,
    executedAt: string,
    indexed: boolean = false
  ): OntologyEditRow {
    return {
      edit_id: editId,
      ontology_id: null,
      object_type_api_name: "Employee",
      primary_key: pk,
      operation,
      property_values: propertyValues,
      link_edits: [],
      action_type_api_name: null,
      execution_id: null,
      action_parameters: {},
      executed_by: executedBy,
      executed_at: executedAt,
      indexed,
      indexed_at: indexed ? executedAt : null,
      applied_to_merged_at: null,
      applied_to_index_at: indexed ? executedAt : null,
      edit_strategy: "user_edit_wins",
      branch_id: null,
    };
  }

  function createMockDeps(state: MockState): IndexerDeps {
    return {
      queryFn: async (text: string, values?: unknown[]): Promise<QueryResult> => {
        if (text.includes("FROM object_type")) {
          const apiName = values?.[1];
          if (apiName === state.objectType.api_name) {
            return { rows: [state.objectType], rowCount: 1 } as unknown as QueryResult;
          }
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        if (text.includes("FROM backing_datasource")) {
          return { rows: [state.datasource], rowCount: 1 } as unknown as QueryResult;
        }
        if (text.includes("FROM property")) {
          return { rows: state.properties, rowCount: state.properties.length } as unknown as QueryResult;
        }
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      },

      readDatasetFile: async (): Promise<Array<Record<string, string>>> => {
        return state.csvRows;
      },

      getAllEdits: async (): Promise<OntologyEditRow[]> => {
        return state.editRows;
      },

      getPendingEdits: async (): Promise<OntologyEditRow[]> => {
        return state.pendingEdits;
      },

      markEditsAsIndexed: async (editIds: string[]): Promise<number> => {
        state.markedEditIds.push(editIds);
        return editIds.length;
      },

      bulkWrite: async (body: Array<Record<string, unknown>>): Promise<void> => {
        state.bulkOps.push(body);
      },
    };
  }

  // =======================================================================
  // Test 1: Pure datasource — no edits
  // =======================================================================
  {
    const state = createDefaultMockState();
    const deps = createMockDeps(state);

    const result = await reindexObjectType(ONTOLOGY_ID, "Employee", deps);

    assert(result.objectsIndexed === 5, `no edits: 5 objects indexed (got ${result.objectsIndexed})`);
    assert(result.editsApplied === 0, "no edits: 0 edits applied");
    assert(result.deletions === 0, "no edits: 0 deletions");
    assert(typeof result.durationMs === "number", "no edits: durationMs is number");

    // Verify bulk ops: 5 index pairs (action + body)
    assert(state.bulkOps.length === 1, "no edits: one bulk write call");
    assert(state.bulkOps[0].length === 10, `no edits: 10 bulk ops (got ${state.bulkOps[0].length})`);
  }

  // =======================================================================
  // Test 2: Update edits — user values override datasource values
  //
  // This is the CRITICAL test from the spec: after reindexing, EMP-001
  // should have salary=150000 (from edit), not 100000 (from CSV).
  // =======================================================================
  {
    const state = createDefaultMockState();
    state.editRows = [
      makeEdit("ed-1", "EMP-001", "update", { salary: 150000 }, "auditor1", "2025-06-15T10:00:00.000Z"),
    ];
    state.pendingEdits = [
      makeEdit("ed-1", "EMP-001", "update", { salary: 150000 }, "auditor1", "2025-06-15T10:00:00.000Z"),
    ];

    const deps = createMockDeps(state);
    const result = await reindexObjectType(ONTOLOGY_ID, "Employee", deps);

    assert(result.objectsIndexed === 5, "update: 5 objects indexed");
    assert(result.editsApplied === 1, "update: 1 edit applied");
    assert(result.deletions === 0, "update: 0 deletions");

    // Find EMP-001's indexed document in bulk ops
    const ops = state.bulkOps[0];
    let emp001Doc: Record<string, unknown> | null = null;
    for (let i = 0; i < ops.length; i += 2) {
      const action = ops[i] as Record<string, unknown>;
      if ("index" in action) {
        const doc = ops[i + 1] as Record<string, unknown>;
        if (doc.__pk === "EMP-001") {
          emp001Doc = doc;
          break;
        }
      }
    }
    assert(emp001Doc !== null, "update: EMP-001 found in bulk ops");
    assert(emp001Doc?.salary === 150000, `update: EMP-001 salary=150000 (got ${emp001Doc?.salary})`);
    assert(emp001Doc?.fullName === "Alice", "update: EMP-001 fullName preserved from datasource");

    // Verify pending edits were marked as indexed
    assert(state.markedEditIds.length === 1, "update: markEditsAsIndexed called");
    assert(state.markedEditIds[0].includes("ed-1"), "update: ed-1 marked as indexed");
  }

  // =======================================================================
  // Test 3: Delete edit — removes object from index
  // =======================================================================
  {
    const state = createDefaultMockState();
    state.editRows = [
      makeEdit("ed-del-1", "EMP-003", "delete", null, "admin", "2025-06-15T11:00:00.000Z"),
    ];
    state.pendingEdits = [
      makeEdit("ed-del-1", "EMP-003", "delete", null, "admin", "2025-06-15T11:00:00.000Z"),
    ];

    const deps = createMockDeps(state);
    const result = await reindexObjectType(ONTOLOGY_ID, "Employee", deps);

    assert(result.objectsIndexed === 4, `delete: 4 objects indexed (got ${result.objectsIndexed})`);
    assert(result.deletions === 1, "delete: 1 deletion");

    // Verify EMP-003 has a delete action in bulk ops
    const ops = state.bulkOps[0];
    let foundDelete = false;
    for (const op of ops) {
      const action = op as Record<string, unknown>;
      if ("delete" in action) {
        const deleteAction = action.delete as Record<string, unknown>;
        if (deleteAction._id === "EMP-003") {
          foundDelete = true;
        }
      }
    }
    assert(foundDelete, "delete: EMP-003 delete action in bulk ops");

    // Verify EMP-003 is NOT indexed
    let foundIndex = false;
    for (let i = 0; i < ops.length; i++) {
      const action = ops[i] as Record<string, unknown>;
      if ("index" in action) {
        const doc = ops[i + 1] as Record<string, unknown>;
        if (doc.__pk === "EMP-003") {
          foundIndex = true;
        }
      }
    }
    assert(!foundIndex, "delete: EMP-003 NOT indexed");
  }

  // =======================================================================
  // Test 4: Create edit — object created via action, not in datasource
  // =======================================================================
  {
    const state = createDefaultMockState();
    state.editRows = [
      makeEdit(
        "ed-c1",
        "EMP-NEW",
        "create",
        { employeeId: "EMP-NEW", fullName: "New Employee", salary: 80000, isActive: true },
        "operator1",
        "2025-06-15T12:00:00.000Z"
      ),
    ];
    state.pendingEdits = [
      makeEdit(
        "ed-c1",
        "EMP-NEW",
        "create",
        { employeeId: "EMP-NEW", fullName: "New Employee", salary: 80000, isActive: true },
        "operator1",
        "2025-06-15T12:00:00.000Z"
      ),
    ];

    const deps = createMockDeps(state);
    const result = await reindexObjectType(ONTOLOGY_ID, "Employee", deps);

    // 5 datasource + 1 action-created = 6 indexed
    assert(result.objectsIndexed === 6, `create: 6 objects indexed (got ${result.objectsIndexed})`);
    assert(result.editsApplied === 1, "create: 1 edit applied");

    // Find EMP-NEW in bulk ops
    const ops = state.bulkOps[0];
    let newDoc: Record<string, unknown> | null = null;
    for (let i = 0; i < ops.length; i += 2) {
      const action = ops[i] as Record<string, unknown>;
      if ("index" in action) {
        const doc = ops[i + 1] as Record<string, unknown>;
        if (doc.__pk === "EMP-NEW") {
          newDoc = doc;
          break;
        }
      }
    }
    assert(newDoc !== null, "create: EMP-NEW found in bulk ops");
    assert(newDoc?.fullName === "New Employee", "create: fullName from edit");
    assert(newDoc?.salary === 80000, "create: salary from edit");
  }

  // =======================================================================
  // Test 5: Combined — update, delete, and create together
  // =======================================================================
  {
    const state = createDefaultMockState();
    state.editRows = [
      makeEdit("ed-u1", "EMP-001", "update", { salary: 150000 }, "auditor1", "2025-06-15T10:00:00.000Z"),
      makeEdit("ed-d1", "EMP-003", "delete", null, "admin", "2025-06-15T11:00:00.000Z"),
      makeEdit("ed-c1", "EMP-NEW", "create", { employeeId: "EMP-NEW", fullName: "Created", salary: 75000 }, "operator1", "2025-06-15T12:00:00.000Z"),
    ];
    state.pendingEdits = [...state.editRows];

    const deps = createMockDeps(state);
    const result = await reindexObjectType(ONTOLOGY_ID, "Employee", deps);

    // 5 datasource - 1 delete + 1 create = 5 indexed
    assert(result.objectsIndexed === 5, `combined: 5 indexed (got ${result.objectsIndexed})`);
    assert(result.editsApplied === 2, `combined: 2 edits applied (got ${result.editsApplied})`);
    assert(result.deletions === 1, `combined: 1 deletion (got ${result.deletions})`);
  }

  // =======================================================================
  // Test 6: Cumulative edits — update → update merges properties
  // =======================================================================
  {
    const state = createDefaultMockState();
    state.editRows = [
      makeEdit("ed-u1", "EMP-002", "update", { salary: 95000 }, "mgr", "2025-06-14T10:00:00.000Z"),
      makeEdit("ed-u2", "EMP-002", "update", { fullName: "Bob Updated" }, "mgr", "2025-06-15T10:00:00.000Z"),
    ];

    const deps = createMockDeps(state);
    const result = await reindexObjectType(ONTOLOGY_ID, "Employee", deps);

    // Find EMP-002's document
    const ops = state.bulkOps[0];
    let emp002Doc: Record<string, unknown> | null = null;
    for (let i = 0; i < ops.length; i += 2) {
      const action = ops[i] as Record<string, unknown>;
      if ("index" in action) {
        const doc = ops[i + 1] as Record<string, unknown>;
        if (doc.__pk === "EMP-002") {
          emp002Doc = doc;
          break;
        }
      }
    }

    assert(emp002Doc !== null, "cumulative: EMP-002 found");
    // Both edits should be merged: salary from first, fullName from second
    assert(emp002Doc?.salary === 95000, `cumulative: salary=95000 (got ${emp002Doc?.salary})`);
    assert(emp002Doc?.fullName === "Bob Updated", `cumulative: fullName updated (got ${emp002Doc?.fullName})`);
    assert(result.editsApplied === 1, "cumulative: 1 PK had edits applied");
  }

  // =======================================================================
  // Test 7: Delete after update — delete wins
  // =======================================================================
  {
    const state = createDefaultMockState();
    state.editRows = [
      makeEdit("ed-u1", "EMP-004", "update", { salary: 200000 }, "mgr", "2025-06-14T10:00:00.000Z"),
      makeEdit("ed-d1", "EMP-004", "delete", null, "admin", "2025-06-15T10:00:00.000Z"),
    ];

    const deps = createMockDeps(state);
    const result = await reindexObjectType(ONTOLOGY_ID, "Employee", deps);

    assert(result.objectsIndexed === 4, "del-after-upd: 4 indexed");
    assert(result.deletions === 1, "del-after-upd: 1 deletion");
  }

  // =======================================================================
  // Test 8: Create → delete → re-create — re-creation state
  // =======================================================================
  {
    const state = createDefaultMockState();
    state.editRows = [
      makeEdit("ed-c1", "EMP-REBORN", "create", { employeeId: "EMP-REBORN", fullName: "First", salary: 50000 }, "op", "2025-06-13T10:00:00.000Z"),
      makeEdit("ed-d1", "EMP-REBORN", "delete", null, "admin", "2025-06-14T10:00:00.000Z"),
      makeEdit("ed-c2", "EMP-REBORN", "create", { employeeId: "EMP-REBORN", fullName: "Reborn", salary: 60000 }, "op", "2025-06-15T10:00:00.000Z"),
    ];

    const deps = createMockDeps(state);
    const result = await reindexObjectType(ONTOLOGY_ID, "Employee", deps);

    // EMP-REBORN should exist with the re-creation values
    assert(result.objectsIndexed === 6, `re-create: 6 indexed (got ${result.objectsIndexed})`);

    const ops = state.bulkOps[0];
    let rebornDoc: Record<string, unknown> | null = null;
    for (let i = 0; i < ops.length; i += 2) {
      const action = ops[i] as Record<string, unknown>;
      if ("index" in action) {
        const doc = ops[i + 1] as Record<string, unknown>;
        if (doc.__pk === "EMP-REBORN") {
          rebornDoc = doc;
          break;
        }
      }
    }
    assert(rebornDoc !== null, "re-create: EMP-REBORN found");
    assert(rebornDoc?.fullName === "Reborn", `re-create: fullName is 'Reborn' (got ${rebornDoc?.fullName})`);
    assert(rebornDoc?.salary === 60000, `re-create: salary is 60000 (got ${rebornDoc?.salary})`);
  }

  // =======================================================================
  // Test 9: Update after delete — update ignored
  // =======================================================================
  {
    const state = createDefaultMockState();
    state.editRows = [
      makeEdit("ed-d1", "EMP-001", "delete", null, "admin", "2025-06-14T10:00:00.000Z"),
      makeEdit("ed-u1", "EMP-001", "update", { salary: 999999 }, "auditor", "2025-06-15T10:00:00.000Z"),
    ];

    const deps = createMockDeps(state);
    const result = await reindexObjectType(ONTOLOGY_ID, "Employee", deps);

    // EMP-001 was deleted, then updated. Since delete clears state and
    // the spec says "don't apply updates after a delete", it should still
    // be deleted.
    assert(result.deletions === 1, "upd-after-del: 1 deletion");
    assert(result.objectsIndexed === 4, "upd-after-del: 4 indexed");
  }

  // =======================================================================
  // Test 10: Duplicate primary key in datasource — throws
  // =======================================================================
  {
    const state = createDefaultMockState();
    state.csvRows.push({
      emp_id: "EMP-001",
      full_name: "Duplicate Alice",
      salary: "50000",
      is_active: "true",
    });

    const deps = createMockDeps(state);
    let threw = false;
    try {
      await reindexObjectType(ONTOLOGY_ID, "Employee", deps);
    } catch (err: unknown) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      assert(
        msg.includes("Duplicate primary key 'EMP-001'"),
        `dup PK: error message (got: ${msg.substring(0, 80)})`
      );
    }
    assert(threw, "dup PK: threw error");
  }

  // =======================================================================
  // Test 11: Object type not found — throws
  // =======================================================================
  {
    const state = createDefaultMockState();
    const deps = createMockDeps(state);
    let threw = false;
    try {
      await reindexObjectType(ONTOLOGY_ID, "NonExistent", deps);
    } catch (err: unknown) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes("not found"), `not found: error message (got: ${msg})`);
    }
    assert(threw, "not found: threw error");
  }

  // =======================================================================
  // Test 12: No datasource registered — throws
  // =======================================================================
  {
    const state = createDefaultMockState();
    const baseDeps = createMockDeps(state);
    const deps: IndexerDeps = {
      ...baseDeps,
      queryFn: async (text: string, values?: unknown[]): Promise<QueryResult> => {
        if (text.includes("FROM backing_datasource")) {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        return baseDeps.queryFn(text, values);
      },
    };

    let threw = false;
    try {
      await reindexObjectType(ONTOLOGY_ID, "Employee", deps);
    } catch (err: unknown) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes("No backing datasource"), `no ds: error message (got: ${msg})`);
    }
    assert(threw, "no ds: threw error");
  }

  // =======================================================================
  // Test 13: Empty datasource — 0 rows, only action-created objects
  // =======================================================================
  {
    const state = createDefaultMockState();
    state.csvRows = [];
    state.editRows = [
      makeEdit("ed-c1", "EMP-ACT-1", "create", { employeeId: "EMP-ACT-1", fullName: "Action Only" }, "op", "2025-06-15T10:00:00.000Z"),
    ];

    const deps = createMockDeps(state);
    const result = await reindexObjectType(ONTOLOGY_ID, "Employee", deps);

    assert(result.objectsIndexed === 1, "empty ds + create: 1 indexed");
    assert(result.editsApplied === 1, "empty ds + create: 1 edit applied");
  }

  // =======================================================================
  // Test 14: No pending edits — markEditsAsIndexed not called
  // =======================================================================
  {
    const state = createDefaultMockState();
    // Edit exists but is already indexed (only in allEdits, not pending)
    state.editRows = [
      makeEdit("ed-1", "EMP-001", "update", { salary: 150000 }, "auditor1", "2025-06-15T10:00:00.000Z", true),
    ];
    state.pendingEdits = []; // No pending

    const deps = createMockDeps(state);
    const result = await reindexObjectType(ONTOLOGY_ID, "Employee", deps);

    assert(result.editsApplied === 1, "already indexed: 1 edit applied (persistent)");
    assert(state.markedEditIds.length === 0, "already indexed: markEditsAsIndexed NOT called");
  }

  // =======================================================================
  // Test 15: Persistent edit overrides re-uploaded datasource
  //
  // Scenario: Auditor changed EMP-001 salary to 150000 yesterday (indexed).
  // Today the datasource CSV is refreshed with the original 100000.
  // After reindex, EMP-001 should still have salary=150000.
  // =======================================================================
  {
    const state = createDefaultMockState();
    // Persistent (already indexed) edit
    state.editRows = [
      makeEdit("ed-persistent", "EMP-001", "update", { salary: 150000 }, "auditor1", "2025-06-15T10:00:00.000Z", true),
    ];
    state.pendingEdits = [];

    const deps = createMockDeps(state);
    const result = await reindexObjectType(ONTOLOGY_ID, "Employee", deps);

    // Find EMP-001 in bulk ops
    const ops = state.bulkOps[0];
    let emp001Doc: Record<string, unknown> | null = null;
    for (let i = 0; i < ops.length; i += 2) {
      const action = ops[i] as Record<string, unknown>;
      if ("index" in action) {
        const doc = ops[i + 1] as Record<string, unknown>;
        if (doc.__pk === "EMP-001") {
          emp001Doc = doc;
          break;
        }
      }
    }

    assert(emp001Doc !== null, "persistent: EMP-001 found");
    assert(
      emp001Doc?.salary === 150000,
      `persistent: salary=150000 (edit wins over CSV 100000) (got ${emp001Doc?.salary})`
    );
    assert(result.editsApplied === 1, "persistent: 1 edit applied");
  }

  // =======================================================================
  // Test 16: Large batch — 1000 rows + 50 edits
  // =======================================================================
  {
    const state = createDefaultMockState();
    state.csvRows = [];
    for (let i = 0; i < 1000; i++) {
      state.csvRows.push({
        emp_id: `EMP-${String(i + 1).padStart(4, "0")}`,
        full_name: `Employee ${i + 1}`,
        salary: String((i + 1) * 1000),
        is_active: i % 3 === 0 ? "false" : "true",
      });
    }

    // 20 updates, 10 deletes, 20 creates
    state.editRows = [];
    for (let i = 0; i < 20; i++) {
      state.editRows.push(
        makeEdit(`ed-u-${i}`, `EMP-${String(i * 50 + 1).padStart(4, "0")}`, "update", { salary: 999999 }, "auditor", `2025-06-15T10:${String(i).padStart(2, "0")}:00.000Z`)
      );
    }
    for (let i = 0; i < 10; i++) {
      state.editRows.push(
        makeEdit(`ed-d-${i}`, `EMP-${String(i * 100 + 50).padStart(4, "0")}`, "delete", null, "admin", `2025-06-15T11:${String(i).padStart(2, "0")}:00.000Z`)
      );
    }
    for (let i = 0; i < 20; i++) {
      state.editRows.push(
        makeEdit(`ed-c-${i}`, `EMP-NEW-${i}`, "create", { employeeId: `EMP-NEW-${i}`, fullName: `New ${i}` }, "operator", `2025-06-15T12:${String(i).padStart(2, "0")}:00.000Z`)
      );
    }

    const deps = createMockDeps(state);
    const start = Date.now();
    const result = await reindexObjectType(ONTOLOGY_ID, "Employee", deps);
    const elapsed = Date.now() - start;

    assert(result.deletions === 10, `perf: 10 deletions (got ${result.deletions})`);
    assert(result.objectsIndexed === 1000 - 10 + 20, `perf: ${1000 - 10 + 20} indexed (got ${result.objectsIndexed})`);
    assert(elapsed < 2000, `perf: completed in ${elapsed}ms (< 2000ms)`);
    console.log(`  (1000 rows + 50 edits merged in ${elapsed}ms)`);
  }

  // =======================================================================
  // Test 17: Create edit for existing datasource PK — edit wins
  // =======================================================================
  {
    const state = createDefaultMockState();
    // Create edit for EMP-001 which also exists in datasource
    state.editRows = [
      makeEdit("ed-c-existing", "EMP-001", "create", { employeeId: "EMP-001", fullName: "Created Override", salary: 200000 }, "op", "2025-06-15T10:00:00.000Z"),
    ];

    const deps = createMockDeps(state);
    const result = await reindexObjectType(ONTOLOGY_ID, "Employee", deps);

    // EMP-001 exists in datasource but create edit overrides
    const ops = state.bulkOps[0];
    let emp001Doc: Record<string, unknown> | null = null;
    for (let i = 0; i < ops.length; i += 2) {
      const action = ops[i] as Record<string, unknown>;
      if ("index" in action) {
        const doc = ops[i + 1] as Record<string, unknown>;
        if (doc.__pk === "EMP-001") {
          emp001Doc = doc;
          break;
        }
      }
    }

    assert(emp001Doc !== null, "create-existing: EMP-001 found");
    // Datasource has salary="100000", create edit has salary=200000 — edit wins
    assert(emp001Doc?.salary === 200000, `create-existing: salary=200000 (got ${emp001Doc?.salary})`);
    assert(emp001Doc?.fullName === "Created Override", "create-existing: fullName from edit");
    assert(result.editsApplied === 1, "create-existing: 1 edit applied");
    assert(result.objectsIndexed === 5, "create-existing: 5 indexed (no extra)");
  }

  // =======================================================================
  // Summary
  // =======================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll indexer (reindexObjectType) tests passed");
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
