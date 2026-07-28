// ---------------------------------------------------------------------------
// OSv2 actions routes (Phase 10)
//
//   POST /api/v2/ontologies/:ontology/actions/:actionType/apply
//   POST /api/v2/ontologies/:ontology/actions/:actionType/applyBatch
//
// Reuses the existing action executor + edit applicator. Adds:
//   * options.mode: VALIDATE_ONLY | VALIDATE_AND_EXECUTE
//     (executor short-circuit after Stage 3 — no edits, no
//     writeback, no side effects)
//   * options.returnEdits: ALL | NONE — edits come from the
//     executor's ACTUAL affected-objects change set, never
//     reconstructed from the index.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from "express";
import { z } from "zod";
import { executeAction } from "../../actions/actionExecutor";
import type { ExecutionContext } from "../../actions/actionExecutor";
import { resolveRequestTenant } from "../../utils/requestTenant";
import { toV2Error } from "../../services/oss/v2Errors";
import { requireOntology } from "./ontologyParam";
import { requireSecurityContext } from "../../middleware/securityContext";
import { recordOssV2AuditBestEffort } from "../../services/oss/audit";

const router = Router({ mergeParams: true });

const MAX_BATCH_REQUESTS = 20;

const ApplyOptions = z
  .object({
    mode: z.enum(["VALIDATE_ONLY", "VALIDATE_AND_EXECUTE"]).optional(),
    returnEdits: z
      .enum(["ALL", "ALL_V2_WITH_DELETIONS", "NONE"])
      .optional(),
  })
  .strict()
  .optional();

const ApplyRequest = z.object({
  options: ApplyOptions,
  parameters: z.record(z.string(), z.unknown()).default({}),
}).strict();

const ApplyBatchRequest = z.object({
  options: z
    .object({ returnEdits: z.enum(["ALL", "NONE"]).optional() })
    .strict()
    .optional(),
  requests: z
    .array(
      z
        .object({
          parameters: z.record(z.string(), z.unknown()).default({}),
        })
        .strict(),
    )
    .min(1)
    .max(MAX_BATCH_REQUESTS),
}).strict();

const ApplyQuery = z
  .object({
    sdkPackageRid: z.string().min(1).optional(),
    sdkVersion: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    transactionId: z.string().min(1).optional(),
    scenarioRid: z.string().min(1).optional(),
  })
  .strict();

function parseQuery(req: Request) {
  const parsed = ApplyQuery.safeParse(req.query);
  if (!parsed.success) {
    throw Object.assign(new Error("Invalid apply-action query parameters"), {
      errorName: "InvalidApplyActionRequest",
      parameters: { issues: parsed.error.issues },
    });
  }
  if (parsed.data.transactionId || parsed.data.scenarioRid) {
    const feature = parsed.data.transactionId ? "transactionId" : "scenarioRid";
    throw Object.assign(
      new Error(`${feature} action execution is not available in Tellus.`),
      {
        errorName: "UnsupportedObjectSetFeature",
        parameters: { feature },
      },
    );
  }
  return parsed.data;
}

function auditAction(
  req: Request,
  ontologyId: string,
  actionType: string,
  mode: string,
  outcome: "success" | "denied" | "error",
  batchSize = 1,
): void {
  const security = requireSecurityContext(req);
  recordOssV2AuditBestEffort({
    eventType: "action_apply",
    tenantId: resolveRequestTenant(req),
    ontologyId,
    userId: security.userId,
    branchId:
      (req.query.branch as string | undefined) ??
      ((req.headers["x-branch-id"] as string | undefined) ?? null),
    requestId:
      (req as Request & { requestId?: string }).requestId ?? null,
    outcome,
    parameters: { actionType, mode, batchSize },
  });
}

function buildContext(
  req: Request,
  options: {
    validateOnly: boolean;
    branch: string | null;
    returnValidationErrors?: boolean;
    suppressNotifications?: boolean;
  },
): ExecutionContext {
  const sec = (req as unknown as { security?: {
    userId: string;
    markings: string[];
    cbac: string[];
    systemPrincipal: boolean;
    markingBypass: boolean;
  } }).security;
  return {
    executedBy:
      (req as unknown as { user?: { id?: string } }).user?.id || "system",
    tenant: resolveRequestTenant(req),
    branchId: options.branch,
    validateOnly: options.validateOnly,
    returnValidationErrors: options.returnValidationErrors,
    suppressNotifications: options.suppressNotifications,
    ...(sec
      ? {
          subjectKind: sec.systemPrincipal
            ? ("service" as const)
            : ("user" as const),
          subjectIdentifier: sec.userId,
          subjectMarkings: sec.markings,
          subjectCbac: sec.cbac,
          markBypass: sec.markingBypass,
        }
      : {}),
  };
}

interface AffectedObject {
  objectType: string;
  primaryKey: string;
  operation: "create" | "update" | "delete";
}

function editsResponse(
  affected: AffectedObject[],
  options: { includeDeletions: boolean },
) {
  const returned = options.includeDeletions
    ? affected
    : affected.filter((item) => item.operation !== "delete");
  return {
    type: "edits",
    edits: returned.map((a) => ({
      type:
        a.operation === "create"
          ? "addObject"
          : a.operation === "update"
            ? "modifyObject"
            : "deleteObject",
      objectType: a.objectType,
      primaryKey: a.primaryKey,
    })),
    addedObjectCount: affected.filter((a) => a.operation === "create").length,
    modifiedObjectsCount: affected.filter((a) => a.operation === "update").length,
    deletedObjectsCount: affected.filter((a) => a.operation === "delete").length,
    addedLinksCount: 0,
    deletedLinksCount: 0,
  };
}

router.post(
  "/actions/:actionType/apply",
  async (req: Request, res: Response) => {
    try {
      const ontologyId = await requireOntology(
        req.params.ontology,
        resolveRequestTenant(req),
      );
      const query = parseQuery(req);
      const parsed = ApplyRequest.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(new Error("Invalid apply request"), {
          errorName: "InvalidApplyActionRequest",
          parameters: { issues: parsed.error.issues },
        });
      }
      const mode = parsed.data.options?.mode ?? "VALIDATE_AND_EXECUTE";
      const returnEdits =
        parsed.data.options?.returnEdits === "ALL" ||
        parsed.data.options?.returnEdits === "ALL_V2_WITH_DELETIONS";
      const result = await executeAction(
        ontologyId,
        req.params.actionType,
        parsed.data.parameters,
        buildContext(req, {
          validateOnly: mode === "VALIDATE_ONLY",
          branch:
            query.branch ??
            ((req.headers["x-branch-id"] as string | undefined) ?? null),
          returnValidationErrors: true,
        }),
      );
      if (result.validation?.result === "INVALID") {
        auditAction(req, ontologyId, req.params.actionType, mode, "success");
        res.json({
          operationId: result.executionId,
          validation: result.validation,
        });
        return;
      }
      if (!result.success) {
        throw Object.assign(
          new Error(result.errorMessage ?? "Action failed"),
          {
            errorName: "ActionFailed",
            parameters: {
              actionType: req.params.actionType,
              failureType: result.failureType,
            },
          },
        );
      }
      if (mode === "VALIDATE_ONLY") {
        auditAction(req, ontologyId, req.params.actionType, mode, "success");
        res.json({
          operationId: result.executionId,
          validation: result.validation,
        });
        return;
      }
      res.json(
        returnEdits
          ? {
              operationId: result.executionId,
              validation: result.validation,
              edits: editsResponse(result.affectedObjects, {
                includeDeletions:
                  parsed.data.options?.returnEdits ===
                  "ALL_V2_WITH_DELETIONS",
              }),
            }
          : {
              operationId: result.executionId,
              validation: result.validation,
            },
      );
      auditAction(req, ontologyId, req.params.actionType, mode, "success");
    } catch (err) {
      const { status, body } = toV2Error(err);
      res.status(status).json(body);
    }
  },
);

router.post(
  "/actions/:actionType/applyBatch",
  async (req: Request, res: Response) => {
    try {
      const ontologyId = await requireOntology(
        req.params.ontology,
        resolveRequestTenant(req),
      );
      const query = parseQuery(req);
      const parsed = ApplyBatchRequest.safeParse(req.body);
      if (!parsed.success) {
        throw Object.assign(new Error("Invalid batch apply request"), {
          errorName: "InvalidApplyActionRequest",
          parameters: { issues: parsed.error.issues },
        });
      }
      const returnEdits = parsed.data.options?.returnEdits === "ALL";
      const allAffected: AffectedObject[] = [];
      // Sequential, ordered, per-item error capture (tenant +
      // authz context preserved per execution).
      for (let i = 0; i < parsed.data.requests.length; i++) {
        const item = parsed.data.requests[i]!;
        const result = await executeAction(
          ontologyId,
          req.params.actionType,
          item.parameters,
          buildContext(req, {
            validateOnly: false,
            branch:
              query.branch ??
              ((req.headers["x-branch-id"] as string | undefined) ?? null),
            suppressNotifications: true,
          }),
        );
        if (!result.success) {
          throw Object.assign(
            new Error(
              `Batch item ${i} failed: ${result.errorMessage ?? "unknown"}`,
            ),
            {
              errorName: "ActionFailed",
              parameters: {
                actionType: req.params.actionType,
                batchIndex: i,
                failureType: result.failureType,
              },
            },
          );
        }
        allAffected.push(...result.affectedObjects);
      }
      res.json(
        returnEdits
          ? {
              edits: editsResponse(allAffected, {
                // BatchActionObjectEdit in SDK 2.70 has no
                // deleteObject variant; deletions are reported by count.
                includeDeletions: false,
              }),
            }
          : {},
      );
      auditAction(
        req,
        ontologyId,
        req.params.actionType,
        "VALIDATE_AND_EXECUTE",
        "success",
        parsed.data.requests.length,
      );
    } catch (err) {
      const { status, body } = toV2Error(err);
      res.status(status).json(body);
    }
  },
);

export default router;
