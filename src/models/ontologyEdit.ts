// ---------------------------------------------------------------------------
// Ontology Edit Model
//
// CRUD and query operations for the ontology_edit table — the write-ahead
// log for all Ontology object modifications made through Actions.
//
// Each row represents a single create, update, or delete operation on one
// object. Pending edits (indexed=false) are processed by the indexer and
// merged with datasource data in OpenSearch.
//
// In Palantir's Object Storage V2, user edits take precedence over
// datasource data. When a reindex occurs, the Funnel merges the latest
// datasource data with any pending user edits — and user edits win for any
// property where both the datasource and a user edit provide a value for
// the same primary key.
// ---------------------------------------------------------------------------

import { query, getClient } from "../db";
import { appError } from "../utils/appError";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EditStrategy = "user_edit_wins" | "latest_wins";

export interface OntologyEditRow {
  edit_id: string;
  ontology_id: string | null;
  object_type_api_name: string;
  primary_key: string;
  operation: "create" | "update" | "delete";
  property_values: Record<string, unknown> | null;
  link_edits: unknown[];
  action_type_api_name: string | null;
  execution_id: string | null;
  action_parameters: Record<string, unknown>;
  executed_by: string;
  executed_at: string;
  indexed: boolean;
  indexed_at: string | null;
  applied_to_merged_at: string | null;
  applied_to_index_at: string | null;
  edit_strategy: EditStrategy;
  branch_id: string | null;
}

export interface CreateEditInput {
  ontology_id?: string | null;
  object_type_api_name: string;
  primary_key: string;
  operation: "create" | "update" | "delete";
  property_values?: Record<string, unknown> | null;
  link_edits?: unknown[];
  action_type_api_name?: string | null;
  execution_id?: string | null;
  action_parameters?: Record<string, unknown>;
  executed_by?: string;
  edit_strategy?: EditStrategy;
  branch_id?: string | null;
}

// ---------------------------------------------------------------------------
// 1. createEdit — Insert a single edit record
// ---------------------------------------------------------------------------

/**
 * Insert a new edit record into the ontology_edit table.
 * Returns the full row including the generated edit_id.
 */
async function createEdit(edit: CreateEditInput): Promise<OntologyEditRow> {
  if (!edit.object_type_api_name) {
    throw appError(
      "INVALID_PARAMETER",
      "object_type_api_name is required."
    );
  }
  if (!edit.primary_key) {
    throw appError("INVALID_PARAMETER", "primary_key is required.");
  }
  if (!edit.operation || !["create", "update", "delete"].includes(edit.operation)) {
    throw appError(
      "INVALID_PARAMETER",
      "operation must be one of: create, update, delete."
    );
  }

  const result = await query(
    `INSERT INTO ontology_edit
       (ontology_id, object_type_api_name, primary_key, operation, property_values,
        link_edits, action_type_api_name, execution_id, action_parameters,
        executed_by, edit_strategy, branch_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      edit.ontology_id ?? null,
      edit.object_type_api_name,
      edit.primary_key,
      edit.operation,
      edit.property_values != null
        ? JSON.stringify(edit.property_values)
        : "{}",
      JSON.stringify(edit.link_edits ?? []),
      edit.action_type_api_name ?? null,
      edit.execution_id ?? null,
      JSON.stringify(edit.action_parameters ?? {}),
      edit.executed_by ?? "system",
      edit.edit_strategy ?? "user_edit_wins",
      edit.branch_id ?? null,
    ]
  );

  return result.rows[0] as OntologyEditRow;
}

// ---------------------------------------------------------------------------
// 2. createEdits — Batch insert multiple edits in a single transaction
// ---------------------------------------------------------------------------

/**
 * Batch insert multiple edit records in a single transaction. All edits
 * in the batch share the same execution_id (if provided on individual
 * edits). The entire batch must succeed or fail atomically.
 *
 * Returns all inserted rows.
 */
async function createEdits(edits: CreateEditInput[]): Promise<OntologyEditRow[]> {
  if (edits.length === 0) {
    return [];
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");

    const insertedRows: OntologyEditRow[] = [];

    for (const edit of edits) {
      if (!edit.object_type_api_name) {
        throw appError(
          "INVALID_PARAMETER",
          "object_type_api_name is required for all edits."
        );
      }
      if (!edit.primary_key) {
        throw appError(
          "INVALID_PARAMETER",
          "primary_key is required for all edits."
        );
      }
      if (
        !edit.operation ||
        !["create", "update", "delete"].includes(edit.operation)
      ) {
        throw appError(
          "INVALID_PARAMETER",
          "operation must be one of: create, update, delete."
        );
      }

      const result = await client.query(
        `INSERT INTO ontology_edit
           (ontology_id, object_type_api_name, primary_key, operation, property_values,
            link_edits, action_type_api_name, execution_id, action_parameters,
            executed_by, edit_strategy, branch_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          edit.ontology_id ?? null,
          edit.object_type_api_name,
          edit.primary_key,
          edit.operation,
          edit.property_values != null
            ? JSON.stringify(edit.property_values)
            : "{}",
          JSON.stringify(edit.link_edits ?? []),
          edit.action_type_api_name ?? null,
          edit.execution_id ?? null,
          JSON.stringify(edit.action_parameters ?? {}),
          edit.executed_by ?? "system",
          edit.edit_strategy ?? "user_edit_wins",
          edit.branch_id ?? null,
        ]
      );

      insertedRows.push(result.rows[0] as OntologyEditRow);
    }

    await client.query("COMMIT");
    return insertedRows;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// 3. getPendingEdits — All un-indexed edits for an object type
// ---------------------------------------------------------------------------

/**
 * Returns all edits where indexed = false for the given object type,
 * ordered by executed_at ascending. This is what the indexer calls to
 * find work to do.
 */
async function getPendingEdits(
  objectTypeApiName: string
): Promise<OntologyEditRow[]> {
  const result = await query(
    `SELECT * FROM ontology_edit
     WHERE object_type_api_name = $1 AND indexed = false
     ORDER BY executed_at ASC`,
    [objectTypeApiName]
  );
  return result.rows as OntologyEditRow[];
}

// ---------------------------------------------------------------------------
// 4. markEditsAsIndexed — Mark specified edits as indexed
// ---------------------------------------------------------------------------

/**
 * Sets indexed = true and indexed_at = now() for the specified edit IDs.
 * Called by the indexer after successfully writing to OpenSearch.
 *
 * Returns the number of rows updated.
 */
async function markEditsAsIndexed(editIds: string[]): Promise<number> {
  if (editIds.length === 0) {
    return 0;
  }

  const result = await query(
    `UPDATE ontology_edit
     SET indexed = true, indexed_at = now()
     WHERE edit_id = ANY($1)`,
    [editIds]
  );

  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// 5. getEditHistory — Full edit history for a specific object
// ---------------------------------------------------------------------------

/**
 * Returns the full edit history for a specific object, ordered by
 * executed_at descending (newest first). Used in Object Views to show
 * the audit trail for a single object.
 */
async function getEditHistory(
  objectTypeApiName: string,
  primaryKey: string
): Promise<OntologyEditRow[]> {
  const result = await query(
    `SELECT * FROM ontology_edit
     WHERE object_type_api_name = $1 AND primary_key = $2
     ORDER BY executed_at DESC`,
    [objectTypeApiName, primaryKey]
  );
  return result.rows as OntologyEditRow[];
}

// ---------------------------------------------------------------------------
// 6. getEditsByExecution — All edits from a single action execution
// ---------------------------------------------------------------------------

/**
 * Returns all edits produced by a single action execution, identified
 * by execution_id.
 */
async function getEditsByExecution(
  executionId: string
): Promise<OntologyEditRow[]> {
  const result = await query(
    `SELECT * FROM ontology_edit
     WHERE execution_id = $1
     ORDER BY executed_at ASC`,
    [executionId]
  );
  return result.rows as OntologyEditRow[];
}

// ---------------------------------------------------------------------------
// 7. getLatestEditsForObject — Cumulative property values from edits
// ---------------------------------------------------------------------------

/**
 * Returns the cumulative property values set by edits for this object.
 * Used by the reindex process: when the Funnel reindexes from a backing
 * datasource, it overlays these edit values on top of datasource values
 * to produce the final object state.
 *
 * Implementation: query all edits ordered by executed_at ASC, then merge
 * all property_values with later edits overriding earlier ones (last write
 * wins).
 *
 * Edge cases:
 * - Zero edits: returns null
 * - create + updates: merges all property_values chronologically
 * - create -> update -> delete: returns { __deleted: true }
 * - create -> delete -> create (re-creation): second create resets state,
 *   merged with subsequent updates
 * - Most recent edit is delete: returns { __deleted: true }
 */
async function getLatestEditsForObject(
  objectTypeApiName: string,
  primaryKey: string
): Promise<Record<string, unknown> | null> {
  const result = await query(
    `SELECT * FROM ontology_edit
     WHERE object_type_api_name = $1 AND primary_key = $2
     ORDER BY executed_at ASC`,
    [objectTypeApiName, primaryKey]
  );

  const edits = result.rows as OntologyEditRow[];

  if (edits.length === 0) {
    return null;
  }

  // Walk through edits chronologically and accumulate state.
  // A 'delete' resets accumulated state to __deleted.
  // A 'create' after a delete resets state to the create's properties.
  let accumulated: Record<string, unknown> = {};
  let isDeleted = false;

  for (const edit of edits) {
    if (edit.operation === "delete") {
      // Delete clears all accumulated state
      accumulated = {};
      isDeleted = true;
      continue;
    }

    if (edit.operation === "create") {
      // Create resets state (handles re-creation after delete)
      accumulated = {};
      isDeleted = false;
      if (edit.property_values) {
        for (const [key, value] of Object.entries(edit.property_values)) {
          accumulated[key] = value;
        }
      }
      continue;
    }

    if (edit.operation === "update") {
      // Update merges on top of existing state
      // If we were deleted and now get an update without a preceding create,
      // the update still applies (could be stale edit ordering)
      isDeleted = false;
      if (edit.property_values) {
        for (const [key, value] of Object.entries(edit.property_values)) {
          accumulated[key] = value;
        }
      }
      continue;
    }
  }

  // If the final state is "deleted", return the __deleted marker
  if (isDeleted) {
    return { __deleted: true };
  }

  return accumulated;
}

// ---------------------------------------------------------------------------
// 8. getAllEditsByObjectType — All edits for an object type (for reindex)
// ---------------------------------------------------------------------------

/**
 * Returns ALL edits (not just pending) for the given object type,
 * ordered by executed_at ASC. Used by Task 16's reindex function
 * for bulk edit accumulation across all objects of a type.
 */
async function getAllEditsByObjectType(
  objectTypeApiName: string
): Promise<OntologyEditRow[]> {
  const result = await query(
    `SELECT * FROM ontology_edit
     WHERE object_type_api_name = $1
     ORDER BY executed_at ASC`,
    [objectTypeApiName]
  );
  return result.rows as OntologyEditRow[];
}

// ---------------------------------------------------------------------------
// 9. getPendingMergeEdits / markEditsAppliedToMerge — B1 + B5
// ---------------------------------------------------------------------------

/**
 * Edits the Merge stage should consume on its next run: those that have
 * not yet been reflected in `object_instances`. Ordered by executed_at so
 * that user_edit_wins preserves intent.
 */
async function getPendingMergeEdits(
  objectTypeApiName: string
): Promise<OntologyEditRow[]> {
  const result = await query(
    `SELECT * FROM ontology_edit
      WHERE object_type_api_name = $1 AND applied_to_merged_at IS NULL
      ORDER BY executed_at ASC`,
    [objectTypeApiName]
  );
  return result.rows as OntologyEditRow[];
}

/**
 * Stamp applied_to_merged_at on the supplied edit_ids. Called by the Merge
 * activity only AFTER the merged snapshot commits — if the activity
 * crashes between the snapshot commit and this call, Temporal retries
 * and the next attempt skips already-committed PKs via PG UPSERT.
 */
async function markEditsAppliedToMerge(editIds: string[]): Promise<number> {
  if (editIds.length === 0) return 0;
  const result = await query(
    `UPDATE ontology_edit
        SET applied_to_merged_at = now()
      WHERE edit_id = ANY($1) AND applied_to_merged_at IS NULL`,
    [editIds]
  );
  return result.rowCount ?? 0;
}

/**
 * Edits the Index stage should consume on its next run. Distinct from
 * merge-pending edits because the index reads the *merged* state but
 * still needs to know which specific edits it has covered — this lets
 * us retry indexing without re-running Merge.
 */
async function getPendingIndexEdits(
  objectTypeApiName: string
): Promise<OntologyEditRow[]> {
  const result = await query(
    `SELECT * FROM ontology_edit
      WHERE object_type_api_name = $1 AND applied_to_index_at IS NULL
      ORDER BY executed_at ASC`,
    [objectTypeApiName]
  );
  return result.rows as OntologyEditRow[];
}

async function markEditsAppliedToIndex(editIds: string[]): Promise<number> {
  if (editIds.length === 0) return 0;
  const result = await query(
    `UPDATE ontology_edit
        SET applied_to_index_at = now(),
            indexed              = true,
            indexed_at           = COALESCE(indexed_at, now())
      WHERE edit_id = ANY($1) AND applied_to_index_at IS NULL`,
    [editIds]
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default {
  createEdit,
  createEdits,
  getPendingEdits,
  markEditsAsIndexed,
  getEditHistory,
  getEditsByExecution,
  getLatestEditsForObject,
  getAllEditsByObjectType,
  getPendingMergeEdits,
  markEditsAppliedToMerge,
  getPendingIndexEdits,
  markEditsAppliedToIndex,
};

export {
  createEdit,
  createEdits,
  getPendingEdits,
  markEditsAsIndexed,
  getEditHistory,
  getEditsByExecution,
  getLatestEditsForObject,
  getAllEditsByObjectType,
  getPendingMergeEdits,
  markEditsAppliedToMerge,
  getPendingIndexEdits,
  markEditsAppliedToIndex,
};
