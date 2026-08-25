// ---------------------------------------------------------------------------
// Shared pin lookups for action-type pins inside automation definitions.
// Used by the bulk re-pin endpoint (repin.ts) AND the edit-time blast
// radius (routes/actionTypes.ts) so both query the SAME candidate set with
// the SAME classification inputs.
// ---------------------------------------------------------------------------

import type { Pool, PoolClient } from "pg";

import type { ActionDefinitionInput } from "../../actions/actionDefinitionCanonical";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

/**
 * Distinct automation ids whose DRAFT definition contains at least one
 * action effect pinned to the given action type. Uses jsonb containment on
 * the extracted effects array (covered by the migration-165 GIN index).
 */
export async function findDraftAutomationsPinningActionType(
  db: Queryable,
  tenantId: string,
  actionTypeId: string,
  limit = 500,
): Promise<Array<{ automationId: string; draftRevision: number }>> {
  const result = await db.query<{
    automation_id: string;
    draft_revision: number;
  }>(
    `SELECT automation_id, draft_revision
       FROM automation
      WHERE tenant_id = $1
        AND status <> 'archived'
        AND draft_definition -> 'effects' @> $2::jsonb
      ORDER BY automation_id
      LIMIT $3`,
    [tenantId, JSON.stringify([{ actionTypeId }]), limit],
  );
  return result.rows.map((r) => ({
    automationId: r.automation_id,
    draftRevision: r.draft_revision,
  }));
}

/**
 * Distinct automations whose LATEST ACTIVATED VERSION pins the action
 * type (what is actually running right now).
 */
export async function findActiveVersionAutomationsPinningActionType(
  db: Queryable,
  tenantId: string,
  actionTypeId: string,
  limit = 500,
): Promise<string[]> {
  const result = await db.query<{ automation_id: string }>(
    `SELECT a.automation_id
       FROM automation a
       JOIN automation_version v
         ON v.automation_id = a.automation_id
        AND v.version = a.current_version
      WHERE a.tenant_id = $1
        AND a.status <> 'archived'
        AND a.current_version IS NOT NULL
        AND v.definition -> 'effects' @> $2::jsonb
      ORDER BY a.automation_id
      LIMIT $3`,
    [tenantId, JSON.stringify([{ actionTypeId }]), limit],
  );
  return result.rows.map((r) => r.automation_id);
}

/**
 * The canonical snapshot of an action-type definition at a specific
 * version (null when the version predates the history rollout — callers
 * must then fall back to conservative legacy behavior).
 */
export async function loadActionDefinitionSnapshot(
  db: Queryable,
  actionTypeId: string,
  definitionVersion: number,
): Promise<unknown | null> {
  const result = await db.query<{ definition: unknown }>(
    `SELECT definition
       FROM action_type_definition_history
      WHERE action_type_id = $1 AND definition_version = $2`,
    [actionTypeId, definitionVersion],
  );
  return result.rows[0]?.definition ?? null;
}

export interface ActionTypeCurrentRow {
  action_type_id: string;
  api_name: string;
  definition_version: number;
  definition_hash: string | null;
  definition: ActionDefinitionInput;
}

/** The CURRENT definition of an action type as a canonical input + hash. */
export async function loadActionTypeCurrent(
  db: Queryable,
  actionTypeId: string,
): Promise<ActionTypeCurrentRow | null> {
  const result = await db.query<{
    action_type_id: string;
    api_name: string;
    definition_version: number | null;
    definition_hash: string | null;
    parameters: unknown;
    rules: unknown;
    submission_criteria: unknown;
    side_effects: unknown;
    writeback_config: unknown;
    function_config: unknown;
    semantics_version: number | null;
    execution_mode: string | null;
    delete_policy: string | null;
  }>(
    `SELECT action_type_id, api_name,
            COALESCE(definition_version, 1) AS definition_version,
            definition_hash, parameters, rules,
            submission_criteria, side_effects, writeback_config, function_config,
            semantics_version, execution_mode, delete_policy
       FROM action_type
      WHERE action_type_id = $1`,
    [actionTypeId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    action_type_id: row.action_type_id,
    api_name: row.api_name,
    definition_version: row.definition_version ?? 1,
    definition_hash: row.definition_hash,
    definition: {
      parameters: row.parameters,
      rules: row.rules,
      submissionCriteria: row.submission_criteria,
      sideEffects: row.side_effects,
      writebackConfig: row.writeback_config,
      functionConfig: row.function_config,
      semanticsVersion: row.semantics_version,
      executionMode: row.execution_mode,
      deletePolicy: row.delete_policy,
    },
  };
}
