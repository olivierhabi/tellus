// ---------------------------------------------------------------------------
// Action Type Routes
//
// CRUD REST API endpoints for managing action type definitions in the
// Ontology. Action types define parameterized, auditable sets of changes
// that can be applied to objects, properties, and links.
//
// Mounted at: /api/v1/ontology/:ontologyId/actionTypes
//
// Endpoints:
//   POST   /                       — Create a new action type
//   GET    /                       — List all action types for an ontology
//   GET    /:actionApiName         — Get a single action type by API name
//   PUT    /:actionApiName         — Update an action type
//   POST   /:actionApiName/clone   — Clone an action type (Task 23)
//   GET    /:actionApiName/impact  — Action type impact analysis (Task 24)
//   DELETE /:actionApiName         — Delete an action type
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { Router, Request, Response, NextFunction } from "express";
import { pool, query } from "../../db";
import { computeActionTypeBlastRadius } from "../../services/automate/blastRadius";
import { actionDefinitionInputFromRow } from "../../actions/actionDefinitionCanonical";
import { resolveFunctionSource } from "../../services/functionsRegistry/artifactStore";
import {
  createActionType,
  getActionType,
  getActionTypeByRid,
  getActionTypesByRidBatch,
  listActionTypes,
  updateActionType,
  deleteActionType,
  migrateActionTypeSemantics,
  migrateActionTypeWithDefinition,
  rollbackActionTypeMigration,
} from "../../models/actionType";
import type { UpdateActionTypeInput } from "../../models/actionType";
import {
  sendError,
  sendCreated,
  sendSuccess,
  sendNoContent,
} from "../../utils/responseFormatter";
import { appError } from "../../utils/appError";
import { OntologyError } from "../../utils/queryErrors";
import {
  validateSchemaMigration,
} from "../../actions/schemaMigrationValidator";
import type { CurrentSchema, ProposedSchema, RecentExecutionStats } from "../../actions/schemaMigrationValidator";
import { dataPlaneGuard } from "../../middleware/requireRole";
import {
  validateActionSemantics,
  V1_DEFAULT_SEMANTICS,
  V2_DEFAULT_SEMANTICS,
  type ActionSemanticsVersion,
  type ActionExecutionMode,
  type DeletePolicy,
} from "../../actions/actionSemantics";
import {
  getActionSemanticsExecutionAvailability,
  isV2CreationEnabled,
} from "../../actions/actionSemanticsFlags";
import {
  analyzeActionTypeMigration,
  ACKNOWLEDGEMENT_REQUIRED_FINDING_CODES,
  type MigrationFinding,
  type MigrationReport,
  type ParameterMigration,
} from "../../actions/actionMigrationAnalysis";
import { hashActionDefinition } from "../../actions/actionDefinitionHash";
import { validateSystemValueSourceForProperty } from "../../actions/valueSourceCompatibility";
import {
  normalizeActionSecuritySettings,
  resolveActionSecuritySettings,
} from "../../actions/actionSecuritySettings";
import { defaultSchemaLookup } from "../../actions/objectReferenceResolver";
import { recordMigration } from "../../models/actionMigrationLog";
import {
  getByApiName as getLinkTypeByApiName,
  resolveObjectTypeApiName,
} from "../../models/linkType";
import { getInterfaceLinkConstraintByApiName } from "../../models/interfaceLinkConstraint";
import { getWebhookByNameVersion } from "../../models/webhookDefinition";
import { getByRid as getConnectivityWebhookByRid } from "../../services/connectivity/webhooks/repository";
import type { WebhookParameterTypeValue } from "../../services/connectivity/webhooks/contracts";
import { CONNECTIVITY_WEBHOOK_RID_PREFIX } from "../../actions/writebackExecutor";
import { resolveRequestTenant } from "../../utils/requestTenant";
import { resolveSemanticsForRow } from "../../models/actionType";
import {
  validateConcreteLinkRuleShape,
  validateInterfaceLinkRuleShape,
} from "../../actions/ruleShapeValidator";
import {
  isActionParameterCompatibleWithWebhook,
  isStaticWebhookValueCompatible,
} from "../../actions/webhookTypeCompatibility";
import {
  parsePublishedFunctionType,
  validateFunctionWebhookContract,
  type PublishedFunctionSignature,
} from "../../actions/functionWebhookContract";

export const ACTION_PARAMETER_RID_PREFIX = "ri.actions.main.parameter.";
export const ACTION_RULE_RID_PREFIX = "ri.actions.main.rule.";
export const ACTION_RULE_SCHEMA_VERSION = 1;

export function ensureParameterRids(
  parameters: Array<Record<string, unknown>>,
  existingParameters: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> {
  const existingRids = new Set(
    existingParameters
      .map((parameter) => parameter.rid)
      .filter((rid): rid is string => typeof rid === "string"),
  );
  const existingRidsByApiName = new Map(
    existingParameters
      .filter(
        (parameter) =>
          typeof parameter.apiName === "string" &&
          typeof parameter.rid === "string",
      )
      .map((parameter) => [parameter.apiName as string, parameter.rid as string]),
  );

  return parameters.map((parameter) => ({
    ...parameter,
    rid:
      typeof parameter.rid === "string" &&
      parameter.rid.startsWith(ACTION_PARAMETER_RID_PREFIX) &&
      existingRids.has(parameter.rid)
        ? parameter.rid
        : existingRidsByApiName.get(String(parameter.apiName)) ??
          `${ACTION_PARAMETER_RID_PREFIX}${randomUUID()}`,
  }));
}

/**
 * Canonicalise authoring identity without changing rule semantics or dropping
 * extension fields. Existing rule RIDs are action-owned: callers cannot move a
 * RID from another action into this definition. Legacy definitions are
 * matched by array position during their first save; migration 147 backfills
 * persisted rows so normal updates carry the RID explicitly.
 */
export function ensureRuleRids(
  rules: Array<Record<string, unknown>>,
  existingRules: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> {
  const ownedRids = new Set(
    existingRules
      .map((rule) => rule.ruleId)
      .filter(
        (ruleId): ruleId is string =>
          typeof ruleId === "string" &&
          ruleId.startsWith(ACTION_RULE_RID_PREFIX),
      ),
  );
  const seen = new Set<string>();
  const hasSubmittedOwnedRid = rules.some(
    (rule) =>
      typeof rule.ruleId === "string" && ownedRids.has(rule.ruleId),
  );

  return rules.map((rule, index) => {
    const submitted =
      typeof rule.ruleId === "string" &&
      rule.ruleId.startsWith(ACTION_RULE_RID_PREFIX) &&
      ownedRids.has(rule.ruleId) &&
      !seen.has(rule.ruleId)
        ? rule.ruleId
        : undefined;
    const positional =
      !hasSubmittedOwnedRid &&
      typeof existingRules[index]?.ruleId === "string" &&
      String(existingRules[index].ruleId).startsWith(ACTION_RULE_RID_PREFIX) &&
      !seen.has(String(existingRules[index].ruleId))
        ? String(existingRules[index].ruleId)
        : undefined;
    const ruleId =
      submitted ?? positional ?? `${ACTION_RULE_RID_PREFIX}${randomUUID()}`;
    seen.add(ruleId);
    return {
      ...rule,
      ruleId,
      schemaVersion: ACTION_RULE_SCHEMA_VERSION,
    };
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Pattern for valid action type API names. */
export const API_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,99}$/;

/** Valid parameter types. */
export const VALID_PARAM_TYPES = new Set([
  "string",
  "boolean",
  "integer",
  "long",
  "byte",
  "short",
  "double",
  "float",
  "decimal",
  "date",
  "timestamp",
  "geopoint",
  "geoshape",
  "object_reference",
  "object_type_reference",
  "interface_reference",
  "interface_reference_array",
  "object_set",
  "string_array",
  "integer_array",
  "double_array",
  "boolean_array",
  "timestamp_array",
  "struct",
  "attachment",
  "marking",
  "media_reference",
  "timeseries",
]);

/** Numeric parameter types (for min/max constraints). */
export const NUMERIC_PARAM_TYPES = new Set([
  "integer",
  "long",
  "byte",
  "short",
  "double",
  "float",
  "decimal",
]);

/** Valid rule types.
 *
 *  The route-layer allowlist covers every canonical rule discriminator that
 *  has runtime support OR is reserved for a near-term phase (so users get a
 *  structured "feature not yet available" error instead of an opaque "unknown
 *  rule type" at compile time). The DB CHECK constraint (migration 127) is
 *  the structural backstop — the two layers agree on the same set.
 */
export const VALID_RULE_TYPES = new Set([
  "createObject",
  "modifyObject",
  "modifyOrCreateObject",
  "deleteObject",
  "addLink",
  "removeLink",
  // Phase 2: persisted-shape accepted, validator returns "not yet available"
  // until the rule-compiler dispatch + runtime resolver land.
  "createInterfaceLink",
  "deleteInterfaceLink",
  "createInterfaceObject",
  "modifyInterfaceObject",
  "deleteInterfaceObject",
]);

/** Valid property mapping source types. */
export const VALID_SOURCES = new Set([
  "parameter",
  "static",
  "currentTimestamp",
  "generatedSequence",
  "currentUser",
  "writebackResponse",
  "objectProperty",
]);

/** Error codes the route layer knows how to translate. */
export const KNOWN_CODES = new Set([
  "ACTION_TYPE_NOT_FOUND",
  "ACTION_TYPE_ALREADY_EXISTS",
  "ONTOLOGY_NOT_FOUND",
  "INVALID_API_NAME",
  "INVALID_PARAMETER",
  "VALIDATION_FAILED",
  "UNSUPPORTED_SEMANTICS_VERSION",
  "INCOMPATIBLE_ACTION_SEMANTICS",
  "INVALID_EXECUTION_MODE",
  "INVALID_DELETE_POLICY",
  "MIGRATION_ACKNOWLEDGEMENT_REQUIRED",
  "MIGRATION_STALE_DEFINITION",
  "MIGRATION_ROLLBACK_NOT_AVAILABLE",
  "MIGRATION_INCOMPATIBLE",
  // Action rule validation — link / interface-link / webhook / writeback / side effect.
  "INVALID_LINK_MAPPING",
  "UNSUPPORTED_RULE_TYPE",
  "AMBIGUOUS_INTERFACE_LINK_IMPLEMENTATION",
  "MISSING_INTERFACE_LINK_IMPLEMENTATION",
  "CARDINALITY_VIOLATION",
  "DUPLICATE_LINK",
  "CONFLICTING_FOREIGN_KEY_EDITS",
  "INVALID_WEBHOOK_INPUT_MAPPING",
  "INVALID_WEBHOOK_OUTPUT_MAPPING",
  "WEBHOOK_NOT_FOUND",
  "WEBHOOK_VERSION_DISABLED",
  "WRITEBACK_TIMEOUT",
  "WRITEBACK_REJECTED",
  "WRITEBACK_OUTPUT_SCHEMA_MISMATCH",
  "WRITEBACK_CONFIG_INVALID",
  "SIDE_EFFECT_CONFIGURATION_INVALID",
  "FUNCTION_CONFIG_INVALID",
  "FUNCTION_VERSION_NOT_FOUND",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FunctionActionConfig {
  functionRid: string;
  repositoryRid: string;
  apiName: string;
  branch: string;
  semver: string;
  autoUpgrade?: boolean;
  inputs?: Record<string, unknown>;
}

export async function validateFunctionConfig(
  raw: unknown,
  parameters: Array<Record<string, unknown>>,
): Promise<string[]> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return ["functionConfig is required for executionMode 'function'."];
  }
  const config = raw as Partial<FunctionActionConfig>;
  const required: Array<keyof FunctionActionConfig> = [
    "functionRid",
    "repositoryRid",
    "apiName",
    "branch",
    "semver",
  ];
  const errors: string[] = [];
  for (const key of required) {
    if (typeof config[key] !== "string" || !(config[key] as string).trim()) {
      errors.push(`functionConfig.${key} is required.`);
    }
  }
  if (errors.length > 0) return errors;

  const found = await query(
    `SELECT f.repository_rid, f.api_name, v.signature,
            fv.state, fv.runtime, fv.manifest_json, fv.artifact_blob_id
       FROM function_registry_function f
       JOIN function_registry_function_version v
         ON v.function_rid = f.rid
        AND v.branch = $2
        AND v.semver = $3
       JOIN function_version fv ON fv.rid = v.release_version_rid
      WHERE f.rid = $1`,
    [config.functionRid, config.branch, config.semver],
  );
  if (!found.rowCount) {
    return [
      `Published Function '${config.functionRid}' version ${config.semver} on branch '${config.branch}' was not found.`,
    ];
  }
  const row = found.rows[0];
  if (row.repository_rid !== config.repositoryRid || row.api_name !== config.apiName) {
    errors.push("functionConfig identity does not match the Function Registry record.");
  }
  if (row.state !== "AVAILABLE") {
    errors.push(`Function version ${config.semver} is '${row.state}' and cannot back a new Action Type.`);
  }
  if (row.runtime !== "NODE_20") {
    errors.push(`Function runtime '${row.runtime}' is not supported for Function-backed Action Types.`);
  }
  // Source resolution (Track 2 #8): inline historical manifests
  // or the content-addressed artifact blob for new versions.
  let source: string | null = null;
  try {
    source = await resolveFunctionSource(row, config.apiName as string);
  } catch {
    source = null;
  }
  if (typeof source !== "string" || source.length === 0) {
    errors.push(`Published source for Function '${config.apiName}' is unavailable in version ${config.semver}.`);
  }

  const declared = new Map(
    parameters.map((parameter) => [
      String(parameter.apiName ?? ""),
      {
        type: String(parameter.type ?? ""),
        required: parameter.required !== false,
        objectType:
          typeof parameter.objectType === "string" ? parameter.objectType : undefined,
      },
    ]),
  );
  const signatureParameters = Array.isArray(row.signature?.parameters)
    ? row.signature.parameters
    : [];
  const callableParameterNames = new Set<string>();
  for (const signatureParameter of signatureParameters) {
    if (!signatureParameter || typeof signatureParameter.name !== "string") continue;
    if (
      signatureParameter.name === "client" &&
      typeof signatureParameter.type === "string" &&
      /(?:^|\.)Client$/.test(signatureParameter.type.trim())
    ) {
      continue;
    }
    callableParameterNames.add(signatureParameter.name);
    const actionParameter = declared.get(signatureParameter.name);
    if (!actionParameter) {
      errors.push(`Function parameter '${signatureParameter.name}' is missing from action parameters.`);
      continue;
    }
    const configuredSource =
      config.inputs && typeof config.inputs === "object" && !Array.isArray(config.inputs)
        ? config.inputs[signatureParameter.name]
        : undefined;
    const mappingUsesSameNamedParameter =
      configuredSource == null ||
      (typeof configuredSource === "object" &&
        !Array.isArray(configuredSource) &&
        (configuredSource as { source?: unknown }).source === "parameter" &&
        (configuredSource as { param?: unknown }).param === signatureParameter.name);
    if (
      signatureParameter.optional !== true &&
      mappingUsesSameNamedParameter &&
      !actionParameter.required
    ) {
      errors.push(`Function parameter '${signatureParameter.name}' must be required.`);
    }
  }
  // Version upgrades can remove or rename function inputs. Reject stale
  // mappings instead of silently persisting metadata that the runtime can no
  // longer honor (and which leaves the editor showing a valid-looking action).
  if (config.inputs != null) {
    if (typeof config.inputs !== "object" || Array.isArray(config.inputs)) {
      errors.push("functionConfig.inputs must be an object.");
    } else {
      for (const [functionInput, rawSource] of Object.entries(config.inputs)) {
        if (!callableParameterNames.has(functionInput)) {
          errors.push(
            `Function input mapping '${functionInput}' is not present in the published ${config.semver} signature.`,
          );
        }
        const sourcePath = `functionConfig.inputs.${functionInput}`;
        errors.push(...validateValueSource(rawSource, sourcePath, new Set(declared.keys())));
        if (rawSource == null || typeof rawSource !== "object" || Array.isArray(rawSource)) {
          continue;
        }
        const source = rawSource as { source?: unknown; param?: unknown };
        if (source.source === "generatedSequence" || source.source === "writebackResponse") {
          errors.push(`${sourcePath} does not support source '${String(source.source)}' for Function-backed actions.`);
          continue;
        }
        if (source.source === "objectProperty") {
          const parameter =
            typeof source.param === "string" ? declared.get(source.param) : undefined;
          if (parameter && (parameter.type !== "object_reference" || !parameter.objectType)) {
            errors.push(
              `${sourcePath} must read from an object_reference action parameter with an objectType.`,
            );
          }
        }
        if (source.source === "currentTimestamp") {
          const publishedParameter = signatureParameters.find(
            (parameter: any) => parameter?.name === functionInput,
          );
          const publishedType = String(publishedParameter?.type ?? "").toLowerCase();
          if (!/(?:date|time|timestamp)/.test(publishedType)) {
            errors.push(
              `${sourcePath} maps Current timestamp to incompatible Function parameter type '${String(publishedParameter?.type ?? "unknown")}'.`,
            );
          }
        }
      }
    }
  }
  return errors;
}

/** Canonical action-type DB-row presenter used by every API read surface. */
export function formatActionType(row: Record<string, any>): Record<string, unknown> {
  const semantics = resolveSemanticsForRow({
    semantics_version: row.semantics_version ?? null,
    execution_mode: row.execution_mode ?? null,
    delete_policy: row.delete_policy ?? null,
  });
  const persistedRules = Array.isArray(row.rules)
    ? row.rules.filter(
        (rule: unknown): rule is Record<string, unknown> =>
          !!rule && typeof rule === "object" && !Array.isArray(rule),
      )
    : [];
  return {
    rid: row.action_type_id,
    apiName: row.api_name,
    displayName: row.display_name,
    description: row.description,
    icon: row.icon_name ?? null,
    iconColor: row.icon_color ?? null,
    saveLocationRid: row.save_location_rid ?? null,
    parameters: row.parameters,
    rules: ensureRuleRids(persistedRules, persistedRules),
    submissionCriteria: row.submission_criteria ?? null,
    sideEffects: row.side_effects ?? null,
    writebackConfig: row.writeback_config ?? null,
    functionConfig: row.function_config ?? null,
    // Migration 173 — always fully resolved, never the raw NULL blob, so the
    // Security page renders the real effective values (and every default it
    // shows is the same one the executor will enforce).
    securitySettings: resolveActionSecuritySettings(row.security_settings),
    maxAffectedObjects: row.max_affected_objects,
    isEnabled: row.is_enabled,
    status: row.is_enabled ? "ACTIVE" : "EXPERIMENTAL",
    // Semantic fields — always resolved (NULL → version 1 fallback). Every
    // response returns the persisted semantics so the frontend can branch.
    semanticsVersion: semantics.semanticsVersion,
    executionMode: semantics.executionMode,
    deletePolicy: semantics.deletePolicy,
    // Phase 6.2 — versioned definitions + If-Match optimistic-concurrency.
    // Surfaced so clients can stamp their PATCH request with `If-Match:
    // <version>` for the safe-update contract. NULL → 1 (migration 132
    // backfills every row with definition_version=1).
    definitionVersion: row.definition_version ?? 1,
    // Read-path fallback: rows written before the pin-identity rollout carry
    // definition_hash NULL (the 165 backfill stamped history snapshots only).
    // Computing the canonical hash on read is what lets the frontend stamp
    // definitionHash onto pre-rollout automation pins without requiring a
    // no-op save of every action type first. The value is the SAME scheme
    // syncDefinitionPinArtifacts() will persist on the next write, so the
    // read/write surfaces can never diverge.
    definitionHash:
      row.definition_hash ??
      hashActionDefinition(actionDefinitionInputFromRow(row)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

/**
 * Stamp create/update actor from the authenticated principal.
 * Mirrors purposes.actorOf / branches createdBy: prefer local users.id
 * (globalAuth/tellusAuth), then email, then system.
 */
export function actorOf(req: Request): string {
  const anyReq = req as any;
  return (
    anyReq.tellusPrincipal?.userId ||
    anyReq.user?.id ||
    anyReq.user?.email ||
    anyReq.auth?.preferred_username ||
    anyReq.auth?.sub ||
    "system"
  );
}

/**
 * Compute the canonical definition hash for an action-type row, given the
 * resolved semantics triple. Used by the /migrate legacy path to record the
 * optimistic-concurrency token + resulting hash in the audit ledger.
 */
export function currentDefinitionHashFor(
  row: { parameters?: unknown; rules?: unknown; function_config?: unknown },
  semantics: { semanticsVersion: number; executionMode: string; deletePolicy: string },
): string {
  return hashActionDefinition({
    parameters: row.parameters,
    rules: row.rules,
    semanticsVersion: semantics.semanticsVersion,
    executionMode: semantics.executionMode,
    deletePolicy: semantics.deletePolicy,
    functionConfig: row.function_config,
  });
}

/**
 * Resolve an object type API name to its object_type_id.
 * Returns { objectTypeId, properties } or throws VALIDATION_FAILED.
 */
export async function resolveObjectType(
  ontologyId: string,
  objectTypeApiName: string,
  contextMsg: string
): Promise<{
  objectTypeId: string;
  properties: Set<string>;
  propertyBaseTypes: Map<string, string>;
  primaryKeyProperty?: string;
  requiredProperties: Set<string>;
}> {
  const otResult = await query(
    "SELECT object_type_id, primary_key_property_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, objectTypeApiName]
  );
  if (otResult.rows.length === 0) {
    throw appError(
      "VALIDATION_FAILED",
      `${contextMsg} references non-existent object type '${objectTypeApiName}'`
    );
  }
  const objectTypeId = otResult.rows[0].object_type_id as string;

  // Fetch all property api_names for this object type
  const propResult = await query(
    "SELECT property_id, api_name, base_type, is_required FROM property WHERE object_type_id = $1",
    [objectTypeId]
  );
  const properties = new Set<string>(
    propResult.rows.map((r: Record<string, unknown>) => r.api_name as string)
  );

  return {
    objectTypeId,
    properties,
    propertyBaseTypes: new Map<string, string>(
      propResult.rows.map((row: Record<string, unknown>) => [
        row.api_name as string,
        String(row.base_type ?? "").toLowerCase(),
      ]),
    ),
    primaryKeyProperty: propResult.rows.find(
      (row: Record<string, unknown>) => row.property_id === otResult.rows[0].primary_key_property_id,
    )?.api_name as string | undefined,
    requiredProperties: new Set<string>(
      propResult.rows
        .filter((row: Record<string, unknown>) => row.is_required === true)
        .map((row: Record<string, unknown>) => row.api_name as string),
    ),
  };
}

export function validateOptionalMetadata(body: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (body.icon !== undefined && body.icon !== null) {
    if (typeof body.icon !== "string" || !/^[a-z][a-z0-9-]{0,99}$/.test(body.icon)) {
      errors.push("icon must be a valid lowercase Blueprint icon name.");
    }
  }
  if (body.iconColor !== undefined && body.iconColor !== null) {
    if (typeof body.iconColor !== "string" || !/^#[0-9a-fA-F]{6}$/.test(body.iconColor)) {
      errors.push("iconColor must be a six-digit hexadecimal color (for example #1A2230).");
    }
  }
  if (body.saveLocationRid !== undefined && body.saveLocationRid !== null) {
    if (
      typeof body.saveLocationRid !== "string" ||
      !/^ri\.compass\.main\.(?:project|folder)\.[A-Za-z0-9-]+$/.test(body.saveLocationRid)
    ) {
      errors.push("saveLocationRid must be a Compass project or folder RID.");
    }
  }
  return errors;
}

export function validateValueSource(
  value: unknown,
  path: string,
  paramNames: Set<string>,
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${path} must be a value source object.`];
  }
  const source = value as Record<string, unknown>;
  if (!VALID_SOURCES.has(source.source as string)) {
    return [`${path}.source must be one of: ${Array.from(VALID_SOURCES).join(", ")}`];
  }
  if (source.source === "parameter") {
    if (typeof source.param !== "string" || !source.param) {
      return [`${path}: source 'parameter' requires a 'param' field.`];
    }
    if (!paramNames.has(source.param)) {
      return [`${path} references non-existent parameter '${source.param}'.`];
    }
  }
  if (source.source === "writebackResponse") {
    if (typeof source.outputId !== "string" || source.outputId.length === 0) {
      return [
        `${path}: source 'writebackResponse' requires a non-empty 'outputId'.`,
      ];
    }
    if (
      source.path !== undefined &&
      (typeof source.path !== "string" ||
        (source.path !== "" && !source.path.startsWith("/")))
    ) {
      return [
        `${path}.path must be an RFC 6901 JSONPointer beginning with '/'.`,
      ];
    }
  }
  if (source.source === "objectProperty") {
    if (typeof source.param !== "string" || !paramNames.has(source.param)) {
      return [`${path} references a missing object parameter '${String(source.param ?? "")}'.`];
    }
    if (
      typeof source.path !== "string" ||
      source.path.length === 0 ||
      source.path.startsWith("/")
    ) {
      return [`${path}.path must begin with an object property API name.`];
    }
  }
  return [];
}

export function validateGeneratedSequenceSource(
  value: unknown,
  path: string,
  ruleType: string,
  propertyApiName: string,
  primaryKeyProperty: string | undefined,
  propertyBaseType: string | undefined,
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const source = value as Record<string, unknown>;
  if (source.source !== "generatedSequence") return [];
  const errors: string[] = [];
  if (ruleType !== "createObject" || propertyApiName !== primaryKeyProperty) {
    errors.push(`${path} may only generate the primary key of a Create object rule.`);
  }
  if (propertyBaseType !== "string") {
    errors.push(`${path} requires a string primary-key property.`);
  }
  if (typeof source.sequenceKey !== "string" || !/^[A-Za-z0-9:-]{1,100}$/.test(source.sequenceKey)) {
    errors.push(`${path}.sequenceKey must contain only letters, numbers, colons, or hyphens (max 100).`);
  }
  if (typeof source.prefix !== "string" || !/^[A-Za-z0-9-]{0,100}$/.test(source.prefix)) {
    errors.push(`${path}.prefix must contain only letters, numbers, or hyphens (max 100).`);
  }
  if (!Number.isInteger(source.padLength) || (source.padLength as number) < 1 || (source.padLength as number) > 18) {
    errors.push(`${path}.padLength must be an integer from 1 to 18.`);
  }
  if (source.startAt !== undefined && (!Number.isSafeInteger(source.startAt) || (source.startAt as number) < 1)) {
    errors.push(`${path}.startAt must be a positive integer when provided.`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidationContext {
  ontologyId: string;
  parameters: Array<Record<string, unknown>>;
  rules: Array<Record<string, unknown>>;
}

/**
 * Validate parameters array. Returns an array of error messages (empty = valid).
 */
export async function validateParameters(
  params: unknown[],
  ontologyId: string
): Promise<string[]> {
  const errors: string[] = [];

  if (!Array.isArray(params)) {
    errors.push("parameters must be an array.");
    return errors;
  }

  const seenNames = new Set<string>();

  for (let i = 0; i < params.length; i++) {
    const p = params[i] as Record<string, unknown>;
    const idx = `parameters[${i}]`;

    if (!p || typeof p !== "object") {
      errors.push(`${idx} must be an object.`);
      continue;
    }

    // apiName
    if (!p.apiName || typeof p.apiName !== "string" || p.apiName.trim() === "") {
      errors.push(`${idx}.apiName is required and must be a non-empty string.`);
      continue;
    }
    if (seenNames.has(p.apiName as string)) {
      errors.push(`Duplicate parameter apiName: '${p.apiName}'`);
    }
    seenNames.add(p.apiName as string);

    // displayName
    if (!p.displayName || typeof p.displayName !== "string" || (p.displayName as string).trim() === "") {
      errors.push(`${idx}.displayName is required and must be a non-empty string.`);
    }

    // type
    if (!p.type || typeof p.type !== "string") {
      errors.push(`${idx}.type is required.`);
    } else if (!VALID_PARAM_TYPES.has(p.type as string)) {
      errors.push(
        `Invalid parameter type '${p.type}' for parameter '${p.apiName}'. ` +
          `Must be one of: ${Array.from(VALID_PARAM_TYPES).join(", ")}`
      );
    }

    // objectType required for object_reference and object_set
    const paramType = p.type as string;
    if (paramType === "object_reference" || paramType === "object_set") {
      if (!p.objectType || typeof p.objectType !== "string") {
        errors.push(
          `Parameter '${p.apiName}' has type '${paramType}' but no objectType specified.`
        );
      } else {
        // Verify the referenced object type exists
        const otResult = await query(
          "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
          [ontologyId, p.objectType]
        );
        if (otResult.rows.length === 0) {
          errors.push(
            `Parameter '${p.apiName}' has type '${paramType}' but references non-existent object type '${p.objectType}'`
          );
        }
      }
    }
    if (
      paramType === "object_type_reference" ||
      paramType === "interface_reference" ||
      paramType === "interface_reference_array"
    ) {
      if (!p.interfaceId || typeof p.interfaceId !== "string") {
        errors.push(
          `Parameter '${p.apiName}' has type '${paramType}' but no interfaceId specified.`,
        );
      } else {
        const interfaceResult = await query(
          "SELECT interface_id FROM interface WHERE ontology_id = $1 AND api_name = $2",
          [ontologyId, p.interfaceId],
        );
        if (interfaceResult.rows.length === 0) {
          errors.push(
            `Parameter '${p.apiName}' references non-existent interface '${p.interfaceId}'.`,
          );
        }
      }
    }

    // structFields — Foundry-style struct authoring: a struct parameter
    // declares its fields so forms render a sub-form and execution
    // coerces/validates each field (see parameterValidator.coerceStruct).
    if (p.structFields !== undefined) {
      if (paramType !== "struct") {
        errors.push(
          `${idx}.structFields is only valid for struct parameters, not '${paramType}'.`,
        );
      } else if (!Array.isArray(p.structFields)) {
        errors.push(`${idx}.structFields must be an array.`);
      } else {
        const VALID_STRUCT_FIELD_TYPES = new Set([
          "string", "boolean", "integer", "long", "byte", "short",
          "double", "float", "decimal", "date", "timestamp",
        ]);
        const seenFields = new Set<string>();
        (p.structFields as Array<Record<string, unknown>>).forEach((field, fi) => {
          const fidx = `${idx}.structFields[${fi}]`;
          if (!field || typeof field !== "object") {
            errors.push(`${fidx} must be an object.`);
            return;
          }
          if (!field.apiName || typeof field.apiName !== "string" || field.apiName.trim() === "") {
            errors.push(`${fidx}.apiName is required and must be a non-empty string.`);
          } else if (seenFields.has(field.apiName)) {
            errors.push(`${fidx}.apiName '${field.apiName}' is duplicated within the struct.`);
          }
          if (typeof field.apiName === "string") seenFields.add(field.apiName);
          if (!field.type || typeof field.type !== "string" || !VALID_STRUCT_FIELD_TYPES.has(field.type)) {
            errors.push(
              `${fidx}.type must be one of: ${Array.from(VALID_STRUCT_FIELD_TYPES).join(", ")}.`,
            );
          }
          if (field.required !== undefined && typeof field.required !== "boolean") {
            errors.push(`${fidx}.required must be a boolean.`);
          }
        });
      }
    }

    // constraints validation
    if (p.constraints && typeof p.constraints === "object") {
      const c = p.constraints as Record<string, unknown>;
      if (c.regex !== undefined && paramType !== "string") {
        errors.push(
          `${idx}.constraints.regex is only valid for string parameters, not '${paramType}'.`
        );
      }
      if ((c.min !== undefined || c.max !== undefined) && !NUMERIC_PARAM_TYPES.has(paramType)) {
        errors.push(
          `${idx}.constraints.min/max are only valid for numeric parameters, not '${paramType}'.`
        );
      }
    }
  }

  return errors;
}

/**
 * Validate rules array. Returns an array of error messages (empty = valid).
 */
export async function validateRules(
  rules: unknown[],
  ontologyId: string,
  paramNames: Set<string>,
  parameters: Array<Record<string, unknown>>,
): Promise<string[]> {
  const errors: string[] = [];
  const orderedObjectRules: Array<{
    index: number;
    ruleId?: string;
    type: string;
    objectType: string;
    identity: string;
  }> = [];
  const orderedLinkRules: Array<{
    index: number;
    ruleId?: string;
    type: string;
    identity: string;
  }> = [];

  if (!Array.isArray(rules)) {
    errors.push("rules must be an array.");
    return errors;
  }

  if (rules.length === 0) {
    errors.push("rules must be a non-empty array (an action with no rules is meaningless).");
    return errors;
  }

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i] as Record<string, unknown>;
    const idx = `rules[${i}]`;

    if (!rule || typeof rule !== "object") {
      errors.push(`${idx} must be an object.`);
      continue;
    }

    // type
    if (!rule.type || typeof rule.type !== "string") {
      errors.push(`${idx}.type is required.`);
      continue;
    }
    if (!VALID_RULE_TYPES.has(rule.type as string)) {
      errors.push(
        `${idx}.type '${rule.type}' is invalid. Must be one of: ${Array.from(VALID_RULE_TYPES).join(", ")}`
      );
      continue;
    }

    const ruleType = rule.type as string;

    // For createObject, modifyObject, deleteObject: validate objectType reference
    if (
      ruleType === "createObject" ||
      ruleType === "modifyObject" ||
      ruleType === "modifyOrCreateObject" ||
      ruleType === "deleteObject"
    ) {
      if (!rule.objectType || typeof rule.objectType !== "string") {
        errors.push(`${idx}.objectType is required for '${ruleType}' rules.`);
        continue;
      }

      let objTypeProps: Set<string> | null = null;
      let propertyBaseTypes = new Map<string, string>();
      let primaryKeyProperty: string | undefined;
      let requiredProperties = new Set<string>();
      try {
        const resolved = await resolveObjectType(
          ontologyId,
          rule.objectType as string,
          `Rule ${idx}`
        );
        objTypeProps = resolved.properties;
        propertyBaseTypes = resolved.propertyBaseTypes;
        primaryKeyProperty = resolved.primaryKeyProperty;
        requiredProperties = resolved.requiredProperties;
      } catch (err: any) {
        errors.push(err.message);
        continue;
      }

      // Validate properties for createObject and modifyObject
      if (ruleType !== "createObject") {
        errors.push(...validateValueSource(rule.objectReference, `${idx}.objectReference`, paramNames));
      }

      if (
        (ruleType === "createObject" || ruleType === "modifyObject" || ruleType === "modifyOrCreateObject") &&
        rule.properties
      ) {
        if (typeof rule.properties !== "object" || Array.isArray(rule.properties)) {
          errors.push(`${idx}.properties must be an object.`);
          continue;
        }

        const props = rule.properties as Record<string, unknown>;
        if ((ruleType === "createObject" || ruleType === "modifyOrCreateObject") && !primaryKeyProperty) {
          errors.push(`${idx}: object type '${rule.objectType}' does not define a primary key.`);
        }
        if (
          (ruleType === "createObject" || ruleType === "modifyOrCreateObject") &&
          primaryKeyProperty &&
          !Object.prototype.hasOwnProperty.call(props, primaryKeyProperty)
        ) {
          errors.push(`${idx}.properties must map primary key property '${primaryKeyProperty}'.`);
        }
        if (ruleType === "createObject" || ruleType === "modifyOrCreateObject") {
          for (const requiredProperty of requiredProperties) {
            if (!Object.prototype.hasOwnProperty.call(props, requiredProperty)) {
              errors.push(`${idx}.properties must map required property '${requiredProperty}'.`);
            }
          }
        }
        for (const [propName, mapping] of Object.entries(props)) {
          // Validate the property exists on the object type
          if (!objTypeProps.has(propName)) {
            errors.push(
              `Rule references non-existent property '${propName}' on object type '${rule.objectType}'`
            );
          }

          // Validate the mapping source
          errors.push(...validateValueSource(mapping, `${idx}.properties.${propName}`, paramNames));
          errors.push(
            ...validateSystemValueSourceForProperty(
              mapping,
              `${idx}.properties.${propName}`,
              propertyBaseTypes.get(propName),
            ),
          );
          errors.push(
            ...validateGeneratedSequenceSource(
              mapping,
              `${idx}.properties.${propName}`,
              ruleType,
              propName,
              primaryKeyProperty,
              propertyBaseTypes.get(propName),
            ),
          );
        }
      } else if (ruleType === "createObject" || ruleType === "modifyOrCreateObject") {
        errors.push(`${idx}.properties is required for '${ruleType}' rules.`);
      }

      const objectIdentitySource =
        ruleType === "createObject"
          ? primaryKeyProperty &&
            rule.properties &&
            typeof rule.properties === "object" &&
            !Array.isArray(rule.properties)
            ? (rule.properties as Record<string, unknown>)[primaryKeyProperty]
            : undefined
          : rule.objectReference;
      if (objectIdentitySource !== undefined) {
        orderedObjectRules.push({
          index: i,
          ruleId:
            typeof rule.ruleId === "string" ? rule.ruleId : undefined,
          type: ruleType,
          objectType: String(rule.objectType),
          identity: JSON.stringify(objectIdentitySource),
        });
      }

      if (ruleType === "createObject" && rule.links !== undefined) {
        if (!Array.isArray(rule.links)) {
          errors.push(`${idx}.links must be an array when present.`);
        } else {
          const seenAttachedLinks = new Set<string>();
          for (let linkIndex = 0; linkIndex < rule.links.length; linkIndex += 1) {
            const mapping = rule.links[linkIndex];
            const linkPath = `${idx}.links[${linkIndex}]`;
            if (
              !mapping ||
              typeof mapping !== "object" ||
              Array.isArray(mapping)
            ) {
              errors.push(`${linkPath} must be an attached link mapping.`);
              continue;
            }
            const attached = mapping as Record<string, unknown>;
            if (
              typeof attached.linkType !== "string" ||
              attached.linkType.length === 0
            ) {
              errors.push(`${linkPath}.linkType is required.`);
              continue;
            }
            if (
              attached.createdObjectSide !== "source" &&
              attached.createdObjectSide !== "target"
            ) {
              errors.push(
                `${linkPath}.createdObjectSide must be 'source' or 'target'.`,
              );
              continue;
            }
            errors.push(
              ...validateValueSource(
                attached.otherObject,
                `${linkPath}.otherObject`,
                paramNames,
              ),
            );
            const identity = JSON.stringify([
              attached.linkType,
              attached.createdObjectSide,
              attached.otherObject,
            ]);
            if (seenAttachedLinks.has(identity)) {
              errors.push(
                `${linkPath} duplicates an earlier attached link mapping.`,
              );
            }
            seenAttachedLinks.add(identity);

            try {
              const linkType = await getLinkTypeByApiName(
                ontologyId,
                attached.linkType,
              );
              if (!linkType) {
                errors.push(
                  `${linkPath}.linkType '${attached.linkType}' does not exist.`,
                );
                continue;
              }
              if (linkType.cardinality !== "MANY_TO_MANY") {
                errors.push(
                  `${linkPath}.linkType '${attached.linkType}' is ${linkType.cardinality}. One-to-one and one-to-many relationships must be authored by mapping the foreign-key property in an object rule.`,
                );
              }
              const endpointId =
                attached.createdObjectSide === "source"
                  ? linkType.source_object_type
                  : linkType.target_object_type;
              const endpointApiName =
                await resolveObjectTypeApiName(endpointId);
              if (endpointApiName !== rule.objectType) {
                errors.push(
                  `${linkPath} places created '${rule.objectType}' on the ${attached.createdObjectSide} side of '${attached.linkType}', which expects '${endpointApiName}'.`,
                );
              }
            } catch {
              errors.push(
                `${linkPath}.linkType '${attached.linkType}' could not be resolved.`,
              );
            }
          }
        }
      }
    }

    if (
      ruleType === "createInterfaceObject" ||
      ruleType === "modifyInterfaceObject" ||
      ruleType === "deleteInterfaceObject"
    ) {
      if (typeof rule.interfaceId !== "string" || rule.interfaceId.length === 0) {
        errors.push(`${idx}.interfaceId is required.`);
      } else {
        const interfaceResult = await query(
          `SELECT i.interface_id, ip.api_name, ip.is_required
             FROM interface i
             LEFT JOIN interface_property ip ON ip.interface_id = i.interface_id
            WHERE i.ontology_id = $1 AND i.api_name = $2`,
          [ontologyId, rule.interfaceId],
        );
        if (interfaceResult.rows.length === 0) {
          errors.push(
            `${idx}.interfaceId '${rule.interfaceId}' does not exist in ontology.`,
          );
        } else {
          const interfaceProperties = new Set(
            interfaceResult.rows
              .map((row) => row.api_name)
              .filter((name): name is string => typeof name === "string"),
          );
          if (ruleType !== "deleteInterfaceObject") {
            if (
              !rule.properties ||
              typeof rule.properties !== "object" ||
              Array.isArray(rule.properties)
            ) {
              errors.push(`${idx}.properties must be an object.`);
            } else {
              for (const [property, source] of Object.entries(
                rule.properties as Record<string, unknown>,
              )) {
                if (!interfaceProperties.has(property)) {
                  errors.push(
                    `${idx}.properties.${property} is not a shared property of interface '${rule.interfaceId}'.`,
                  );
                }
                errors.push(
                  ...validateValueSource(
                    source,
                    `${idx}.properties.${property}`,
                    paramNames,
                  ),
                );
              }
            }
          }
        }
      }

      if (ruleType === "createInterfaceObject") {
        const objectTypeParameter =
          typeof rule.objectTypeParameter === "string"
            ? parameters.find(
                (parameter) =>
                  parameter.apiName === rule.objectTypeParameter,
              )
            : undefined;
        if (
          !objectTypeParameter ||
          objectTypeParameter.type !== "object_type_reference" ||
          objectTypeParameter.interfaceId !== rule.interfaceId
        ) {
          errors.push(
            `${idx}.objectTypeParameter must reference an object_type_reference parameter constrained to interface '${String(rule.interfaceId ?? "")}'.`,
          );
        }
      } else {
        errors.push(
          ...validateValueSource(
            rule.interfaceReference,
            `${idx}.interfaceReference`,
            paramNames,
          ),
        );
      }
    }

    // For addLink/removeLink: validate canonical rule shape.
    if (ruleType === "addLink" || ruleType === "removeLink") {
      // Pure structural shape check first (canonical linkType / sourceObject /
      // targetObject). Delegates to the pure helper so the same check is
      // available to unit tests and the FE without standing up Postgres.
      for (const shapeErr of validateConcreteLinkRuleShape(rule)) {
        errors.push(`${idx}: ${shapeErr}`);
      }
      // Ontology-coupled existence check — only run when the shape is valid.
      if (errors.filter((e) => e.startsWith(`${idx}:`)).length === 0) {
        await validateConcreteLinkRule(rule, idx, paramNames, ontologyId, errors);
      }
      if (
        typeof (rule.linkType ?? rule.linkTypeApiName) === "string" &&
        rule.sourceObject !== undefined &&
        rule.targetObject !== undefined
      ) {
        orderedLinkRules.push({
          index: i,
          ruleId:
            typeof rule.ruleId === "string" ? rule.ruleId : undefined,
          type: ruleType,
          identity: JSON.stringify([
            rule.linkType ?? rule.linkTypeApiName,
            rule.sourceObject,
            rule.targetObject,
          ]),
        });
      }
    }

    // For createInterfaceLink / deleteInterfaceLink: Phase 2 enabled.
    // Persistence requires the interface_link_constraint to exist and the
    // rule's declared `interfaceId` to match its owning interface.
    if (ruleType === "createInterfaceLink" || ruleType === "deleteInterfaceLink") {
      for (const shapeErr of validateInterfaceLinkRuleShape(rule)) {
        errors.push(`${idx}: ${shapeErr}`);
      }
      // Only run the DE-coupled semantics check when the shape is valid;
      // the structural shape errors above are enough otherwise.
      const shapeHadError = errors.some((e) => e.startsWith(`${idx}:`));
      if (!shapeHadError) {
        await validateInterfaceLinkRule(rule, idx, paramNames, ontologyId, errors);
      }
    }
  }

  const firstCreate = new Map<string, (typeof orderedObjectRules)[number]>();
  const firstDelete = new Map<string, (typeof orderedObjectRules)[number]>();
  for (const entry of orderedObjectRules) {
    const key = `${entry.objectType}:${entry.identity}`;
    const create = firstCreate.get(key);
    const deletion = firstDelete.get(key);
    if (entry.type === "createObject") {
      if (create) {
        errors.push(
          `rules[${entry.index}]${entry.ruleId ? ` (${entry.ruleId})` : ""} duplicates object creation from rules[${create.index}]${create.ruleId ? ` (${create.ruleId})` : ""}. Keep one create rule for this object identity.`,
        );
      }
      if (deletion) {
        errors.push(
          `rules[${entry.index}] creates an object after rules[${deletion.index}] deleted the same identity. Move deletion after all object rules or remove the conflicting rule.`,
        );
      }
      firstCreate.set(key, create ?? entry);
      continue;
    }
    if (
      (entry.type === "modifyObject" ||
        entry.type === "modifyOrCreateObject") &&
      deletion
    ) {
      errors.push(
        `rules[${entry.index}] modifies an object after rules[${deletion.index}] deleted the same identity. Move the delete rule later.`,
      );
    }
    if (entry.type === "deleteObject") {
      firstDelete.set(key, deletion ?? entry);
    }
  }

  const laterCreates = new Map<string, (typeof orderedObjectRules)[number]>();
  for (const entry of [...orderedObjectRules].reverse()) {
    const key = `${entry.objectType}:${entry.identity}`;
    const laterCreate = laterCreates.get(key);
    if (
      laterCreate &&
      (entry.type === "modifyObject" ||
        entry.type === "modifyOrCreateObject" ||
        entry.type === "deleteObject")
    ) {
      errors.push(
        `rules[${entry.index}] ${entry.type === "deleteObject" ? "deletes" : "modifies"} an object before rules[${laterCreate.index}] creates the same identity. Move the create rule earlier.`,
      );
    }
    if (entry.type === "createObject") laterCreates.set(key, entry);
  }

  const linkCreates = new Map<string, (typeof orderedLinkRules)[number]>();
  for (const entry of orderedLinkRules) {
    const earlier = linkCreates.get(entry.identity);
    if (entry.type === "addLink") {
      if (earlier) {
        errors.push(
          `rules[${entry.index}] duplicates link creation from rules[${earlier.index}]. Remove the duplicate or map different endpoints.`,
        );
      } else {
        linkCreates.set(entry.identity, entry);
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Phase 4 — writeback_config validation
//
//  {
//    webhookId: <connectivity webhook RID | legacy registry name>,
//    webhookVersion: number,                // immutable, versioned reference
//    inputs: Record<webhookInputName, ValueSource>,  // each validated via validateValueSource
//    outputBindings?: Record<outputId, {
//       outputId: string, path: string (JSONPointer), schema: object, valueType: string
//    }>,
//    failurePolicy: "abort"
//  }
//
// `webhookId` is a dual-typed reference:
//   * `ri.magritte.main.webhook.<uuid>` — a REAL data-connection webhook,
//     resolved against the connectivity webhook store (pinned immutable
//     version). This is the canonical binding going forward.
//   * anything else — a legacy `webhook_definition` registry name
//     (backward compatibility for action types authored before the
//     connectivity wiring).
//
// One-writeback-per-action is FIRST enforced structurally by migration 130's
// CHECK constraint (writeback_config is a JSONB object, not array); the
// shape check here is also defence-in-depth.
//
// Persistence accepts NULL (no writeback). When body.writebackConfig is
// undefined → null (no writeback). When present → structurally validated.
// ---------------------------------------------------------------------------

/**
 * Foundry parity: a webhook-backed action (writeback and/or webhook side
 * effect) is meaningful even with zero object-edit rules — Foundry's
 * webhook tutorial attaches the webhook in Logic and requires no edit
 * rules. The legacy "enabled actions must declare at least one rule" guard
 * therefore applies only when no webhook binding is present.
 */
export function hasWebhookBinding(writeback: unknown, sideEffects: unknown): boolean {
  const wb = (writeback ?? undefined) as Record<string, unknown> | undefined;
  const se = (sideEffects ?? undefined) as Record<string, unknown> | undefined;
  return (
    typeof wb?.webhookId === "string" ||
    (Array.isArray(se?.webhooks) && (se.webhooks as unknown[]).length > 0)
  );
}

export async function validateWritebackConfig(
  wb: unknown,
  ontologyId: string,
  paramNames: Set<string>,
  parameters: Array<Record<string, unknown>>,
  tenant: string,
  requireComplete = true,
): Promise<string[]> {
  const errors: string[] = [];
  if (wb === undefined || wb === null) return errors; // null is fine (no writeback)

  if (typeof wb !== "object" || Array.isArray(wb)) {
    errors.push("writeback_config must be a JSON object (not an array — at most one writeback per action type).");
    return errors;
  }
  const wbRow = wb as Record<string, unknown>;

  // webhookId — string; a connectivity webhook RID (canonical) or a
  // legacy registry name.
  if (typeof wbRow.webhookId !== "string" || wbRow.webhookId.length === 0) {
    errors.push("writeback_config.webhookId is required (the webhook's RID or name).");
  }
  const isConnectivityRef =
    typeof wbRow.webhookId === "string" &&
    wbRow.webhookId.startsWith(CONNECTIVITY_WEBHOOK_RID_PREFIX);
  // webhookVersion — positive integer
  if (typeof wbRow.webhookVersion !== "number" ||
      !Number.isInteger(wbRow.webhookVersion) ||
      wbRow.webhookVersion < 1) {
    errors.push("writeback_config.webhookVersion is required and must be a positive integer (the explicit immutable version reference — action_type bindings never silently follow webhook updates).");
  }

  // failurePolicy — must be 'abort' (Phase 4 only supports this)
  if (wbRow.failurePolicy !== "abort") {
    errors.push("writeback_config.failurePolicy must be 'abort' (Phase 4 only supports abort-on-fail; ontology edits are NOT applied when writeback fails).");
  }

  // inputs — Record<string, ValueSource>
  if (!wbRow.inputs || typeof wbRow.inputs !== "object" || Array.isArray(wbRow.inputs)) {
    errors.push("writeback_config.inputs is required (Record<string, ValueSource>) — each input maps to a value source on the action's parameters.");
  } else {
    const inputs = wbRow.inputs as Record<string, unknown>;
    // The registry-era "at least one input" rule only applies to LEGACY
    // registry references: a data-connection webhook may legitimately
    // declare zero inputs (fire-and-forget calls), in which case an
    // empty mapping is correct. Connectivity-declared input coverage is
    // validated against the webhook's own declaration below.
    if (!isConnectivityRef && Object.keys(inputs).length === 0) {
      errors.push("writeback_config.inputs must declare at least one input (an action with no writeback inputs is meaningless).");
    }
    for (const [name, src] of Object.entries(inputs)) {
      errors.push(...validateValueSource(src, `writeback_config.inputs.${name}`, paramNames));
    }
  }

  // outputBindings — optional, but if present each entry must be structurally valid.
  if (wbRow.outputBindings !== undefined && wbRow.outputBindings !== null) {
    if (typeof wbRow.outputBindings !== "object" || Array.isArray(wbRow.outputBindings)) {
      errors.push("writeback_config.outputBindings must be a Record<string, WritebackOutputDefinition> object when present.");
    } else {
      for (const [oid, def] of Object.entries(wbRow.outputBindings as Record<string, unknown>)) {
        if (!def || typeof def !== "object" || Array.isArray(def)) {
          errors.push(`writeback_config.outputBindings.${oid} must be a WritebackOutputDefinition object.`);
          continue;
        }
        const d = def as Record<string, unknown>;
        if (typeof d.outputId !== "string" || d.outputId.length === 0) {
          errors.push(`writeback_config.outputBindings.${oid}.outputId is required.`);
        }
        if (typeof d.path !== "string") {
          errors.push(`writeback_config.outputBindings.${oid}.path is required (RFC 6901 JSONPointer).`);
        }
        if (!d.schema || typeof d.schema !== "object" || Array.isArray(d.schema)) {
          errors.push(`writeback_config.outputBindings.${oid}.schema is required (JSON Schema for this output).`);
        }
        if (typeof d.valueType !== "string" || d.valueType.length === 0) {
          errors.push(`writeback_config.outputBindings.${oid}.valueType is required (ontology base type for save-time typecheck).`);
        }
      }
    }
  }

  // Verify the referenced webhook (webhookId + webhookVersion) exists and is
  // bindable. The route layer surfaces a structured error here so
  // the user doesn't author an action type bound to a webhook that can't
  // be invoked at execution time.
  if (errors.length === 0 && typeof wbRow.webhookId === "string" && typeof wbRow.webhookVersion === "number") {
    if (isConnectivityRef) {
      errors.push(
        ...(await validateConnectivityWebhookBinding(
          wbRow.webhookId,
          wbRow.webhookVersion,
          (wbRow.inputs ?? {}) as Record<string, unknown>,
          parameters,
          ontologyId,
          tenant,
          requireComplete,
          wbRow.inputFunction,
        )),
      );
    } else {
      const wh = await getWebhookByNameVersion(ontologyId, wbRow.webhookId, wbRow.webhookVersion);
      if (!wh) {
        errors.push(`writeback_config references webhook '${wbRow.webhookId}' v${wbRow.webhookVersion} which does not exist in this ontology. PATCH the webhook to bump the version, or DELETE + recreate to release the version slot, then re-bind the action type.`);
      } else if (wh.status === "disabled") {
        errors.push(`writeback_config references webhook '${wbRow.webhookId}' v${wbRow.webhookVersion} which is 'disabled'. New action types cannot bind disabled webhook versions.`);
      }
    }
  }

  return errors;
}

/**
 * Validates a writeback binding against the REAL data-connection webhook
 * store (connectivity engine):
 *
 *   1. The pinned version must exist (bindings never silently follow the
 *      webhook's current version).
 *   2. Lifecycle gate — mirrors the registry's "cannot bind disabled"
 *      semantics across the richer connectivity lifecycle: `disabled`,
 *      `archived` and `failed` configurations can never execute, so they
 *      cannot be bound. Pre-activation states (`draft` / `validating` /
 *      `ready`) MAY be bound — the author can activate the webhook
 *      afterwards; the connectivity executor hard-refuses non-active
 *      production execution regardless.
 *   3. Input-mapping coverage — every mapped key must be a declared
 *      input of the webhook version, and every REQUIRED declared input
 *      must have a mapping. This replaces the registry-era
 *      "at least one input" heuristic with the webhook's own contract.
 */
export async function validateConnectivityWebhookBinding(
  webhookRid: string,
  webhookVersion: number,
  inputs: Record<string, unknown>,
  parameters: Array<Record<string, unknown>>,
  ontologyId: string,
  tenant: string,
  requireComplete = true,
  inputFunction?: unknown,
): Promise<string[]> {
  const errors: string[] = [];
  let webhook;
  try {
    webhook = await getConnectivityWebhookByRid(webhookRid, tenant, webhookVersion);
  } catch {
    errors.push(
      `writeback_config references data-connection webhook '${webhookRid}' v${webhookVersion} which does not exist. Check the webhook RID and version on the source's Webhooks tab, then re-bind the action type.`,
    );
    return errors;
  }
  if (webhook.status === "disabled" || webhook.status === "archived" || webhook.status === "failed") {
    errors.push(
      `writeback_config references data-connection webhook '${webhook.displayName}' (${webhookRid}) which is '${webhook.status}'. New action types cannot bind a webhook in this state.`,
    );
    return errors;
  }
  const declared = webhook.configuration.inputs ?? [];
  if (inputFunction !== undefined) {
    if (Object.keys(inputs).length > 0) {
      errors.push(
        "writeback_config cannot combine direct input mappings with inputFunction.",
      );
    }
    errors.push(
      ...(await validateWebhookInputFunction(
        inputFunction,
        parameters,
        declared,
      )),
    );
    return errors;
  }
  const declaredIds = new Set(declared.map((input) => input.id));
  for (const key of Object.keys(inputs)) {
    if (!declaredIds.has(key)) {
      errors.push(
        `writeback_config.inputs.${key} is not a declared input of webhook '${webhook.displayName}' v${webhookVersion}. Declared inputs: ${declared.map((i) => i.id).join(", ") || "(none)"}.`,
      );
    }
  }
  for (const input of declared) {
    if (requireComplete && input.required && !(input.id in inputs)) {
      errors.push(
        `writeback_config.inputs is missing a mapping for required input '${input.id}' declared by webhook '${webhook.displayName}' v${webhookVersion}.`,
      );
    }
    const mapping = inputs[input.id];
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
      continue;
    }
    const source = mapping as Record<string, unknown>;
    if (source.source === "parameter" && typeof source.param === "string") {
      const parameter = parameters.find(
        (candidate) => candidate.apiName === source.param,
      );
      if (
        parameter &&
        !isActionParameterCompatibleWithWebhook(
          {
            apiName: String(parameter.apiName),
            type: String(parameter.type),
            required: parameter.required === true,
          },
          input.type,
        )
      ) {
        errors.push(
          `writeback_config.inputs.${input.id} maps action parameter '${source.param}' of type '${parameter.type}' to incompatible webhook type '${input.type.kind}'.`,
        );
      }
      if (parameter && input.required && parameter.required !== true) {
        errors.push(
          `writeback_config.inputs.${input.id} is required, but action parameter '${source.param}' is optional and may be unavailable at execution time.`,
        );
      }
    }
    if (
      source.source === "objectProperty" &&
      typeof source.param === "string" &&
      typeof source.path === "string"
    ) {
      const parameter = parameters.find(
        (candidate) => candidate.apiName === source.param,
      );
      if (!parameter || parameter.type !== "object_reference") {
        errors.push(
          `writeback_config.inputs.${input.id} must source object properties from an object_reference parameter.`,
        );
      } else if (typeof parameter.objectType !== "string") {
        errors.push(
          `writeback_config.inputs.${input.id} uses object parameter '${source.param}' without an objectType.`,
        );
      } else {
        const [propertyApiName, ...nestedPath] = source.path.split("/").filter(Boolean);
        const propertyResult = await query(
          `SELECT p.base_type, p.is_required
             FROM property p
             JOIN object_type ot ON ot.object_type_id = p.object_type_id
            WHERE ot.ontology_id = $1
              AND ot.api_name = $2
              AND p.api_name = $3`,
          [ontologyId, parameter.objectType, propertyApiName],
        );
        const property = propertyResult.rows[0] as
          | { base_type: string; is_required: boolean }
          | undefined;
        if (!property) {
          errors.push(
            `writeback_config.inputs.${input.id} references missing property '${source.path}' on '${parameter.objectType}'.`,
          );
        } else if (nestedPath.length > 0 && property.base_type !== "struct") {
          errors.push(
            `writeback_config.inputs.${input.id} path '${source.path}' is nested beneath non-struct property '${propertyApiName}'.`,
          );
        } else if (
          nestedPath.length === 0 &&
          !isActionParameterCompatibleWithWebhook(
            {
              apiName: propertyApiName,
              type: property.base_type,
              required: property.is_required,
            },
            input.type,
          )
        ) {
          errors.push(
            `writeback_config.inputs.${input.id} maps property '${source.path}' of type '${property.base_type}' to incompatible webhook type '${input.type.kind}'.`,
          );
        } else if (
          input.required &&
          property.is_required !== true
        ) {
          errors.push(
            `writeback_config.inputs.${input.id} is required, but object property '${source.path}' is nullable.`,
          );
        }
      }
    }
    if (
      source.source === "static" &&
      !isStaticWebhookValueCompatible(
        source.value,
        input.type,
        !input.required,
      )
    ) {
      errors.push(
        `writeback_config.inputs.${input.id} has a static value incompatible with webhook type '${input.type.kind}'${input.required ? "" : " or its nullable contract"}.`,
      );
    }
    if (source.source === "currentUser" && input.type.kind !== "string") {
      errors.push(
        `writeback_config.inputs.${input.id} maps current user to incompatible webhook type '${input.type.kind}'; current user is a string principal identifier.`,
      );
    }
    if (
      source.source === "currentTimestamp" &&
      input.type.kind !== "timestamp"
    ) {
      errors.push(
        `writeback_config.inputs.${input.id} maps current submission time to incompatible webhook type '${input.type.kind}'.`,
      );
    }
    if (source.source === "writebackResponse") {
      errors.push(
        `writeback_config.inputs.${input.id} cannot read a response from the same writeback before it executes.`,
      );
    }
  }
  return errors;
}

export async function validateWebhookInputFunction(
  raw: unknown,
  parameters: Array<Record<string, unknown>>,
  webhookInputs: ReadonlyArray<{
    id: string;
    required: boolean;
    type: WebhookParameterTypeValue;
  }>,
): Promise<string[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return ["writeback_config.inputFunction must be an object."];
  }
  const config = raw as Record<string, unknown>;
  const errors: string[] = [];
  const requiredStrings = [
    "functionRid",
    "repositoryRid",
    "apiName",
    "branch",
    "semver",
  ] as const;
  for (const key of requiredStrings) {
    if (typeof config[key] !== "string" || !config[key]) {
      errors.push(`writeback_config.inputFunction.${key} is required.`);
    }
  }
  if (config.resultMode !== "single" && config.resultMode !== "list") {
    errors.push(
      "writeback_config.inputFunction.resultMode must be 'single' or 'list'.",
    );
  }
  if (
    !config.arguments ||
    typeof config.arguments !== "object" ||
    Array.isArray(config.arguments)
  ) {
    errors.push(
      "writeback_config.inputFunction.arguments must be a value-source map.",
    );
  }
  if (errors.length > 0) return errors;

  const found = await query(
    `SELECT f.repository_rid, f.api_name, v.signature, v.function_kind,
            fv.state, fv.runtime
       FROM function_registry_function f
       JOIN function_registry_function_version v
         ON v.function_rid = f.rid
        AND v.branch = $2
        AND v.semver = $3
       JOIN function_version fv ON fv.rid = v.release_version_rid
      WHERE f.rid = $1`,
    [config.functionRid, config.branch, config.semver],
  );
  const row = found.rows[0] as
    | {
        repository_rid: string;
        api_name: string;
        signature: PublishedFunctionSignature | null;
        function_kind: string | null;
        state: string;
        runtime: string;
      }
    | undefined;
  if (!row) {
    return [
      `Published Function '${config.functionRid}' ${config.semver} was not found.`,
    ];
  }
  if (
    row.repository_rid !== config.repositoryRid ||
    row.api_name !== config.apiName
  ) {
    errors.push(
      "writeback_config.inputFunction identity does not match the Function Registry record.",
    );
  }
  if (row.state !== "AVAILABLE" || row.runtime !== "NODE_20") {
    errors.push(
      `Function version is not callable (state=${row.state}, runtime=${row.runtime}).`,
    );
  }
  if (row.function_kind !== "query") {
    errors.push(
      `Function '${config.apiName}' must be a query Function to derive webhook inputs.`,
    );
  }
  if (!row.signature || typeof row.signature.output !== "string") {
    errors.push("Published Function is missing a typed return contract.");
    return errors;
  }

  const argumentMappings = config.arguments as Record<string, unknown>;
  const signatureNames = new Set(
    row.signature.parameters.map((parameter) => parameter.name),
  );
  for (const name of Object.keys(argumentMappings)) {
    if (!signatureNames.has(name)) {
      errors.push(
        `writeback_config.inputFunction.arguments.${name} references a deleted Function parameter.`,
      );
    }
  }
  for (const functionParameter of row.signature.parameters) {
    const mapping = argumentMappings[functionParameter.name];
    if (mapping === undefined) {
      if (!functionParameter.optional) {
        errors.push(
          `writeback_config.inputFunction.arguments is missing required Function input '${functionParameter.name}'.`,
        );
      }
      continue;
    }
    errors.push(
      ...validateValueSource(
        mapping,
        `writeback_config.inputFunction.arguments.${functionParameter.name}`,
        new Set(
          parameters
            .map((parameter) => parameter.apiName)
            .filter((name): name is string => typeof name === "string"),
        ),
      ),
    );
    const parsed = parsePublishedFunctionType(functionParameter.type);
    if (!parsed) {
      errors.push(
        `Function input '${functionParameter.name}' has unsupported type '${functionParameter.type}'.`,
      );
      continue;
    }
    if (
      mapping &&
      typeof mapping === "object" &&
      !Array.isArray(mapping)
    ) {
      const source = mapping as Record<string, unknown>;
      if (source.source === "parameter" && typeof source.param === "string") {
        const actionParameter = parameters.find(
          (parameter) => parameter.apiName === source.param,
        );
        if (
          actionParameter &&
          !isActionParameterCompatibleWithWebhook(
            {
              apiName: String(actionParameter.apiName),
              type: String(actionParameter.type),
              required: actionParameter.required === true,
            },
            parsed.type,
          )
        ) {
          errors.push(
            `Action parameter '${source.param}' is incompatible with Function input '${functionParameter.name}' (${functionParameter.type}).`,
          );
        }
      } else if (
        source.source === "static" &&
        !isStaticWebhookValueCompatible(
          source.value,
          parsed.type,
          functionParameter.optional || parsed.nullable,
        )
      ) {
        errors.push(
          `Static value for Function input '${functionParameter.name}' is incompatible with '${functionParameter.type}'.`,
        );
      }
    }
  }
  const contract = validateFunctionWebhookContract(
    row.signature,
    webhookInputs,
    config.resultMode as "single" | "list",
  );
  errors.push(...contract.errors.map((error) => `inputFunction: ${error}`));
  return errors;
}

interface LocatedWritebackSource {
  path: string;
  outputId: string;
  pointer: string;
}

export function collectWritebackSources(
  value: unknown,
  path: string,
  found: LocatedWritebackSource[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectWritebackSources(entry, `${path}[${index}]`, found),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (
    record.source === "writebackResponse" &&
    typeof record.outputId === "string"
  ) {
    found.push({
      path,
      outputId: record.outputId,
      pointer: typeof record.path === "string" ? record.path : "",
    });
    return;
  }
  for (const [key, nested] of Object.entries(record)) {
    collectWritebackSources(nested, `${path}.${key}`, found);
  }
}

export function decodeJsonPointer(pointer: string): string[] | null {
  if (pointer === "" || pointer === "/") return [];
  if (!pointer.startsWith("/")) return null;
  const parts = pointer.slice(1).split("/");
  if (parts.some((part) => /~(?![01])/u.test(part))) return null;
  return parts.map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

export function resolveWebhookOutputPath(
  root: WebhookParameterTypeValue,
  pointer: string,
): string | null {
  const segments = decodeJsonPointer(pointer);
  if (segments === null) return "is not a valid RFC 6901 JSONPointer";
  let current = root;
  for (const segment of segments) {
    if (current.kind === "record") {
      const field = current.fields.find((candidate) => candidate.id === segment);
      if (!field) return `references missing record field '${segment}'`;
      current = field.type;
      continue;
    }
    if (current.kind === "list") {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) {
        return `must use a non-negative array index at '${segment}'`;
      }
      current = current.elementType;
      continue;
    }
    return `cannot descend through primitive output type '${current.kind}' at '${segment}'`;
  }
  return null;
}

/**
 * Cross-validates every rule-level writeback source against the immutable
 * webhook version. This is deliberately independent of the editor: stale
 * output ids and nested paths are rejected again on save.
 */
export async function validateWritebackOutputReferences(
  rules: unknown[],
  writebackConfig: unknown,
  tenant: string,
): Promise<string[]> {
  const references: LocatedWritebackSource[] = [];
  rules.forEach((rule, index) =>
    collectWritebackSources(rule, `rules[${index}]`, references),
  );
  if (references.length === 0) return [];
  if (
    !writebackConfig ||
    typeof writebackConfig !== "object" ||
    Array.isArray(writebackConfig)
  ) {
    return references.map(
      (reference) =>
        `${reference.path} reads writeback output '${reference.outputId}', but this Action Type has no writeback webhook.`,
    );
  }
  const config = writebackConfig as Record<string, unknown>;
  if (
    typeof config.webhookId !== "string" ||
    typeof config.webhookVersion !== "number"
  ) {
    return [];
  }

  if (config.webhookId.startsWith(CONNECTIVITY_WEBHOOK_RID_PREFIX)) {
    let webhook;
    try {
      webhook = await getConnectivityWebhookByRid(
        config.webhookId,
        tenant,
        config.webhookVersion,
      );
    } catch {
      return [];
    }
    const outputs = new Map(
      (webhook.configuration.outputs ?? []).map((output) => [
        output.id,
        output,
      ]),
    );
    const errors: string[] = [];
    for (const reference of references) {
      const output = outputs.get(reference.outputId);
      if (!output) {
        errors.push(
          `${reference.path} references missing output '${reference.outputId}' on webhook '${webhook.displayName}' v${config.webhookVersion}. Select a current output or update the pinned webhook version.`,
        );
        continue;
      }
      const pathError = resolveWebhookOutputPath(
        output.type,
        reference.pointer,
      );
      if (pathError) {
        errors.push(
          `${reference.path}.path '${reference.pointer}' ${pathError} for output '${reference.outputId}'.`,
        );
      }
    }
    return errors;
  }

  const bindings =
    config.outputBindings &&
    typeof config.outputBindings === "object" &&
    !Array.isArray(config.outputBindings)
      ? (config.outputBindings as Record<string, unknown>)
      : {};
  return references
    .filter((reference) => !(reference.outputId in bindings))
    .map(
      (reference) =>
        `${reference.path} references missing writeback output binding '${reference.outputId}'.`,
    );
}

/**
 * Validate post-commit side effects. Legacy URL webhook specs remain
 * supported; newly-authored UI bindings use the connectivity RID/version
 * form and share the same immutable-contract validation as writebacks.
 */
export async function validateSideEffectsConfig(
  value: unknown,
  paramNames: Set<string>,
  parameters: Array<Record<string, unknown>>,
  ontologyId: string,
  tenant: string,
  requireComplete = true,
): Promise<string[]> {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) {
    return ["sideEffects must be a JSON object."];
  }
  const webhooks = (value as Record<string, unknown>).webhooks;
  if (webhooks === undefined) return [];
  if (!Array.isArray(webhooks)) return ["sideEffects.webhooks must be an array."];

  const errors: string[] = [];
  for (let index = 0; index < webhooks.length; index += 1) {
    const entryErrorCount = errors.length;
    const path = `sideEffects.webhooks[${index}]`;
    const entry = webhooks[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${path} must be an object.`);
      continue;
    }
    const spec = entry as Record<string, unknown>;
    // Existing installations may contain direct URL delivery specs.
    if (spec.kind !== "connectivity") {
      if (typeof spec.url !== "string" || spec.url.length === 0) {
        errors.push(`${path}.url is required for a legacy webhook side effect.`);
      }
      continue;
    }
    if (typeof spec.webhookId !== "string" || !spec.webhookId.startsWith(CONNECTIVITY_WEBHOOK_RID_PREFIX)) {
      errors.push(`${path}.webhookId must be a connectivity webhook RID.`);
      continue;
    }
    if (typeof spec.webhookVersion !== "number" || !Number.isInteger(spec.webhookVersion) || spec.webhookVersion < 1) {
      errors.push(`${path}.webhookVersion must be a positive integer.`);
      continue;
    }
    if (!spec.inputs || typeof spec.inputs !== "object" || Array.isArray(spec.inputs)) {
      errors.push(`${path}.inputs must be a Record<string, ValueSource>.`);
      continue;
    }
    const inputs = spec.inputs as Record<string, unknown>;
    for (const [name, source] of Object.entries(inputs)) {
      errors.push(...validateValueSource(source, `${path}.inputs.${name}`, paramNames));
    }
    if (errors.length === entryErrorCount) {
      const bindingErrors = await validateConnectivityWebhookBinding(
        spec.webhookId,
        spec.webhookVersion,
        inputs,
        parameters,
        ontologyId,
        tenant,
        requireComplete,
        spec.inputFunction,
      );
      errors.push(...bindingErrors.map((error) => error.split("writeback_config").join(path)));
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Concrete link rule (addLink / removeLink) validator — canonical shape
//
//  {
//    type: "addLink" | "removeLink",
//    linkType:  <apiName>           // canonical; legacy `linkTypeApiName` accepted as alias
//    sourceObject: ValueSource,     // { source: "parameter", param, objectType? }
//    targetObject: ValueSource,
//  }
//
// The runtime (ruleCompiler.ts + linkRules.ts) reads `linkType` (NOT
// `linkTypeApiName`). Seeded / pre-canonical data persisted `linkTypeApiName`
// alongside or instead — those rows keep validating because we accept either
// field here and the runtime falls back to `linkTypeApiName` when `linkType`
// is absent. New FE-authored rules MUST emit `linkType` only.
// ---------------------------------------------------------------------------

export async function validateConcreteLinkRule(
  rule: Record<string, unknown>,
  idx: string,
  paramNames: Set<string>,
  ontologyId: string,
  errors: string[],
): Promise<void> {
  const linkTypeRaw = (rule.linkType ?? rule.linkTypeApiName) as unknown;
  if (typeof linkTypeRaw !== "string" || linkTypeRaw.length === 0) {
    errors.push(`${idx}.linkType is required (canonical field used by the runtime). The legacy alias 'linkTypeApiName' is accepted on input only.`);
    return;
  }

  // Verify the link type exists in this ontology. The runtime would
  // otherwise fail at compile-time with a less helpful error.
  try {
    const linkType = await getLinkTypeByApiName(ontologyId, linkTypeRaw);
    if (!linkType) {
      errors.push(`${idx}.linkType '${linkTypeRaw}' does not exist in ontology '${ontologyId}'.`);
    }
  } catch {
    errors.push(`${idx}.linkType '${linkTypeRaw}' could not be resolved against ontology '${ontologyId}'.`);
  }

  // sourceObject / targetObject — both required ValueSources.
  if (!rule.sourceObject || typeof rule.sourceObject !== "object" || Array.isArray(rule.sourceObject)) {
    errors.push(`${idx}.sourceObject is required and must be a ValueSource object.`);
  } else {
    errors.push(...validateValueSource(rule.sourceObject, `${idx}.sourceObject`, paramNames));
  }
  if (!rule.targetObject || typeof rule.targetObject !== "object" || Array.isArray(rule.targetObject)) {
    errors.push(`${idx}.targetObject is required and must be a ValueSource object.`);
  } else {
    errors.push(...validateValueSource(rule.targetObject, `${idx}.targetObject`, paramNames));
  }
}

// ---------------------------------------------------------------------------
// Interface-link rule validator — Phase 2 (runtime enabled)
//
//  {
//    type: "createInterfaceLink" | "deleteInterfaceLink",
//    interfaceLinkConstraint: <apiName>,
//    interfaceId: <apiName>,
//    source: ValueSource,
//    target: ValueSource,
//  }
//
// Phase 2 persistence path:
//   * structural shape is checked first against the pure
//     `validateInterfaceLinkRuleShape` helper (no DB)
//   * the interface_link_constraint referenced must exist in the ontology
//     and must be in `active` (or `deprecated`, with a structured warning)
//     status (lifecycle transitions enforced at the route layer for
//     create/update; this validator enforces only "constraint exists")
//   * the declared `interfaceId` on the rule MUST match the constraint's
//     owning interface apiName (a sanity check; the runtime resolver
//     re-validates)
//   * source / target must be present and structurally correct
//     ValueSources (param-name validity checked by `validateValueSource`)
//
// The runtime resolver (`actions/rules/interfaceLinkRules.ts`) is the
// authoritative producer of edit-either a single concrete addLink when
// resolution is unambiguous, or a `AMBIGUOUS_INTERFACE_LINK_IMPLEMENTATION`
// 422 when >1 candidate matches on create, or a deterministic all-matching
// removeLink list on delete. Save-time validation here is structural +
// constraint existence + declared interface match; runtime resolution is
// at execution time.
// ---------------------------------------------------------------------------

export async function validateInterfaceLinkRule(
  rule: Record<string, unknown>,
  idx: string,
  paramNames: Set<string>,
  ontologyId: string,
  errors: string[],
): Promise<void> {
  if (typeof rule.interfaceLinkConstraint !== "string" || rule.interfaceLinkConstraint.length === 0) {
    errors.push(`${idx}.interfaceLinkConstraint is required.`);
  } else {
    // Load the constraint to verify existence + the declared owning
    // interface matches. Structural shape was already validated by
    // `validateInterfaceLinkRuleShape` (pure, called before this); we
    // consult the constraint row for the save-time sanity check.
    const constraint = await getInterfaceLinkConstraintByApiName(
      ontologyId,
      rule.interfaceLinkConstraint as string,
    );
    if (!constraint) {
      errors.push(
        `${idx}.interfaceLinkConstraint '${rule.interfaceLinkConstraint}' does not exist in ontology.`,
      );
    } else {
      // Verify the rule's declared `interfaceId` matches the constraint's owning interface.
      const ifaceRes = await query(
        "SELECT api_name FROM interface WHERE interface_id = $1",
        [constraint.interface_id],
      );
      const constraintOwnerApiName = ifaceRes.rows[0]?.api_name;
      if (rule.interfaceId && constraintOwnerApiName && rule.interfaceId !== constraintOwnerApiName) {
        errors.push(
          `${idx}.interfaceId '${rule.interfaceId}' does not match the constraint's owning interface '${constraintOwnerApiName}'.`,
        );
      }
      // Save-time lifecycle: action types referencing a 'deprecated'
      // constraint can no longer be persisted (existing action types that
      // were saved while the constraint was 'active' continue to execute —
      // enforcement is at the route layer here, not at execution time).
      if (constraint.status === "deprecated") {
        errors.push(
          `${idx}.interfaceLinkConstraint '${rule.interfaceLinkConstraint}' is deprecated; action types referencing it can no longer be created. Existing action types referencing it keep executing.`,
        );
      } else if (constraint.status === "draft") {
        // 'draft' constraints are accepted structurally but persisted with
        // an explicit warning so the operator knows to flip to 'active'
        // before the action type can execute against fresh data. (Runtime
        // resolver does NOT yet reject 'draft'; route layer surface only.)
        // No error — a warning that we surface well below.
      }
    }
  }
  if (typeof rule.interfaceId !== "string" || rule.interfaceId.length === 0) {
    errors.push(`${idx}.interfaceId is required.`);
  }
  if (!rule.source || typeof rule.source !== "object" || Array.isArray(rule.source)) {
    errors.push(`${idx}.source is required and must be a ValueSource object.`);
  } else {
    errors.push(...validateValueSource(rule.source, `${idx}.source`, paramNames));
  }
  if (!rule.target || typeof rule.target !== "object" || Array.isArray(rule.target)) {
    errors.push(`${idx}.target is required and must be a ValueSource object.`);
  } else {
    errors.push(...validateValueSource(rule.target, `${idx}.target`, paramNames));
  }
}
