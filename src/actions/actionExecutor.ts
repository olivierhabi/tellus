// ---------------------------------------------------------------------------
// Action Execution Orchestrator
//
// Master orchestrator that ties together parameter validation, rule
// compilation, edit application, and audit logging into a single coherent
// action execution pipeline. This is the main entry point — when someone
// calls POST /api/v2/actions/:actionTypeApiName/apply, this runs.
//
// Palantir's action execution has 8 documented stages. In week 1, we
// implement 6 of them (skipping submission criteria and side effects):
//
//   Stage 1: Load the action type definition
//   Stage 2: Validate parameters
//   Stage 3: Submission criteria (SKIP in week 1)
//   Stage 4: Compile rules into edits
//   Stage 5: Writeback webhooks (SKIP in week 1)
//   Stage 6: Apply edits to edit store + OpenSearch
//   Stage 7: Side effect webhooks (SKIP in week 1)
//   Stage 8: Audit log (ALWAYS — even on failure)
//
// The orchestrator tracks timing for each stage, handles errors at every
// stage, and always writes to the audit log — even for failed executions.
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { getActionType } from "../models/actionType";
import type { ActionTypeRow } from "../models/actionType";
import { validateParameters } from "./parameterValidator";
import type { ParameterDefinition } from "./parameterValidator";
import { compileRules } from "./ruleCompiler";
import { applyEdits } from "./editApplicator";
import { logActionExecution } from "../models/actionAuditLog";
import type { FailureType, AuditResult } from "../models/actionAuditLog";
import { getIndexName } from "../services/opensearch/indexMappingGenerator";
import { client as opensearchClient } from "../services/opensearch/client";
import { OntologyError } from "../utils/queryErrors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context provided by the caller (route handler). */
export interface ExecutionContext {
  executedBy: string;
  sourceIp?: string | null;
  branchId?: string | null;
  /** Optimistic concurrency: expected __version of the target object (Task 22). */
  expectedVersion?: number;
}

/** A single affected object in the result. */
export interface AffectedObject {
  objectType: string;
  primaryKey: string;
  operation: "create" | "update" | "delete";
}

/** Result of executeAction. */
export interface ExecutionResult {
  success: boolean;
  executionId: string;
  result: AuditResult;
  failureType: FailureType | null;
  errorMessage: string | null;
  affectedObjects: AffectedObject[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// OpenSearch helpers
// ---------------------------------------------------------------------------

/**
 * Check if an object exists in OpenSearch. Used as the objectExistsChecker
 * for parameter validation (object_reference type parameters).
 */
async function objectExists(
  objectType: string,
  primaryKey: string
): Promise<boolean> {
  try {
    const indexName = getIndexName(objectType);
    await opensearchClient.get({ index: indexName, id: primaryKey });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch an object from OpenSearch. Used as the objectFetcher for rule
 * compilation (modifyObject/deleteObject rules need the current state).
 * Returns the document _source, or null if not found.
 */
async function fetchObject(
  objectType: string,
  primaryKey: string
): Promise<Record<string, unknown> | null> {
  try {
    const indexName = getIndexName(objectType);
    const { body } = await opensearchClient.get({
      index: indexName,
      id: primaryKey,
    });
    return (body as any)._source ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Executes an action: validates parameters, compiles rules, applies edits,
 * and logs to audit. This is the main entry point for all action executions.
 *
 * **Important control flow note:** On failure, this function throws an
 * `OntologyError` from its `finally` block (after writing the audit log).
 * The `Promise<ExecutionResult>` return type is only fulfilled on success
 * paths. Callers must handle the thrown `OntologyError` in a catch block
 * for failure responses — the route handler in `src/routes/actions.ts`
 * is written to expect this pattern. The `finally` block intentionally
 * defers the throw so the audit log is always written, even for failures.
 *
 * @param ontologyId        - The ontology ID
 * @param actionTypeApiName - The api_name of the action type to execute
 * @param parameters        - The raw parameters provided by the caller
 * @param context           - Execution context: { executedBy, sourceIp, branchId }
 * @returns ExecutionResult on success; throws OntologyError on failure
 * @throws {OntologyError} After audit logging, for validation/compilation/unexpected errors
 */
export async function executeAction(
  ontologyId: string,
  actionTypeApiName: string,
  parameters: Record<string, unknown>,
  context: ExecutionContext
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const executionId = crypto.randomUUID();

  // Pre-declare result and actionType so `finally` block can access them
  const result: ExecutionResult = {
    success: false,
    executionId,
    result: "failed",
    failureType: null,
    errorMessage: null,
    affectedObjects: [],
    durationMs: 0,
  };

  let actionType: ActionTypeRow | null = null;

  // Track whether we should throw an OntologyError after audit logging
  let pendingError: OntologyError | null = null;

  try {
    // -----------------------------------------------------------------
    // STAGE 1: Load the action type definition
    // -----------------------------------------------------------------
    actionType = await getActionType(ontologyId, actionTypeApiName);

    if (!actionType) {
      result.failureType = "unclassified";
      result.errorMessage = `Action type '${actionTypeApiName}' not found`;
      pendingError = new OntologyError(
        `Action type '${actionTypeApiName}' not found`,
        "ACTION_TYPE_NOT_FOUND",
        undefined,
        { actionTypeApiName, executionId }
      );
      return result;
    }

    if (!actionType.is_enabled) {
      result.failureType = "unclassified";
      result.errorMessage = `Action type '${actionTypeApiName}' is disabled`;
      pendingError = new OntologyError(
        `Action type '${actionTypeApiName}' is disabled`,
        "ACTION_DISABLED",
        undefined,
        { actionTypeApiName, executionId }
      );
      return result;
    }

    // -----------------------------------------------------------------
    // STAGE 2: Validate parameters
    // -----------------------------------------------------------------
    const validation = await validateParameters(
      actionType.parameters as ParameterDefinition[],
      parameters,
      objectExists
    );

    if (!validation.valid) {
      result.failureType = "invalid_parameter";
      result.errorMessage = validation.errors.join("; ");
      pendingError = new OntologyError(
        validation.errors.join("; "),
        "INVALID_PARAMETER",
        undefined,
        { errors: validation.errors, executionId }
      );
      return result;
    }

    const resolvedParameters = validation.resolvedParameters!;

    // -----------------------------------------------------------------
    // STAGE 3: Submission criteria (SKIP in week 1 — allow all)
    // -----------------------------------------------------------------

    // -----------------------------------------------------------------
    // STAGE 4: Compile rules into edits
    // -----------------------------------------------------------------
    const compilation = await compileRules(
      actionType.rules as any[],
      resolvedParameters,
      fetchObject,
      {
        executedBy: context.executedBy || "system",
        ontologyId,
      }
    );

    if (compilation.errors.length > 0) {
      // Classify the failure type based on error messages
      const firstError = compilation.errors[0];
      let errorCode: string;
      if (firstError.includes("does not exist")) {
        result.failureType = "object_not_found";
        errorCode = "OBJECT_NOT_FOUND";
      } else if (firstError.includes("already exists")) {
        result.failureType = "duplicate_primary_key";
        errorCode = "DUPLICATE_PRIMARY_KEY";
      } else if (firstError.includes("Conflicting")) {
        result.failureType = "unclassified";
        errorCode = "VALIDATION_ERROR";
      } else {
        result.failureType = "unclassified";
        errorCode = "VALIDATION_ERROR";
      }
      result.errorMessage = compilation.errors.join("; ");
      pendingError = new OntologyError(
        compilation.errors.join("; "),
        errorCode,
        undefined,
        { errors: compilation.errors, executionId }
      );
      return result;
    }

    // Check scale limit
    if (compilation.affectedObjectCount > actionType.max_affected_objects) {
      result.failureType = "scale_limit";
      result.errorMessage =
        `Action would affect ${compilation.affectedObjectCount} objects, ` +
        `exceeding the limit of ${actionType.max_affected_objects}`;
      pendingError = new OntologyError(
        result.errorMessage,
        "SCALE_LIMIT_EXCEEDED",
        undefined,
        {
          affectedObjectCount: compilation.affectedObjectCount,
          maxAffectedObjects: actionType.max_affected_objects,
          executionId,
        }
      );
      return result;
    }

    // -----------------------------------------------------------------
    // STAGE 4b: Optimistic Concurrency Check (Task 22)
    //
    // If the caller provided $expectedVersion, verify that the target
    // object's current __version matches. This prevents lost updates
    // when two clients modify the same object concurrently.
    //
    // Week 1 scope: Only supported for single-object modify actions.
    // Multi-object actions with $expectedVersion return a 400 error.
    // -----------------------------------------------------------------
    if (context.expectedVersion !== undefined) {
      // Count how many modify (update) rules produced edits
      const modifyEdits = compilation.edits.filter(
        (e) => e.operation === "update"
      );

      if (modifyEdits.length === 0) {
        result.failureType = "unclassified";
        result.errorMessage =
          "$expectedVersion is only applicable to actions with modifyObject rules";
        pendingError = new OntologyError(
          result.errorMessage,
          "INVALID_PARAMETER",
          undefined,
          { executionId }
        );
        return result;
      }

      if (compilation.edits.length > 1) {
        result.failureType = "unclassified";
        result.errorMessage =
          "Optimistic concurrency control is only supported for single-object actions in week 1";
        pendingError = new OntologyError(
          result.errorMessage,
          "INVALID_PARAMETER",
          400,
          { executionId }
        );
        return result;
      }

      // Single modify edit — fetch the current object and check __version
      const targetEdit = modifyEdits[0];
      const currentObject = await fetchObject(
        targetEdit.objectType,
        targetEdit.primaryKey
      );
      const currentVersion: number =
        (currentObject as any)?.__version ?? 0;

      if (currentVersion !== context.expectedVersion) {
        result.failureType = "unclassified";
        result.errorMessage =
          `Object '${targetEdit.primaryKey}' of type '${targetEdit.objectType}' has been modified since you last read it. ` +
          `Expected version ${context.expectedVersion}, current version ${currentVersion}. ` +
          `Reload the object and try again.`;
        pendingError = new OntologyError(
          result.errorMessage,
          "CONCURRENCY_CONFLICT",
          undefined,
          {
            objectType: targetEdit.objectType,
            primaryKey: targetEdit.primaryKey,
            expectedVersion: context.expectedVersion,
            currentVersion,
            executionId,
          }
        );
        return result;
      }
    }

    // -----------------------------------------------------------------
    // STAGE 5: Writeback webhooks (SKIP in week 1)
    // -----------------------------------------------------------------

    // -----------------------------------------------------------------
    // STAGE 6: Apply edits
    // -----------------------------------------------------------------
    const application = await applyEdits(compilation.edits, {
      executionId,
      actionTypeApiName,
      parameters: resolvedParameters,
      executedBy: context.executedBy || "system",
    });

    result.success = application.success;

    if (!application.success) {
      // PG transaction failed (should not happen — PG failures throw, but
      // handle defensively in case applyEdits evolves).
      result.result = "failed";
    } else if (application.failedEdits.length === 0) {
      // PG committed + all OpenSearch writes succeeded
      result.result = "success";
    } else {
      // PG committed but some or all OpenSearch writes failed. Data IS
      // durably stored in PostgreSQL; the reindex pipeline will sync to
      // OpenSearch. Report "partial" (not "failed") so clients know the
      // action took effect even though search indexing is degraded.
      result.result = "partial";
    }

    result.affectedObjects = application.appliedEdits.map((e) => ({
      objectType: e.objectType,
      primaryKey: e.primaryKey,
      operation: e.operation,
    }));

    // -----------------------------------------------------------------
    // STAGE 7: Side effect webhooks/notifications (SKIP in week 1)
    // -----------------------------------------------------------------

    return result;
  } catch (err: unknown) {
    // Re-throw OntologyErrors (they were already classified)
    if (err instanceof OntologyError) {
      result.failureType = "unclassified";
      result.errorMessage = err.message;
      pendingError = err;
      return result;
    }
    // Unexpected error in the pipeline
    result.failureType = "unclassified";
    result.errorMessage =
      err instanceof Error ? err.message : String(err);
    return result;
  } finally {
    // -----------------------------------------------------------------
    // STAGE 8: ALWAYS write audit log (even for failures)
    // -----------------------------------------------------------------
    result.durationMs = Date.now() - startTime;

    await logActionExecution({
      action_type_api_name: actionTypeApiName,
      action_type_display_name:
        actionType?.display_name || actionTypeApiName,
      execution_id: executionId,
      parameters,
      affected_objects: result.affectedObjects,
      affected_object_count: result.affectedObjects.length,
      result: result.result,
      failure_type: result.failureType,
      error_message: result.errorMessage,
      duration_ms: result.durationMs,
      executed_by: context.executedBy || "system",
      source_ip: context.sourceIp || null,
      branch_id: context.branchId || null,
    });

    // ---------------------------------------------------------------------
    // STAGE 9: Publish to Kafka so the streaming pipeline (Apache Flink)
    // and the Object Explorer "Action Run History" panel see the event in
    // near-real-time. Best-effort — we don't block the action result on
    // broker availability.
    // ---------------------------------------------------------------------
    try {
      const { publishEvent } = await import("../services/kafkaProducer");
      const { incrementCounter, observeHistogram } = await import("../routes/metrics");
      incrementCounter("ontology_actions_applied_total");
      observeHistogram("ontology_action_duration_ms", result.durationMs);
      void publishEvent("ontology.actions", {
        ontologyId,
        actionTypeApiName,
        executionId,
        result: result.result,
        affectedCount: result.affectedObjects.length,
        durationMs: result.durationMs,
        executedBy: context.executedBy ?? "system",
      });
    } catch {
      /* ignore — observability must never break the action path */
    }

    // After audit logging, throw the deferred OntologyError. This causes
    // the Promise<ExecutionResult> to reject — the caller never receives
    // the result object on failure paths. This is intentional: the global
    // error handler in the route layer catches the OntologyError and
    // produces a standardized HTTP error response. The result object was
    // only used above to populate the audit log entry.
    if (pendingError) {
      throw pendingError;
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { executeAction };
