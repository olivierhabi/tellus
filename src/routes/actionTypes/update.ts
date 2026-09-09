// ---------------------------------------------------------------------------
// Action Type Routes — Update
//
// PUT/PATCH /:actionApiName and POST /:actionApiName/blastRadius (pre-save preview).
// Extracted from the former god-file routes/actionTypes.ts (behavior-preserving
// move; route registration order is unchanged — see ./index.ts).
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { pool, query } from "../../db";
import { computeActionTypeBlastRadius } from "../../services/automate/blastRadius";
import { actionDefinitionInputFromRow } from "../../actions/actionDefinitionCanonical";
import { getActionType, updateActionType } from "../../models/actionType";
import type { UpdateActionTypeInput } from "../../models/actionType";
import { sendError, sendSuccess } from "../../utils/responseFormatter";
import { OntologyError } from "../../utils/queryErrors";
import { validateSchemaMigration } from "../../actions/schemaMigrationValidator";
import type { CurrentSchema, ProposedSchema, RecentExecutionStats } from "../../actions/schemaMigrationValidator";
import { dataPlaneGuard } from "../../middleware/requireRole";
import { normalizeActionSecuritySettings } from "../../actions/actionSecuritySettings";
import { resolveRequestTenant } from "../../utils/requestTenant";
import {
  ensureParameterRids,
  ensureRuleRids,
  KNOWN_CODES,
  validateFunctionConfig,
  formatActionType,
  validateOptionalMetadata,
  validateParameters,
  validateRules,
  hasWebhookBinding,
  validateWritebackConfig,
  validateWritebackOutputReferences,
  validateSideEffectsConfig,
} from "./shared";

export function registerUpdateRoutes(router: Router): void {
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
      const effectiveWriteback =
        body.writebackConfig !== undefined
          ? body.writebackConfig
          : existing.writeback_config;
      const effectiveSideEffects =
        body.sideEffects !== undefined
          ? body.sideEffects
          : existing.side_effects;
      const resultingEnabled =
        body.isEnabled !== undefined ? body.isEnabled : existing.is_enabled;

      // --- Function-backed actions (Action Semantics v2) -------------------
      //
      // Mirror the POST create contract on partial updates: a Function-backed
      // action carries NO declarative rules — its `functionConfig` is the
      // action's logic — and every declared Function input must exist as an
      // action parameter. `executionMode` may flip between "declarative" and
      // "function"; persistence of either column is partial-update style.
      if (
        body.executionMode !== undefined &&
        body.executionMode !== "declarative" &&
        body.executionMode !== "function"
      ) {
        sendError(
          res,
          "VALIDATION_FAILED",
          "executionMode must be 'declarative' or 'function'."
        );
        return;
      }
      const effectiveExecutionMode =
        body.executionMode !== undefined
          ? body.executionMode
          : existing.execution_mode;
      const isFunctionAction = effectiveExecutionMode === "function";

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

      // Rule-validation errors: hard errors block; a required-property
      // mapping gap on UPDATE is downgraded to a migration warning (see
      // below). Both arrays accumulate across this request's single pass.
      const ruleErrors: string[] = [];
      const downgradedRuleWarnings: string[] = [];

      // Validate rules if provided, or re-validate existing rules against new params
      if (
        body.rules !== undefined ||
        body.parameters !== undefined ||
        body.isEnabled === true
      ) {
        const rulesToValidate = effectiveRules;
        if (!Array.isArray(rulesToValidate) || rulesToValidate.length === 0) {
          // Webhook-backed AND Function-backed actions need no edit rules
          // (see POST create): the binding/config IS the action's logic.
          if (
            resultingEnabled &&
            !isFunctionAction &&
            !hasWebhookBinding(effectiveWriteback, effectiveSideEffects)
          ) {
            sendError(
              res,
              "VALIDATION_FAILED",
              "rules must be a non-empty array (an action with no rules is meaningless)."
            );
            return;
          }
        } else {
          if (isFunctionAction) {
            sendError(
              res,
              "FUNCTION_CONFIG_INVALID",
              "Function-backed Action Types cannot also declare declarative rules."
            );
            return;
          }
          const paramNames = new Set<string>(
            (effectiveParams as Array<Record<string, unknown>>).map(
              (p) => p.apiName as string
            )
          );
          const allRuleErrors = await validateRules(
            rulesToValidate,
            ontologyId,
            paramNames,
            effectiveParams as Array<Record<string, unknown>>,
          );
          // UPDATE semantics (Task 26): a breaking schema migration must
          // persist with warnings rather than hard-fail. The canonical
          // breaking-change class is a create/modifyOrCreate rule that no
          // longer maps a required property (the object type may have
          // gained a requirement, or the parameter backing the mapping was
          // removed). Creation stays strict — this leniency is only for
          // evolution of an existing definition, surfaced to the caller as
          // migrationWarnings. Every other validation error remains fatal.
          const REQUIRED_PROPERTY_MAPPING =
            /^rules\[\d+\]\.properties must map required property /;
          for (const e of allRuleErrors) {
            if (REQUIRED_PROPERTY_MAPPING.test(e)) {
              downgradedRuleWarnings.push(e);
            } else {
              ruleErrors.push(e);
            }
          }
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
      if (body.writebackConfig !== undefined || body.isEnabled === true) {
        const paramNames = new Set<string>(
          (effectiveParams as Array<Record<string, unknown>>).map(
            (p) => p.apiName as string
          )
        );
        const wbErrors = await validateWritebackConfig(
          effectiveWriteback,
          ontologyId,
          paramNames,
          effectiveParams as Array<Record<string, unknown>>,
          resolveRequestTenant(req),
          resultingEnabled,
        );
        if (wbErrors.length > 0) {
          sendError(res, "WRITEBACK_CONFIG_INVALID", wbErrors.join(" "), {
            validationErrors: wbErrors,
          });
          return;
        }
      }
      if (
        body.rules !== undefined ||
        body.writebackConfig !== undefined ||
        body.isEnabled === true
      ) {
        const writebackReferenceErrors =
          await validateWritebackOutputReferences(
            effectiveRules,
            effectiveWriteback,
            resolveRequestTenant(req),
          );
        if (writebackReferenceErrors.length > 0) {
          sendError(
            res,
            "WRITEBACK_CONFIG_INVALID",
            writebackReferenceErrors.join(" "),
            { validationErrors: writebackReferenceErrors },
          );
          return;
        }
      }
      if (body.sideEffects !== undefined || body.parameters !== undefined || body.isEnabled === true) {
        const paramNames = new Set<string>(
          (effectiveParams as Array<Record<string, unknown>>).map(
            (p) => p.apiName as string
          )
        );
        const sideEffectErrors = await validateSideEffectsConfig(
          effectiveSideEffects,
          paramNames,
          effectiveParams as Array<Record<string, unknown>>,
          ontologyId,
          resolveRequestTenant(req),
          resultingEnabled,
        );
        if (sideEffectErrors.length > 0) {
          sendError(res, "SIDE_EFFECTS_INVALID", sideEffectErrors.join(" "), {
            validationErrors: sideEffectErrors,
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
      if (body.parameters !== undefined) {
        updates.parameters = ensureParameterRids(
          body.parameters as Array<Record<string, unknown>>,
          Array.isArray(existing.parameters)
            ? (existing.parameters as Array<Record<string, unknown>>)
            : [],
        );
      }
      if (body.rules !== undefined) {
        updates.rules = ensureRuleRids(
          body.rules.filter(
            (rule: unknown): rule is Record<string, unknown> =>
              !!rule && typeof rule === "object" && !Array.isArray(rule),
          ),
          Array.isArray(existing.rules)
            ? existing.rules.filter(
                (rule: unknown): rule is Record<string, unknown> =>
                  !!rule && typeof rule === "object" && !Array.isArray(rule),
              )
            : [],
        );
      }
      // Function-backed action: validate the effective functionConfig
      // against the effective action parameters (auto-created inputs)
      // before persisting either — mirrors the POST create gate.
      if (
        isFunctionAction &&
        (body.functionConfig !== undefined ||
          body.executionMode !== undefined ||
          body.parameters !== undefined)
      ) {
        const effectiveFunctionConfig =
          body.functionConfig !== undefined
            ? body.functionConfig
            : existing.function_config;
        const functionErrors = await validateFunctionConfig(
          effectiveFunctionConfig,
          effectiveParams as Array<Record<string, unknown>>,
        );
        if (functionErrors.length > 0) {
          sendError(res, "FUNCTION_CONFIG_INVALID", functionErrors.join(" "), {
            validationErrors: functionErrors,
          });
          return;
        }
      }
      if (body.submissionCriteria !== undefined) updates.submission_criteria = body.submissionCriteria;
      if (body.sideEffects !== undefined) updates.side_effects = body.sideEffects;
      if (body.writebackConfig !== undefined) updates.writeback_config = body.writebackConfig;
      if (body.functionConfig !== undefined) updates.function_config = body.functionConfig;
      if (body.executionMode !== undefined) updates.execution_mode = body.executionMode;
      // Migration 173 — normalized (unknown keys dropped, all-defaults → NULL)
      // before it reaches a security-relevant column.
      if (body.securitySettings !== undefined) {
        updates.security_settings = normalizeActionSecuritySettings(
          body.securitySettings,
        );
      }
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

      // Post-save blast radius: same classification the pre-save preview
      // returned, recomputed against the now-persisted definition.
      let postSaveBlastRadius: import("../../services/automate/blastRadius").BlastRadiusResult | null = null;
      try {
        postSaveBlastRadius = await computeActionTypeBlastRadius(
          pool,
          resolveRequestTenant(req),
          updatedRow.action_type_id,
          actionDefinitionInputFromRow(updatedRow),
          updatedRow.definition_version ?? 1,
        );
      } catch {
        postSaveBlastRadius = null; // advisory only — never fails the save
      }

      // Build response — include migration warnings if any exist
      const responseData: Record<string, unknown> = formatActionType(updatedRow);
      if (downgradedRuleWarnings.length > 0 || !migration.safe) {
        responseData.migrationWarnings = [
          ...downgradedRuleWarnings,
          ...migration.warnings,
          ...migration.breakingChanges,
        ];
      }
      if (postSaveBlastRadius && postSaveBlastRadius.total > 0) {
        responseData.blastRadius = postSaveBlastRadius;
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
// ---------------------------------------------------------------------------
// Pre-save blast radius preview. Body = the same partial-update payload as
// PUT /:actionApiName. Returns the classifier-driven per-pin verdicts over
// every automation (draft or active version) pinning this action type —
// so UIs can warn BEFORE the save happens.
// ---------------------------------------------------------------------------
router.post(
  "/:actionApiName/blastRadius",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ontologyId, actionApiName } = req.params;
      const existing = await getActionType(ontologyId, actionApiName);
      if (!existing) {
        sendError(res, "ACTION_TYPE_NOT_FOUND", `Action type '${actionApiName}' not found.`);
        return;
      }
      const body = req.body ?? {};
      // Candidate = existing semantic columns with candidate payload merged
      // (omitted fields stay) — mirrors updateActionType's merge semantics.
      const candidate = actionDefinitionInputFromRow({
        ...existing,
        ...(body.parameters !== undefined ? { parameters: body.parameters } : {}),
        ...(body.rules !== undefined ? { rules: body.rules } : {}),
        ...(body.submissionCriteria !== undefined ? { submission_criteria: body.submissionCriteria } : {}),
        ...(body.sideEffects !== undefined ? { side_effects: body.sideEffects } : {}),
        ...(body.writebackConfig !== undefined ? { writeback_config: body.writebackConfig } : {}),
        ...(body.functionConfig !== undefined ? { function_config: body.functionConfig } : {}),
        ...(body.semanticsVersion !== undefined || body.executionMode !== undefined || body.deletePolicy !== undefined
          ? {
              semantics_version: body.semanticsVersion ?? existing.semantics_version,
              execution_mode: body.executionMode ?? existing.execution_mode,
              delete_policy: body.deletePolicy ?? existing.delete_policy,
            }
          : {}),
      });
      const blastRadius = await computeActionTypeBlastRadius(
        pool,
        resolveRequestTenant(req),
        existing.action_type_id,
        candidate,
        // The bump trigger increments the version on semantic drift — the
        // new version is what pins will eventually point at.
        (existing.definition_version ?? 1) + 1,
      );
      res.status(200).json({ data: { actionTypeId: existing.action_type_id, actionApiName, blastRadius } });
    } catch (err: any) {
      next(err);
    }
  },
);

router
  .route("/:actionApiName")
  .put(updateActionTypeHandler)
  .patch(updateActionTypeHandler);
}
