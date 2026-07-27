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

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
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
} from "../models/actionType";
import type { UpdateActionTypeInput } from "../models/actionType";
import {
  sendError,
  sendCreated,
  sendSuccess,
  sendNoContent,
} from "../utils/responseFormatter";
import { appError } from "../utils/appError";
import { OntologyError } from "../utils/queryErrors";
import {
  validateSchemaMigration,
} from "../actions/schemaMigrationValidator";
import type { CurrentSchema, ProposedSchema, RecentExecutionStats } from "../actions/schemaMigrationValidator";
import { dataPlaneGuard } from "../middleware/requireRole";
import {
  validateActionSemantics,
  V1_DEFAULT_SEMANTICS,
  V2_DEFAULT_SEMANTICS,
  type ActionSemanticsVersion,
  type ActionExecutionMode,
  type DeletePolicy,
} from "../actions/actionSemantics";
import {
  getActionSemanticsExecutionAvailability,
  isV2CreationEnabled,
} from "../actions/actionSemanticsFlags";
import {
  analyzeActionTypeMigration,
  ACKNOWLEDGEMENT_REQUIRED_FINDING_CODES,
  type MigrationFinding,
  type MigrationReport,
  type ParameterMigration,
} from "../actions/actionMigrationAnalysis";
import { hashActionDefinition } from "../actions/actionDefinitionHash";
import { defaultSchemaLookup } from "../actions/objectReferenceResolver";
import { recordMigration } from "../models/actionMigrationLog";
import { getByApiName as getLinkTypeByApiName } from "../models/linkType";
import { getInterfaceLinkConstraintByApiName } from "../models/interfaceLinkConstraint";
import { getWebhookByNameVersion } from "../models/webhookDefinition";
import { getByRid as getConnectivityWebhookByRid } from "../services/connectivity/webhooks/repository";
import { CONNECTIVITY_WEBHOOK_RID_PREFIX } from "../actions/writebackExecutor";
import { resolveRequestTenant } from "../utils/requestTenant";
import { resolveSemanticsForRow } from "../models/actionType";
import {
  validateConcreteLinkRuleShape,
  validateInterfaceLinkRuleShape,
} from "../actions/ruleShapeValidator";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router({ mergeParams: true });

// Function-level authorization: action-type create/update/clone require
// ontology-editor, delete requires ontology-admin (PATs scope-gated upstream,
// superadmin passes, reads open).
router.use(dataPlaneGuard({ post: "write" }));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Pattern for valid action type API names. */
const API_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,99}$/;

/** Valid parameter types. */
const VALID_PARAM_TYPES = new Set([
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
const NUMERIC_PARAM_TYPES = new Set([
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
const VALID_RULE_TYPES = new Set([
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
]);

/** Valid property mapping source types. */
const VALID_SOURCES = new Set([
  "parameter",
  "static",
  "currentTimestamp",
  "currentUser",
]);

/** Error codes the route layer knows how to translate. */
const KNOWN_CODES = new Set([
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
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonical action-type DB-row presenter used by every API read surface. */
export function formatActionType(row: Record<string, any>): Record<string, unknown> {
  const semantics = resolveSemanticsForRow({
    semantics_version: row.semantics_version ?? null,
    execution_mode: row.execution_mode ?? null,
    delete_policy: row.delete_policy ?? null,
  });
  return {
    rid: row.action_type_id,
    apiName: row.api_name,
    displayName: row.display_name,
    description: row.description,
    icon: row.icon_name ?? null,
    iconColor: row.icon_color ?? null,
    saveLocationRid: row.save_location_rid ?? null,
    parameters: row.parameters,
    rules: row.rules,
    submissionCriteria: row.submission_criteria ?? null,
    sideEffects: row.side_effects ?? null,
    writebackConfig: row.writeback_config ?? null,
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
    definitionHash: row.definition_hash ?? null,
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
function actorOf(req: Request): string {
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
function currentDefinitionHashFor(
  row: { parameters?: unknown; rules?: unknown },
  semantics: { semanticsVersion: number; executionMode: string; deletePolicy: string },
): string {
  return hashActionDefinition({
    parameters: row.parameters,
    rules: row.rules,
    semanticsVersion: semantics.semanticsVersion,
    executionMode: semantics.executionMode,
    deletePolicy: semantics.deletePolicy,
  });
}

/**
 * Resolve an object type API name to its object_type_id.
 * Returns { objectTypeId, properties } or throws VALIDATION_FAILED.
 */
async function resolveObjectType(
  ontologyId: string,
  objectTypeApiName: string,
  contextMsg: string
): Promise<{
  objectTypeId: string;
  properties: Set<string>;
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
    "SELECT property_id, api_name, is_required FROM property WHERE object_type_id = $1",
    [objectTypeId]
  );
  const properties = new Set<string>(
    propResult.rows.map((r: Record<string, unknown>) => r.api_name as string)
  );

  return {
    objectTypeId,
    properties,
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

function validateOptionalMetadata(body: Record<string, unknown>): string[] {
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

function validateValueSource(
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
  return [];
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
async function validateParameters(
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
async function validateRules(
  rules: unknown[],
  ontologyId: string,
  paramNames: Set<string>
): Promise<string[]> {
  const errors: string[] = [];

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
      let primaryKeyProperty: string | undefined;
      let requiredProperties = new Set<string>();
      try {
        const resolved = await resolveObjectType(
          ontologyId,
          rule.objectType as string,
          `Rule ${idx}`
        );
        objTypeProps = resolved.properties;
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
        }
      } else if (ruleType === "createObject" || ruleType === "modifyOrCreateObject") {
        errors.push(`${idx}.properties is required for '${ruleType}' rules.`);
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

async function validateWritebackConfig(
  wb: unknown,
  ontologyId: string,
  paramNames: Set<string>,
  tenant: string,
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
          tenant,
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
async function validateConnectivityWebhookBinding(
  webhookRid: string,
  webhookVersion: number,
  inputs: Record<string, unknown>,
  tenant: string,
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
  const declaredIds = new Set(declared.map((input) => input.id));
  for (const key of Object.keys(inputs)) {
    if (!declaredIds.has(key)) {
      errors.push(
        `writeback_config.inputs.${key} is not a declared input of webhook '${webhook.displayName}' v${webhookVersion}. Declared inputs: ${declared.map((i) => i.id).join(", ") || "(none)"}.`,
      );
    }
  }
  for (const input of declared) {
    if (input.required && !(input.id in inputs)) {
      errors.push(
        `writeback_config.inputs is missing a mapping for required input '${input.id}' declared by webhook '${webhook.displayName}' v${webhookVersion}.`,
      );
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

async function validateConcreteLinkRule(
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

async function validateInterfaceLinkRule(
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

// ---------------------------------------------------------------------------
// Endpoint 1: POST / (Create Action Type)
// ---------------------------------------------------------------------------

router.post(
  "/",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ontologyId } = req.params;
      const body = req.body;

      // --- Basic field validation ---

      // apiName
      if (!body.apiName || typeof body.apiName !== "string") {
        sendError(res, "VALIDATION_FAILED", "apiName is required and must be a string.");
        return;
      }
      if (!API_NAME_RE.test(body.apiName)) {
        sendError(
          res,
          "VALIDATION_FAILED",
          "apiName must start with a letter and contain only letters, numbers, and underscores (max 100 characters)"
        );
        return;
      }

      // displayName
      if (!body.displayName || typeof body.displayName !== "string" || body.displayName.trim() === "") {
        sendError(res, "VALIDATION_FAILED", "displayName is required and must be a non-empty string.");
        return;
      }
      if (body.displayName.length > 200) {
        sendError(res, "VALIDATION_FAILED", "displayName must be at most 200 characters.");
        return;
      }

      // description
      if (body.description !== undefined && typeof body.description !== "string") {
        sendError(res, "VALIDATION_FAILED", "description must be a string.");
        return;
      }

      const metadataErrors = validateOptionalMetadata(body);
      if (metadataErrors.length > 0) {
        sendError(res, "VALIDATION_FAILED", metadataErrors.join(" "), { validationErrors: metadataErrors });
        return;
      }

      // maxAffectedObjects
      const maxAffected = body.maxAffectedObjects ?? 10000;
      if (typeof maxAffected !== "number" || !Number.isInteger(maxAffected) || maxAffected < 1 || maxAffected > 100000) {
        sendError(
          res,
          "VALIDATION_FAILED",
          "maxAffectedObjects must be a positive integer up to 100,000."
        );
        return;
      }

      // parameters
      const params = body.parameters ?? [];
      if (!Array.isArray(params)) {
        sendError(res, "VALIDATION_FAILED", "parameters must be an array.");
        return;
      }

      const paramErrors = await validateParameters(params, ontologyId);
      if (paramErrors.length > 0) {
        sendError(res, "VALIDATION_FAILED", paramErrors.join(" "), {
          validationErrors: paramErrors,
        });
        return;
      }

      // rules
      const rules = body.rules;
      if (!rules || !Array.isArray(rules) || rules.length === 0) {
        sendError(
          res,
          "VALIDATION_FAILED",
          "rules must be a non-empty array (an action with no rules is meaningless)."
        );
        return;
      }

      // Build parameter name set for rule validation
      const paramNames = new Set<string>(
        params.map((p: Record<string, unknown>) => p.apiName as string)
      );

      const ruleErrors = await validateRules(rules, ontologyId, paramNames);
      if (ruleErrors.length > 0) {
        sendError(res, "VALIDATION_FAILED", ruleErrors.join(" "), {
          validationErrors: ruleErrors,
        });
        return;
      }

      // Phase 4 — writeback_config validation (one-writeback-per-action
      // invariant is structural in DB migration 130; this validates the
      // shape, the webhook reference, and the input-mapping's ValueSources).
        const wbErrors = await validateWritebackConfig(body.writebackConfig, ontologyId, paramNames, resolveRequestTenant(req));
      if (wbErrors.length > 0) {
        sendError(res, "WRITEBACK_CONFIG_INVALID", wbErrors.join(" "), {
          validationErrors: wbErrors,
        });
        return;
      }

      // --- Action semantics validation (§1, §9, §10) ---
      //
      // Backward-compatible contract:
      //   * Omitted semanticsVersion on the legacy create endpoint →
      //     persisted as version 1 + legacy_unchecked + declarative, and a
      //     deprecation telemetry counter is incremented (action_legacy_default_used_total).
      //   * Explicit semanticsVersion: 2 → executionMode/deletePolicy are
      //     defaulted server-side to v2 values when the caller omits them.
      //   * Unknown semantics versions fail closed (never silently run as v1).
      //   * Function executionMode is rejected until implemented.
      //   * Changing semantics happens through the dedicated migration
      //     endpoint, NOT a generic PATCH (§12) — so UpdateActionTypeInput
      //     does not carry semantics fields.
      const semanticsVersion = body.semanticsVersion;
      let resolvedSemanticsVersion: ActionSemanticsVersion | undefined;
      let resolvedExecutionMode: ActionExecutionMode | undefined;
      let resolvedDeletePolicy: DeletePolicy | undefined;

      if (semanticsVersion === undefined) {
        // Legacy-omit path: persisted as version 1, deprecation telemetry.
        resolvedSemanticsVersion = V1_DEFAULT_SEMANTICS.semanticsVersion;
        resolvedExecutionMode = V1_DEFAULT_SEMANTICS.executionMode;
        resolvedDeletePolicy = V1_DEFAULT_SEMANTICS.deletePolicy;
        // Deprecation counter (best-effort; metrics must never block create).
        try {
          const { incCounter } = await import("../services/funnel/metrics");
          incCounter("tellus_action_legacy_default_used_total", {
            stage: "action_type_create",
          });
        } catch {
          /* ignore — observability is non-blocking */
        }
      } else {
        // Explicit version supplied — validate the combination.
        const sv = validateActionSemantics({
          semanticsVersion,
          executionMode: body.executionMode,
          deletePolicy: body.deletePolicy,
        });
        if (!sv.valid) {
          const e = sv.error!;
          sendError(res, e.code, e.message, { stage: "definition" });
          return;
        }
        // Fail closed: v2 creation is gated behind the feature flag until DB
        // verification (locking, concurrency, query plans, E2E) passes. We
        // never silently persist a v2 action type whose behaviour isn't
        // enforced. Compilation + unit tests are NOT sufficient to flip this.
        if (semanticsVersion === 2 && !isV2CreationEnabled()) {
          sendError(
            res,
            "UNSUPPORTED_SEMANTICS_VERSION",
            "Version-2 action-type creation is not enabled on this deployment. Existing version-1 behaviour is unchanged. Set ACTION_SEMANTICS_V2_CREATION_ENABLED=1 after completing the v2 verification runbook.",
            { requestedVersion: semanticsVersion, stage: "definition" },
          );
          return;
        }
        resolvedSemanticsVersion = semanticsVersion as ActionSemanticsVersion;
        // Default omitted mode/policy according to the requested version.
        const defaults = resolvedSemanticsVersion === 2 ? V2_DEFAULT_SEMANTICS : V1_DEFAULT_SEMANTICS;
        resolvedExecutionMode = (body.executionMode as ActionExecutionMode) ?? defaults.executionMode;
        resolvedDeletePolicy = (body.deletePolicy as DeletePolicy) ?? defaults.deletePolicy;
      }

      // --- Create the action type ---
      const row = await createActionType(ontologyId, {
        apiName: body.apiName,
        displayName: body.displayName,
        description: body.description,
        iconName: body.icon ?? null,
        iconColor: body.iconColor ?? null,
        saveLocationRid: body.saveLocationRid ?? null,
        parameters: params,
        rules,
        submissionCriteria: body.submissionCriteria ?? null,
        sideEffects: body.sideEffects ?? null,
        writebackConfig: body.writebackConfig ?? null,
        maxAffectedObjects: maxAffected,
        isEnabled: body.isEnabled ?? true,
        createdBy: actorOf(req),
        semanticsVersion: resolvedSemanticsVersion,
        executionMode: resolvedExecutionMode,
        deletePolicy: resolvedDeletePolicy,
      });

      sendCreated(res, formatActionType(row));
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message, err.details);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Endpoint 2: GET / (List Action Types)
// ---------------------------------------------------------------------------

router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ontologyId } = req.params;

      const rows = await listActionTypes(ontologyId);
      const data = rows.map((row) => formatActionType(row));

      sendSuccess(res, { data });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Endpoint 3: GET /by-rid/:rid (Get Action Type by RID)
// ---------------------------------------------------------------------------

router.get(
  "/by-rid/:rid",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { rid } = req.params;

      if (!rid || typeof rid !== "string") {
        sendError(res, "INVALID_PARAMETER", "rid is required and must be a string");
        return;
      }

      const row = await getActionTypeByRid(rid);
      if (!row) {
        throw new OntologyError(
          `Action type with RID '${rid}' not found`,
          "ACTION_TYPE_NOT_FOUND",
          undefined,
          { rid }
        );
      }

      sendSuccess(res, formatActionType(row));
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Endpoint 4: POST /by-rid/batch (Get Action Types by RIDs Batch)
// ---------------------------------------------------------------------------

router.post(
  "/by-rid/batch",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body;
      const rids: string[] = body.rids ?? body;

      if (!Array.isArray(rids)) {
        sendError(res, "INVALID_PARAMETER", "rids must be an array of RID strings");
        return;
      }

      if (rids.length === 0) {
        sendSuccess(res, { data: [] });
        return;
      }

      if (rids.length > 500) {
        sendError(res, "INVALID_PARAMETER", "Maximum 500 RIDs allowed per batch request");
        return;
      }

      const rows = await getActionTypesByRidBatch(rids);
      const data = rows.map((row) => formatActionType(row));

      sendSuccess(res, { data });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Endpoint 5: GET /:actionApiName (Get Single Action Type)
// ---------------------------------------------------------------------------

router.get(
  "/:actionApiName",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ontologyId, actionApiName } = req.params;

      const row = await getActionType(ontologyId, actionApiName);
      if (!row) {
        throw new OntologyError(
          `Action type '${actionApiName}' not found in ontology '${ontologyId}'`,
          "ACTION_TYPE_NOT_FOUND",
          undefined,
          { actionTypeApiName: actionApiName, ontologyId }
        );
      }

      // Phase 6.2 — ETag header so a client can stamp `If-Match: <Etag>`
      // on its next PATCH for optimistic-concurrency enforcement. The
      // ETag is the persisted `definition_version` (migration 132
      // backfills to 1 + bumps on every structural change via the
      // BEFORE-UPDATE trigger wrapped as a strong ETag.
      const version = Number(row.definition_version ?? 1);
      if (Number.isInteger(version)) {
        res.set("ETag", `"${version}"`);
      }
      sendSuccess(res, formatActionType(row));
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Endpoint 6: PUT/PATCH /:actionApiName (Update Action Type)
// ---------------------------------------------------------------------------

const updateActionTypeHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
    try {
      const { ontologyId, actionApiName } = req.params;
      const body = req.body;

      // Verify the action type exists first
      const existing = await getActionType(ontologyId, actionApiName);
      if (!existing) {
        throw new OntologyError(
          `Action type '${actionApiName}' not found in ontology '${ontologyId}'`,
          "ACTION_TYPE_NOT_FOUND",
          undefined,
          { actionTypeApiName: actionApiName, ontologyId }
        );
      }
      // --- Phase 6.2 — optimistic-concurrency If-Match guard ----------------
      //
      // Migration 132 (Phase 1) already stamps every row with
      // `definition_version` + `definition_hash`. The route-layer PATCH
      // surface here closes the wire-side contract: a client may stamp
      // `If-Match: <version>` on its update request. The persisted version
      // is the source of truth; on mismatch we 412 with structured details
      // (expected vs forwarded + the new `definition_hash` for the
      // operator to see what changed underneath them).
      //
      // Absence of If-Match is permitted (the action-type management route
      // is only writable by editors today per `dataPlaneGuard`). Phase 6.6
      // ships a forward-looking opt-in to make If-Match STRICT (env-gated).
      const ifMatchHeader = req.get("If-Match");
      if (ifMatchHeader !== undefined && ifMatchHeader !== null && ifMatchHeader !== "") {
        // Strip weak-ETag wrapping (`W/"1"`, `"1"`, `1`) — Phase 6.2
        // accepts the bare integer OR the ETag-wrapped form so the
        // client can pass either the raw version or a quoted string.
        const cleanedHeader = ifMatchHeader.replace(/^W\//, "").replace(/^"/, "").replace(/"$/, "").trim();
        const expectedVersion = parseInt(cleanedHeader, 10);
        const persistedVersion = Number(existing.definition_version ?? 1);
        if (!Number.isInteger(expectedVersion) || expectedVersion !== persistedVersion) {
          throw new OntologyError(
            `If-Match version ${ifMatchHeader} does not match persisted version ${persistedVersion} of action type '${actionApiName}'.`,
            "PRECONDITION_FAILED",
            412,
            {
              actionTypeApiName: actionApiName,
              ontologyId,
              expectedVersion: ifMatchHeader,
              persistedVersion,
              definitionHash: existing.definition_hash ?? null,
            },
          );
        }
      }

      // --- Validate updatable fields ---

      // displayName
      if (body.displayName !== undefined) {
        if (typeof body.displayName !== "string" || body.displayName.trim() === "") {
          sendError(res, "VALIDATION_FAILED", "displayName must be a non-empty string.");
          return;
        }
        if (body.displayName.length > 200) {
          sendError(res, "VALIDATION_FAILED", "displayName must be at most 200 characters.");
          return;
        }
      }

      // description
      if (body.description !== undefined && typeof body.description !== "string") {
        sendError(res, "VALIDATION_FAILED", "description must be a string.");
        return;
      }

      const metadataErrors = validateOptionalMetadata(body);
      if (metadataErrors.length > 0) {
        sendError(res, "VALIDATION_FAILED", metadataErrors.join(" "), { validationErrors: metadataErrors });
        return;
      }

      // maxAffectedObjects
      if (body.maxAffectedObjects !== undefined) {
        if (
          typeof body.maxAffectedObjects !== "number" ||
          !Number.isInteger(body.maxAffectedObjects) ||
          body.maxAffectedObjects < 1 ||
          body.maxAffectedObjects > 100000
        ) {
          sendError(
            res,
            "VALIDATION_FAILED",
            "maxAffectedObjects must be a positive integer up to 100,000."
          );
          return;
        }
      }

      // isEnabled
      if (body.isEnabled !== undefined && typeof body.isEnabled !== "boolean") {
        sendError(res, "VALIDATION_FAILED", "isEnabled must be a boolean.");
        return;
      }

      // Determine the effective parameters and rules for cross-validation.
      // If parameters or rules are being updated, use the new values;
      // otherwise, use the existing values from the database.
      const effectiveParams: unknown[] = body.parameters !== undefined
        ? body.parameters
        : (existing.parameters as unknown[]);
      const effectiveRules: unknown[] = body.rules !== undefined
        ? body.rules
        : (existing.rules as unknown[]);

      // Validate parameters if provided
      if (body.parameters !== undefined) {
        if (!Array.isArray(body.parameters)) {
          sendError(res, "VALIDATION_FAILED", "parameters must be an array.");
          return;
        }
        const paramErrors = await validateParameters(body.parameters, ontologyId);
        if (paramErrors.length > 0) {
          sendError(res, "VALIDATION_FAILED", paramErrors.join(" "), {
            validationErrors: paramErrors,
          });
          return;
        }
      }

      // Validate rules if provided, or re-validate existing rules against new params
      if (body.rules !== undefined || body.parameters !== undefined) {
        const rulesToValidate = effectiveRules;
        if (!Array.isArray(rulesToValidate) || rulesToValidate.length === 0) {
          if (body.rules !== undefined) {
            sendError(
              res,
              "VALIDATION_FAILED",
              "rules must be a non-empty array (an action with no rules is meaningless)."
            );
            return;
          }
        } else {
          const paramNames = new Set<string>(
            (effectiveParams as Array<Record<string, unknown>>).map(
              (p) => p.apiName as string
            )
          );
          const ruleErrors = await validateRules(rulesToValidate, ontologyId, paramNames);
          if (ruleErrors.length > 0) {
            sendError(res, "VALIDATION_FAILED", ruleErrors.join(" "), {
              validationErrors: ruleErrors,
            });
            return;
          }
        }
      }

      // Phase 4 — validate writeback_config on PATCH (when provided).
      // Use the EFFECTIVE parameter name set: if parameters are being
      // updated, the new ones; otherwise the existing ones on disk so the
      // value-source resolver can verify the new writeback_config's
      // input mappings reference still-existing parameters.
      if (body.writebackConfig !== undefined) {
        const paramNames = new Set<string>(
          (effectiveParams as Array<Record<string, unknown>>).map(
            (p) => p.apiName as string
          )
        );
      const wbErrors = await validateWritebackConfig(body.writebackConfig, ontologyId, paramNames, resolveRequestTenant(req));
        if (wbErrors.length > 0) {
          sendError(res, "WRITEBACK_CONFIG_INVALID", wbErrors.join(" "), {
            validationErrors: wbErrors,
          });
          return;
        }
      }

      // --- Build the update payload (snake_case for the model) ---
      const updates: UpdateActionTypeInput = {};

      if (body.displayName !== undefined) updates.display_name = body.displayName;
      if (body.description !== undefined) updates.description = body.description;
      if (body.icon !== undefined) updates.icon_name = body.icon;
      if (body.iconColor !== undefined) updates.icon_color = body.iconColor;
      if (body.saveLocationRid !== undefined) updates.save_location_rid = body.saveLocationRid;
      if (body.parameters !== undefined) updates.parameters = body.parameters;
      if (body.rules !== undefined) updates.rules = body.rules;
      if (body.submissionCriteria !== undefined) updates.submission_criteria = body.submissionCriteria;
      if (body.sideEffects !== undefined) updates.side_effects = body.sideEffects;
      if (body.writebackConfig !== undefined) updates.writeback_config = body.writebackConfig;
      if (body.maxAffectedObjects !== undefined) updates.max_affected_objects = body.maxAffectedObjects;
      if (body.isEnabled !== undefined) updates.is_enabled = body.isEnabled;

      if (Object.keys(updates).length === 0) {
        sendError(
          res,
          "VALIDATION_FAILED",
          "At least one updatable field must be provided."
        );
        return;
      }

      // -----------------------------------------------------------------
      // Schema Migration Validation (Task 26)
      //
      // Before applying the update, validate backward-compatibility with
      // existing audit log entries and historical usage. Warnings are
      // included in the response for the UI to display.
      // -----------------------------------------------------------------
      const currentSchema: CurrentSchema = {
        parameters: existing.parameters as any[],
        rules: existing.rules as any[],
        max_affected_objects: existing.max_affected_objects,
      };

      const proposedSchema: ProposedSchema = {};
      if (body.parameters !== undefined) proposedSchema.parameters = body.parameters;
      if (body.rules !== undefined) proposedSchema.rules = body.rules;
      if (body.maxAffectedObjects !== undefined) proposedSchema.maxAffectedObjects = body.maxAffectedObjects;

      // Query recent execution stats for detection #5 (maxAffectedObjects reduction)
      let recentStats: RecentExecutionStats | null = null;
      if (body.maxAffectedObjects !== undefined && body.maxAffectedObjects < existing.max_affected_objects) {
        const statsResult = await query(
          `SELECT COALESCE(MAX(affected_object_count), 0) AS max_count
           FROM action_audit_log
           WHERE action_type_api_name = $1
             AND executed_at > NOW() - INTERVAL '30 days'`,
          [actionApiName]
        );
        recentStats = {
          maxAffectedCount: parseInt(statsResult.rows[0].max_count, 10),
        };
      }

      const migration = validateSchemaMigration(currentSchema, proposedSchema, recentStats);

      const updatedRow = await updateActionType(ontologyId, actionApiName, updates);

      // Build response — include migration warnings if any exist
      const responseData: Record<string, unknown> = formatActionType(updatedRow);
      if (!migration.safe) {
        responseData.migrationWarnings = [
          ...migration.warnings,
          ...migration.breakingChanges,
        ];
      }

      sendSuccess(res, responseData);
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message, err.details);
      }
      next(err);
    }
};

// PUT is the established Tellus route. PATCH is intentionally supported as
// an equivalent partial-update alias so clients that follow the OpenAPI-style
// update convention do not fail at routing before validation/persistence.
router
  .route("/:actionApiName")
  .put(updateActionTypeHandler)
  .patch(updateActionTypeHandler);

// ---------------------------------------------------------------------------
// Endpoint 5: POST /:actionApiName/clone (Clone Action Type) — Task 23
//
// Creates a deep copy of an existing action type with a new API name. The
// clone is completely independent — changes to either action type don't
// affect the other. All JSONB fields (parameters, rules, submission_criteria,
// side_effects) are deep-copied. is_enabled and max_affected_objects are
// preserved from the source.
// ---------------------------------------------------------------------------

router.post(
  "/:actionApiName/clone",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ontologyId, actionApiName } = req.params;
      const body = req.body || {};

      // 1. Fetch the source action type
      const source = await getActionType(ontologyId, actionApiName);
      if (!source) {
        throw new OntologyError(
          `Action type '${actionApiName}' not found in ontology '${ontologyId}'`,
          "ACTION_TYPE_NOT_FOUND",
          undefined,
          { actionTypeApiName: actionApiName, ontologyId }
        );
      }

      // 2. Validate newApiName
      if (!body.newApiName || typeof body.newApiName !== "string") {
        sendError(
          res,
          "VALIDATION_FAILED",
          "newApiName is required and must be a non-empty string."
        );
        return;
      }

      if (!API_NAME_RE.test(body.newApiName)) {
        sendError(
          res,
          "VALIDATION_FAILED",
          "newApiName must start with a letter and contain only letters, numbers, and underscores (max 100 characters)"
        );
        return;
      }

      // 3. Determine newDisplayName
      const newDisplayName =
        body.newDisplayName && typeof body.newDisplayName === "string"
          ? body.newDisplayName
          : `Copy of ${source.display_name}`;

      // 4. Create the clone using the existing createActionType model function.
      //    This handles uniqueness checking (throws ACTION_TYPE_ALREADY_EXISTS
      //    on PG unique constraint violation) and api_name format validation.
      const clonedRow = await createActionType(ontologyId, {
        apiName: body.newApiName,
        displayName: newDisplayName,
        description: source.description,
        iconName: source.icon_name,
        iconColor: source.icon_color,
        saveLocationRid: source.save_location_rid,
        parameters: JSON.parse(JSON.stringify(source.parameters)), // deep copy
        rules: JSON.parse(JSON.stringify(source.rules)),           // deep copy
        submissionCriteria: source.submission_criteria != null
          ? JSON.parse(JSON.stringify(source.submission_criteria))
          : null,
        sideEffects: source.side_effects != null
          ? JSON.parse(JSON.stringify(source.side_effects))
          : null,
        maxAffectedObjects: source.max_affected_objects,
        isEnabled: source.is_enabled,
        createdBy: actorOf(req),
      });

      sendCreated(res, formatActionType(clonedRow));
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message, err.details);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Endpoint 6: GET /:actionApiName/impact (Action Type Impact Analysis) — Task 24
//
// Analyses an action type's impact by inspecting its rules to determine
// which object types, properties, and link types it touches. Also returns
// execution statistics from the audit log and warnings for any missing
// references (e.g. a rule references a deleted object type).
// ---------------------------------------------------------------------------

router.get(
  "/:actionApiName/impact",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ontologyId, actionApiName } = req.params;

      // 1. Load the action type
      const row = await getActionType(ontologyId, actionApiName);
      if (!row) {
        throw new OntologyError(
          `Action type '${actionApiName}' not found in ontology '${ontologyId}'`,
          "ACTION_TYPE_NOT_FOUND",
          undefined,
          { actionTypeApiName: actionApiName, ontologyId }
        );
      }

      const rules = (row.rules ?? []) as Array<Record<string, unknown>>;
      const warnings: string[] = [];

      // 2. Parse rules to extract object types, properties, and link types
      // Map: objectTypeApiName -> { operations: Set, properties: Set }
      const objectTypeMap = new Map<
        string,
        { operations: Set<string>; properties: Set<string> }
      >();
      const linkTypeSet = new Map<string, Set<string>>(); // apiName -> Set<operation>

      for (const rule of rules) {
        const ruleType = rule.type as string;

        if (
          ruleType === "createObject" ||
          ruleType === "modifyObject" ||
          ruleType === "deleteObject"
        ) {
          const objType = rule.objectType as string;
          if (!objType) continue;

          if (!objectTypeMap.has(objType)) {
            objectTypeMap.set(objType, {
              operations: new Set(),
              properties: new Set(),
            });
          }
          const entry = objectTypeMap.get(objType)!;

          // Map rule type to operation verb
          if (ruleType === "createObject") entry.operations.add("create");
          else if (ruleType === "modifyObject") entry.operations.add("modify");
          else if (ruleType === "deleteObject") entry.operations.add("delete");

          // Extract property names from create/modify rules
          if (
            (ruleType === "createObject" || ruleType === "modifyObject") &&
            rule.properties &&
            typeof rule.properties === "object"
          ) {
            for (const propName of Object.keys(
              rule.properties as Record<string, unknown>
            )) {
              entry.properties.add(propName);
            }
          }
        }

        if (ruleType === "addLink" || ruleType === "removeLink") {
          const linkApiName =
            (rule.linkTypeApiName as string) || (rule.linkType as string);
          if (!linkApiName) continue;

          if (!linkTypeSet.has(linkApiName)) {
            linkTypeSet.set(linkApiName, new Set());
          }
          linkTypeSet
            .get(linkApiName)!
            .add(ruleType === "addLink" ? "add" : "remove");
        }
      }

      // 3. Verify each referenced object type exists and check properties
      const affectedObjectTypes: Array<Record<string, unknown>> = [];

      for (const [objApiName, info] of objectTypeMap) {
        const otResult = await query(
          "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
          [ontologyId, objApiName]
        );
        const exists = otResult.rows.length > 0;

        if (!exists) {
          warnings.push(
            `Object type '${objApiName}' referenced in rules does not exist in ontology.`
          );
        }

        // Check properties exist on the object type
        const propertiesModified = Array.from(info.properties);
        if (exists && propertiesModified.length > 0) {
          const objectTypeId = otResult.rows[0].object_type_id as string;
          const propResult = await query(
            "SELECT api_name FROM property WHERE object_type_id = $1",
            [objectTypeId]
          );
          const existingProps = new Set<string>(
            propResult.rows.map(
              (r: Record<string, unknown>) => r.api_name as string
            )
          );
          for (const propName of propertiesModified) {
            if (!existingProps.has(propName)) {
              warnings.push(
                `Property '${propName}' on object type '${objApiName}' referenced in rules does not exist.`
              );
            }
          }
        }

        affectedObjectTypes.push({
          apiName: objApiName,
          exists,
          operations: Array.from(info.operations),
          propertiesModified,
        });
      }

      // 4. Verify each referenced link type exists
      const affectedLinkTypes: Array<Record<string, unknown>> = [];

      for (const [linkApiName, ops] of linkTypeSet) {
        const ltResult = await query(
          "SELECT link_type_id FROM link_type WHERE ontology_id = $1 AND api_name = $2",
          [ontologyId, linkApiName]
        );
        const exists = ltResult.rows.length > 0;

        if (!exists) {
          warnings.push(
            `Link type '${linkApiName}' referenced in rules does not exist in ontology.`
          );
        }

        affectedLinkTypes.push({
          apiName: linkApiName,
          exists,
          operations: Array.from(ops),
        });
      }

      // 5. Query execution statistics from audit log
      const statsResult = await query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE result = 'success') AS success_count,
                MAX(executed_at) AS last_executed_at
         FROM action_audit_log
         WHERE action_type_api_name = $1`,
        [actionApiName]
      );

      const last30Result = await query(
        `SELECT COUNT(*) AS count
         FROM action_audit_log
         WHERE action_type_api_name = $1
           AND executed_at > NOW() - INTERVAL '30 days'`,
        [actionApiName]
      );

      const totalExecutions = parseInt(statsResult.rows[0].total, 10);
      const successCount = parseInt(statsResult.rows[0].success_count, 10);
      const last30DayExecutions = parseInt(last30Result.rows[0].count, 10);
      const successRate =
        totalExecutions > 0
          ? Math.round((successCount / totalExecutions) * 100) / 100
          : 0;
      const lastExecutedAt = statsResult.rows[0].last_executed_at ?? null;

      // 6. Build response
      sendSuccess(res, {
        actionTypeApiName: actionApiName,
        affectedObjectTypes,
        affectedLinkTypes,
        executionStats: {
          totalExecutions,
          last30DayExecutions,
          successRate,
          lastExecutedAt,
        },
        warnings,
      });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Endpoint: GET /:actionApiName/migrationAnalysis (§12)
//
// Returns a v1→v2 migration analysis for the action type: classification,
// proposed Assurf definition with typed object_reference parameters,
// per-parameter migration details (primary-key base type loaded from the
// object schema), wire compatibility, mixed-usage detection, delete-policy
// impact, acknowledgement-required finding codes, and a definition hash the
// client must echo back on /migrate for optimistic concurrency. Static
// analysis only — never migrates.
// ---------------------------------------------------------------------------
router.get(
  "/:actionApiName/migrationAnalysis",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ontologyId, actionApiName } = req.params;
      const row = await getActionType(ontologyId, actionApiName);
      if (!row) {
        throw new OntologyError(
          `Action type '${actionApiName}' not found in ontology '${ontologyId}'`,
          "ACTION_TYPE_NOT_FOUND", undefined, { actionTypeApiName: actionApiName, ontologyId },
        );
      }
      const semantics = resolveSemanticsForRow({
        semantics_version: (row as any).semantics_version ?? null,
        execution_mode: (row as any).execution_mode ?? null,
        delete_policy: (row as any).delete_policy ?? null,
      });
      const report: MigrationReport = await analyzeActionTypeMigration(
        {
          rules: (row.rules ?? []) as any[],
          parameters: (row.parameters ?? []) as any[],
        },
        { schemaLookup: defaultSchemaLookup, ontologyId },
      );
      const currentDefinitionHash = hashActionDefinition({
        parameters: row.parameters,
        rules: row.rules,
        semanticsVersion: semantics.semanticsVersion,
        executionMode: semantics.executionMode,
        deletePolicy: semantics.deletePolicy,
      });
      const rolloutAvailability =
        getActionSemanticsExecutionAvailability(2);
      const migrationPermitted =
        rolloutAvailability.available &&
        semantics.semanticsVersion === 1 &&
        (report.classification === "compatible" ||
          report.classification === "requires_review") &&
        !!report.proposedDefinition;
      const acknowledgementRequired = report.findings
        .filter((f) =>
          ACKNOWLEDGEMENT_REQUIRED_FINDING_CODES.has(f.code as MigrationFinding["code"]),
        )
        .map((f) => f.code);
      try {
        const { incCounter } = await import("../services/funnel/metrics");
        incCounter("tellus_action_migration_analysis_total", { classification: report.classification });
      } catch { /* metrics non-blocking */ }
      sendSuccess(res, {
        currentSemanticsVersion: semantics.semanticsVersion,
        proposedTargetVersion: 2,
        classification: report.classification,
        findings: report.findings,
        parameterMigrations: report.parameterMigrations,
        proposedDefinition: report.proposedDefinition,
        schemaVerified: report.schemaVerified,
        deletePolicyChange: report.deletePolicyChange ?? null,
        deletePolicyImpact:
          report.deletePolicyChange === "legacy_unchecked_to_restrict"
            ? "Migration changes the delete policy from legacy_unchecked to restrict; any execution targeting an object with active relationships will be rejected."
            : "No delete-policy change implied by this migration.",
        currentDefinitionHash,
        acknowledgementRequired,
        migrationPermitted,
        rolloutAvailability,
      });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) return sendError(res, err.code, err.message, err.details);
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Endpoint: POST /:actionApiName/migrate (§12)
//
// Explicit v1→v2 migration. Two accepted request shapes:
//
//   1. Full schema-aware migration (recommended). The client echoes the
//      `currentDefinitionHash` it received from /migrationAnalysis along
//      with the acknowledged finding codes. The server re-derives the
//      proposed definition, rejects stale hashes, requires acknowledgements
//      for review-required findings, persists the new parameters + rules +
//      semantics atomically inside a single transaction, and writes an
//      immutable action_migration_log ledger row.
//
//   2. Legacy semantics-only migration. The client sends only
//      `{ targetVersion: 2 }`. The server refuses unless the action is
//      already classified `compatible` with NO proposed-definition change
//      (i.e. all parameters were already typed object_reference). This
//      preserves the original contract for already-typed actions.
// ---------------------------------------------------------------------------
router.post(
  "/:actionApiName/migrate",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ontologyId, actionApiName } = req.params;
      const body = req.body || {};
      if (body.targetVersion !== 2) {
        sendError(res, "VALIDATION_FAILED", "Migration requires targetVersion: 2 (explicit, no automatic downgrade).");
        return;
      }
      const rolloutAvailability =
        getActionSemanticsExecutionAvailability(2);
      if (!rolloutAvailability.available) {
        throw new OntologyError(
          rolloutAvailability.message ??
            "Version-2 action execution is not available for this deployment.",
          rolloutAvailability.code ?? "UNSUPPORTED_SEMANTICS_VERSION",
          422,
          rolloutAvailability.details ?? { semanticsVersion: 2 },
        );
      }
      const actor = actorOf(req);
      const correlationId =
        (req as any).correlationId ??
        ((req as any).requestId ?? null) ??
        null;

      const row = await getActionType(ontologyId, actionApiName);
      if (!row) {
        throw new OntologyError(
          `Action type '${actionApiName}' not found in ontology '${ontologyId}'`,
          "ACTION_TYPE_NOT_FOUND", undefined, { actionTypeApiName: actionApiName, ontologyId },
        );
      }
      const previous = resolveSemanticsForRow({
        semantics_version: (row as any).semantics_version ?? null,
        execution_mode: (row as any).execution_mode ?? null,
        delete_policy: (row as any).delete_policy ?? null,
      });
      if (previous.semanticsVersion !== 1) {
        sendError(res, "INCOMPATIBLE_ACTION_SEMANTICS",
          `Action type is already semantics version ${previous.semanticsVersion}; migration is v1→v2 only.`,
          { currentVersion: previous.semanticsVersion });
        return;
      }

      // Full schema-aware migration path.
      if (typeof body.expectedDefinitionHash === "string" && body.expectedDefinitionHash.length > 0) {
        const result = await migrateActionTypeWithDefinition(ontologyId, actionApiName, {
          expectedDefinitionHash: body.expectedDefinitionHash,
          proposedDefinition: body.proposedDefinition ?? { parameters: row.parameters, rules: row.rules },
          acknowledgedFindingCodes: Array.isArray(body.acknowledgedFindingCodes) ? body.acknowledgedFindingCodes : [],
          adapterEnabled: !!body.adapterEnabled,
          actor,
          correlationId,
        });
        sendSuccess(res, {
          ...formatActionType(result.migrated),
          migrationRecord: {
            actor,
            migratedAt: new Date().toISOString(),
            previousVersion: 1,
            newVersion: 2,
            migrationId: result.log.migration_id,
            previousDefinitionHash: result.log.previous_definition_hash,
            resultingDefinitionHash: result.log.resulting_definition_hash,
            acknowledgedFindingCodes: result.log.acknowledged_finding_codes,
            parameterMigrations: result.log.parameter_changes,
            rollbackAvailable: true,
          },
        });
        return;
      }

      // Legacy semantics-only path: refuse if any proposed-definition change
      // was required (i.e. untyped parameters must be converted). The
      // operator must use the full path.
      const report = await analyzeActionTypeMigration(
        { rules: (row.rules ?? []) as any[], parameters: (row.parameters ?? []) as any[] },
        { schemaLookup: defaultSchemaLookup, ontologyId },
      );
      if (report.parameterMigrations.length > 0 || report.classification !== "compatible") {
        sendError(res, "INCOMPATIBLE_ACTION_SEMANTICS",
          `Migration rejected: this action requires the full migration workflow (expectedDefinitionHash + acknowledgements). Classification '${report.classification}' with ${report.parameterMigrations.length} parameter conversion(s).`,
          { classification: report.classification, parameterMigrations: report.parameterMigrations, findings: report.findings });
        return;
      }
      const migrated = await migrateActionTypeSemantics(ontologyId, actionApiName, 2);
      if (!migrated) {
        throw new OntologyError("Action type not found during migration", "ACTION_TYPE_NOT_FOUND", 404);
      }
      // Record an audit ledger row for the legacy path as well so every
      // v1→v2 migration is tamper-evident and rollback is available. The
      // parameters/rules did NOT change in this path (only the semantics
      // triple), so the previous + resulting snapshots share the same
      // parameters/rules and differ only by the semantics triple.
      const resultingSemantics = resolveSemanticsForRow({
        semantics_version: (migrated as any).semantics_version ?? null,
        execution_mode: (migrated as any).execution_mode ?? null,
        delete_policy: (migrated as any).delete_policy ?? null,
      });
      const previousHash = currentDefinitionHashFor(row, previous);
      const resultingHash = hashActionDefinition({
        parameters: migrated.parameters,
        rules: migrated.rules,
        semanticsVersion: resultingSemantics.semanticsVersion,
        executionMode: resultingSemantics.executionMode,
        deletePolicy: resultingSemantics.deletePolicy,
      });
      let legacyMigrationId: string | undefined;
      try {
        const audit = await recordMigration({
          ontologyId,
          actionApiName,
          migrationKind: "migrate",
          previousSemanticsVersion: 1,
          resultingSemanticsVersion: 2,
          previousDeletePolicy: previous.deletePolicy,
          resultingDeletePolicy: resultingSemantics.deletePolicy,
          previousDefinitionHash: previousHash,
          resultingDefinitionHash: resultingHash,
          previousDefinitionSnapshot: {
            parameters: row.parameters,
            rules: row.rules,
            semanticsVersion: 1,
            executionMode: previous.executionMode,
            deletePolicy: previous.deletePolicy,
          },
          resultingDefinitionSnapshot: {
            parameters: migrated.parameters,
            rules: migrated.rules,
            semanticsVersion: 2,
            executionMode: resultingSemantics.executionMode,
            deletePolicy: resultingSemantics.deletePolicy,
          },
          parameterChanges: [],
          acknowledgedFindingCodes: [],
          adapterEnabled: false,
          actor,
          correlationId,
        });
        legacyMigrationId = audit.migration_id;
      } catch (auditErr: any) {
        // The action_type migration already committed; the audit ledger
        // insert failed. Surface the audit failure but DO NOT undo the
        // committed migration.
        console.error("legacy-migrate audit row write failed:", auditErr?.message);
      }
      sendSuccess(res, {
        ...formatActionType(migrated),
        migrationRecord: {
          actor,
          migratedAt: new Date().toISOString(),
          previousVersion: 1,
          newVersion: 2,
          migrationId: legacyMigrationId,
          previousDefinitionHash: previousHash,
          resultingDefinitionHash: resultingHash,
          rollbackAvailable: !!legacyMigrationId,
        },
      });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) return sendError(res, err.code, err.message, err.details);
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Endpoint: POST /:actionApiName/migrate/rollback (§12)
//
// Restores the previous v1 definition from the latest forward migration's
// immutable `previous_definition_snapshot`. Append-only: writes a NEW
// `rollback` ledger row inside the same transaction. The action_type UPDATE
// goes through the same domain path (parameters/rules/semantics columns in
// a single transactional UPDATE) — never a raw row patch.
//
// IMPORTANT: rolling back the definition does NOT reverse any object
// mutations already produced by executions that ran under v2 semantics.
// ---------------------------------------------------------------------------
router.post(
  "/:actionApiName/migrate/rollback",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ontologyId, actionApiName } = req.params;
      const actor = actorOf(req);
      const correlationId =
        (req as any).correlationId ?? ((req as any).requestId ?? null) ?? null;
      const result = await rollbackActionTypeMigration(
        ontologyId,
        actionApiName,
        actor,
        correlationId,
      );
      sendSuccess(res, {
        ...formatActionType(result.rolledBack),
        rollbackRecord: {
          actor,
          rolledBackAt: new Date().toISOString(),
          previousVersion: 2,
          newVersion: result.log.resulting_semantics_version,
          restoredFromMigrationId: result.log.previous_definition_hash,
          migrationLogId: result.log.migration_id,
          note: "Definition rollback does not revert object mutations already produced by executions under v2 semantics.",
        },
      });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) return sendError(res, err.code, err.message, err.details);
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Endpoint 7: DELETE /:actionApiName (Delete Action Type)
// ---------------------------------------------------------------------------

router.delete(
  "/:actionApiName",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ontologyId, actionApiName } = req.params;

      const deleted = await deleteActionType(ontologyId, actionApiName);
      if (!deleted) {
        throw new OntologyError(
          `Action type '${actionApiName}' not found in ontology '${ontologyId}'`,
          "ACTION_TYPE_NOT_FOUND",
          undefined,
          { actionTypeApiName: actionApiName, ontologyId }
        );
      }

      sendNoContent(res);
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default router;
