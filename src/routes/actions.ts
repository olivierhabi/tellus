// ---------------------------------------------------------------------------
// Action Execution Routes
//
// REST API endpoint for executing actions against the Ontology. This is the
// primary interface for action execution — all action executions go through
// this route.
//
// Mounted at: /api/v1/ontology/:ontologyId/actions
//
// Endpoints:
//   POST /:actionTypeApiName/apply      — Execute an action
//   POST /:actionTypeApiName/applyBatch — Bulk-execute an action (Task 25)
//   POST /:actionTypeApiName/validate   — Dry-run validation (no edits applied)
//
// The /validate and /applyBatch endpoints are also mounted at /api/v1/actions
// (without ontologyId) via the validateRouter and batchRouter exports. In
// that case, the default ontology is used automatically.
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { Router, Request, Response, NextFunction } from "express";
import { executeAction } from "../actions/actionExecutor";
import {
  validateAction,
  getDefaultOntologyId,
} from "../actions/actionValidator";
// FailureType import removed — executor now throws OntologyError directly
import { OntologyError } from "../utils/queryErrors";
import {
  checkIdempotencyKey,
  storeIdempotencyKey,
  withIdempotencyLock,
} from "../actions/idempotency";
import { actionRateLimiter, batchRateLimiter } from "../middleware/rateLimiter";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// POST /:actionTypeApiName/apply — Execute an action
// ---------------------------------------------------------------------------

router.post(
  "/:actionTypeApiName/apply",
  actionRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, actionTypeApiName } = req.params;
      const { parameters = {} } = req.body || {};

      if (!ontologyId) {
        throw new OntologyError(
          "ontologyId is required",
          "INVALID_PARAMETER",
          undefined,
          { parameterName: "ontologyId" }
        );
      }

      if (!actionTypeApiName) {
        throw new OntologyError(
          "actionTypeApiName is required",
          "INVALID_PARAMETER",
          undefined,
          { parameterName: "actionTypeApiName" }
        );
      }

      // ---------------------------------------------------------------
      // Idempotency (Task 21, Phase A5 F-04)
      //
      // If the client supplied an `Idempotency-Key` header we must:
      //   1. Serialize concurrent requests for that key (advisory lock).
      //   2. Re-check the cache inside the lock — a concurrent first
      //      winner may have just cached a result.
      //   3. Execute the action.
      //   4. Cache the result (success or error) before releasing.
      //
      // Without step 1, two requests that arrive inside a ~1ms window
      // both miss the cache, both execute, both cache — F-04 exactly.
      // The advisory lock turns the window into a queue: the loser
      // wakes on step 2 and returns the cached result.
      // ---------------------------------------------------------------
      const idempotencyKey = req.headers["idempotency-key"] as
        | string
        | undefined;

      // Optimistic concurrency: validate $expectedVersion early (Task 22)
      let expectedVersion: number | undefined;
      if (req.body?.$expectedVersion !== undefined) {
        const ev = Number(req.body.$expectedVersion);
        if (!Number.isInteger(ev) || ev < 0) {
          throw new OntologyError(
            "$expectedVersion must be a non-negative integer",
            "INVALID_PARAMETER",
            undefined,
            { parameterName: "$expectedVersion" }
          );
        }
        expectedVersion = ev;
      }

      // Extract execution context from request
      const context = {
        executedBy: (req as any).user?.id || "system",
        sourceIp:
          (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
          req.socket.remoteAddress ||
          null,
        branchId: req.body?.branchId || null,
        expectedVersion,
        roles: (req as any).user?.roles || [],
        groups: (req as any).user?.groups || [],
      };

      // Core execute+store closure. Runs EITHER bare (no idempotency key)
      // OR under a session-level advisory lock (with a key). Both paths
      // share the same body so that on a cache-hit inside the lock we
      // still produce the cached response to the client.
      const doExecute = async () => {
        // Step 2: cache re-check inside the lock (or first check if no lock).
        if (idempotencyKey) {
          const cached = await checkIdempotencyKey(
            idempotencyKey,
            actionTypeApiName,
          );
          if (cached) {
            const { _httpStatus, _isError, ...body } = cached as {
              _httpStatus: number;
              _isError: boolean;
              [key: string]: unknown;
            };
            const status =
              typeof _httpStatus === "number" ? _httpStatus : 200;
            res.setHeader("X-Idempotency-Cached", "true");
            res.status(status).json(body);
            return;
          }
        }

        try {
          // Step 3: execute the action
          const result = await executeAction(
            ontologyId,
            actionTypeApiName,
            parameters,
            context,
          );

          const successBody = {
            executionId: result.executionId,
            result: result.result,
            affectedObjects: result.affectedObjects,
            durationMs: result.durationMs,
          };

          // Step 4a: cache success
          if (idempotencyKey) {
            await storeIdempotencyKey(
              idempotencyKey,
              actionTypeApiName,
              result.executionId,
              { _httpStatus: 200, _isError: false, ...successBody },
            );
          }

          res.status(200).json(successBody);
        } catch (err: unknown) {
          // Step 4b: cache error (same key → same error on retry)
          if (err instanceof OntologyError && idempotencyKey) {
            const errorBody = err.toResponse();
            const execId =
              (err.parameters?.executionId as string) ||
              crypto.randomUUID();
            await storeIdempotencyKey(
              idempotencyKey,
              actionTypeApiName,
              execId,
              {
                _httpStatus: err.statusCode,
                _isError: true,
                ...errorBody,
              },
            );
          }
          throw err;
        }
      };

      if (idempotencyKey) {
        await withIdempotencyLock(idempotencyKey, doExecute);
      } else {
        await doExecute();
      }
    } catch (err: any) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /:actionTypeApiName/applyBatch — Bulk action execution (Task 25)
//
// Executes the same action type multiple times with different parameter sets
// in a single API call. Each request in the batch is independent — if one
// fails, the others still succeed. This matches Palantir's inline edit
// behavior where each cell edit is independent and they are applied
// sequentially.
//
// Limits:
//   - Maximum 100 requests per batch
//   - Total affected objects across the batch cannot exceed 100,000
// ---------------------------------------------------------------------------

const MAX_BATCH_SIZE = 100;
const MAX_BATCH_AFFECTED_OBJECTS = 100_000;

router.post(
  "/:actionTypeApiName/applyBatch",
  batchRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, actionTypeApiName } = req.params;
      const batchStartTime = Date.now();
      const batchId = crypto.randomUUID();

      if (!ontologyId) {
        throw new OntologyError(
          "ontologyId is required",
          "INVALID_PARAMETER",
          undefined,
          { parameterName: "ontologyId" }
        );
      }

      if (!actionTypeApiName) {
        throw new OntologyError(
          "actionTypeApiName is required",
          "INVALID_PARAMETER",
          undefined,
          { parameterName: "actionTypeApiName" }
        );
      }

      // Validate request body
      const body = req.body || {};
      if (!body.requests || !Array.isArray(body.requests)) {
        throw new OntologyError(
          "requests must be a non-empty array",
          "INVALID_PARAMETER",
          400,
          { parameterName: "requests" }
        );
      }

      if (body.requests.length === 0) {
        throw new OntologyError(
          "requests must be a non-empty array",
          "INVALID_PARAMETER",
          400,
          { parameterName: "requests" }
        );
      }

      if (body.requests.length > MAX_BATCH_SIZE) {
        throw new OntologyError(
          `Batch size ${body.requests.length} exceeds the maximum of ${MAX_BATCH_SIZE} requests`,
          "SCALE_LIMIT_EXCEEDED",
          400,
          {
            batchSize: body.requests.length,
            maxBatchSize: MAX_BATCH_SIZE,
          }
        );
      }

      // Validate each request has a parameters object
      for (let i = 0; i < body.requests.length; i++) {
        const item = body.requests[i];
        if (!item || typeof item !== "object") {
          throw new OntologyError(
            `requests[${i}] must be an object`,
            "INVALID_PARAMETER",
            400,
            { parameterName: `requests[${i}]` }
          );
        }
        if (item.parameters !== undefined && typeof item.parameters !== "object") {
          throw new OntologyError(
            `requests[${i}].parameters must be an object`,
            "INVALID_PARAMETER",
            400,
            { parameterName: `requests[${i}].parameters` }
          );
        }
      }

      // Execute each request sequentially (matches Palantir's inline edit behavior)
      const results: Array<Record<string, unknown>> = [];
      let successCount = 0;
      let failedCount = 0;
      let totalAffectedObjects = 0;

      for (let i = 0; i < body.requests.length; i++) {
        const item = body.requests[i];
        const parameters = item.parameters || {};

        // Build execution context for this individual request
        const context = {
          executedBy: (req as any).user?.id || "system",
          sourceIp:
            (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
            req.socket.remoteAddress ||
            null,
          branchId: item.branchId || body.branchId || null,
        };

        try {
          const result = await executeAction(
            ontologyId,
            actionTypeApiName,
            parameters,
            context
          );

          totalAffectedObjects += result.affectedObjects.length;

          // Check if total affected objects exceeds the batch limit.
          // The action has already been executed and committed at this point,
          // so we must record it as a success. Only skip remaining requests.
          if (totalAffectedObjects > MAX_BATCH_AFFECTED_OBJECTS) {
            successCount++;
            results.push({
              index: i,
              success: true,
              executionId: result.executionId,
              affectedObjects: result.affectedObjects,
              scaleLimitReached: true,
              errorMessage:
                `Total affected objects across batch (${totalAffectedObjects}) exceeds ` +
                `the limit of ${MAX_BATCH_AFFECTED_OBJECTS}. Remaining requests skipped.`,
            });

            // Skip remaining requests — these were never executed
            for (let j = i + 1; j < body.requests.length; j++) {
              failedCount++;
              results.push({
                index: j,
                success: false,
                executionId: null,
                failureType: "scale_limit_skipped",
                errorMessage:
                  "Skipped: total affected objects limit reached by a prior request in the batch.",
              });
            }
            break;
          }

          successCount++;
          results.push({
            index: i,
            success: true,
            executionId: result.executionId,
            affectedObjects: result.affectedObjects,
          });
        } catch (err: any) {
          failedCount++;
          // Extract failure details from OntologyError or generic error
          const executionId =
            err instanceof OntologyError
              ? (err.parameters?.executionId as string) || null
              : null;
          const failureType =
            err instanceof OntologyError
              ? mapErrorCodeToFailureType(err.code)
              : "unclassified";
          const errorMessage = err.message || "Unknown error";

          results.push({
            index: i,
            success: false,
            executionId,
            failureType,
            errorMessage,
          });
        }
      }

      const totalDurationMs = Date.now() - batchStartTime;

      return res.status(200).json({
        batchId,
        totalRequests: body.requests.length,
        successCount,
        failedCount,
        results,
        totalDurationMs,
      });
    } catch (err: any) {
      // Batch-level errors (invalid body, over limit) → 400 via error handler
      if (err instanceof OntologyError) return next(err);
      next(err);
    }
  }
);

/**
 * Map an OntologyError code to a FailureType string for batch result items.
 */
function mapErrorCodeToFailureType(code: string): string {
  switch (code) {
    case "ACTION_TYPE_NOT_FOUND":
      return "unclassified";
    case "INVALID_PARAMETER":
      return "invalid_parameter";
    case "OBJECT_NOT_FOUND":
      return "object_not_found";
    case "DUPLICATE_PRIMARY_KEY":
      return "duplicate_primary_key";
    case "SCALE_LIMIT_EXCEEDED":
      return "scale_limit";
    case "CONCURRENCY_CONFLICT":
      return "unclassified";
    default:
      return "unclassified";
  }
}

// ---------------------------------------------------------------------------
// POST /:actionTypeApiName/validate — Dry-run validation (no edits applied)
//
// Runs Stages 1, 2, and 4 of the execution pipeline without applying edits.
// Used by UIs to preview what an action will do before committing. Returns
// a preview of affected objects on success, or validation errors on failure.
// ---------------------------------------------------------------------------

router.post(
  "/:actionTypeApiName/validate",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // ontologyId may come from the URL (/api/v1/ontology/:ontologyId/actions)
      // or be resolved from the default ontology (/api/v1/actions)
      let ontologyId = req.params.ontologyId;
      const { actionTypeApiName } = req.params;

      if (!ontologyId) {
        const defaultId = await getDefaultOntologyId();
        if (!defaultId) {
          throw new OntologyError(
            "No ontology found in the system",
            "INTERNAL_ERROR"
          );
        }
        ontologyId = defaultId;
      }

      if (!actionTypeApiName) {
        throw new OntologyError(
          "actionTypeApiName is required",
          "INVALID_PARAMETER",
          undefined,
          { parameterName: "actionTypeApiName" }
        );
      }

      const { parameters = {} } = req.body || {};
      const context = {
        executedBy: (req as any).user?.id || "system",
        roles: (req as any).user?.roles || [],
        groups: (req as any).user?.groups || [],
      };

      const result = await validateAction(
        ontologyId,
        actionTypeApiName,
        parameters,
        context
      );

      if (result.valid) {
        return res.status(200).json({
          valid: true,
          preview: result.preview,
        });
      }

      // Action type not found → throw OntologyError for standardized 404
      const isNotFound = result.errors.some(
        (e) => e === "Action type not found"
      );
      if (isNotFound) {
        throw new OntologyError(
          `Action type '${actionTypeApiName}' not found`,
          "ACTION_TYPE_NOT_FOUND",
          undefined,
          { actionTypeApiName }
        );
      }

      // All other validation failures → 400 with { valid, errors }
      return res.status(400).json({
        valid: false,
        errors: result.errors,
      });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Validate-only router (mounted at /api/v1/actions — no ontologyId)
// ---------------------------------------------------------------------------

const validateRouter = Router({ mergeParams: true });

validateRouter.post(
  "/:actionTypeApiName/validate",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { actionTypeApiName } = req.params;

      const defaultId = await getDefaultOntologyId();
      if (!defaultId) {
        throw new OntologyError(
          "No ontology found in the system",
          "INTERNAL_ERROR"
        );
      }

      if (!actionTypeApiName) {
        throw new OntologyError(
          "actionTypeApiName is required",
          "INVALID_PARAMETER",
          undefined,
          { parameterName: "actionTypeApiName" }
        );
      }

      const { parameters = {} } = req.body || {};
      const context = {
        executedBy: (req as any).user?.id || "system",
        roles: (req as any).user?.roles || [],
        groups: (req as any).user?.groups || [],
      };

      const result = await validateAction(
        defaultId,
        actionTypeApiName,
        parameters,
        context
      );

      if (result.valid) {
        return res.status(200).json({
          valid: true,
          preview: result.preview,
        });
      }

      // Action type not found → throw OntologyError for standardized 404
      const isNotFound = result.errors.some(
        (e) => e === "Action type not found"
      );
      if (isNotFound) {
        throw new OntologyError(
          `Action type '${actionTypeApiName}' not found`,
          "ACTION_TYPE_NOT_FOUND",
          undefined,
          { actionTypeApiName }
        );
      }

      // All other validation failures → 400 with { valid, errors }
      return res.status(400).json({
        valid: false,
        errors: result.errors,
      });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Batch-only router (mounted at /api/v1/actions — no ontologyId)
//
// This allows clients to call POST /api/v1/actions/:actionTypeApiName/applyBatch
// without specifying the ontologyId in the URL. The default ontology is used.
// ---------------------------------------------------------------------------

const batchRouter = Router({ mergeParams: true });

batchRouter.post(
  "/:actionTypeApiName/applyBatch",
  batchRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { actionTypeApiName } = req.params;
      const batchStartTime = Date.now();
      const batchId = crypto.randomUUID();

      const defaultId = await getDefaultOntologyId();
      if (!defaultId) {
        throw new OntologyError(
          "No ontology found in the system",
          "INTERNAL_ERROR"
        );
      }

      if (!actionTypeApiName) {
        throw new OntologyError(
          "actionTypeApiName is required",
          "INVALID_PARAMETER",
          undefined,
          { parameterName: "actionTypeApiName" }
        );
      }

      // Validate request body
      const body = req.body || {};
      if (!body.requests || !Array.isArray(body.requests)) {
        throw new OntologyError(
          "requests must be a non-empty array",
          "INVALID_PARAMETER",
          400,
          { parameterName: "requests" }
        );
      }

      if (body.requests.length === 0) {
        throw new OntologyError(
          "requests must be a non-empty array",
          "INVALID_PARAMETER",
          400,
          { parameterName: "requests" }
        );
      }

      if (body.requests.length > MAX_BATCH_SIZE) {
        throw new OntologyError(
          `Batch size ${body.requests.length} exceeds the maximum of ${MAX_BATCH_SIZE} requests`,
          "SCALE_LIMIT_EXCEEDED",
          400,
          {
            batchSize: body.requests.length,
            maxBatchSize: MAX_BATCH_SIZE,
          }
        );
      }

      // Validate each request has a parameters object
      for (let i = 0; i < body.requests.length; i++) {
        const item = body.requests[i];
        if (!item || typeof item !== "object") {
          throw new OntologyError(
            `requests[${i}] must be an object`,
            "INVALID_PARAMETER",
            400,
            { parameterName: `requests[${i}]` }
          );
        }
        if (item.parameters !== undefined && typeof item.parameters !== "object") {
          throw new OntologyError(
            `requests[${i}].parameters must be an object`,
            "INVALID_PARAMETER",
            400,
            { parameterName: `requests[${i}].parameters` }
          );
        }
      }

      // Execute each request sequentially
      const results: Array<Record<string, unknown>> = [];
      let successCount = 0;
      let failedCount = 0;
      let totalAffectedObjects = 0;

      for (let i = 0; i < body.requests.length; i++) {
        const item = body.requests[i];
        const parameters = item.parameters || {};

        const context = {
          executedBy: (req as any).user?.id || "system",
          sourceIp:
            (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
            req.socket.remoteAddress ||
            null,
          branchId: item.branchId || body.branchId || null,
        };

        try {
          const result = await executeAction(
            defaultId,
            actionTypeApiName,
            parameters,
            context
          );

          totalAffectedObjects += result.affectedObjects.length;

          // Check if total affected objects exceeds the batch limit.
          // The action has already been executed and committed at this point,
          // so we must record it as a success. Only skip remaining requests.
          if (totalAffectedObjects > MAX_BATCH_AFFECTED_OBJECTS) {
            successCount++;
            results.push({
              index: i,
              success: true,
              executionId: result.executionId,
              affectedObjects: result.affectedObjects,
              scaleLimitReached: true,
              errorMessage:
                `Total affected objects across batch (${totalAffectedObjects}) exceeds ` +
                `the limit of ${MAX_BATCH_AFFECTED_OBJECTS}. Remaining requests skipped.`,
            });

            // Skip remaining requests — these were never executed
            for (let j = i + 1; j < body.requests.length; j++) {
              failedCount++;
              results.push({
                index: j,
                success: false,
                executionId: null,
                failureType: "scale_limit_skipped",
                errorMessage:
                  "Skipped: total affected objects limit reached by a prior request in the batch.",
              });
            }
            break;
          }

          successCount++;
          results.push({
            index: i,
            success: true,
            executionId: result.executionId,
            affectedObjects: result.affectedObjects,
          });
        } catch (err: any) {
          failedCount++;
          const executionId =
            err instanceof OntologyError
              ? (err.parameters?.executionId as string) || null
              : null;
          const failureType =
            err instanceof OntologyError
              ? mapErrorCodeToFailureType(err.code)
              : "unclassified";
          const errorMessage = err.message || "Unknown error";

          results.push({
            index: i,
            success: false,
            executionId,
            failureType,
            errorMessage,
          });
        }
      }

      const totalDurationMs = Date.now() - batchStartTime;

      return res.status(200).json({
        batchId,
        totalRequests: body.requests.length,
        successCount,
        failedCount,
        results,
        totalDurationMs,
      });
    } catch (err: any) {
      if (err instanceof OntologyError) return next(err);
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { validateRouter, batchRouter };
export default router;
