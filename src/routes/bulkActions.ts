// ---------------------------------------------------------------------------
// Bulk Action Routes
//
// REST API endpoint for executing an action type in bulk with multiple
// parameter sets in a single API call. Each request in the bulk is
// independent and executed sequentially.
//
// Mounted at: /api/v1/actions
//
// Endpoint:
//   POST /:actionTypeApiName/applyBulk — Bulk-execute an action
//
// Limits:
//   - Maximum 1,000 requests per bulk call
//   - Total affected objects across the batch cannot exceed 10,000
//   - stopOnError flag to halt on first failure
//   - autoIndex flag to trigger a single reindex after all actions
//
// Partial success handling:
//   - HTTP 200 if any request succeeded
//   - HTTP 422 if ALL requests failed
//   - Per-item results with status/primaryKey/operation or error details
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { executeAction } from "../actions/actionExecutor";
import {
  collectPendingAcks,
  assertBatchAckOutcomeInvariant,
  COMMITTED_INDEX_PENDING,
  perItemAckBudgetMs,
  type BatchAckCandidate,
} from "../actions/linkIndexAckHttp";
import { getDefaultOntologyId } from "../actions/actionValidator";
import { OntologyError } from "../utils/queryErrors";
import { resolveRequestTenant } from "../utils/requestTenant";
import { sendError } from "../utils/responseFormatter";
import { indexObjectType } from "../services/indexing/indexingOrchestrator";

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BULK_SIZE = 1000;
const MAX_AFFECTED_OBJECTS = 10_000;

// ---------------------------------------------------------------------------
// POST /:actionTypeApiName/applyBulk — Bulk action execution
// ---------------------------------------------------------------------------

router.post(
  "/:actionTypeApiName/applyBulk",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { actionTypeApiName } = req.params;
      const bulkStartTime = Date.now();
      const bulkId = crypto.randomUUID();

      // -----------------------------------------------------------------
      // Resolve ontology — use default ontology for /api/v1/actions mount
      // -----------------------------------------------------------------
      let ontologyId = req.params.ontologyId;
      if (!ontologyId) {
        const defaultId = await getDefaultOntologyId();
        if (!defaultId) {
          return sendError(
            res,
            "INTERNAL_ERROR",
            "No ontology found in the system."
          );
        }
        ontologyId = defaultId;
      }

      if (!actionTypeApiName) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          "actionTypeApiName is required."
        );
      }

      // -----------------------------------------------------------------
      // Parse and validate request body
      // -----------------------------------------------------------------
      const body = req.body || {};
      const {
        requests,
        stopOnError = false,
        autoIndex = false,
      } = body;

      if (!requests || !Array.isArray(requests)) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          "requests must be a non-empty array."
        );
      }

      if (requests.length === 0) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          "requests must be a non-empty array."
        );
      }

      if (requests.length > MAX_BULK_SIZE) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          `Bulk size ${requests.length} exceeds the maximum of ${MAX_BULK_SIZE} requests.`
        );
      }

      // Validate each request has a parameters object
      for (let i = 0; i < requests.length; i++) {
        const item = requests[i];
        if (!item || typeof item !== "object") {
          return sendError(
            res,
            "INVALID_PARAMETER",
            `requests[${i}] must be an object.`
          );
        }
        if (
          item.parameters !== undefined &&
          typeof item.parameters !== "object"
        ) {
          return sendError(
            res,
            "INVALID_PARAMETER",
            `requests[${i}].parameters must be an object.`
          );
        }
      }

      // -----------------------------------------------------------------
      // Execute each request sequentially, collecting results
      // -----------------------------------------------------------------
      const results: Array<Record<string, unknown>> = [];
      let successCount = 0;
      let failedCount = 0;
      let totalAffectedObjects = 0;
      let stopped = false;

      // Track which object types were affected (for autoIndex)
      const affectedObjectTypes = new Set<string>();
      const envAckTimeoutMs = Number(
        process.env.LINK_INDEX_ACK_TIMEOUT_MS ?? 5_000,
      );

      for (let i = 0; i < requests.length; i++) {
        if (stopped) {
          // If stopOnError was triggered, mark remaining as skipped
          failedCount++;
          results.push({
            index: i,
            status: "skipped",
            primaryKey: null,
            operation: null,
            error: {
              code: "STOP_ON_ERROR",
              message:
                "Skipped: a prior request failed and stopOnError is enabled.",
            },
          });
          continue;
        }

        const item = requests[i];
        const parameters = item.parameters || {};

        // Pre-defer the ack when the wire budget is nearly spent
        // (same rule as applyBatch — if this router is ever mounted
        // WITHOUT the budget middleware's route regex covering it, the
        // stamped DATA-plane deadline is what holds, which is still the
        // correct ceiling): a committed item is answered 202-per-item
        // pending, never 504'd post-commit.
        const ackBudgetMs = perItemAckBudgetMs({
          localsDeadlineAt: (res.locals as Record<string, unknown>)
            .requestBudgetDeadlineAt,
          envAckTimeoutMs,
        });

        // Build execution context
        //
        // Phase 6.1 — thread `req.security` so the per-iteration
        // `executeAction` runs Stage 1c against the same CBAC policy
        // as the single-action route.
        const secBulk = (req as any).security as
          | {
              userId: string;
              markings: string[];
              cbac: string[];
              systemPrincipal: boolean;
              markingBypass: boolean;
            }
          | undefined;
        const context = {
          executedBy: (req as any).user?.id || "system",
          tenant: resolveRequestTenant(req),
          sourceIp:
            (req.headers["x-forwarded-for"] as string)
              ?.split(",")[0]
              ?.trim() ||
            req.socket.remoteAddress ||
            null,
          branchId: item.branchId || body.branchId || null,
          roles: (req as any).user?.roles || [],
          groups: (req as any).user?.groups || [],
          ...(ackBudgetMs !== undefined ? { ackBudgetMs } : {}),
          ...(secBulk
            ? {
                subjectKind: (secBulk.systemPrincipal
                  ? "service"
                  : "user") as "user" | "service" | "token" | "anonymous",
                subjectIdentifier:
                  secBulk.userId || (req as any).user?.id || "anonymous",
                subjectMarkings: secBulk.markings ?? [],
                subjectCbac: secBulk.cbac ?? [],
                markBypass: secBulk.markingBypass === true,
              }
            : {}),
        };

        try {
          const result = await executeAction(
            ontologyId,
            actionTypeApiName,
            parameters,
            context
          );

          totalAffectedObjects += result.affectedObjects.length;

          // Track affected object types for autoIndex
          for (const obj of result.affectedObjects) {
            affectedObjectTypes.add(obj.objectType);
          }

          // Check if total affected objects exceeds the limit
          if (totalAffectedObjects > MAX_AFFECTED_OBJECTS) {
            successCount++;
            results.push({
              index: i,
              status: "success",
              primaryKey:
                result.affectedObjects.length > 0
                  ? result.affectedObjects[0].primaryKey
                  : null,
              operation:
                result.affectedObjects.length > 0
                  ? result.affectedObjects[0].operation
                  : null,
              executionId: result.executionId,
              affectedObjects: result.affectedObjects,
              scaleLimitReached: true,
              // OSv2 read-after-write verdict (present only when
              // LINK_INDEX_ACK_REQUIRED=true and link edits were staged).
              ...(result.linkIndexAck
                ? { linkIndexAck: result.linkIndexAck }
                : {}),
              warning: `Total affected objects (${totalAffectedObjects}) exceeds the limit of ${MAX_AFFECTED_OBJECTS}. Remaining requests skipped.`,
            });

            // Skip remaining requests
            for (let j = i + 1; j < requests.length; j++) {
              failedCount++;
              results.push({
                index: j,
                status: "skipped",
                primaryKey: null,
                operation: null,
                error: {
                  code: "SCALE_LIMIT_EXCEEDED",
                  message:
                    "Skipped: total affected objects limit reached by a prior request.",
                },
              });
            }
            break;
          }

          successCount++;
          results.push({
            index: i,
            status: "success",
            primaryKey:
              result.affectedObjects.length > 0
                ? result.affectedObjects[0].primaryKey
                : null,
            operation:
              result.affectedObjects.length > 0
                ? result.affectedObjects[0].operation
                : null,
            executionId: result.executionId,
            affectedObjects: result.affectedObjects,
            // OSv2 read-after-write verdict (present only when
            // LINK_INDEX_ACK_REQUIRED=true and link edits were staged).
            ...(result.linkIndexAck
              ? { linkIndexAck: result.linkIndexAck }
              : {}),
          });
        } catch (err: any) {
          failedCount++;
          const errorCode =
            err instanceof OntologyError ? err.code : "INTERNAL_ERROR";
          const errorMessage = err.message || "Unknown error";

          results.push({
            index: i,
            status: "failed",
            primaryKey: null,
            operation: null,
            error: {
              code: errorCode,
              message: errorMessage,
            },
          });

          // If stopOnError is enabled, mark the run as stopped
          if (stopOnError) {
            stopped = true;
          }

          // Spec §Task 17: "If > 10% fail, abort remaining and return
          // partial result." Compute the failure ratio over attempted
          // requests and trip if we're past the 10% threshold.
          const attempted = i + 1;
          if (attempted >= 10 && failedCount / attempted > 0.1) {
            stopped = true;
            for (let j = i + 1; j < requests.length; j++) {
              failedCount++;
              results.push({
                index: j,
                status: "skipped",
                primaryKey: null,
                operation: null,
                error: {
                  code: "BULK_FAILURE_THRESHOLD_EXCEEDED",
                  message: `Skipped: > 10% of prior requests failed (${failedCount}/${attempted}).`,
                },
              });
            }
            break;
          }
        }
      }

      // -----------------------------------------------------------------
      // Auto-index: trigger a single reindex after all actions complete
      // -----------------------------------------------------------------
      let autoIndexResults: Array<Record<string, unknown>> | null = null;

      if (autoIndex && successCount > 0 && affectedObjectTypes.size > 0) {
        autoIndexResults = [];

        for (const objectTypeApiName of affectedObjectTypes) {
          try {
            const indexResult = await indexObjectType(objectTypeApiName);

            autoIndexResults.push({
              objectTypeApiName,
              status: indexResult.success ? "success" : "failed",
              objectsIndexed: indexResult.success
                ? indexResult.objectsIndexed
                : 0,
              error: indexResult.success
                ? null
                : (indexResult as any).error,
            });
          } catch (indexErr: any) {
            autoIndexResults.push({
              objectTypeApiName,
              status: "failed",
              objectsIndexed: 0,
              error: indexErr.message || "Reindex failed",
            });
          }
        }
      }

      // -----------------------------------------------------------------
      // Build response
      // -----------------------------------------------------------------
      const totalDurationMs = Date.now() - bulkStartTime;

      // OSv2 read-after-write aggregation (single rule for all batch
      // surfaces — actions/linkIndexAckHttp.ts): 202
      // result:COMMITTED_INDEX_PENDING iff at least one item committed
      // AND its edge-index ack is unconfirmed; each pending item carries
      // its own pollable statusUrl. A post-commit deferral is NEVER an
      // error status nor a per-item failure — so 202 outranks 200 but
      // never outranks the all-pre-commit-failed 422 (nothing committed).
      const pendingAcks = collectPendingAcks(
        results as Array<Record<string, unknown>> & BatchAckCandidate[],
      );
      if (pendingAcks.length > 0) {
        const urlByIndex = new Map(
          pendingAcks.map((p) => [p.index, p.statusUrl]),
        );
        for (const r of results) {
          const u = urlByIndex.get(r.index as number);
          if (u) r.statusUrl = u;
        }
      }
      const bulkOutcome = {
        status:
          successCount > 0 && pendingAcks.length > 0
            ? 202
            : successCount > 0
              ? 200
              : 422,
        pendingCount: pendingAcks.length,
        ...(successCount > 0 && pendingAcks.length > 0
          ? { result: COMMITTED_INDEX_PENDING }
          : {}),
      };
      assertBatchAckOutcomeInvariant(bulkOutcome);

      // HTTP status: 202 if any committed item is index-pending, else 200
      // if any succeeded, 422 if all failed
      const httpStatus = bulkOutcome.status;

      return res.status(httpStatus).json({
        bulkId,
        actionTypeApiName,
        totalRequests: requests.length,
        successCount,
        failedCount,
        totalAffectedObjects,
        results,
        autoIndexResults,
        totalDurationMs,
        ...(bulkOutcome.result ? { result: bulkOutcome.result } : {}),
      });
    } catch (err: any) {
      // Top-level errors (invalid body structure) → 400
      if (err instanceof OntologyError) return next(err);
      next(err);
    }
  }
);

export default router;
