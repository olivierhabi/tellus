// ---------------------------------------------------------------------------
// Webhook Definition Routes — Express Router
//
// CRUD for webhook_definition rows (Phase 3). Mounted at:
//   /api/v1/ontology/:ontologyId/webhooks
//
// A webhook definition is the governed, versioned, immutable-after-publish
// webhook registry row that an Action Type references by
// `ontology_id + name + version` from its `side_effects` (Phase 5) or
// `writeback_config` (Phase 4).
//
// Versioning is monotonic by `(ontology_id, name)`. Each PATCH bumps the
// version (INSERT a new row, mark the previous as 'disabled'). Action
// types carry the explicit `(name, version)` binding so editing webhook
// config never silently mutates the meaning of a previously-saved
// action type.
//
// Lifecycle:
//   draft   — invisible to new action-type bindings
//   active  — selectable by new action types; called at execution
//   disabled — new action types CANNOT bind; existing bindings stay
//             functional but the executor surfaces a structured error
//             ("webhook disabled") at execution time (Phase 4)
//
// Plaintext credentials NEVER cross this endpoint. `authentication_config`
// is a SecretReference-shaped JSON blob that the BE resolver later
// resolves against Tellus's secrets manager (Phase 4 execution path).
//
// Phase 6 will tighten authorization: only specific role + persona combos
// may create/update webhooks (today: `requireOntologyWrite` create,
// `requireOntologyWrite` update, `requireOntologyAdmin` delete).
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import {
  sendSuccess,
  sendCreated,
  sendError,
} from "../utils/responseFormatter";
import { requireOntologyWrite, requireOntologyAdmin } from "../middleware/requireRole";
import {
  createWebhookDefinition,
  getWebhookByName,
  getWebhookByNameVersion,
  getWebhookById,
  listWebhooks,
  bumpWebhookVersion,
  disableWebhook,
  hardDeleteWebhook,
  type WebhookDefinitionRow,
} from "../models/webhookDefinition";

const router = Router({ mergeParams: true });

const STATUSES = new Set(["draft", "active", "disabled"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function formatRow(row: WebhookDefinitionRow): Record<string, unknown> {
  return {
    rid: row.webhook_id,
    name: row.name,
    version: row.version,
    description: row.description,
    status: row.status,
    method: row.method,
    endpointConfig: row.endpoint_config,
    inputSchema: row.input_schema,
    outputSchema: row.output_schema,
    authenticationConfig: row.authentication_config,
    timeoutMs: row.timeout_ms,
    maxResponseBytes: row.max_response_bytes,
    retryPolicy: row.retry_policy,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Frontend-friendly display fields:
    displayName: row.name, // mirrors the (intentional) name==displayName
                              // simplification in Phase 3 — Phase 6 will
                              // separate displayName onto its own column
                              // once backward-compat shimming lands
  };
}

function actorOf(req: Request): string {
  const anyReq = req as unknown as {
    tellusPrincipal?: { userId?: string };
    user?: { id?: string; email?: string };
  };
  return (
    anyReq.tellusPrincipal?.userId ||
    anyReq.user?.id ||
    anyReq.user?.email ||
    "system"
  );
}

// ---------------------------------------------------------------------------
// POST / — Create
// ---------------------------------------------------------------------------

router.post(
  "/",
  requireOntologyWrite,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId } = req.params as { ontologyId: string };
      const body = req.body ?? {};

      if (!body.name || typeof body.name !== "string" || !/^[A-Z][a-zA-Z0-9]*$/.test(body.name)) {
        sendError(res, "VALIDATION_FAILED", "name is required and must be UpperCamelCase (^[A-Z][a-zA-Z0-9]*$).");
        return;
      }
      if (!body.method || !METHODS.has(body.method)) {
        sendError(res, "VALIDATION_FAILED", `method must be one of: ${Array.from(METHODS).join(", ")}.`);
        return;
      }
      if (body.status !== undefined && !STATUSES.has(body.status)) {
        sendError(res, "VALIDATION_FAILED", `status must be one of: ${Array.from(STATUSES).join(", ")}.`);
        return;
      }
      if (!body.inputSchema || typeof body.inputSchema !== "object") {
        sendError(res, "VALIDATION_FAILED", "inputSchema is required (JSON Schema for the webhook request body).");
        return;
      }
      if (!body.authenticationConfig || typeof body.authenticationConfig !== "object") {
        sendError(res, "VALIDATION_FAILED", "authenticationConfig is required (SecretReference object — never plaintext).");
        return;
      }

      const row = await createWebhookDefinition(ontologyId, {
        name: body.name,
        description: body.description ?? null,
        status: body.status ?? "draft",
        method: body.method,
        endpointConfig: body.endpointConfig,
        inputSchema: body.inputSchema,
        outputSchema: body.outputSchema ?? null,
        authenticationConfig: body.authenticationConfig,
        timeoutMs: body.timeoutMs,
        maxResponseBytes: body.maxResponseBytes,
        retryPolicy: body.retryPolicy ?? null,
        createdBy: actorOf(req),
      });
      sendCreated(res, formatRow(row));
    } catch (err: any) {
      // translateWebhookKnownErrors in middleware — forward to next()
      // for the global error handler to surface ValidationError /
      // WEBHOOK_ALREADY_EXISTS through the structured envelope.
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET / — List (current version of each webhook only)
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params as { ontologyId: string };
    const status = req.query.status as string | undefined;
    const rows = await listWebhooks(ontologyId, status && STATUSES.has(status) ? { status: status as any } : undefined);
    sendSuccess(res, { data: rows.map(formatRow) });
  } catch (err: any) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /:name — Latest draft/active version by name
// ---------------------------------------------------------------------------

router.get("/:name", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, name } = req.params as { ontologyId: string; name: string };
    const row = await getWebhookByName(ontologyId, name);
    if (!row) {
      sendError(res, "WEBHOOK_NOT_FOUND", `Webhook '${name}' not found in this ontology.`);
      return;
    }
    sendSuccess(res, formatRow(row));
  } catch (err: any) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /:name/versions/:version — Specific immutable version
// (Phase 4 read; the explicit-version lookup is what an action type's
// `writeback_config.webhookId + webhookVersion` binding resolves
// against at execution time. Exposed in Phase 3 so Phase 4 consumers
// can land against a stable contract.)
// ---------------------------------------------------------------------------

router.get("/:name/versions/:version", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, name, version } = req.params as { ontologyId: string; name: string; version: string };
    const v = Number(version);
    if (!Number.isInteger(v) || v < 1) {
      sendError(res, "VALIDATION_FAILED", "version must be a positive integer.");
      return;
    }
    const row = await getWebhookByNameVersion(ontologyId, name, v);
    if (!row) {
      sendError(res, "WEBHOOK_NOT_FOUND", `Webhook '${name}' v${v} not found.`);
      return;
    }
    sendSuccess(res, formatRow(row));
  } catch (err: any) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /:name — Update (bumps version)
// ---------------------------------------------------------------------------

router.patch(
  "/:name",
  requireOntologyWrite,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, name } = req.params as { ontologyId: string; name: string };
      const body = req.body ?? {};

      if (body.method !== undefined && !METHODS.has(body.method)) {
        sendError(res, "VALIDATION_FAILED", `method must be one of: ${Array.from(METHODS).join(", ")}.`);
        return;
      }
      if (body.status !== undefined && !STATUSES.has(body.status)) {
        sendError(res, "VALIDATION_FAILED", `status must be one of: ${Array.from(STATUSES).join(", ")}.`);
        return;
      }

      const row = await bumpWebhookVersion(ontologyId, name, {
        description: body.description,
        status: body.status,
        method: body.method,
        endpointConfig: body.endpointConfig,
        inputSchema: body.inputSchema,
        outputSchema: body.outputSchema,
        authenticationConfig: body.authenticationConfig,
        timeoutMs: body.timeoutMs,
        maxResponseBytes: body.maxResponseBytes,
        retryPolicy: body.retryPolicy,
        updatedBy: actorOf(req),
      });
      sendSuccess(res, formatRow(row));
    } catch (err: any) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /:name/disable — Soft-delete (lifecycle to disabled)
// ---------------------------------------------------------------------------

router.post(
  "/:name/disable",
  requireOntologyWrite,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, name } = req.params as { ontologyId: string; name: string };
      const row = await disableWebhook(ontologyId, name);
      if (!row) {
        sendError(res, "WEBHOOK_NOT_FOUND", `Webhook '${name}' not found.`);
        return;
      }
      sendSuccess(res, formatRow(row));
    } catch (err: any) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /:name — Hard-delete (admin only)
// ---------------------------------------------------------------------------

router.delete(
  "/:name",
  requireOntologyAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, name } = req.params as { ontologyId: string; name: string };
      const ok = await hardDeleteWebhook(ontologyId, name);
      if (!ok) {
        sendError(res, "WEBHOOK_NOT_FOUND", `Webhook '${name}' not found.`);
        return;
      }
      sendSuccess(res, { deleted: true });
    } catch (err: any) {
      next(err);
    }
  }
);

export default router;
