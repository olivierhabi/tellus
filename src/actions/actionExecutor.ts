// ---------------------------------------------------------------------------
// Action Execution Orchestrator
//
// Master orchestrator that ties together parameter validation, rule
// compilation, edit application, and audit logging into a single coherent
// action execution pipeline. This is the main entry point — when someone
// calls POST /api/v1/actions/:actionTypeApiName/apply, this runs.
//
// Palantir's action execution has 8 documented stages. All are implemented
// (FOUNDRY-GAPS §5 closed Stage 3 + the webhook side-effects):
//
//   Stage 1: Load the action type definition
//   Stage 2: Validate parameters
//   Stage 3: Submission criteria (submissionCriteria.ts — gate on inputs/subject)
//   Stage 4: Compile rules into edits
//   Stage 5: (see Stage 7) — webhooks fire post-commit, not pre-commit, by design
//   Stage 6: Apply edits to edit store + OpenSearch
//   Stage 7: Side effects — object_set.changed events + outbound webhooks
//            (actionWebhooks.ts, post-commit, best-effort, SSRF-guarded)
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
import { executeWriteback, type WritebackConfig, type WritebackResult, type HttpRequestFn, type HttpResponseSimulated } from "./writebackExecutor";
import { runWritebackStage } from "./runWritebackStage";
import { DEFAULT_EGRESS_POLICY } from "../services/webhookSafeTransport";
import * as https from "https";
import * as http from "http";
import { applyEdits } from "./editApplicator";
import { evaluateSubmissionCriteria, resolveObjectPropertyOperands } from "./submissionCriteria";
import { evaluateFunctionValidationCriteria } from "./functionValidationCriteria";
import { fireActionWebhooks } from "./actionWebhooks";
import { sendNotifications } from "./sideEffectNotifier";
import {
  extractSideEffectJobs,
  type SideEffectExecutionContext,
} from "./sideEffectJobExtractor";
import { enqueueSideEffectJobsInTransaction } from "../models/actionSideEffectJob";
import {
  appendAuditRow,
  logStandaloneFailureAudit,
  AuditDurabilityError,
  type AuditLogEntry,
  type FailureType,
  type AuditResult,
} from "../models/actionAuditLog";
import {
  runActionCbacGate,
  cbacDenyMessage,
  type CbacGateResult,
} from "./actionCbac";
import { incCounter } from "../services/funnel/metrics";
import { eventBus } from "../websocket/eventBus";
import { resolveBranchIdOrMain } from "../services/branchContext";
import { getIndexName } from "../services/opensearch/indexMappingGenerator";
import { client as opensearchClient } from "../services/opensearch/client";
import { OntologyError } from "../utils/queryErrors";
import { query as pgQuery } from "../db";
import { resolveSemanticsForRow } from "../models/actionType";
import {
  getActionSemanticsExecutionAvailability,
  isV2ExecutionEnabled,
} from "./actionSemanticsFlags";
import type { ActionError } from "./actionErrors";
import { defaultSchemaLookup } from "./objectReferenceResolver";
import { buildPlannedStepsFromRules } from "./actionV2PlanBuilder";
import { buildActionPlan, objectKey, type ObjectIdentity } from "./actionPlanner";
import { loadPersistedState, toLockIdentities } from "./actionV2StateLoader";
import type { LockIdentity } from "./actionLockManager";
import { withBoundedRetry } from "./actionRetry";
import {
  executeFunctionAction,
  type FunctionActionBinding,
  type FunctionActionParameterDefinition,
} from "./functionActionExecutor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context provided by the caller (route handler). */
export interface ExecutionContext {
  executedBy: string;
  /**
   * UI/request trace identifier. When supplied it is propagated unchanged to
   * action plans, writebacks, and audit entries; executionId remains the
   * immutable identifier of this particular execution.
   */
  correlationId?: string;
  sourceIp?: string | null;
  branchId?: string | null;
  /** Tenant scope for data-connection webhook resolution during the
   * writeback pre-edit stage (the connectivity store is
   * tenant-scoped). Threaded from the route's authenticated
   * principal; the writeback executor falls back to "default" when
   * absent (tests, internal callers). */
  tenant?: string;
  /** Optimistic concurrency: expected __version of the target object (Task 22). */
  expectedVersion?: number;
  /** Subject roles/groups for §5 submission-criteria evaluation (Stage 3). */
  roles?: string[];
  groups?: string[];
  /** Phase 6.1 — CBAC subject + markings/cbac from `req.security`.
   * Threaded through from the route's `securityContext` middleware so
   * the Stage 1c CBAC gate (action-type-level allow/deny +
   * required_markings) can evaluate the actor against the
   * action_type row's `allowed_principals` / `denied_principals` /
   * `required_markings` columns (migration 037).
   *
   * When `subjectKind` is undefined → the CBAC gate is **skipped**
   * (preserves backward compatibility with any caller that didn't
   * thread security context — typically test-only).
   */
  subjectKind?: "user" | "service" | "token" | "anonymous";
  /** Stable subject identifier — username / service-account / token-id / "anonymous". */
  subjectIdentifier?: string;
  /** Markings the subject is cleared for. Empty when none. */
  subjectMarkings?: string[];
  /** CBAC tags the subject is cleared for. Permissive-on-absent at the predicate layer. */
  subjectCbac?: string[];
  /** When true, the subject is a superadmin with `markingBypass` — the CBAC gate is an automatic ALLOW. */
  markBypass?: boolean;
  /**
   * v2 ApplyActionMode VALIDATE_ONLY (OSv2 parity): run stages
   * 1–3 (definition load, semantics, CBAC, parameter validation,
   * submission criteria) and STOP. No edits are compiled or
   * applied, no writeback webhooks fire, no side-effect jobs are
   * enqueued, no functions execute. The audit row is still
   * written by the outer finally block — Foundry audits
   * validations too.
   */
  validateOnly?: boolean;
  /** v2 apply returns validation failures in a 200 response body. */
  returnValidationErrors?: boolean;
  /** Public applyBatch does not support notification side effects. */
  suppressNotifications?: boolean;
  /**
   * Optional ceiling (ms) for the Step 6b link ack barrier. Batch routes
   * thread the REMAINING request-budget per item so a committed item
   * pre-defers (202) instead of the timeout middleware 504-ing the wire.
   * Absent ⇒ LINK_INDEX_ACK_TIMEOUT_MS applies (default behavior).
   */
  ackBudgetMs?: number;
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
  /**
   * OSv2 read-after-write acknowledgement (Step 6b, editApplicator).
   * Present ONLY when the execution staged link CDC events AND
   * LINK_INDEX_ACK_REQUIRED=true. `confirmed:false` means the PG edit is
   * durable but the serving edge index had NOT confirmed visibility by
   * the deadline — callers MUST NOT treat the Action as fully complete.
   */
  linkIndexAck?: import("./editApplicator").ApplyResult["linkIndexAck"];
  validation?: {
    result: "VALID" | "INVALID";
    submissionCriteria: Array<{
      result: "VALID" | "INVALID";
      configuredFailureMessage?: string;
    }>;
    parameters: Record<
      string,
      {
        result: "VALID" | "INVALID";
        evaluatedConstraints: unknown[];
        required: boolean;
      }
    >;
  };
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
  const correlationId = context.correlationId || executionId;

  // Phase 8 — observability: action_execution_total, partitioned by semantics version.
  try {
    incCounter("tellus_action_execution_total", { result: "started" });
  } catch { /* metrics non-blocking */ }

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
  // Phase 6/8 — semantics resolved in Stage 1b (inside the try). Hoisted to
  // the outer scope so the audit-entry builder + finally counters can read it.
  let semantics: { semanticsVersion: number; executionMode: string; deletePolicy: string } = {
    semanticsVersion: 1,
    executionMode: "declarative",
    deletePolicy: "legacy_unchecked",
  };

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
    // Phase 8 — thread semantics + correlation id into the audit row.
    semantics_version: semantics?.semanticsVersion ?? null,
    execution_mode: semantics?.executionMode ?? null,
    correlation_id: correlationId,
  } as AuditLogEntry & { semantics_version: number | null; execution_mode: string | null; correlation_id: string });

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

    // Foundry parity: `is_enabled` is cosmetic metadata and no longer gates
    // execution (Foundry action types have no enable/disable lifecycle —
    // saved = applyable). Apply-time safety lives in the writeback executor's
    // non-active-webhook refusal and the validators below, not here.

    // -----------------------------------------------------------------
    // STAGE 1b: Action Semantics Enforcement (Phase 6)
    //
    // Resolve the persisted semantics triple (NULL → v1 read fallback). v1
    // continues unchanged. v2 is enforced ONLY when the version-2 execution
    // feature flag is on; otherwise fail closed with
    // UNSUPPORTED_SEMANTICS_VERSION. Unknown stored versions (shouldn't
    // persist) also fail closed. Never silently downgrade v2 to v1.
    // -----------------------------------------------------------------
    const resolvedSemantics = resolveSemanticsForRow({
      semantics_version: (actionType as any).semantics_version ?? null,
      execution_mode: (actionType as any).execution_mode ?? null,
      delete_policy: (actionType as any).delete_policy ?? null,
    });
    semantics = resolvedSemantics;
    const semanticsAvailability =
      getActionSemanticsExecutionAvailability(semantics.semanticsVersion);
    if (!semanticsAvailability.available) {
      result.failureType = "unclassified";
      result.errorMessage =
        semanticsAvailability.message ??
        `Unsupported action semantics version '${semantics.semanticsVersion}'.`;
      pendingError = new OntologyError(
        result.errorMessage,
        semanticsAvailability.code ?? "UNSUPPORTED_SEMANTICS_VERSION",
        422,
        {
          executionId,
          ...semanticsAvailability.details,
        },
      );
      return result;
    }

    // -----------------------------------------------------------------
    // STAGE 1c (Phase 6.1): CBAC authorization gate (action-type-level
    // allowed_principals / denied_principals / required_markings).
    //
    // The CBAC layer was built in F-P3-18 (cbacPolicy.ts +
    // cbacPolicyLoader.ts + cbacDecisionLog.ts) but did NOT ship a
    // wiring on /actions/.../apply — the JSDoc example at
    // middleware/cbac.ts:10-19 prescribes the surface but no route
    // mounts it. Phase 6.1 wires the same evaluator INSIDE the
    // executor (rather than as a route middleware) so the gate is
    // authoritative across all action-exec entry points —
    // /actions/:api/apply, /applyBatch, the bulk-action runner, and
    // future programmatic dispatch paths.
    //
    // Default-allow for callers that don't thread a security context
    // (subjectKind=undefined) — preserves test + integration
    // backward-compat. Once a security context is threaded, the
    // policy MUST evaluate to ALLOW or the action aborts at Stage 1c
    // (no edits, no emulation, no audit row beyond the failure audit).
    //
    // Default-allow also for the action_type row with NULL policy
    // columns (the v1.0 baseline across all existing rows). The
    // loader returns a Policy with allowedPrincipals=null (no
    // allowlist gate), requiredMarkings=[] (no marking gate), and
    // deniedPrincipals=null (no denylist gate) — so for any
    // authenticated non-anonymous subject it ALLOWs. This is the
    // backward-compat guarantee: switching the flag on never breaks
    // existing action types.
    // -----------------------------------------------------------------
    if (context.subjectKind !== undefined) {
      const policyCtx = {
        resourceKind: "action_type",
        resourceId: actionTypeApiName,
        ontologyId,
        sourceIp: context.sourceIp ?? null,
        requestId: executionId,
      };
      const cbacResult: CbacGateResult = await runActionCbacGate(
        ontologyId,
        actionTypeApiName,
        {
          subjectKind: context.subjectKind,
          subjectIdentifier: context.subjectIdentifier,
          roles: context.roles,
          groups: context.groups,
          subjectMarkings: context.subjectMarkings,
          markBypass: context.markBypass,
        },
        policyCtx,
      );
      // Loader failure (e.g. transient PG drop). Fail-closed per F-P3-18 §4.
      // Phase 6.1 emits AUTHORIZATION_UNAVAILABLE (503) — same semantics
      // as the existing requireCbac middleware's catch branch.
      if (cbacResult.internalError) {
        result.failureType = "unclassified";
        result.errorMessage = "Authorization service temporarily unavailable.";
        pendingError = new OntologyError(
          "Authorization service temporarily unavailable.",
          "AUTHORIZATION_UNAVAILABLE",
          503,
          { executionId, actionTypeApiName, detail: cbacResult.internalError.detail },
        );
        return result;
      }
      if (cbacResult.decision === "deny") {
        const userMessage = cbacDenyMessage(cbacResult);
        result.failureType = "unclassified";
        result.errorMessage = userMessage;
        pendingError = new OntologyError(
          userMessage,
          "PERMISSION_DENIED",
          403,
          {
            executionId,
            actionTypeApiName,
            cbacReason: cbacResult.reason,
            subject: context.subjectIdentifier ?? "anonymous",
            matchedRule: cbacResult.matchedRule,
          },
        );
        return result;
      }
    }

    // -----------------------------------------------------------------
    // STAGE 2: Validate parameters
    // -----------------------------------------------------------------
    const parameterDefinitions =
      actionType.parameters as ParameterDefinition[];
    const parameterEvaluations = (
      resultValue: "VALID" | "INVALID",
    ): NonNullable<ExecutionResult["validation"]>["parameters"] =>
      Object.fromEntries(
        parameterDefinitions.map((definition) => [
          definition.apiName,
          {
            result: resultValue,
            evaluatedConstraints: [],
            required: definition.required === true,
          },
        ]),
      );
    const validation = await validateParameters(
      parameterDefinitions,
      parameters,
      objectExists,
      fetchObject
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
      result.validation = {
        result: "INVALID",
        submissionCriteria: [],
        parameters: parameterEvaluations("INVALID"),
      };
      return result;
    }

    const resolvedParameters = validation.resolvedParameters!;

    // A stale client read must surface as the typed OCC error even when the
    // winning write also changed a status used by submission criteria. This
    // read is diagnostic ordering only; editApplicator repeats the check under
    // FOR UPDATE in the mutation transaction and remains authoritative.
    if (context.expectedVersion !== undefined) {
      const modifyRule = (actionType.rules as Array<Record<string, any>>).find(
        (rule) => rule.type === "modifyObject" && rule.objectReference?.source === "parameter",
      );
      const criteria = actionType.submission_criteria as {
        conditions?: Array<Record<string, any>>;
      } | null;
      const objectCondition = criteria?.conditions?.find(
        (condition) => typeof condition.parameter === "string" && typeof condition.objectType === "string",
      );
      const targetObjectType = modifyRule?.objectType ?? objectCondition?.objectType;
      const parameterName = modifyRule?.objectReference?.param ?? objectCondition?.parameter;
      const primaryKey = typeof parameterName === "string"
        ? resolvedParameters[parameterName]
        : undefined;
      if (typeof targetObjectType === "string" && primaryKey != null) {
        const versionResult = await pgQuery(
          `SELECT version FROM object_instances
            WHERE object_type_api_name = $1 AND primary_key = $2`,
          [targetObjectType, String(primaryKey)],
        );
        if ((versionResult.rowCount ?? 0) > 0) {
          const actualVersion = Number(versionResult.rows[0].version);
          if (actualVersion !== context.expectedVersion) {
            result.failureType = "concurrency_conflict";
            result.errorMessage = "Object was modified by another user";
            pendingError = new OntologyError(
              result.errorMessage,
              "CONCURRENCY_CONFLICT",
              409,
              {
                executionId,
                expectedVersion: context.expectedVersion,
                actualVersion,
                objectType: targetObjectType,
                primaryKey: String(primaryKey),
              },
            );
            return result;
          }
        }
      }
    }

    // -----------------------------------------------------------------
    // STAGE 3: Submission criteria (FOUNDRY-GAPS §5)
    //
    // Conditions that must hold for the action to be submittable, evaluated
    // against the resolved parameters and the subject's roles/groups. Runs
    // after parameter validation, before any edits are produced. null/empty
    // criteria ⇒ allow-all (backward compatible). CBAC (principals + required
    // markings) is enforced separately; this gates on the inputs/preconditions.
    // -----------------------------------------------------------------
    {
      const functionFailures = await evaluateFunctionValidationCriteria(
        ontologyId,
        actionType.submission_criteria,
        resolvedParameters as Record<string, unknown>,
      );
      // D27 — pre-resolve object-property operands (conditions of the form
      // `{ parameter, objectProperty }`) against the live referenced-object
      // state before evaluating criteria, so the pure evaluator can compare
      // against the object's property without doing IO.
      const objectPropertyValues = await resolveObjectPropertyOperands(
        actionType.submission_criteria,
        resolvedParameters as Record<string, unknown>,
        actionType.parameters as ReadonlyArray<{ apiName: string; objectType?: string }>,
        fetchObject,
      );
      const submission = evaluateSubmissionCriteria(
        actionType.submission_criteria,
        resolvedParameters as Record<string, unknown>,
        {
          username: context.executedBy ?? undefined,
          roles: context.roles ?? [],
          groups: context.groups ?? [],
        },
        objectPropertyValues,
      );
      if (functionFailures.length > 0) {
        submission.ok = false;
        submission.failures.push(...functionFailures);
      }
      if (!submission.ok) {
        result.failureType = "unclassified";
        result.errorMessage = `Submission criteria not met: ${submission.failures.join("; ")}`;
        pendingError = new OntologyError(
          result.errorMessage,
          "SUBMISSION_CRITERIA_NOT_MET",
          undefined,
          { failures: submission.failures, executionId },
        );
        result.validation = {
          result: "INVALID",
          submissionCriteria: submission.failures.map((failure) => ({
            result: "INVALID",
            configuredFailureMessage: failure,
          })),
          parameters: parameterEvaluations("VALID"),
        };
        return result;
      }
    }
    result.validation = {
      result: "VALID",
      submissionCriteria: [],
      parameters: parameterEvaluations("VALID"),
    };

    // VALIDATE_ONLY short-circuit (v2 ApplyActionMode). Placed
    // AFTER submission criteria so all validation gates (1–3) have
    // run, and BEFORE the writeback pre-edit stage (3.5), rule
    // compilation (4) and edit application (6) — validation-only
    // mode must not perform edits, trigger side effects, or
    // enqueue write-back jobs.
    if (context.validateOnly) {
      result.success = true;
      result.result = "success";
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // Function-backed Action Types execute an immutable published Function
    // version. The Function runtime returns an Ontology edit batch; its
    // persistence layer commits that batch transactionally. Declarative rule
    // compilation is deliberately bypassed because function actions persist
    // `rules: []` and are mutually exclusive with declarative rules.
    if (semantics.executionMode === "function") {
      if (!actionType.function_config) {
        result.failureType = "unclassified";
        result.errorMessage = "Function-backed Action Type has no function binding.";
        pendingError = new OntologyError(
          result.errorMessage,
          "FUNCTION_CONFIG_INVALID",
          422,
          { executionId, actionTypeApiName },
        );
        return result;
      }
      const functionExecution = await executeFunctionAction({
        ontologyId,
        binding: actionType.function_config as FunctionActionBinding,
        parameters: resolvedParameters as Record<string, unknown>,
        parameterDefinitions:
          actionType.parameters as FunctionActionParameterDefinition[],
        executedBy: context.executedBy || "system",
        maxAffectedObjects: actionType.max_affected_objects,
        preCommitHook: async (client, affectedObjects) => {
          result.success = true;
          result.result = "success";
          result.affectedObjects = affectedObjects;
          result.durationMs = Date.now() - startTime;
          await appendAuditRow(client, buildAuditEntry());
          auditCommitted = true;
        },
      });
      result.success = true;
      result.result = "success";
      result.affectedObjects = functionExecution.affectedObjects;

      // STAGE 7 parity (function mode) — one `object_set.changed` event
      // per affected object type, identical in shape to the declarative
      // Stage 7 block below. The function branch returns before that
      // block, so emit here. This executor is the SINGLE ownership
      // point for change events across /apply, /applyBatch, and the
      // bulk runner (the /apply route's former route-level copy was
      // removed — exactly one event per affected type per execution).
      // Ordering guarantee: executeFunctionAction only resolves AFTER
      // its edit transaction has COMMITted (see
      // ontologyRuntime.applyEdits), so this event can never fire
      // before the writes are durable. On failure
      // executeFunctionAction throws and this block is unreachable —
      // subscribers never see a change event for a rolled-back
      // action. Webhook/notification side effects are deliberately
      // NOT fired here: their semantics for function-backed actions
      // are not established. Best-effort: a broken event bus must
      // never fail a committed action.
      if (functionExecution.affectedObjects.length > 0) {
        try {
          const byType = new Map<string, Array<string | number>>();
          for (const affected of functionExecution.affectedObjects) {
            const pks = byType.get(affected.objectType) ?? [];
            pks.push(affected.primaryKey);
            byType.set(affected.objectType, pks);
          }
          for (const [objectType, primaryKeys] of byType) {
            eventBus.emit('ws:event', {
              event: 'object_set.changed',
              projectId: null,
              objectTopic: `${ontologyId}:${objectType}`,
              payload: {
                ontologyId,
                tenantId: context.tenant ?? "default",
                objectType,
                // FE auto-refresh (useObjectAutoRefresh) filters on
                // this field name — keep it in sync with the
                // declarative Stage 7 payload.
                objectTypeApiName: objectType,
                // Contract preserved from the retired route-level
                // emitter: same operation label + per-type count.
                operation: "applyAction",
                affectedCount: primaryKeys.length,
                primaryKeys,
                actionTypeApiName,
                executionId,
                branchId: context.branchId ?? null,
                result: result.result,
                changedAt: new Date().toISOString(),
              },
            });
          }
        } catch (emitErr) {
          console.warn(
            `[action:${actionTypeApiName}] object_set.changed emission failed (non-fatal): ${(emitErr as Error).message}`,
          );
        }
      }

      return result;
    }

    // -----------------------------------------------------------------
    // STAGE 3.5 (Phase 6.3): Writeback pre-edit hook (Phase 4-origin,
    // re-ordered from Stage 5 to Stage 3.5 in Phase 6.3).
    //
    // Runs the writeback webhook BEFORE compileRules so the typed
    // outputs map produced by a successful writeback is available as
    // the `ExecutionContext.writebackOutputs` value source for rule
    // bodies that declare `ValueSource.source === "writebackResponse"`.
    //
    // Phase 4 wire-up kept intact: failures abort the entire action —
    // no edits are committed, the user sees a sanitized error, and
    // the structured BE log captures the full request/response
    // diagnostic. Phase 6 will ship the durable reconciliation state
    // for the unavoidable external-success/local-commit-failure
    // window (the gap when the external side acknowledges but the
    // local apply-edits COMMIT rolls back).
    // -----------------------------------------------------------------
    let writebackOutputs: Record<string, unknown> | undefined;
    if (actionType.writeback_config != null) {
      try {
        const wbRes = await runWritebackStage({
          actionType,
          resolvedParameters,
          executedBy: context.executedBy || "system",
          ontologyId,
          actionTypeApiName,
          executionId,
          correlationId,
          tenant: context.tenant,
        });
        if (wbRes.kind === "ok") {
          writebackOutputs = wbRes.outputs;
        }
      } catch (wbErr) {
        // runWritebackStage throws an OntologyError with the canonical
        // status mapping (404/409/504/502/422 by code). Surface it
        // verbatim + mark the result so the audit-finally block records
        // the structured failureType.
        result.result = "failed";
        result.failureType = "writeback_rejected";
        result.errorMessage = wbErr instanceof Error ? wbErr.message : String(wbErr);
        pendingError = wbErr instanceof OntologyError
          ? wbErr
          : new OntologyError(
              `Writeback execution error: ${result.errorMessage}`,
              "WRITEBACK_REJECTED",
              502,
              { executionId, actionTypeApiName },
            );
        return result;
      }
    }

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
    //
    // Phase 6.3 — also thread the writeback's typed outputs map when
    // present so rule bodies that declare `ValueSource.source === "writebackResponse"`
    // resolve against the live webhook response via `localJsonPointer` (ruleCompiler.ts).
    const compilation = await compileRules(
      actionType.rules as any[],
      resolvedParameters,
      fetchObject,
      {
        executedBy: context.executedBy || "system",
        ontologyId,
        branchId: context.branchId ?? undefined,
        ...(writebackOutputs ? { writebackOutputs } : {}),
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
    // STAGE 4a (Phase 6): Version-2 plan + final-state validation.
    //
    // For version 2 (and only when the v2 execution flag is on), build the
    // action plan directly from the rules + resolved parameters (not the
    // merged compiled edits) so the same-invocation restriction and the
    // final-state validator see faithful per-rule ordering. The pre-lock
    // plan fails fast on static v2 violations (string refs, create→modify/
    // delete of the same identity, dangling final state). The
    // authoritative revalidation runs inside the apply transaction after
    // advisory + row locks are acquired (v2RevalidateAfterLock below) so a
    // concurrent writer cannot slip a violation between plan and commit.
    //
    // v1 is completely unchanged: it skips this stage and proceeds straight
    // to the existing applyEdits path.
    // -----------------------------------------------------------------
    let v2PlannedLocks: LockIdentity[] | undefined;
    let v2Revalidate: ((client: import("pg").PoolClient) => Promise<ActionError[]>) | undefined;
    if (semantics.semanticsVersion === 2 && isV2ExecutionEnabled()) {
      const planCtx = {
        ontologyId,
        branchId: context.branchId ?? (await resolveBranchIdOrMain(ontologyId, context.branchId)),
        semanticsVersion: semantics.semanticsVersion as 1 | 2,
        schemaLookup: defaultSchemaLookup,
      };
      const rules = (actionType.rules ?? []) as Array<Record<string, unknown>> as any[];
      const params = (actionType.parameters ?? []) as any[];
      // Phase 1: build with an empty persisted snapshot to derive identities
      // and fail fast on static v2 violations (the post-lock revalidation is
      // authoritative for persisted-dependent invariants).
      const preBuild = await buildPlannedStepsFromRules(
        rules, params, resolvedParameters,
        { existingObjects: new Set<string>(), activeEdges: new Set<string>() },
        planCtx, context.executedBy || "system",
      );
      if (!preBuild.ok || !preBuild.steps) {
        result.failureType = "unclassified";
        result.errorMessage = preBuild.errors.map((e) => e.message).join("; ");
        pendingError = new OntologyError(
          result.errorMessage, preBuild.errors[0]?.code ?? "VALIDATION_ERROR", 400,
          { errors: preBuild.errors.map((e) => ({ code: e.code, path: e.path })), executionId },
        );
        return result;
      }
      // Phase 2: pre-lock authoritative plan — reload persisted state for the
      // plan's identities, rebuild, run the planner/final-state validator.
      const planIdentities: ObjectIdentity[] = [
        ...preBuild.steps.objectDeltas.map((d) => d.identity),
        ...preBuild.steps.relationshipDeltas.flatMap((r) => [r.source, r.target]),
      ];
      const persisted = await loadPersistedState(planIdentities);
      const planBuild = await buildPlannedStepsFromRules(
        rules, params, resolvedParameters, persisted, planCtx, context.executedBy || "system",
      );
      if (!planBuild.ok || !planBuild.steps) {
        result.failureType = "unclassified";
        result.errorMessage = planBuild.errors.map((e) => e.message).join("; ");
        pendingError = new OntologyError(
          result.errorMessage, planBuild.errors[0]?.code ?? "VALIDATION_ERROR", 400,
          { errors: planBuild.errors.map((e) => ({ code: e.code, path: e.path })), executionId },
        );
        return result;
      }
      const plan = buildActionPlan(semantics.semanticsVersion as 1 | 2, planBuild.steps, {
        executionId, correlationId,
      });
      if (!plan.plan || !plan.plan.valid) {
        const errs = plan.errors.length ? plan.errors : plan.plan?.errors ?? [];
        result.failureType = "unclassified";
        result.errorMessage = errs.map((e) => e.message).join("; ");
        pendingError = new OntologyError(
          result.errorMessage, errs[0]?.code ?? "FINAL_STATE_INVALID", 422,
          { errors: errs.map((e) => ({ code: e.code, path: e.path })), executionId },
        );
        return result;
      }
      v2PlannedLocks = plan.plan.requiredLocks.map((l) => ({
        ontologyId: l.ontologyId, branchId: l.branchId, objectType: l.objectType, primaryKey: l.primaryKey,
      }));
      // Authoritative transaction-time revalidation: after locks, reload
      // canonical state from the (now locked) tables and re-run the
      // planner + final-state validator. Non-empty errors → applyEdits
      // rolls back the whole transaction (no partial edits).
      v2Revalidate = async (client) => {
        const reloaded = await loadPersistedState(planIdentities, client);
        const reBuild = await buildPlannedStepsFromRules(
          rules, params, resolvedParameters, reloaded, planCtx, context.executedBy || "system",
        );
        if (!reBuild.ok || !reBuild.steps) return reBuild.errors;
        const rePlan = buildActionPlan(semantics.semanticsVersion as 1 | 2, reBuild.steps, {
          executionId, correlationId,
        });
        return (rePlan.errors.length ? rePlan.errors : rePlan.plan?.errors ?? []);
      };
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
    // -----------------------------------------------------------------
    // STAGE 5: Writeback webhook pre-edit stage (Phase 4 → Phase 6.3)
    //
    // Phase 6.3 lifts the writeback from AFTER compileRules (Phase 4) to
    // BEFORE compileRules (Stage 3.5 above) so the typed outputs map
    // returned by a successful writeback is available as the
    // `ExecutionContext.writebackOutputs` value source for rules whose
    // ValueSource.source === "writebackResponse". The block above (Stage
    // 3.5 → `runWritebackStage`) computes it; the now-empty Stage 5 site
    // is left as a single no-op marker so the audit-log stage numbers
    // remain stable for operators reading the code or stage-graph
    // dashboards. (Phase 6.6 ships the runtime-graph trace.)
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
      // Durable side-effect outbox is enabled by default. Setting
      // ACTION_SIDE_EFFECT_WORKER_ENABLED=0 is the explicit legacy fallback.
      // rows IN THIS SAME PG TRANSACTION so the side effects are
      // atomic with the audit row + the ontology edits. A subsequent
      // worker drains the outbox post-commit. The legacy fire-and-forget
      // path (Stage 7 below) is suppressed in this mode.
      const at = actionType;
      if (at && process.env.ACTION_SIDE_EFFECT_WORKER_ENABLED !== "0" && at.side_effects != null) {
        const execCtx: SideEffectExecutionContext = {
          executionId,
          actionTypeApiName,
          actionTypeId: at.action_type_id,
          actionTypeVersion: at.definition_version ?? 1,
          ontologyId,
          executedBy: context.executedBy || "system",
          tenant: context.tenant ?? "default",
          resolvedParameters: resolvedParameters as Record<string, unknown>,
          parameterDefinitions: Array.isArray(at.parameters)
            ? (at.parameters as Array<{
                apiName?: string;
                type?: string;
                objectType?: string;
              }>)
            : [],
          result: result.result,
          affectedObjects: result.affectedObjects,
          firedAt: new Date().toISOString(),
        };
        const sideEffects = context.suppressNotifications
          ? {
              ...(at.side_effects as Record<string, unknown>),
              notifications: [],
            }
          : at.side_effects;
        const jobs = extractSideEffectJobs(sideEffects, execCtx);
        if (jobs.length > 0) {
          await enqueueSideEffectJobsInTransaction(pg, {
            executionId,
            actionTypeId: at.action_type_id,
            actionTypeVersion: at.definition_version ?? 1,
            jobs: jobs.map((job, idx) => ({
              sideEffectIndex: idx,
              kind: job.kind,
              payload: job.payload,
              ...(job.idempotencySeed ? { idempotencyKey: `${executionId}:${job.idempotencySeed}` } : {}),
            })),
          });
        }
      }
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

    const applyContext = {
      executionId,
      actionTypeApiName,
      parameters: resolvedParameters,
      executedBy: context.executedBy || "system",
      expectedVersion: context.expectedVersion,
      expectedVersionTarget: occTarget,
      preCommitHook,
      ontologyId,
      branchId: resolvedBranchId,
      semanticsVersion: semantics.semanticsVersion,
      plannedLockIdentities: v2PlannedLocks,
      v2RevalidateAfterLock: v2Revalidate,
      // Per-item ack barrier ceiling (batch routes pre-defer rather than
      // let the request-budget middleware 504 a committed mutation).
      ...(context.ackBudgetMs !== undefined
        ? { ackBudgetMs: context.ackBudgetMs }
        : {}),
    };

    // Phase 6 — v2 only: wrap applyEdits in bounded deadlock/serialization
    // retry. v1 calls applyEdits directly (unchanged). Domain validation
    // errors from the v2 revalidation are NOT retried (actionRetry only
    // retries PG 40P01/40001/40P02).
    let application: import("./editApplicator").ApplyResult;
    if (semantics.semanticsVersion === 2 && isV2ExecutionEnabled()) {
      const retryOutcome = await withBoundedRetry<import("./editApplicator").ApplyResult>(
        () => applyEdits(compilation.edits, applyContext),
        {
          onRetry: (attempt, err) => {
            const code = (err as { code?: string }).code;
            try {
              incCounter(
                code === "40001"
                  ? "tellus_action_serialization_retry_total"
                  : "tellus_action_deadlock_retry_total",
                { attempt: String(attempt + 1), actionType: actionTypeApiName },
              );
            } catch { /* metrics non-blocking */ }
          },
        },
      );
      if (!retryOutcome.ok || !retryOutcome.result) {
        const e = retryOutcome.error!;
        incCounter(
          e.code === "CONCURRENCY_CONFLICT"
            ? "tellus_action_concurrency_conflict_total"
            : "tellus_action_deadlock_retry_total",
          { actionType: actionTypeApiName, exhausted: "true" },
        );
        result.failureType = "unclassified";
        result.errorMessage = e.message;
        pendingError = new OntologyError(e.message, e.code, 500, { attempts: e.attempts, executionId });
        return result;
      }
      application = retryOutcome.result;
    } else {
      application = await applyEdits(compilation.edits, applyContext);
    }

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

    // OSv2 ack transparency: surface the edge-index confirmation verdict so
    // the REST contract can distinguish "confirmed queryable" from
    // "deferred (durable in PG, index not yet caught up)".
    if (application.linkIndexAck) {
      result.linkIndexAck = application.linkIndexAck;
    }

    // -----------------------------------------------------------------
    // STAGE 7: real-time object notifications (FOUNDRY-GAPS §5 Object
    // Storage V2). One `object_set.changed` event per affected object
    // type, routed by objectTopic so only clients subscribed to that
    // ontology/object type receive it (see websocket/server.ts). This
    // executor is the SINGLE ownership point for the event across
    // /apply, /applyBatch, and the bulk runner (declarative here;
    // function-backed in the branch above) — exactly one event per
    // affected object type per execution. Best-effort: a broken event
    // bus must never fail a committed action.
    // -----------------------------------------------------------------
    if (application.success && application.appliedEdits.length > 0) {
      try {
        const byType = new Map<string, Array<string | number>>();
        for (const e of application.appliedEdits) {
          const pks = byType.get(e.objectType) ?? [];
          pks.push(e.primaryKey);
          byType.set(e.objectType, pks);
        }
        for (const [objectType, primaryKeys] of byType) {
          eventBus.emit('ws:event', {
            event: 'object_set.changed',
            projectId: null,
            objectTopic: `${ontologyId}:${objectType}`,
            payload: {
              ontologyId,
              tenantId: context.tenant ?? "default",
              objectType,
              // FE auto-refresh (useObjectAutoRefresh) filters on
              // this field name.
              objectTypeApiName: objectType,
              // Contract preserved from the retired route-level
              // emitter: same operation label + per-type count.
              operation: "applyAction",
              affectedCount: primaryKeys.length,
              primaryKeys,
              actionTypeApiName,
              executionId,
              branchId: resolvedBranchId,
              result: result.result,
              changedAt: new Date().toISOString(),
            },
          });
        }
      } catch (emitErr) {
        console.warn(
          `[action:${actionTypeApiName}] object_set.changed emission failed (non-fatal): ${(emitErr as Error).message}`,
        );
      }
    }

    // -----------------------------------------------------------------
    // STAGE 5/7 (FOUNDRY-GAPS §5): side-effect webhooks and notifications.
    // Fired POST-COMMIT (edits are durable) so a failure can never roll back a
    // committed action; delivery is best-effort with an SSRF egress guard.
    // null/empty side_effects ⇒ no-op. Awaited so the audit/return reflect
    // that delivery was attempted, but failures are swallowed inside.
    // -----------------------------------------------------------------
    if (application.success && actionType.side_effects != null && process.env.ACTION_SIDE_EFFECT_WORKER_ENABLED === "0") {
      try {
        // Fire webhooks
        await fireActionWebhooks(actionType.side_effects, {
          executionId,
          actionTypeApiName,
          ontologyId,
          branchId: resolvedBranchId,
          result: result.result,
          executedBy: context.executedBy || "system",
          affectedObjects: result.affectedObjects,
          firedAt: new Date().toISOString(),
        });
        
        // Send notifications (email, push, etc.)
        if (!context.suppressNotifications) {
          await sendNotifications(actionType.side_effects, {
            executionId,
            actionTypeApiName,
            ontologyId,
            result: result.result,
            executedBy: context.executedBy || "system",
            affectedObjects: result.affectedObjects,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (whErr) {
        console.warn(
          `[action:${actionTypeApiName}] side effect dispatch error (non-fatal): ${(whErr as Error).message}`,
        );
      }
    }

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

    // Phase 8 — observability: outcome counters + duration. Non-blocking.
    try {
      const ver = String(semantics?.semanticsVersion ?? 1);
      if (result.result === "success") {
        incCounter("tellus_action_execution_total", { semantics_version: ver, result: "success" });
      } else {
        incCounter("tellus_action_execution_total", { semantics_version: ver, result: "failed" });
        incCounter("tellus_action_execution_failure_total", {
          semantics_version: ver,
          failure_type: result.failureType ?? "unclassified",
        });
      }
      if (result.errorMessage && /DELETE_BLOCKED_BY_RELATIONSHIPS/i.test(result.errorMessage)) {
        incCounter("tellus_action_delete_blocked_total", { semantics_version: ver });
      }
    } catch { /* metrics non-blocking */ }

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
    const isReturnedValidationError =
      context.returnValidationErrors === true &&
      (pendingError?.code === "INVALID_PARAMETER" ||
        pendingError?.code === "SUBMISSION_CRITERIA_NOT_MET");
    if (pendingError && !isReturnedValidationError) {
      throw pendingError;
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { executeAction };
