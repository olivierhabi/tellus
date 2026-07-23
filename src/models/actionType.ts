// ---------------------------------------------------------------------------
// Action Type Model
//
// CRUD operations for action types. An action type defines a parameterized,
// auditable set of changes that can be applied to objects, properties, and
// links in the Ontology. Mirrors Palantir Foundry action type schema.
//
// Each action type has:
//   - parameters: what inputs the caller must provide
//   - rules: what edits the action performs (createObject, modifyObject, etc.)
//   - submission_criteria: who can execute it (null = anyone, for week 1)
//   - side_effects: webhooks/notifications after execution (null = none)
// ---------------------------------------------------------------------------

import { query } from "../db";
import { appError } from "../utils/appError";
import { validateActionTypeName } from "../utils/apiNameValidator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActionTypeRow {
  action_type_id: string;
  ontology_id: string;
  api_name: string;
  display_name: string;
  description: string;
  icon_name: string | null;
  icon_color: string | null;
  save_location_rid: string | null;
  parameters: unknown[];
  rules: unknown[];
  submission_criteria: unknown | null;
  side_effects: unknown | null;
  max_affected_objects: number;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export interface CreateActionTypeInput {
  apiName: string;
  displayName: string;
  description?: string;
  iconName?: string | null;
  iconColor?: string | null;
  saveLocationRid?: string | null;
  parameters?: unknown[];
  rules?: unknown[];
  submissionCriteria?: unknown | null;
  sideEffects?: unknown | null;
  maxAffectedObjects?: number;
  isEnabled?: boolean;
  createdBy?: string;
}

export interface UpdateActionTypeInput {
  display_name?: string;
  description?: string;
  icon_name?: string | null;
  icon_color?: string | null;
  save_location_rid?: string | null;
  parameters?: unknown[];
  rules?: unknown[];
  submission_criteria?: unknown | null;
  side_effects?: unknown | null;
  max_affected_objects?: number;
  is_enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Allowed fields for update (whitelist)
// ---------------------------------------------------------------------------

const UPDATABLE_FIELDS: ReadonlySet<string> = new Set([
  "display_name",
  "description",
  "icon_name",
  "icon_color",
  "save_location_rid",
  "parameters",
  "rules",
  "submission_criteria",
  "side_effects",
  "max_affected_objects",
  "is_enabled",
]);

// ---------------------------------------------------------------------------
// CRUD Functions
// ---------------------------------------------------------------------------

/**
 * Create a new action type in the given ontology.
 *
 * Validates that:
 *   1. The ontologyId references an existing ontology
 *   2. The api_name matches camelCase naming conventions
 *
 * Returns the full inserted row including the generated action_type_id.
 */
async function createActionType(
  ontologyId: string,
  actionTypeDef: CreateActionTypeInput
): Promise<ActionTypeRow> {
  // 1. Validate ontology exists
  const ontologyResult = await query(
    "SELECT ontology_id FROM ontology WHERE ontology_id = $1",
    [ontologyId]
  );
  if (ontologyResult.rows.length === 0) {
    throw appError(
      "ONTOLOGY_NOT_FOUND",
      `Ontology '${ontologyId}' not found.`
    );
  }

  // 2. Validate api_name format
  const nameValidation = validateActionTypeName(actionTypeDef.apiName);
  if (!nameValidation.valid) {
    throw appError("INVALID_API_NAME", nameValidation.error!);
  }

  // 3. Insert the action type
  try {
    const result = await query(
      `INSERT INTO action_type
         (ontology_id, api_name, display_name, description,
          icon_name, icon_color, save_location_rid,
          parameters, rules, submission_criteria, side_effects,
          max_affected_objects, is_enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        ontologyId,
        actionTypeDef.apiName,
        actionTypeDef.displayName,
        actionTypeDef.description ?? "",
        actionTypeDef.iconName ?? "manually-entered-data",
        actionTypeDef.iconColor ?? "#1A2230",
        actionTypeDef.saveLocationRid ?? null,
        JSON.stringify(actionTypeDef.parameters ?? []),
        JSON.stringify(actionTypeDef.rules ?? []),
        actionTypeDef.submissionCriteria != null
          ? JSON.stringify(actionTypeDef.submissionCriteria)
          : null,
        actionTypeDef.sideEffects != null
          ? JSON.stringify(actionTypeDef.sideEffects)
          : null,
        actionTypeDef.maxAffectedObjects ?? 10000,
        actionTypeDef.isEnabled ?? true,
        actionTypeDef.createdBy ?? "system",
      ]
    );
    return result.rows[0] as ActionTypeRow;
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") {
      throw appError(
        "ACTION_TYPE_ALREADY_EXISTS",
        `Action type '${actionTypeDef.apiName}' already exists in this ontology.`
      );
    }
    throw err;
  }
}

/**
 * Get a single action type by ontology ID and API name.
 * Returns null if not found.
 */
async function getActionType(
  ontologyId: string,
  apiName: string
): Promise<ActionTypeRow | null> {
  const result = await query(
    "SELECT * FROM action_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, apiName]
  );
  return result.rows.length > 0 ? (result.rows[0] as ActionTypeRow) : null;
}

/**
 * Get a single action type by its RID (action_type_id).
 * Returns null if not found.
 */
async function getActionTypeByRid(
  rid: string
): Promise<ActionTypeRow | null> {
  const result = await query(
    "SELECT * FROM action_type WHERE action_type_id = $1",
    [rid]
  );
  return result.rows.length > 0 ? (result.rows[0] as ActionTypeRow) : null;
}

/**
 * Get multiple action types by their RIDs (action_type_id).
 * Returns array of found action types (may be fewer than requested if some RIDs don't exist).
 */
async function getActionTypesByRidBatch(
  rids: string[]
): Promise<ActionTypeRow[]> {
  if (rids.length === 0) return [];
  const result = await query(
    `SELECT * FROM action_type WHERE action_type_id = ANY($1::uuid[])`,
    [rids]
  );
  return result.rows as ActionTypeRow[];
}

/**
 * List all action types for a given ontology, ordered by created_at ascending.
 */
async function listActionTypes(
  ontologyId: string
): Promise<ActionTypeRow[]> {
  const result = await query(
    "SELECT * FROM action_type WHERE ontology_id = $1 ORDER BY created_at ASC",
    [ontologyId]
  );
  return result.rows as ActionTypeRow[];
}

/**
 * Update specified fields on an existing action type.
 *
 * Only allows updating: display_name, description, parameters, rules,
 * submission_criteria, side_effects, max_affected_objects, is_enabled.
 *
 * Always sets updated_at to now(). Returns the updated row.
 */
async function updateActionType(
  ontologyId: string,
  apiName: string,
  updates: UpdateActionTypeInput
): Promise<ActionTypeRow> {
  // 1. Build dynamic SET clause from allowed fields only
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (!UPDATABLE_FIELDS.has(key)) {
      continue; // silently skip disallowed fields
    }

    setClauses.push(`${key} = $${paramIndex++}`);

    // JSONB columns need to be serialized
    if (
      key === "parameters" ||
      key === "rules" ||
      key === "submission_criteria" ||
      key === "side_effects"
    ) {
      values.push(value != null ? JSON.stringify(value) : null);
    } else {
      values.push(value);
    }
  }

  if (setClauses.length === 0) {
    throw appError(
      "INVALID_PARAMETER",
      "At least one updatable field must be provided. Allowed fields: " +
        Array.from(UPDATABLE_FIELDS).join(", ")
    );
  }

  // Always update updated_at
  setClauses.push(`updated_at = now()`);

  // Add WHERE clause parameters
  values.push(ontologyId);
  values.push(apiName);

  const sql = `UPDATE action_type SET ${setClauses.join(", ")} WHERE ontology_id = $${paramIndex++} AND api_name = $${paramIndex} RETURNING *`;

  const result = await query(sql, values);

  if (result.rows.length === 0) {
    throw appError(
      "ACTION_TYPE_NOT_FOUND",
      `Action type '${apiName}' not found in ontology '${ontologyId}'.`
    );
  }

  return result.rows[0] as ActionTypeRow;
}

/**
 * Delete an action type by ontology ID and API name.
 * Returns true if deleted, false if not found.
 */
async function deleteActionType(
  ontologyId: string,
  apiName: string
): Promise<boolean> {
  const result = await query(
    "DELETE FROM action_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, apiName]
  );
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default {
  createActionType,
  getActionType,
  getActionTypeByRid,
  getActionTypesByRidBatch,
  listActionTypes,
  updateActionType,
  deleteActionType,
};

export {
  createActionType,
  getActionType,
  getActionTypeByRid,
  getActionTypesByRidBatch,
  listActionTypes,
  updateActionType,
  deleteActionType,
};
