// ---------------------------------------------------------------------------
// Action Execution Orchestrator
//
// Master orchestrator that ties together parameter validation, rule
// compilation, edit application, and audit logging into a single coherent
// action execution pipeline. This is the main entry point — when someone
// calls POST /api/v1/actions/:actionTypeApiName/apply, this runs.
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
import {
  appendAuditRow,
  logStandaloneFailureAudit,
  AuditDurabilityError,
  type AuditLogEntry,
  type FailureType,
  type AuditResult,
} from "../models/actionAuditLog";
import { incCounter } from "../services/funnel/metrics";
import { resolveBranchIdOrMain } from "../services/branchContext";
import { getIndexName } from "../services/opensearch/indexMappingGenerator";
import { client as opensearchClient } from "../services/opensearch/client";
import { OntologyError } from "../utils/queryErrors";
import { query as pgQuery } from "../db";

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
  // 1. Postgres is authoritative — a freshly-created object lands in
  //    object_instances synchronously inside the same action txn, whereas
  //    OpenSearch indexing is best-effort and may lag. Check PG first so
  //    multi-rule actions see objects produced by prior rules in the same
  //    batch or by a preceding action call.
  try {
    const res = await pgQuery(
      `SELECT 1 FROM object_instances
        WHERE object_type_api_name = $1 AND primary_key = $2
        LIMIT 1`,
      [objectType, primaryKey]
    );
    if ((res.rowCount ?? 0) > 0) return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Tolerate missing B1 table in transitional deployments; fall through.
    if (!/relation .*object_instances.* does not exist/i.test(msg)) {
      console.warn(`[action:objectExists] PG lookup failed: ${msg}`);
    }
  }

  // 2. Fall back to OpenSearch for objects that predate the writeback store.
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
  // Prefer Postgres (authoritative writeback store) so rule compilation sees
  // the latest state of objects modified by earlier rules in the same batch,
  // or created by a prior action call, without waiting for OpenSearch indexing.
  try {
    const res = await pgQuery(
      `SELECT properties FROM object_instances
        WHERE object_type_api_name = $1 AND primary_key = $2
        LIMIT 1`,
      [objectType, primaryKey]
    );
    if ((res.rowCount ?? 0) > 0) {
      const row = res.rows[0] as { properties: unknown };
      if (row.properties && typeof row.properties === "object") {
        return row.properties as Record<string, unknown>;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/relation .*object_instances.* does not exist/i.test(msg)) {
      console.warn(`[action:fetchObject] PG lookup failed: ${msg}`);
    }
  }

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

  // F-P3-11: tracks whether the durable-before-ack audit row was
  // committed inside the applyEdits transaction. If true, the finally
  // block skips the standalone audit write (the hash chain is already
  // extended). If false, the finally block writes a failure audit via
  // logStandaloneFailureAudit — failure-path events (stages 1-5) and
  // mid-apply-edits exceptions both reach audit durability this way.
  let auditCommitted = false;

  const buildAuditEntry = (): AuditLogEntry => ({
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
    metadata: {},
  });

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
    // F-P3-12: thread the (possibly unresolved) caller-supplied branchId
    // into the rule-compilation context so read-path helpers
    // (`linkRules.getLinkNetState`, `deleteObjectRule.checkManyToManyLinks`)
    // scope their link_edit lookups to the correct branch. The writer
    // boundary further down the function resolves an unset branch to
    // `main`; rule compilation still sees `undefined` for that case
    // and its readers comment on the cross-branch fallback.
    const compilation = await compileRules(
      actionType.rules as any[],
      resolvedParameters,
      fetchObject,
      {
        executedBy: context.executedBy || "system",
        ontologyId,
        branchId: context.branchId ?? undefined,
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
    // Pre-flight validation only: reject unsupported configurations.
    // The actual version check is performed atomically inside the PG
    // transaction in editApplicator.ts (F-05 fix).
    // -----------------------------------------------------------------
    let occTarget: { objectType: string; primaryKey: string } | undefined;
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
          "Optimistic concurrency control is only supported for single-object actions";
        pendingError = new OntologyError(
          result.errorMessage,
          "INVALID_PARAMETER",
          400,
          { executionId }
        );
        return result;
      }

      occTarget = {
        objectType: modifyEdits[0].objectType,
        primaryKey: modifyEdits[0].primaryKey,
      };
    }

    // -----------------------------------------------------------------
    // STAGE 5: Writeback webhooks (SKIP in week 1)
    // -----------------------------------------------------------------

    // -----------------------------------------------------------------
    // STAGE 6: Apply edits (with F-P3-11 durable-before-ack audit hook)
    //
    // The preCommitHook runs AFTER all edits have been inserted but
    // BEFORE the PG COMMIT. If the hash-chain append fails, the outer
    // transaction rolls back — edits and audit are atomic. We
    // pre-stamp `result.result` to "success" here so the audit row
    // records the intended outcome; if COMMIT subsequently fails (very
    // rare — PG connection loss between hook and COMMIT), the catch
    // below flips it to "failed" and the finally block writes a
    // standalone failure audit recording the rollback.
    // -----------------------------------------------------------------
    result.durationMs = Date.now() - startTime;
    result.result = "success";
    result.affectedObjects = compilation.edits.map((e) => ({
      objectType: e.objectType,
      primaryKey: e.primaryKey,
      operation: e.operation,
    }));

    const preCommitHook = async (pg: any) => {
      // Recompute duration at commit time for a tighter audit number.
      result.durationMs = Date.now() - startTime;
      const entry = buildAuditEntry();
      await appendAuditRow(pg, entry);
      auditCommitted = true;
    };

    // F-P3-12: resolve branch at the single executor boundary. The
    // writer (`applyEdits`) requires `branchId: string` — a missing
    // branch is a compile-time error. `resolveBranchIdOrMain` falls
    // back to the ontology's `main` branch UUID when the caller did
    // not thread one (classic untagged writes); any other downstream
    // code is forbidden from performing this fallback again.
    const resolvedBranchId = await resolveBranchIdOrMain(
      ontologyId,
      context.branchId,
    );

    const application = await applyEdits(compilation.edits, {
      executionId,
      actionTypeApiName,
      parameters: resolvedParameters,
      executedBy: context.executedBy || "system",
      expectedVersion: context.expectedVersion,
      expectedVersionTarget: occTarget,
      preCommitHook,
      ontologyId,
      branchId: resolvedBranchId,
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
    // Audit-durability failures are first-class — they must translate to
    // 503 Service Unavailable at the route layer and MUST NOT be swallowed
    // or downgraded. auditCommitted stays false, so the finally block will
    // attempt a standalone failure audit; if that also fails, the client
    // still sees the AuditDurabilityError.
    if (err instanceof AuditDurabilityError) {
      result.result = "failed";
      result.failureType = "unclassified";
      result.errorMessage = err.message;
      pendingError = new OntologyError(
        err.message,
        "AUDIT_DURABILITY_FAILED",
        503,
        { executionId },
      );
      incCounter("tellus_action_audit_rollback_total", { reason: "hash_chain" });
      return result;
    }

    // Re-throw OntologyErrors (they were already classified)
    if (err instanceof OntologyError) {
      result.failureType = "unclassified";
      result.errorMessage = err.message;
      pendingError = err;
      return result;
    }
    // Unexpected error in the pipeline. Log it + wrap in an
    // OntologyError so the client gets a structured 500 instead of a
    // silent HTTP 200 with {result:"failed"}. Previously this branch
    // swallowed the stack trace AND didn't set `pendingError`, so
    // the response body carried no actionable info and the route
    // responded 200 — which broke multi-rule integration tests that
    // assert `expect(res.body.result).toBe("success")` on an otherwise
    // legitimate exception (e.g. a missing B1 table mid-transaction).
    const errorMessage =
      err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    console.error(
      `[action:${actionTypeApiName}] unexpected execution error: ${errorMessage}${errorStack ? "\n" + errorStack : ""}`,
    );
    result.failureType = "unclassified";
    result.errorMessage = errorMessage;
    pendingError = new OntologyError(
      `Action '${actionTypeApiName}' failed with an unexpected error: ${errorMessage}`,
      "ACTION_EXECUTION_FAILED",
      undefined,
      { actionTypeApiName, executionId },
    );
    return result;
  } finally {
    // -----------------------------------------------------------------
    // STAGE 8: ALWAYS write audit log (even for failures)
    // -----------------------------------------------------------------
    result.durationMs = Date.now() - startTime;

    // F-P3-11: if the hash-chain append succeeded inside the applyEdits
    // PG transaction, the audit row is already committed — skip the
    // standalone write. If not (stages 1-5 failure or mid-apply
    // exception), write a failure audit now. AuditDurabilityError from
    // this standalone path is surfaced as a 503 OntologyError so the
    // client sees the real contract violation.
    if (!auditCommitted) {
      try {
        await logStandaloneFailureAudit(buildAuditEntry());
      } catch (auditErr) {
        if (auditErr instanceof AuditDurabilityError) {
          incCounter("tellus_action_audit_rollback_total", { reason: "standalone" });
          // If we didn't already have a pending error, this becomes it.
          // Otherwise, prefer the original business error but still log
          // the audit failure.
          if (!pendingError) {
            pendingError = new OntologyError(
              auditErr.message,
              "AUDIT_DURABILITY_FAILED",
              503,
              { executionId },
            );
          } else {
            console.error(
              `[action:${actionTypeApiName}] audit durability failed during failure-path log: ${auditErr.message}`,
            );
          }
        } else {
          console.error(
            `[action:${actionTypeApiName}] unexpected error from logStandaloneFailureAudit: ${
              auditErr instanceof Error ? auditErr.message : String(auditErr)
            }`,
          );
        }
      }
    }

    // ---------------------------------------------------------------------
    // STAGE 9: Publish to Kafka so the streaming pipeline (Apache Flink)
    // and the Object Explorer "Action Run History" panel see the event in
    // near-real-time. Best-effort — we don't block the action result on
    // broker availability.
    // ---------------------------------------------------------------------
    try {
      const { publishEvent } = await import("../services/kafkaProducer");
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
