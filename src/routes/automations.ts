import crypto from "crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "../db";
import { requireOntologyWrite } from "../middleware/requireRole";
import { resolveRequestTenant } from "../utils/requestTenant";
import {
  AutomationServiceError,
  activateAutomation,
  createDraft,
  cancelTriggerEvent,
  getAutomation,
  getExecutionDetails,
  listAutomations,
  listAutomationAudit,
  listConditionEvaluations,
  listExecutionHistory,
  retryTriggerEvent,
  transitionAutomation,
  updateDraft,
} from "../services/automate/repository";
import {
  validateAutomationDraft,
  validateAutomationForActivation,
} from "../services/automate/validation";
import { CONDITION_COMPATIBILITY } from "../services/automate/compatibility";
import {
  DatabaseUuidSchema,
  EffectDraftSchema,
  ThresholdConditionSchema,
} from "../services/automate/contracts";
import {
  renderNotificationEffectContent,
} from "../services/automate/effectExecutors";
import { getKeycloakAdminService } from "../services/keycloakAdminService";
import {
  evaluateThresholdExpression,
} from "../services/automate/conditionRuntime";

const router = Router();

const UuidSchema = z.string().uuid();
const CreateDraftSchema = z.object({
  ontologyId: DatabaseUuidSchema,
  definition: z.unknown().optional(),
});
const UpdateDraftSchema = z.object({
  revision: z.number().int().positive(),
  definition: z.unknown(),
});
const ActivateSchema = z.object({
  revision: z.number().int().positive(),
});
const TransitionSchema = z.object({
  reason: z.string().trim().min(1).max(2_000).optional(),
});
const PreviewThresholdSchema = z.object({
  ontologyId: DatabaseUuidSchema,
  condition: ThresholdConditionSchema,
});

function actor(req: Request): { id: string; displayName?: string } {
  const user = (req as unknown as {
    user?: { id?: string; name?: string; displayName?: string };
    tellusPrincipal?: { userId?: string };
    auth?: { sub?: string };
  });
  const id = user.user?.id ?? user.tellusPrincipal?.userId ?? user.auth?.sub;
  if (!id) {
    throw new AutomationServiceError(
      "UNAUTHORIZED",
      "Authentication is required.",
      401,
    );
  }
  return {
    id,
    displayName: user.user?.displayName ?? user.user?.name,
  };
}

function parseId(req: Request): string {
  const parsed = UuidSchema.safeParse(req.params.automationId);
  if (!parsed.success) {
    throw new AutomationServiceError(
      "AUTOMATION_ID_INVALID",
      "automationId must be a UUID.",
    );
  }
  return parsed.data;
}

function requestId(req: Request): string {
  const value = req.headers["x-request-id"];
  return typeof value === "string" && value.length > 0
    ? value
    : crypto.randomUUID();
}

function sendAutomationError(
  req: Request,
  res: Response,
  error: unknown,
): void {
  const serviceError =
    error instanceof AutomationServiceError
      ? error
      : error instanceof z.ZodError
        ? new AutomationServiceError(
            "AUTOMATION_DEFINITION_INVALID",
            "The automation request is invalid.",
            422,
            { issues: error.issues },
          )
        : new AutomationServiceError(
            "AUTOMATION_INTERNAL_ERROR",
            "The automation request could not be completed.",
            500,
          );
  res.status(serviceError.status).json({
    errorCode: serviceError.code,
    errorName: "AutomationError",
    message: serviceError.message,
    statusCode: serviceError.status,
    requestId: requestId(req),
    parameters: serviceError.details,
    error: {
      code: serviceError.code,
      message: serviceError.message,
      details: serviceError.details,
      timestamp: new Date().toISOString(),
    },
  });
}

function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, _next) => {
    void fn(req, res).catch((error) => sendAutomationError(req, res, error));
  };
}

router.get(
  "/compatibility",
  handler(async (_req, res) => {
    res.status(200).json({ data: CONDITION_COMPATIBILITY });
  }),
);

router.get(
  "/discovery/users",
  handler(async (req, res) => {
    actor(req);
    const search =
      typeof req.query.q === "string" ? req.query.q.trim().slice(0, 256) : "";
    const limit = Math.min(Math.max(Number(req.query.limit ?? 25), 1), 100);
    const users = await getKeycloakAdminService().listUsers({
      search: search || undefined,
      first: 0,
      max: limit,
    });
    res.status(200).json({
      data: users
        .filter((user) => user.enabled)
        .map((user) => ({
          kind: "user" as const,
          id: user.id,
          displayName:
            [user.firstName, user.lastName].filter(Boolean).join(" ") ||
            user.email ||
            user.username,
          email: user.email,
        })),
    });
  }),
);

router.get(
  "/discovery/groups",
  handler(async (req, res) => {
    actor(req);
    const search =
      typeof req.query.q === "string" ? req.query.q.trim().slice(0, 256) : "";
    const limit = Math.min(Math.max(Number(req.query.limit ?? 25), 1), 100);
    const groups = await getKeycloakAdminService().listGroups({
      search: search || undefined,
      first: 0,
      max: limit,
    });
    res.status(200).json({
      data: groups.map((group) => ({
        kind: "group" as const,
        id: group.id,
        displayName: group.name,
        path: group.path,
      })),
    });
  }),
);

router.post(
  "/preview/notification",
  handler(async (req, res) => {
    const principal = actor(req);
    const ontologyId = DatabaseUuidSchema.parse(req.body?.ontologyId);
    const effect = EffectDraftSchema.parse(req.body?.effect);
    if (effect.type !== "notification") {
      throw new AutomationServiceError(
        "NOTIFICATION_EFFECT_REQUIRED",
        "A Notification effect is required for preview.",
        422,
      );
    }
    res.status(200).json({
      data: {
        ...(await renderNotificationEffectContent({
          ontologyId,
          ownerUserId: principal.id,
          effect,
          resolveBinding: (binding) => {
            if (binding.kind === "constant") return binding.value;
            if (binding.kind === "system-value") {
              return {
                triggeredAt: new Date().toISOString(),
                automationId: "notification-preview",
                automationVersion: 0,
                triggerEventId: "notification-preview",
                ownerId: principal.id,
              }[binding.value];
            }
            return undefined;
          },
        })),
        channels: effect.channels,
        recipientCount:
          effect.recipients.static.length + effect.recipients.dynamic.length,
      },
    });
  }),
);

router.post(
  "/preview/threshold",
  handler(async (req, res) => {
    const principal = actor(req);
    const body = PreviewThresholdSchema.parse(req.body);
    try {
      const evaluated = await evaluateThresholdExpression({
        expression: body.condition.expression,
        tenantId: resolveRequestTenant(req),
        ontologyId: body.ontologyId,
        ownerUserId: principal.id,
        ownerSecuritySnapshot: {
          roles:
            (req as unknown as { user?: { roles?: string[] } }).user?.roles ??
            [],
          groups:
            (req as unknown as { user?: { groups?: string[] } }).user?.groups ??
            [],
          markings: req.security?.markings ?? [],
          cbac: req.security?.cbac ?? [],
          organizations: req.security?.organizations ?? [],
          markingMode: req.security?.markingMode ?? "disjunctive",
          markingBypass: req.security?.markingBypass === true,
        },
        requestId: requestId(req),
      });
      res.status(200).json({ data: evaluated });
    } catch (error) {
      const candidate = error as {
        code?: string;
        status?: number;
        message?: string;
      };
      throw new AutomationServiceError(
        candidate.code ?? "THRESHOLD_PREVIEW_FAILED",
        candidate.message ?? "The threshold preview failed.",
        candidate.status ?? 422,
      );
    }
  }),
);

router.post(
  "/drafts",
  requireOntologyWrite,
  handler(async (req, res) => {
    const body = CreateDraftSchema.parse(req.body);
    const principal = actor(req);
    const record = await createDraft({
      tenantId: resolveRequestTenant(req),
      ontologyId: body.ontologyId,
      actorUserId: principal.id,
      actorDisplayName: principal.displayName,
      securitySnapshot: {
        roles: (req as unknown as { user?: { roles?: string[] } }).user?.roles ?? [],
        groups: (req as unknown as { user?: { groups?: string[] } }).user?.groups ?? [],
        markings: req.security?.markings ?? [],
        cbac: req.security?.cbac ?? [],
        organizations: req.security?.organizations ?? [],
        markingMode: req.security?.markingMode ?? "disjunctive",
        markingBypass: req.security?.markingBypass === true,
      },
      definition: body.definition,
    });
    res
      .status(201)
      .setHeader("Location", `/api/v1/automations/${record.automationId}`)
      .setHeader("ETag", `"${record.draftRevision}"`)
      .json({ data: record });
  }),
);

router.get(
  "/",
  handler(async (req, res) => {
    const principal = actor(req);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    const ontologyId =
      typeof req.query.ontologyId === "string"
        ? DatabaseUuidSchema.parse(req.query.ontologyId)
        : undefined;
    const before =
      typeof req.query.before === "string" ? req.query.before : undefined;
    const records = await listAutomations({
      tenantId: resolveRequestTenant(req),
      actorUserId: principal.id,
      ontologyId,
      limit,
      before,
    });
    res.status(200).json({
      data: records,
      nextPageToken:
        records.length === limit ? records[records.length - 1].updatedAt : null,
    });
  }),
);

router.get(
  "/:automationId",
  handler(async (req, res) => {
    const principal = actor(req);
    const record = await getAutomation(
      parseId(req),
      resolveRequestTenant(req),
      principal.id,
    );
    res
      .status(200)
      .setHeader("ETag", `"${record.draftRevision}"`)
      .json({ data: record });
  }),
);

router.patch(
  "/:automationId/draft",
  requireOntologyWrite,
  handler(async (req, res) => {
    const body = UpdateDraftSchema.parse(req.body);
    const principal = actor(req);
    const record = await updateDraft({
      automationId: parseId(req),
      tenantId: resolveRequestTenant(req),
      actorUserId: principal.id,
      expectedRevision: body.revision,
      definition: body.definition,
    });
    res
      .status(200)
      .setHeader("ETag", `"${record.draftRevision}"`)
      .json({ data: record });
  }),
);

router.post(
  "/:automationId/validate",
  handler(async (req, res) => {
    const principal = actor(req);
    const record = await getAutomation(
      parseId(req),
      resolveRequestTenant(req),
      principal.id,
    );
    const definition =
      req.body && Object.prototype.hasOwnProperty.call(req.body, "definition")
        ? req.body.definition
        : record.draftDefinition;
    const result =
      req.query.activation === "true"
        ? await validateAutomationForActivation(
            pool,
            definition,
            record.automationId,
            record.tenantId,
          )
        : validateAutomationDraft(definition);
    res.status(200).json({ data: result });
  }),
);

router.post(
  "/:automationId/activate",
  requireOntologyWrite,
  handler(async (req, res) => {
    const body = ActivateSchema.parse(req.body);
    const principal = actor(req);
    const idempotencyKey = req.header("Idempotency-Key");
    if (!idempotencyKey || idempotencyKey.length > 500) {
      throw new AutomationServiceError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key header is required for activation.",
      );
    }
    const record = await activateAutomation({
      automationId: parseId(req),
      tenantId: resolveRequestTenant(req),
      actorUserId: principal.id,
      expectedRevision: body.revision,
      idempotencyKey,
    });
    res.status(200).json({ data: record });
  }),
);

router.get(
  "/:automationId/history",
  handler(async (req, res) => {
    const principal = actor(req);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    const history = await listExecutionHistory({
      automationId: parseId(req),
      tenantId: resolveRequestTenant(req),
      actorUserId: principal.id,
      limit,
      before:
        typeof req.query.before === "string" ? req.query.before : undefined,
    });
    res.status(200).json({ data: history });
  }),
);

router.get(
  "/:automationId/evaluations",
  handler(async (req, res) => {
    const principal = actor(req);
    const data = await listConditionEvaluations({
      automationId: parseId(req),
      tenantId: resolveRequestTenant(req),
      actorUserId: principal.id,
      limit: Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500),
    });
    res.status(200).json({ data });
  }),
);

router.get(
  "/:automationId/audit",
  handler(async (req, res) => {
    const principal = actor(req);
    const data = await listAutomationAudit({
      automationId: parseId(req),
      tenantId: resolveRequestTenant(req),
      actorUserId: principal.id,
      limit: Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500),
    });
    res.status(200).json({ data });
  }),
);

router.get(
  "/:automationId/executions/:triggerEventId",
  handler(async (req, res) => {
    const principal = actor(req);
    const data = await getExecutionDetails({
      automationId: parseId(req),
      triggerEventId: UuidSchema.parse(req.params.triggerEventId),
      tenantId: resolveRequestTenant(req),
      actorUserId: principal.id,
    });
    res.status(200).json({ data });
  }),
);

router.post(
  "/:automationId/executions/:triggerEventId/retry",
  handler(async (req, res) => {
    const principal = actor(req);
    const idempotencyKey = req.header("Idempotency-Key");
    if (!idempotencyKey || idempotencyKey.length > 500) {
      throw new AutomationServiceError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key header is required.",
        400,
      );
    }
    const result = await retryTriggerEvent({
      automationId: parseId(req),
      triggerEventId: UuidSchema.parse(req.params.triggerEventId),
      tenantId: resolveRequestTenant(req),
      actorUserId: principal.id,
      idempotencyKey,
    });
    res.status(result.reused ? 200 : 201).json({ data: result });
  }),
);

router.post(
  "/:automationId/executions/:triggerEventId/cancel",
  handler(async (req, res) => {
    const principal = actor(req);
    await cancelTriggerEvent({
      automationId: parseId(req),
      triggerEventId: UuidSchema.parse(req.params.triggerEventId),
      tenantId: resolveRequestTenant(req),
      actorUserId: principal.id,
    });
    res.status(204).end();
  }),
);

for (const transition of [
  ["pause", "paused"],
  ["resume", "active"],
  ["mute", "muted"],
  ["unmute", "active"],
  ["archive", "archived"],
] as const) {
  router.post(
    `/:automationId/${transition[0]}`,
    requireOntologyWrite,
    handler(async (req, res) => {
      const body = TransitionSchema.parse(req.body ?? {});
      const principal = actor(req);
      const record = await transitionAutomation({
        automationId: parseId(req),
        tenantId: resolveRequestTenant(req),
        actorUserId: principal.id,
        target: transition[1],
        reason: body.reason,
      });
      res.status(200).json({ data: record });
    }),
  );
  router.post("/:automationId/live-eval-trigger", async (req: Request, res: Response) => {
    const automationId = req.params.automationId;
    const { runAutomateLiveEventsOnce } = await import("../services/automate/conditionRuntime");
    const processed = await runAutomateLiveEventsOnce(500);
    res.status(200).json({ automationId, processed });
  });
}

export default router;
