// ---------------------------------------------------------------------------
// Action Migration Log Model
//
// Append-only, tamper-evident ledger of v1→v2 action-type semantics
// migrations and rollbacks (migration 125). Each row carries immutable
// previous + resulting definition snapshots, the actor, correlation id,
// acknowledged warning codes, and the delete-policy transition.
//
// Rollback is expressed by writing a NEW row with migration_kind='rollback'
// whose previous_definition_snapshot is the v2 definition being reverted;
// the action_type row itself is restored through the normal domain
// validation path (never a raw UPDATE here). This module only persists the
// audit ledger row.
// ---------------------------------------------------------------------------

import { query } from "../db";
import type { PoolClient } from "pg";

/** Run a SQL statement against the pool, or a specific transaction client. */
async function exec(
  client: PoolClient | undefined,
  text: string,
  values: unknown[],
) {
  return client ? client.query(text, values) : query(text, values);
}

export interface ActionMigrationLogRow {
  migration_id: string;
  ontology_id: string;
  action_api_name: string;
  migration_kind: "migrate" | "rollback";
  previous_semantics_version: number;
  resulting_semantics_version: number;
  previous_delete_policy: string;
  resulting_delete_policy: string;
  previous_definition_hash: string;
  resulting_definition_hash: string;
  previous_definition_snapshot: unknown;
  resulting_definition_snapshot: unknown;
  parameter_changes: unknown;
  acknowledged_finding_codes: string[];
  adapter_enabled: boolean;
  actor: string;
  correlation_id: string | null;
  created_at: string;
}

export interface RecordMigrationInput {
  ontologyId: string;
  actionApiName: string;
  migrationKind: "migrate" | "rollback";
  previousSemanticsVersion: number;
  resultingSemanticsVersion: number;
  previousDeletePolicy: string;
  resultingDeletePolicy: string;
  previousDefinitionHash: string;
  resultingDefinitionHash: string;
  previousDefinitionSnapshot: unknown;
  resultingDefinitionSnapshot: unknown;
  parameterChanges: unknown;
  acknowledgedFindingCodes: string[];
  adapterEnabled: boolean;
  actor: string;
  correlationId?: string | null;
}

/**
 * Persist a single migration (or rollback) ledger row.
 * Append-only; never updates an existing row.
 */
export async function recordMigration(
  input: RecordMigrationInput,
  client?: PoolClient,
): Promise<ActionMigrationLogRow> {
  const result = await exec(
    client,
    `INSERT INTO action_migration_log (
       ontology_id, action_api_name, migration_kind,
       previous_semantics_version, resulting_semantics_version,
       previous_delete_policy, resulting_delete_policy,
       previous_definition_hash, resulting_definition_hash,
       previous_definition_snapshot, resulting_definition_snapshot,
       parameter_changes, acknowledged_finding_codes, adapter_enabled,
       actor, correlation_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING *`,
    [
      input.ontologyId,
      input.actionApiName,
      input.migrationKind,
      input.previousSemanticsVersion,
      input.resultingSemanticsVersion,
      input.previousDeletePolicy,
      input.resultingDeletePolicy,
      input.previousDefinitionHash,
      input.resultingDefinitionHash,
      JSON.stringify(input.previousDefinitionSnapshot),
      JSON.stringify(input.resultingDefinitionSnapshot),
      JSON.stringify(input.parameterChanges ?? []),
      input.acknowledgedFindingCodes ?? [],
      input.adapterEnabled ?? false,
      input.actor,
      input.correlationId ?? null,
    ],
  );
  return result.rows[0] as ActionMigrationLogRow;
}

/**
 * Fetch the most recent ledger row for an action type (any kind). Used by
 * the rollback path to choose the snapshot to restore.
 */
export async function latestMigration(
  ontologyId: string,
  actionApiName: string,
): Promise<ActionMigrationLogRow | null> {
  const result = await query(
    `SELECT * FROM action_migration_log
      WHERE ontology_id = $1 AND action_api_name = $2
      ORDER BY created_at DESC, migration_id DESC
      LIMIT 1`,
    [ontologyId, actionApiName],
  );
  return result.rows.length > 0 ? (result.rows[0] as ActionMigrationLogRow) : null;
}

/**
 * Fetch the most recent *forward* migration (kind='migrate') for an action
 * type. The rollback path uses this to decide whether rollback is available.
 */
export async function latestForwardMigration(
  ontologyId: string,
  actionApiName: string,
): Promise<ActionMigrationLogRow | null> {
  const result = await query(
    `SELECT * FROM action_migration_log
      WHERE ontology_id = $1 AND action_api_name = $2 AND migration_kind = 'migrate'
      ORDER BY created_at DESC, migration_id DESC
      LIMIT 1`,
    [ontologyId, actionApiName],
  );
  return result.rows.length > 0 ? (result.rows[0] as ActionMigrationLogRow) : null;
}
