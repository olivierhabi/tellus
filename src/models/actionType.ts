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

import { query, withTransaction } from "../db";
import { appError } from "../utils/appError";
import { validateActionTypeName } from "../utils/apiNameValidator";
import {
  V1_DEFAULT_SEMANTICS,
  V2_DEFAULT_SEMANTICS,
  type ActionSemanticsVersion,
  type ActionExecutionMode,
  type DeletePolicy,
} from "../actions/actionSemantics";
import {
  analyzeActionTypeMigration,
  ACKNOWLEDGEMENT_REQUIRED_FINDING_CODES,
  type MigrationFinding,
  type ParameterMigration,
  type MigrationReport,
} from "../actions/actionMigrationAnalysis";
import { hashActionDefinition } from "../actions/actionDefinitionHash";
import {
  actionDefinitionInputFromRow,
  canonicalizeActionDefinition,
} from "../actions/actionDefinitionCanonical";
import { defaultSchemaLookup } from "../actions/objectReferenceResolver";
import {
  recordMigration,
  latestForwardMigration,
  type ActionMigrationLogRow,
} from "./actionMigrationLog";
import type { PoolClient } from "pg";

/**
 * Pin-artifact sync (Automate effect pinning).
 *
 * After ANY write that lands a new action-type definition, persist the two
 * artifacts Automate pins evaluate against:
 *
 *   1. action_type.definition_hash — content-addressed sha256 of the
 *      canonical semantic definition (see actionDefinitionCanonical.ts),
 *      computed from the post-write row so column + hash can never drift
 *      apart. Guarded with IS DISTINCT FROM: a no-op write stays a no-op.
 *   2. action_type_definition_history — immutable per-version snapshot
 *      (INSERT ... ON CONFLICT DO NOTHING) so a future pin at THIS version
 *      remains classifiable after the row later moves on.
 *
 * Also normalizes legacy rows whose definition_version is still NULL
 * (created before migration 132's trigger existed) to 1 — the value effect
 * pins carry for such rows.
 *
 * Call with the surrounding transaction's client when inside one (the
 * migrate/rollback paths) so artifacts commit atomically with the
 * definition change; otherwise the pool is used and the two statements are
 * best-effort-atomic (a crash mid-way is repaired on the next save).
 */
export async function syncDefinitionPinArtifacts(
  row: ActionTypeRow,
  client?: Pick<PoolClient, "query">,
): Promise<{ definitionHash: string; definitionVersion: number }> {
  const input = actionDefinitionInputFromRow(row);
  const definitionHash = hashActionDefinition(input);
  const definitionVersion = row.definition_version ?? 1;
  const run = (text: string, values: unknown[]) =>
    client ? client.query(text, values) : query(text, values);
  await run(
    `UPDATE action_type
        SET definition_hash = $2,
            definition_version = $3
      WHERE action_type_id = $1
        AND (definition_hash IS DISTINCT FROM $2
             OR definition_version IS DISTINCT FROM $3)`,
    [row.action_type_id, definitionHash, definitionVersion],
  );
  await run(
    `INSERT INTO action_type_definition_history (
       action_type_id, definition_version, definition_hash, definition
     ) VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (action_type_id, definition_version) DO NOTHING`,
    [
      row.action_type_id,
      definitionVersion,
      definitionHash,
      JSON.stringify(canonicalizeActionDefinition(input)),
    ],
  );
  return { definitionHash, definitionVersion };
}

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
  /**
   * Phase 4 — single ActionWritebackConfig JSONB or NULL. The pre-edit
   * writeback webhook (Phase 4) executes BEFORE ontology edits; on
   * failure, no edits are applied (failurePolicy:'abort' is the only
   * supported policy). At most one writeback per action type, enforced
   * at the structural level by migration 130's CHECK constraint.
   */
  writeback_config: unknown | null;
  /** Immutable published Function binding for function execution mode. */
  function_config?: unknown | null;
  /**
   * Migration 173 — Ontology Manager Security page operational settings
   * (branch side-effect switches, Automate consumer gate, notification
   * failure policy / redaction). NULL = every default; always read through
   * `resolveActionSecuritySettings` so consumers agree on what NULL means.
   * Deliberately outside the definition hash and version-bump trigger:
   * operational policy, not action semantics.
   */
  security_settings?: unknown | null;
  max_affected_objects: number;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
  // Action Semantics v2 (migration 121). NULL → read-time fallback to v1
  // (see resolveSemanticsFromRow). Persisted explicitly on every create.
  semantics_version: number | null;
  execution_mode: string | null;
  delete_policy: string | null;
  /** Phase 1 migration 132 — versioned action-type definitions. The
   * BEFORE UPDATE trigger bumps this on every material change. */
  definition_version?: number;
  definition_hash?: string | null;
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
  /** Phase 4 — pre-edit writeback config (null = no writeback). One-writeback-per-action structural invariant is enforced by migration 130 CHECK. */
  writebackConfig?: unknown | null;
  functionConfig?: unknown | null;
  maxAffectedObjects?: number;
  isEnabled?: boolean;
  createdBy?: string;
  // Action Semantics v2. Omitted semanticsVersion on the legacy create
  // endpoint → persisted as version 1 + legacy_unchecked + declarative,
  // with deprecation telemetry emitted by the route layer.
  semanticsVersion?: ActionSemanticsVersion;
  executionMode?: ActionExecutionMode;
  deletePolicy?: DeletePolicy;
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
  /** Phase 4 — pre-edit writeback config (NULL = no writeback). One-writeback-per-action enforced by CHECK constraint from migration 130. */
  writeback_config?: unknown | null;
  function_config?: unknown | null;
  /** Action Semantics v2 — declarative rules vs Function-backed execution. */
  execution_mode?: "declarative" | "function";
  /** Migration 173 — see ActionTypeRow.security_settings. */
  security_settings?: unknown | null;
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
  "writeback_config",
  "function_config",
  "execution_mode",
  "security_settings",
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

  // 3. Resolve semantics triple. Omitted semanticsVersion on the legacy
  // create endpoint is persisted as version 1 (default + deprecation
  // telemetry emitted by the route). An explicit version 2 carries the
  // v2 defaults server-side when executionMode/deletePolicy are omitted.
  const semanticsVersion: number | null =
    actionTypeDef.semanticsVersion !== undefined
      ? actionTypeDef.semanticsVersion
      : null; // null persisted for legacy-v1-omit; read-time fallback to 1
  let executionMode: string | null =
    actionTypeDef.executionMode ?? null;
  let deletePolicy: string | null =
    actionTypeDef.deletePolicy ?? null;
  if (actionTypeDef.semanticsVersion === 2) {
    const v2 = V2_DEFAULT_SEMANTICS;
    executionMode = actionTypeDef.executionMode ?? v2.executionMode;
    deletePolicy = actionTypeDef.deletePolicy ?? v2.deletePolicy;
  } else if (actionTypeDef.semanticsVersion === 1) {
    const v1 = V1_DEFAULT_SEMANTICS;
    executionMode = actionTypeDef.executionMode ?? v1.executionMode;
    deletePolicy = actionTypeDef.deletePolicy ?? v1.deletePolicy;
  }

  // 4. Insert the action type
  try {
    const result = await query(
      `INSERT INTO action_type
         (ontology_id, api_name, display_name, description,
          icon_name, icon_color, save_location_rid,
          parameters, rules, submission_criteria, side_effects,
          max_affected_objects, is_enabled, created_by,
          semantics_version, execution_mode, delete_policy, writeback_config,
          function_config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
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
        semanticsVersion,
        executionMode,
        deletePolicy,
        // Phase 4 — writeback_config. The route layer's
        // validateWritebackConfig() validates the shape before this INSERT.
        actionTypeDef.writebackConfig != null
          ? JSON.stringify(actionTypeDef.writebackConfig)
          : null,
        actionTypeDef.functionConfig != null
          ? JSON.stringify(actionTypeDef.functionConfig)
          : null,
      ]
    );
    const created = result.rows[0] as ActionTypeRow;
    await syncDefinitionPinArtifacts(created);
    return created;
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
 * Read-time semantics fallback (Stage B): NULL columns → version 1.
 * Returns the resolved semantics triple for a row. The route formatter
 * uses this so existing action types keep their v1 behaviour even though
 * their semantics columns are NULL before the Stage C backfill.
 */
export function resolveSemanticsForRow(
  row: Pick<
    ActionTypeRow,
    "semantics_version" | "execution_mode" | "delete_policy"
  >,
): {
  semanticsVersion: number;
  executionMode: string;
  deletePolicy: string;
} {
  if (row.semantics_version == null) {
    return { ...V1_DEFAULT_SEMANTICS } as {
      semanticsVersion: number;
      executionMode: string;
      deletePolicy: string;
    };
  }
  return {
    semanticsVersion: row.semantics_version,
    executionMode: row.execution_mode ?? "declarative",
    deletePolicy: row.delete_policy ?? "legacy_unchecked",
  };
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
      key === "side_effects" ||
      key === "writeback_config" ||
      key === "function_config" ||
      key === "security_settings"
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

  const updated = result.rows[0] as ActionTypeRow;
  await syncDefinitionPinArtifacts(updated);
  return updated;
}

/**
 * Dedicated v1→v2 semantics migration (§12). Not exposed through the
 * generic update path; the route layer requires explicit operator
 * confirmation and re-runs compatibility analysis server-side before
 * calling this. Records the migration actor via the standard
 * `updated_at`/`updated_by`? (created_by is immutable; we bump updated_at).
 *
 * Never silently downgrades: target must be 2. Never migrates
 * automatically: the route calls this only after analysis + confirmation.
 */
export async function migrateActionTypeSemantics(
  ontologyId: string,
  apiName: string,
  targetVersion: ActionSemanticsVersion,
): Promise<ActionTypeRow | null> {
  if (targetVersion !== 2) {
    throw appError(
      "INCOMPATIBLE_ACTION_SEMANTICS",
      `Migration target version must be 2; received '${targetVersion}'.`,
    );
  }
  const defaults = targetVersion === 2 ? V2_DEFAULT_SEMANTICS : V1_DEFAULT_SEMANTICS;
  const result = await query(
    `UPDATE action_type
        SET semantics_version = $3,
            execution_mode = $4,
            delete_policy = $5,
            updated_at = now()
      WHERE ontology_id = $1 AND api_name = $2
      RETURNING *`,
    [
      ontologyId,
      apiName,
      targetVersion,
      defaults.executionMode,
      defaults.deletePolicy,
    ],
  );
  return result.rows.length > 0 ? (result.rows[0] as ActionTypeRow) : null;
}

// ---------------------------------------------------------------------------
// Atomic, optimistic-concurrency-safe v1→v2 migration that ALSO persists a
// proposed definition (typed object_reference parameters, repointed rules)
// in the same UPDATE. Re-runs analysis immediately before the transaction,
// verifies the definition hash matches the analysis the operator saw, and
// writes an immutable action_migration_log ledger row inside the same
// transaction. Caller-supplied `expectedDefinitionHash` is the concurrency
// token returned by the GET /migrationAnalysis endpoint.
// ---------------------------------------------------------------------------

export interface MigrateWithDefinitionInput {
  /** The hash the client received from the analysis response. */
  expectedDefinitionHash: string;
  /** The proposed v2 parameters/rules produced by the analyzer. They must
   *  match what the server-side re-analysis produces from the CURRENT row;
   *  the server re-derives the proposal rather than trusting the client. */
  proposedDefinition: { parameters: unknown[]; rules: unknown[] };
  /** Finding codes the operator acknowledged (review-required findings). */
  acknowledgedFindingCodes: string[];
  /** Whether a compatibility adapter was enabled for this migration. */
  adapterEnabled: boolean;
  /** Operator that triggered the migration. */
  actor: string;
  /** Optional correlation id propagated to the audit row. */
  correlationId?: string | null;
}

export interface MigrateWithDefinitionResult {
  /** The newly persisted action-type row (semantics version 2). */
  migrated: ActionTypeRow;
  /** The audit ledger row written inside the same transaction. */
  log: ActionMigrationLogRow;
  /** The server-side analysis run immediately before the transaction. */
  analysis: MigrationReport;
}

export async function migrateActionTypeWithDefinition(
  ontologyId: string,
  apiName: string,
  input: MigrateWithDefinitionInput,
): Promise<MigrateWithDefinitionResult> {
  // 1. Load the current row and re-derive a server-side analysis. Never trust
  //    the client's proposed definition — re-derive it from the live row.
  const current = await getActionType(ontologyId, apiName);
  if (!current) {
    throw appError(
      "ACTION_TYPE_NOT_FOUND",
      `Action type '${apiName}' not found in ontology '${ontologyId}'.`,
    );
  }
  const currentSemantics = resolveSemanticsForRow({
    semantics_version: (current as any).semantics_version ?? null,
    execution_mode: (current as any).execution_mode ?? null,
    delete_policy: (current as any).delete_policy ?? null,
  });
  if (currentSemantics.semanticsVersion !== 1) {
    throw appError(
      "INCOMPATIBLE_ACTION_SEMANTICS",
      `Action type is already semantics version ${currentSemantics.semanticsVersion}; migration is v1→v2 only.`,
      { currentVersion: currentSemantics.semanticsVersion },
    );
  }
  const currentHash = hashActionDefinition({
    parameters: current.parameters,
    rules: current.rules,
    semanticsVersion: currentSemantics.semanticsVersion,
    executionMode: currentSemantics.executionMode,
    deletePolicy: currentSemantics.deletePolicy,
  });
  if (input.expectedDefinitionHash !== currentHash) {
    throw appError(
      "MIGRATION_STALE_DEFINITION",
      `Migration rejected: the action definition changed since the analysis was generated. Re-run migration analysis and retry.`,
      {
        expectedHash: input.expectedDefinitionHash,
        currentHash,
        actionTypeApiName: apiName,
      },
    );
  }
  const analysis = await analyzeActionTypeMigration(
    {
      rules: (current.rules ?? []) as any[],
      parameters: (current.parameters ?? []) as any[],
    },
    { schemaLookup: defaultSchemaLookup, ontologyId },
  );
  const proposedDef = analysis.proposedDefinition;
  if (!proposedDef) {
    throw appError(
      "INCOMPATIBLE_ACTION_SEMANTICS",
      `Migration rejected: analysis produced no proposed definition (classification '${analysis.classification}'). Resolve blocking findings before migrating.`,
      { classification: analysis.classification, findings: analysis.findings },
    );
  }
  // 2. Acknowledgement enforcement: every code in ACKNOWLEDGEMENT_REQUIRED
  //    that appears among the analysis findings must be acknowledged.
  const presentRequired = analysis.findings
    .filter(
      (f) =>
        (f.code as string) &&
        ACKNOWLEDGEMENT_REQUIRED_FINDING_CODES.has(f.code as MigrationFinding["code"]),
    )
    .map((f) => f.code as string);
  const acked = new Set(input.acknowledgedFindingCodes ?? []);
  const missing = presentRequired.filter((c) => !acked.has(c));
  if (missing.length > 0) {
    throw appError(
      "MIGRATION_ACKNOWLEDGEMENT_REQUIRED",
      `Migration rejected: missing acknowledgements for review-required findings: ${missing.join(", ")}.`,
      { missingAcknowledgements: missing, presentRequired },
    );
  }
  // 3. Atomic persist + audit inside one transaction.
  return withTransaction(
    async (pg: PoolClient): Promise<MigrateWithDefinitionResult> => {
      // Re-read FOR UPDATE to serialize against concurrent migrations.
      const locked = await pg.query(
        "SELECT * FROM action_type WHERE ontology_id = $1 AND api_name = $2 FOR UPDATE",
        [ontologyId, apiName],
      );
      if (locked.rows.length === 0) {
        throw appError(
          "ACTION_TYPE_NOT_FOUND",
          `Action type '${apiName}' disappeared between analysis and migration.`,
        );
      }
      const lockedRow = locked.rows[0];
      const lockedSemantics = resolveSemanticsForRow({
        semantics_version: lockedRow.semantics_version ?? null,
        execution_mode: lockedRow.execution_mode ?? null,
        delete_policy: lockedRow.delete_policy ?? null,
      });
      if (lockedSemantics.semanticsVersion !== 1) {
        throw appError(
          "INCOMPATIBLE_ACTION_SEMANTICS",
          `Concurrent migration detected: action type is now version ${lockedSemantics.semanticsVersion}.`,
          { currentVersion: lockedSemantics.semanticsVersion },
        );
      }
      const lockedHash = hashActionDefinition({
        parameters: lockedRow.parameters,
        rules: lockedRow.rules,
        semanticsVersion: lockedSemantics.semanticsVersion,
        executionMode: lockedSemantics.executionMode,
        deletePolicy: lockedSemantics.deletePolicy,
      });
      if (lockedHash !== input.expectedDefinitionHash) {
        throw appError(
          "MIGRATION_STALE_DEFINITION",
          `Migration rejected inside transaction: the action definition was edited while migration was in flight. Re-run migration analysis and retry.`,
          { expectedHash: input.expectedDefinitionHash, currentHash: lockedHash },
        );
      }

      // Persist the proposed v2 definition + semantics in one UPDATE.
      const updated = await pg.query(
        `UPDATE action_type
            SET parameters = $3,
                rules = $4,
                semantics_version = $5,
                execution_mode = $6,
                delete_policy = $7,
                updated_at = now()
          WHERE ontology_id = $1 AND api_name = $2
          RETURNING *`,
        [
          ontologyId,
          apiName,
          JSON.stringify(proposedDef.parameters),
          JSON.stringify(proposedDef.rules),
          2,
          V2_DEFAULT_SEMANTICS.executionMode,
          V2_DEFAULT_SEMANTICS.deletePolicy,
        ],
      );
      if (updated.rows.length === 0) {
        throw appError(
          "ACTION_TYPE_NOT_FOUND",
          `Action type '${apiName}' disappeared during migration UPDATE.`,
        );
      }
      const migrated = updated.rows[0] as ActionTypeRow;
      const resultingSemantics = resolveSemanticsForRow({
        semantics_version: migrated.semantics_version ?? null,
        execution_mode: migrated.execution_mode ?? null,
        delete_policy: migrated.delete_policy ?? null,
      });
      const resultingHash = hashActionDefinition({
        parameters: migrated.parameters,
        rules: migrated.rules,
        semanticsVersion: resultingSemantics.semanticsVersion,
        executionMode: resultingSemantics.executionMode,
        deletePolicy: resultingSemantics.deletePolicy,
      });

      const logRow = await recordMigration(
        {
          ontologyId,
          actionApiName: apiName,
          migrationKind: "migrate",
          previousSemanticsVersion: 1,
          resultingSemanticsVersion: 2,
          previousDeletePolicy: currentSemantics.deletePolicy,
          resultingDeletePolicy: resultingSemantics.deletePolicy,
          previousDefinitionHash: currentHash,
          resultingDefinitionHash: resultingHash,
          previousDefinitionSnapshot: {
            parameters: current.parameters,
            rules: current.rules,
            semanticsVersion: currentSemantics.semanticsVersion,
            executionMode: currentSemantics.executionMode,
            deletePolicy: currentSemantics.deletePolicy,
          },
          resultingDefinitionSnapshot: {
            parameters: migrated.parameters,
            rules: migrated.rules,
            semanticsVersion: resultingSemantics.semanticsVersion,
            executionMode: resultingSemantics.executionMode,
            deletePolicy: resultingSemantics.deletePolicy,
          },
          parameterChanges: analysis.parameterMigrations as ParameterMigration[],
          acknowledgedFindingCodes: input.acknowledgedFindingCodes ?? [],
          adapterEnabled: input.adapterEnabled ?? false,
          actor: input.actor,
          correlationId: input.correlationId ?? null,
        },
        pg,
      );
      // Persist pin artifacts in the SAME transaction: the v2 definition
      // version becomes classifiable for Automate pins immediately.
      await syncDefinitionPinArtifacts(migrated, pg);
      return { migrated, log: logRow, analysis };
    },
  );
}

// ---------------------------------------------------------------------------
// Rollback — restore the previous v1 definition from the latest forward
// migration's `previous_definition_snapshot`. Append-only: writes a NEW
// ledger row with migration_kind='rollback'. The action_type UPDATE goes
// through the same domain path (parameters/rules/semantics columns in a
// single transactional UPDATE) — never a raw row patch.
// ---------------------------------------------------------------------------

export interface RollbackResult {
  rolledBack: ActionTypeRow;
  log: ActionMigrationLogRow;
}

export async function rollbackActionTypeMigration(
  ontologyId: string,
  apiName: string,
  actor: string,
  correlationId?: string | null,
): Promise<RollbackResult> {
  const latest = await latestForwardMigration(ontologyId, apiName);
  if (!latest) {
    throw appError(
      "MIGRATION_ROLLBACK_NOT_AVAILABLE",
      `No forward migration recorded for action type '${apiName}' in ontology '${ontologyId}'. Rollback is not available.`,
      { actionTypeApiName: apiName, ontologyId },
    );
  }
  const previousDef = (latest.previous_definition_snapshot ?? null) as {
    parameters?: unknown[];
    rules?: unknown[];
    semanticsVersion?: number;
    executionMode?: string;
    deletePolicy?: string;
  } | null;
  if (!previousDef) {
    throw appError(
      "MIGRATION_ROLLBACK_NOT_AVAILABLE",
      `Latest forward migration for '${apiName}' has no previous definition snapshot; rollback cannot be performed.`,
      { migrationId: latest.migration_id },
    );
  }
  const targetVersion = previousDef.semanticsVersion ?? 1;
  return withTransaction(
    async (pg: PoolClient): Promise<RollbackResult> => {
      const locked = await pg.query(
        "SELECT * FROM action_type WHERE ontology_id = $1 AND api_name = $2 FOR UPDATE",
        [ontologyId, apiName],
      );
      if (locked.rows.length === 0) {
        throw appError(
          "ACTION_TYPE_NOT_FOUND",
          `Action type '${apiName}' not found during rollback.`,
        );
      }
      const lockedRow = locked.rows[0] as ActionTypeRow;
      const lockedSemantics = resolveSemanticsForRow({
        semantics_version: lockedRow.semantics_version ?? null,
        execution_mode: lockedRow.execution_mode ?? null,
        delete_policy: lockedRow.delete_policy ?? null,
      });
      if (lockedSemantics.semanticsVersion !== 2) {
        throw appError(
          "INCOMPATIBLE_ACTION_SEMANTICS",
          `Rollback is only available for v2 action types; current version is ${lockedSemantics.semanticsVersion}.`,
          { currentVersion: lockedSemantics.semanticsVersion },
        );
      }
      const previousV2Hash = hashActionDefinition({
        parameters: lockedRow.parameters,
        rules: lockedRow.rules,
        semanticsVersion: lockedSemantics.semanticsVersion,
        executionMode: lockedSemantics.executionMode,
        deletePolicy: lockedSemantics.deletePolicy,
      });
      const restored = await pg.query(
        `UPDATE action_type
            SET parameters = $3,
                rules = $4,
                semantics_version = $5,
                execution_mode = $6,
                delete_policy = $7,
                updated_at = now()
          WHERE ontology_id = $1 AND api_name = $2
          RETURNING *`,
        [
          ontologyId,
          apiName,
          JSON.stringify(previousDef.parameters ?? []),
          JSON.stringify(previousDef.rules ?? []),
          targetVersion,
          previousDef.executionMode ?? "declarative",
          previousDef.deletePolicy ?? "legacy_unchecked",
        ],
      );
      if (restored.rows.length === 0) {
        throw appError(
          "ACTION_TYPE_NOT_FOUND",
          `Action type '${apiName}' disappeared during rollback UPDATE.`,
        );
      }
      const restoredRow = restored.rows[0] as ActionTypeRow;
      const restoredSemantics = resolveSemanticsForRow({
        semantics_version: restoredRow.semantics_version ?? null,
        execution_mode: restoredRow.execution_mode ?? null,
        delete_policy: restoredRow.delete_policy ?? null,
      });
      const restoredHash = hashActionDefinition({
        parameters: restoredRow.parameters,
        rules: restoredRow.rules,
        semanticsVersion: restoredSemantics.semanticsVersion,
        executionMode: restoredSemantics.executionMode,
        deletePolicy: restoredSemantics.deletePolicy,
      });
      const logRow = await recordMigration(
        {
          ontologyId,
          actionApiName: apiName,
          migrationKind: "rollback",
          previousSemanticsVersion: 2,
          resultingSemanticsVersion: targetVersion,
          previousDeletePolicy: lockedSemantics.deletePolicy,
          resultingDeletePolicy: restoredSemantics.deletePolicy,
          previousDefinitionHash: previousV2Hash,
          resultingDefinitionHash: restoredHash,
          previousDefinitionSnapshot: {
            parameters: lockedRow.parameters,
            rules: lockedRow.rules,
            semanticsVersion: lockedSemantics.semanticsVersion,
            executionMode: lockedSemantics.executionMode,
            deletePolicy: lockedSemantics.deletePolicy,
          },
          resultingDefinitionSnapshot: {
            parameters: restoredRow.parameters,
            rules: restoredRow.rules,
            semanticsVersion: restoredSemantics.semanticsVersion,
            executionMode: restoredSemantics.executionMode,
            deletePolicy: restoredSemantics.deletePolicy,
          },
          parameterChanges: [],
          acknowledgedFindingCodes: [],
          adapterEnabled: false,
          actor,
          correlationId: correlationId ?? null,
        },
        pg,
      );
      // Same-transaction pin artifacts for the restored v1 definition.
      await syncDefinitionPinArtifacts(restoredRow, pg);
      return { rolledBack: restoredRow, log: logRow };
    },
  );
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
