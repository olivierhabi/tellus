// ---------------------------------------------------------------------------
// Action Type Routes — Clone
//
// POST /:actionApiName/clone — deep-copy an action type under a new API name.
// Extracted from the former god-file routes/actionTypes.ts (behavior-preserving
// move; route registration order is unchanged — see ./index.ts).
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { createActionType, getActionType } from "../../models/actionType";
import { sendError, sendCreated } from "../../utils/responseFormatter";
import { appError } from "../../utils/appError";
import { OntologyError } from "../../utils/queryErrors";
import { ActionSemanticsVersion, ActionExecutionMode, DeletePolicy } from "../../actions/actionSemantics";
import {
  ensureParameterRids,
  ensureRuleRids,
  API_NAME_RE,
  KNOWN_CODES,
  formatActionType,
  actorOf,
} from "./shared";

export function registerCloneRoutes(router: Router): void {
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
      const sourceSemanticsVersion: ActionSemanticsVersion | undefined =
        source.semantics_version === 1 || source.semantics_version === 2
          ? source.semantics_version
          : undefined;
      const sourceExecutionMode: ActionExecutionMode | undefined =
        source.execution_mode === "declarative" ||
        source.execution_mode === "function"
          ? source.execution_mode
          : undefined;
      const sourceDeletePolicy: DeletePolicy | undefined =
        source.delete_policy === "legacy_unchecked" ||
        source.delete_policy === "restrict"
          ? source.delete_policy
          : undefined;
      if (
        source.semantics_version != null &&
        sourceSemanticsVersion === undefined
      ) {
        throw appError(
          "VALIDATION_FAILED",
          `Cannot clone action type with unsupported semantics version '${source.semantics_version}'.`,
        );
      }
      if (source.execution_mode != null && sourceExecutionMode === undefined) {
        throw appError(
          "VALIDATION_FAILED",
          `Cannot clone action type with unsupported execution mode '${source.execution_mode}'.`,
        );
      }
      if (source.delete_policy != null && sourceDeletePolicy === undefined) {
        throw appError(
          "VALIDATION_FAILED",
          `Cannot clone action type with unsupported delete policy '${source.delete_policy}'.`,
        );
      }

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
        parameters: ensureParameterRids(
          JSON.parse(JSON.stringify(source.parameters)).map(
            (parameter: Record<string, unknown>) => {
              const { rid: _sourceRid, ...definition } = parameter;
              return definition;
            },
          ),
        ),
        rules: ensureRuleRids(
          JSON.parse(JSON.stringify(source.rules)).map(
            (rule: Record<string, unknown>) => {
              const {
                ruleId: _sourceRuleId,
                schemaVersion: _sourceSchemaVersion,
                ...definition
              } = rule;
              return definition;
            },
          ),
        ),
        submissionCriteria: source.submission_criteria != null
          ? JSON.parse(JSON.stringify(source.submission_criteria))
          : null,
        sideEffects: source.side_effects != null
          ? JSON.parse(JSON.stringify(source.side_effects))
          : null,
        writebackConfig: source.writeback_config != null
          ? JSON.parse(JSON.stringify(source.writeback_config))
          : null,
        functionConfig: source.function_config != null
          ? JSON.parse(JSON.stringify(source.function_config))
          : null,
        maxAffectedObjects: source.max_affected_objects,
        isEnabled: source.is_enabled,
        createdBy: actorOf(req),
        semanticsVersion: sourceSemanticsVersion,
        executionMode: sourceExecutionMode,
        deletePolicy: sourceDeletePolicy,
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
}
