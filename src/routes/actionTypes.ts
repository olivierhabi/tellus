// ---------------------------------------------------------------------------
// Action Type Routes
//
// CRUD REST API endpoints for managing action type definitions in the
// Ontology. Action types define parameterized, auditable sets of changes
// that can be applied to objects, properties, and links.
//
// Mounted at: /api/v2/ontologies/:ontologyId/actionTypes
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
  listActionTypes,
  updateActionType,
  deleteActionType,
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
import { validateSchemaMigration } from "../actions/schemaMigrationValidator";
import type { CurrentSchema, ProposedSchema, RecentExecutionStats } from "../actions/schemaMigrationValidator";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router({ mergeParams: true });

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
  "double",
  "float",
  "date",
  "timestamp",
  "object_reference",
  "object_set",
  "string_array",
  "integer_array",
  "double_array",
  "struct",
]);

/** Numeric parameter types (for min/max constraints). */
const NUMERIC_PARAM_TYPES = new Set([
  "integer",
  "long",
  "double",
  "float",
]);

/** Valid rule types. */
const VALID_RULE_TYPES = new Set([
  "createObject",
  "modifyObject",
  "deleteObject",
  "addLink",
  "removeLink",
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
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format an action type DB row for API response (snake_case -> camelCase). */
function formatActionType(row: Record<string, any>): Record<string, unknown> {
  return {
    actionTypeId: row.action_type_id,
    apiName: row.api_name,
    displayName: row.display_name,
    description: row.description,
    parameters: row.parameters,
    rules: row.rules,
    submissionCriteria: row.submission_criteria ?? null,
    sideEffects: row.side_effects ?? null,
    maxAffectedObjects: row.max_affected_objects,
    isEnabled: row.is_enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

/**
 * Resolve an object type API name to its object_type_id.
 * Returns { objectTypeId, properties } or throws VALIDATION_FAILED.
 */
async function resolveObjectType(
  ontologyId: string,
  objectTypeApiName: string,
  contextMsg: string
): Promise<{ objectTypeId: string; properties: Set<string> }> {
  const otResult = await query(
    "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
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
    "SELECT api_name FROM property WHERE object_type_id = $1",
    [objectTypeId]
  );
  const properties = new Set<string>(
    propResult.rows.map((r: Record<string, unknown>) => r.api_name as string)
  );

  return { objectTypeId, properties };
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
    if (ruleType === "createObject" || ruleType === "modifyObject" || ruleType === "deleteObject") {
      if (!rule.objectType || typeof rule.objectType !== "string") {
        errors.push(`${idx}.objectType is required for '${ruleType}' rules.`);
        continue;
      }

      let objTypeProps: Set<string> | null = null;
      try {
        const resolved = await resolveObjectType(
          ontologyId,
          rule.objectType as string,
          `Rule ${idx}`
        );
        objTypeProps = resolved.properties;
      } catch (err: any) {
        errors.push(err.message);
        continue;
      }

      // Validate properties for createObject and modifyObject
      if ((ruleType === "createObject" || ruleType === "modifyObject") && rule.properties) {
        if (typeof rule.properties !== "object" || Array.isArray(rule.properties)) {
          errors.push(`${idx}.properties must be an object.`);
          continue;
        }

        const props = rule.properties as Record<string, unknown>;
        for (const [propName, mapping] of Object.entries(props)) {
          // Validate the property exists on the object type
          if (!objTypeProps.has(propName)) {
            errors.push(
              `Rule references non-existent property '${propName}' on object type '${rule.objectType}'`
            );
          }

          // Validate the mapping source
          if (mapping && typeof mapping === "object" && !Array.isArray(mapping)) {
            const m = mapping as Record<string, unknown>;
            if (m.source) {
              if (!VALID_SOURCES.has(m.source as string)) {
                errors.push(
                  `${idx}.properties.${propName}.source '${m.source}' is invalid. ` +
                    `Must be one of: ${Array.from(VALID_SOURCES).join(", ")}`
                );
              }
              // If source is 'parameter', validate param reference
              if (m.source === "parameter") {
                if (!m.param || typeof m.param !== "string") {
                  errors.push(
                    `${idx}.properties.${propName}: source 'parameter' requires a 'param' field.`
                  );
                } else if (!paramNames.has(m.param as string)) {
                  errors.push(
                    `${idx}.properties.${propName}: references non-existent parameter '${m.param}'`
                  );
                }
              }
            }
          }
        }
      }
    }

    // For addLink/removeLink: validate linkTypeApiName if provided
    if (ruleType === "addLink" || ruleType === "removeLink") {
      if (!rule.linkTypeApiName && !rule.objectType) {
        errors.push(`${idx}: addLink/removeLink rules require a linkTypeApiName or objectType.`);
      }
    }
  }

  return errors;
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

      // --- Create the action type ---
      const row = await createActionType(ontologyId, {
        apiName: body.apiName,
        displayName: body.displayName,
        description: body.description,
        parameters: params,
        rules,
        submissionCriteria: body.submissionCriteria ?? null,
        sideEffects: body.sideEffects ?? null,
        maxAffectedObjects: maxAffected,
        isEnabled: body.isEnabled ?? true,
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
// Endpoint 3: GET /:actionApiName (Get Single Action Type)
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
// Endpoint 4: PUT /:actionApiName (Update Action Type)
// ---------------------------------------------------------------------------

router.put(
  "/:actionApiName",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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

      // --- Build the update payload (snake_case for the model) ---
      const updates: UpdateActionTypeInput = {};

      if (body.displayName !== undefined) updates.display_name = body.displayName;
      if (body.description !== undefined) updates.description = body.description;
      if (body.parameters !== undefined) updates.parameters = body.parameters;
      if (body.rules !== undefined) updates.rules = body.rules;
      if (body.submissionCriteria !== undefined) updates.submission_criteria = body.submissionCriteria;
      if (body.sideEffects !== undefined) updates.side_effects = body.sideEffects;
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
  }
);

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
