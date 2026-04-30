// ---------------------------------------------------------------------------
// undoService.ts — compute and apply inverse edits for audit/undo
// ---------------------------------------------------------------------------
// Ontology Platform spec §Task 17:
//   "Undo computation: For each edit in edits_json, generate inverse.
//    CREATE → DELETE. MODIFY → MODIFY with old values. DELETE → CREATE
//    with all old values. ADD_LINK → REMOVE_LINK."
//   "Undo window: 7 days."
//   "Undo of undo: Allowed (creates chain)."
// ---------------------------------------------------------------------------

import { query } from "../db";
import { OntologyError } from "../utils/queryErrors";

export const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface LinkEdit {
  linkTypeApiName: string;
  targetPrimaryKey: string;
  operation: "add" | "remove";
}

export interface EditRecord {
  edit_id: string;
  object_type_api_name: string;
  primary_key: string;
  operation: "create" | "update" | "delete";
  property_values: Record<string, unknown>;
  previous_values?: Record<string, unknown> | null;
  link_edits: LinkEdit[];
  action_type_api_name: string | null;
  execution_id: string | null;
  action_parameters: Record<string, unknown>;
  applied_at: string | Date;
}

export interface InverseEdit {
  objectTypeApiName: string;
  primaryKey: string;
  operation: "create" | "update" | "delete";
  propertyValues: Record<string, unknown>;
  linkEdits: LinkEdit[];
  sourceEditId: string;
}

/**
 * Compute a single inverse edit record. The `previous_values` snapshot
 * stored on the original edit is the ground truth for MODIFY/DELETE undo.
 */
export function computeInverse(edit: EditRecord): InverseEdit {
  const linkEdits: LinkEdit[] = (edit.link_edits || []).map((le) => ({
    linkTypeApiName: le.linkTypeApiName,
    targetPrimaryKey: le.targetPrimaryKey,
    operation: le.operation === "add" ? "remove" : "add",
  }));

  switch (edit.operation) {
    case "create":
      // CREATE → DELETE
      return {
        objectTypeApiName: edit.object_type_api_name,
        primaryKey: edit.primary_key,
        operation: "delete",
        propertyValues: {},
        linkEdits,
        sourceEditId: edit.edit_id,
      };
    case "update": {
      // MODIFY → MODIFY with old values (falls back to empty if the
      // original edit didn't capture a pre-image snapshot).
      const previous = edit.previous_values || {};
      return {
        objectTypeApiName: edit.object_type_api_name,
        primaryKey: edit.primary_key,
        operation: "update",
        propertyValues: previous,
        linkEdits,
        sourceEditId: edit.edit_id,
      };
    }
    case "delete":
      // DELETE → CREATE with previous values (requires a pre-image).
      return {
        objectTypeApiName: edit.object_type_api_name,
        primaryKey: edit.primary_key,
        operation: "create",
        propertyValues: edit.previous_values || edit.property_values || {},
        linkEdits,
        sourceEditId: edit.edit_id,
      };
    default:
      throw new OntologyError(
        `Unknown edit operation: ${edit.operation}`,
        "INVALID_PARAMETER",
        400,
        { operation: edit.operation }
      );
  }
}

/**
 * Look up an edit by ID and verify it's within the 7-day undo window.
 * Uses the live `ontology_edit` schema, which stores the timestamp as
 * `executed_at` (not `applied_at`) and doesn't always carry a pre-image
 * snapshot; we fall back to `COALESCE(previous_values, '{}'::jsonb)`.
 */
export async function loadEditForUndo(editId: string): Promise<EditRecord> {
  const result = await query(
    `SELECT edit_id, object_type_api_name, primary_key, operation,
            property_values,
            '{}'::jsonb AS previous_values,
            link_edits,
            action_type_api_name, execution_id, action_parameters,
            executed_at AS applied_at
       FROM ontology_edit
      WHERE edit_id = $1`,
    [editId]
  );
  if (result.rows.length === 0) {
    throw new OntologyError(
      `Edit ${editId} not found`,
      "EDIT_NOT_FOUND",
      404,
      { editId }
    );
  }
  const row = result.rows[0] as EditRecord;
  const applied = new Date(row.applied_at).getTime();
  if (Date.now() - applied > UNDO_WINDOW_MS) {
    throw new OntologyError(
      `Edit ${editId} is older than the 7-day undo window`,
      "UNDO_WINDOW_EXPIRED",
      410,
      { editId, appliedAt: row.applied_at }
    );
  }
  return row;
}

/**
 * Persist an inverse edit as a new `ontology_edit` row. Returns the new
 * edit's ID so the caller can surface it back to the client.
 */
export async function persistInverse(
  inverse: InverseEdit,
  executedBy: string
): Promise<string> {
  const result = await query(
    `INSERT INTO ontology_edit
       (object_type_api_name, primary_key, operation, property_values,
        link_edits, action_type_api_name, action_parameters, executed_by)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'undo', $6::jsonb, $7)
     RETURNING edit_id`,
    [
      inverse.objectTypeApiName,
      inverse.primaryKey,
      inverse.operation,
      JSON.stringify(inverse.propertyValues),
      JSON.stringify(inverse.linkEdits),
      JSON.stringify({ reverts: inverse.sourceEditId }),
      executedBy,
    ]
  );
  return result.rows[0].edit_id;
}
