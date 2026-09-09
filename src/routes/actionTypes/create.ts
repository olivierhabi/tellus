// ---------------------------------------------------------------------------
// Action Type Routes — Create
//
// POST / — Create a new action type.
// Extracted from the former god-file routes/actionTypes.ts (behavior-preserving
// move; route registration order is unchanged — see ./index.ts).
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../../db";
import { createActionType } from "../../models/actionType";
import type { UpdateActionTypeInput } from "../../models/actionType";
import { sendError, sendCreated } from "../../utils/responseFormatter";
import { OntologyError } from "../../utils/queryErrors";
import { validateActionSemantics, V1_DEFAULT_SEMANTICS, V2_DEFAULT_SEMANTICS, ActionSemanticsVersion, ActionExecutionMode, DeletePolicy } from "../../actions/actionSemantics";
import { isV2CreationEnabled } from "../../actions/actionSemanticsFlags";
import { resolveRequestTenant } from "../../utils/requestTenant";
import {
  ensureParameterRids,
  ensureRuleRids,
  API_NAME_RE,
  KNOWN_CODES,
  validateFunctionConfig,
  formatActionType,
  actorOf,
  validateOptionalMetadata,
  validateParameters,
  validateRules,
  hasWebhookBinding,
  validateWritebackConfig,
  validateWritebackOutputReferences,
  validateSideEffectsConfig,
} from "./shared";

export function registerCreateRoutes(router: Router): void {
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
      const persistedParams = ensureParameterRids(params);

      // rules
      const isFunctionAction = body.executionMode === "function";
      const isDraft = body.isEnabled === false;
      const rules = body.rules ?? [];
      // Webhook-backed actions are meaningful with zero edit rules — the
      // binding IS the action's logic (mappings completed in Logic).
      if (
        !Array.isArray(rules) ||
        (!isFunctionAction &&
          !isDraft &&
          !hasWebhookBinding(body.writebackConfig, body.sideEffects) &&
          rules.length === 0)
      ) {
        sendError(
          res,
          "VALIDATION_FAILED",
          isFunctionAction
            ? "rules must be an array."
            : "rules must be a non-empty array (an action with no rules is meaningless)."
        );
        return;
      }
      if (isFunctionAction && rules.length > 0) {
        sendError(
          res,
          "FUNCTION_CONFIG_INVALID",
          "Function-backed Action Types cannot also declare declarative rules.",
        );
        return;
      }

      // Build parameter name set for rule validation
      const paramNames = new Set<string>(
        params.map((p: Record<string, unknown>) => p.apiName as string)
      );

      const ruleErrors = isFunctionAction || rules.length === 0
        ? []
        : await validateRules(rules, ontologyId, paramNames, params);
      if (ruleErrors.length > 0) {
        sendError(res, "VALIDATION_FAILED", ruleErrors.join(" "), {
          validationErrors: ruleErrors,
        });
        return;
      }
      const persistedRules = ensureRuleRids(
        rules.filter(
          (rule: unknown): rule is Record<string, unknown> =>
            !!rule && typeof rule === "object" && !Array.isArray(rule),
        ),
      );

      if (isFunctionAction) {
        const functionErrors = await validateFunctionConfig(body.functionConfig, params);
        if (functionErrors.length > 0) {
          sendError(res, "FUNCTION_CONFIG_INVALID", functionErrors.join(" "), {
            validationErrors: functionErrors,
          });
          return;
        }
      } else if (body.functionConfig != null) {
        sendError(
          res,
          "FUNCTION_CONFIG_INVALID",
          "functionConfig is only valid when executionMode is 'function'.",
        );
        return;
      }

      // Phase 4 — writeback_config validation (one-writeback-per-action
      // invariant is structural in DB migration 130; this validates the
      // shape, the webhook reference, and the input-mapping's ValueSources).
      // Creation is the authoring boundary: shape/status/membership of the
      // webhook binding are validated here, but input-mapping COMPLETENESS
      // (requireComplete) is not — the UI flow authors mappings in Logic
      // after create. Completeness is enforced at the next checkpoint:
      // PATCH on an enabled action re-validates with requireComplete=true.
      const wbErrors = await validateWritebackConfig(
        body.writebackConfig,
        ontologyId,
        paramNames,
        params,
        resolveRequestTenant(req),
        false,
      );
      if (wbErrors.length > 0) {
        sendError(res, "WRITEBACK_CONFIG_INVALID", wbErrors.join(" "), {
          validationErrors: wbErrors,
        });
        return;
      }
      const writebackReferenceErrors =
        await validateWritebackOutputReferences(
          rules,
          body.writebackConfig,
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
      const sideEffectErrors = await validateSideEffectsConfig(
        body.sideEffects,
        paramNames,
        params,
        ontologyId,
        resolveRequestTenant(req),
        false,
      );
      if (sideEffectErrors.length > 0) {
        sendError(res, "SIDE_EFFECTS_INVALID", sideEffectErrors.join(" "), {
          validationErrors: sideEffectErrors,
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
          const { incCounter } = await import("../../services/funnel/metrics");
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
        parameters: persistedParams,
        rules: persistedRules,
        submissionCriteria: body.submissionCriteria ?? null,
        sideEffects: body.sideEffects ?? null,
        writebackConfig: body.writebackConfig ?? null,
        functionConfig: body.functionConfig ?? null,
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
}
