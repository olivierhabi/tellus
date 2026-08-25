import type { NextFunction, Request, Response } from "express";
import { trace } from "@opentelemetry/api";
import { Counter, Histogram, register as metricsRegistry } from "prom-client";
import { auditWriter } from "../../audit";
import {
  ResourceVersionMismatch,
  WebhookExecutionNotFound,
  WebhookExecutionRateLimited,
  WebhookInvalidConfiguration,
  WebhookNameAlreadyExists,
  WebhookNotActive,
  WebhookNotFound,
} from "../../../lib/errors/connectivity.errors";
import { TellusError } from "../../../lib/errors/envelope";
import {
  requireConnectivityIfMatch,
  setConnectivityEtag,
} from "../../../middleware/connectivityEtag";
import { extractUser, requireScope } from "../handlers/connections.handler";
import * as connections from "../store/connections.repo";
import {
  WebhookCreateRequest,
  WebhookExecuteRequest,
  WebhookUpdateRequest,
  type ConnectivityWebhook,
  type WebhookExecutionSummary,
} from "./contracts";
import { executeWebhook } from "./executor";
import * as repository from "./repository";

function metric<T extends Counter<string> | Histogram<string>>(
  name: string,
  create: () => T,
): T {
  return (metricsRegistry.getSingleMetric(name) as T | undefined) ?? create();
}

const requests = metric(
  "tellus_connectivity_webhook_requests_total",
  () =>
    new Counter({
      name: "tellus_connectivity_webhook_requests_total",
      help: "Source-scoped webhook API requests.",
      labelNames: ["operation", "outcome"] as const,
    }),
);

const executionDuration = metric(
  "tellus_connectivity_webhook_execution_duration_seconds",
  () =>
    new Histogram({
      name: "tellus_connectivity_webhook_execution_duration_seconds",
      help: "Source-scoped webhook execution duration.",
      labelNames: ["kind", "outcome"] as const,
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 60, 180],
    }),
);

function translate(error: unknown): TellusError {
  if (error instanceof TellusError) return error;
  const structuredCode = (error as { code?: unknown } | null)?.code;
  const code =
    typeof structuredCode === "string"
      ? structuredCode
      : error instanceof Error
        ? error.message
        : String(error);
  if (code === "WEBHOOK_NOT_FOUND") return new TellusError(WebhookNotFound);
  if (code === "WEBHOOK_EXECUTION_NOT_FOUND") {
    return new TellusError(WebhookExecutionNotFound);
  }
  if (code === "WEBHOOK_VERSION_MISMATCH") {
    return new TellusError(ResourceVersionMismatch);
  }
  if (code === "WEBHOOK_CONCURRENCY_LIMIT" || code === "WEBHOOK_RATE_LIMIT") {
    return new TellusError(WebhookExecutionRateLimited, { limit: code });
  }
  if ((error as { code?: string }).code === "23505") {
    return new TellusError(WebhookNameAlreadyExists);
  }
  if (code === "WEBHOOK_NOT_ACTIVE") return new TellusError(WebhookNotActive);
  return new TellusError(WebhookInvalidConfiguration, {
    reason: error instanceof Error ? error.message : String(error),
  });
}

function handler(
  operation: string,
  fn: (req: Request, res: Response) => Promise<void>,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const span = trace.getActiveSpan();
    span?.setAttribute("tellus.webhook.operation", operation);
    try {
      await fn(req, res);
      requests.labels(operation, "success").inc();
    } catch (error) {
      requests.labels(operation, "failure").inc();
      const translated = translate(error);
      if (!res.headersSent) translated.send(res);
      next(undefined);
    }
  };
}

async function restConnection(req: Request, scope: string) {
  const user = extractUser(req);
  requireScope(user, scope);
  const rid = req.params.rid;
  const connection = await connections.findByRid(rid, user.tenant);
  if (connection.connectorType !== "rest-api") {
    throw new TellusError(WebhookInvalidConfiguration, {
      reason: "Webhooks can only be created from REST API sources.",
    });
  }
  return { user, connection };
}

function validateAgainstSource(
  webhook: Pick<ConnectivityWebhook, "configuration">,
  domainCount: number,
  secretNames: readonly string[],
): void {
  const configuredSecrets = new Set(secretNames);
  for (const [callIndex, call] of webhook.configuration.request.calls.entries()) {
    if (call.domainIndex >= domainCount) {
      throw new TellusError(WebhookInvalidConfiguration, {
        path: ["configuration", "request", "calls", callIndex, "domainIndex"],
        reason: "Call references a REST source domain that does not exist.",
      });
    }
    const secretReferences = [
      ...call.headers
        .filter((entry) => entry.value.kind === "secret")
        .map((entry) => (entry.value as { secretName: string }).secretName),
      ...call.queryParameters
        .filter((entry) => entry.value.kind === "secret")
        .map((entry) => (entry.value as { secretName: string }).secretName),
    ];
    for (const name of secretReferences) {
      if (!configuredSecrets.has(name)) {
        throw new TellusError(WebhookInvalidConfiguration, {
          path: ["configuration", "request", "calls", callIndex],
          reason: `Secret '${name}' is not declared by the REST source.`,
        });
      }
    }
  }
  if (
    webhook.configuration.signature &&
    !configuredSecrets.has(webhook.configuration.signature.secretName)
  ) {
    throw new TellusError(WebhookInvalidConfiguration, {
      path: ["configuration", "signature", "secretName"],
      reason: "Signature secret is not declared by the REST source.",
    });
  }
}

function requestContext(req: Request) {
  const requestIdHeader = req.headers["x-request-id"];
  return {
    requestId:
      typeof requestIdHeader === "string" ? requestIdHeader.slice(0, 200) : undefined,
    clientIp: req.ip,
  };
}

async function writeAudit(params: {
  req: Request;
  actor: string;
  operationId: string;
  resourceRid: string;
  metadata?: Record<string, unknown>;
}) {
  await auditWriter.write({
    actorId: params.actor,
    operationId: params.operationId,
    resourceRid: params.resourceRid,
    decision: "ALLOW",
    requestId:
      typeof params.req.headers["x-request-id"] === "string"
        ? params.req.headers["x-request-id"]
        : null,
    ip: params.req.ip,
    metadata: params.metadata,
  });
}

export const listWebhooks = handler("list", async (req, res) => {
  const { user } = await restConnection(req, "connectivity:read");
  const data = await repository.listByConnection(
    req.params.rid,
    user.tenant,
    req.query.includeArchived === "true",
  );
  res.status(200).json({ data });
});

export const createWebhook = handler("create", async (req, res) => {
  const { user, connection } = await restConnection(req, "connectivity:write");
  const parsed = WebhookCreateRequest.safeParse(req.body);
  if (!parsed.success) {
    throw new TellusError(WebhookInvalidConfiguration, {
      issues: parsed.error.issues,
    });
  }
  const rest = connection.config.connectorType === "rest-api"
    ? connection.config.restApi
    : null;
  if (!rest) throw new TellusError(WebhookInvalidConfiguration);
  validateAgainstSource(
    { configuration: parsed.data.configuration },
    rest.domains.length,
    rest.additionalSecretNames,
  );
  const created = await repository.create({
    tenant: user.tenant,
    connectionRid: connection.rid,
    apiName: parsed.data.apiName,
    displayName: parsed.data.displayName,
    description: parsed.data.description,
    status: "active",
    configuration: parsed.data.configuration,
    actor: user.id,
  });
  await writeAudit({
    req,
    actor: user.id,
    operationId: "connectivity.webhook.create",
    resourceRid: created.rid,
    metadata: {
      connectionRid: connection.rid,
      version: created.currentVersion,
      status: created.status,
    },
  });
  setConnectivityEtag(res, created.currentVersion);
  res.setHeader(
    "Location",
    `/api/v1/connectivity/webhooks/${encodeURIComponent(created.rid)}`,
  );
  res.status(201).json(created);
});

export const getWebhook = handler("get", async (req, res) => {
  const user = extractUser(req);
  requireScope(user, "connectivity:read");
  const webhook = await repository.getByRid(req.params.webhookRid, user.tenant);
  await connections.findByRid(webhook.connectionRid, user.tenant);
  setConnectivityEtag(res, webhook.currentVersion);
  res.status(200).json(webhook);
});

export const listWebhookVersions = handler("versions.list", async (req, res) => {
  const user = extractUser(req);
  requireScope(user, "connectivity:read");
  const requestedPageSize = Number(req.query.pageSize ?? 100);
  const pageSize = Number.isInteger(requestedPageSize)
    ? Math.min(Math.max(requestedPageSize, 1), 200)
    : 100;
  const requestedToken =
    req.query.pageToken === undefined ? undefined : Number(req.query.pageToken);
  const beforeVersion =
    requestedToken !== undefined &&
    Number.isInteger(requestedToken) &&
    requestedToken > 0
      ? requestedToken
      : undefined;
  const { data, nextPageToken } = await repository.listVersions(
    req.params.webhookRid,
    user.tenant,
    { pageSize, beforeVersion },
  );
  await connections.findByRid(data[0].connectionRid, user.tenant);
  res.status(200).json({ data, nextPageToken });
});

export const updateWebhook = handler("update", async (req, res) => {
  const user = extractUser(req);
  requireScope(user, "connectivity:write");
  const current = await repository.getByRid(req.params.webhookRid, user.tenant);
  const connection = await connections.findByRid(
    current.connectionRid,
    user.tenant,
  );
  const expected = requireConnectivityIfMatch(req, current.currentVersion);
  const parsed = WebhookUpdateRequest.safeParse(req.body);
  if (!parsed.success) {
    throw new TellusError(WebhookInvalidConfiguration, {
      issues: parsed.error.issues,
    });
  }
  if (connection.config.connectorType !== "rest-api") {
    throw new TellusError(WebhookInvalidConfiguration);
  }
  validateAgainstSource(
    { configuration: parsed.data.configuration },
    connection.config.restApi.domains.length,
    connection.config.restApi.additionalSecretNames,
  );
  const updated = await repository.updateVersion({
    webhookRid: current.rid,
    tenant: user.tenant,
    expectedVersion: expected,
    displayName: parsed.data.displayName,
    description: parsed.data.description,
    configuration: parsed.data.configuration,
    actor: user.id,
  });
  await writeAudit({
    req,
    actor: user.id,
    operationId: "connectivity.webhook.version.create",
    resourceRid: updated.rid,
    metadata: { version: updated.currentVersion },
  });
  setConnectivityEtag(res, updated.currentVersion);
  res.status(200).json(updated);
});

function changeStatus(
  status: "ready" | "active" | "disabled" | "archived",
) {
  return handler(status, async (req, res) => {
    const user = extractUser(req);
    requireScope(user, "connectivity:write");
    const current = await repository.getByRid(req.params.webhookRid, user.tenant);
    await connections.findByRid(current.connectionRid, user.tenant);
    const expected = requireConnectivityIfMatch(req, current.currentVersion);
    if (status === "active" && !["ready", "disabled", "active"].includes(current.status)) {
      throw new TellusError(WebhookInvalidConfiguration, {
        reason: "Only a ready or disabled webhook version can be activated.",
      });
    }
    const updated = await repository.setStatus({
      webhookRid: current.rid,
      tenant: user.tenant,
      expectedVersion: expected,
      status,
      actor: user.id,
    });
    await writeAudit({
      req,
      actor: user.id,
      operationId: `connectivity.webhook.${status}`,
      resourceRid: updated.rid,
      metadata: { version: updated.currentVersion, status },
    });
    setConnectivityEtag(res, updated.currentVersion);
    res.status(200).json(updated);
  });
}

export const markWebhookReady = changeStatus("ready");
export const activateWebhook = changeStatus("active");
export const disableWebhook = changeStatus("disabled");
export const archiveWebhook = changeStatus("archived");

function redactExecutionForViewer(
  row: WebhookExecutionSummary,
  actor: string,
  privileged: boolean,
): WebhookExecutionSummary {
  if (privileged || row.triggeredBy === actor) return row;
  return {
    ...row,
    inputSummary: {},
    outputSummary: null,
    attempts: row.attempts?.map((attempt) => ({
      ...attempt,
      responsePreview: null,
    })),
  };
}

function execute(kind: "test" | "production") {
  return handler(kind, async (req, res) => {
    const user = extractUser(req);
    requireScope(user, kind === "test" ? "connectivity:test" : "connectivity:write");
    const webhook = await repository.getByRid(req.params.webhookRid, user.tenant);
    const connection = await connections.findByRid(
      webhook.connectionRid,
      user.tenant,
    );
    const parsed = WebhookExecuteRequest.safeParse(req.body);
    if (!parsed.success) {
      throw new TellusError(WebhookInvalidConfiguration, {
        issues: parsed.error.issues,
      });
    }
    const started = Date.now();
    const result = await executeWebhook({
      webhook,
      connection,
      tenant: user.tenant,
      actor: user.id,
      kind,
      inputs: parsed.data.inputs,
      idempotencyKey:
        parsed.data.idempotencyKey ??
        (typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"]
          : undefined),
      ...requestContext(req),
    });
    executionDuration
      .labels(kind, result.execution.status)
      .observe((Date.now() - started) / 1000);
    await writeAudit({
      req,
      actor: user.id,
      operationId: `connectivity.webhook.${kind}.execute`,
      resourceRid: webhook.rid,
      metadata: {
        executionRid: result.execution.rid,
        version: webhook.currentVersion,
        outcome: result.execution.status,
        replayed: result.replayed,
      },
    });
    res.status(result.replayed ? 200 : 201).json(result);
  });
}

export const testWebhook = execute("test");
export const executeProductionWebhook = execute("production");

export const listExecutions = handler("history.list", async (req, res) => {
  const user = extractUser(req);
  requireScope(user, "connectivity:read");
  const webhook = await repository.getByRid(req.params.webhookRid, user.tenant);
  await connections.findByRid(webhook.connectionRid, user.tenant);
  const privileged = user.scopes.includes("webhooks:read-privileged-data");
  const requestedLimit = req.query.limit ? Number(req.query.limit) : 100;
  const limit =
    Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 500)
      : 100;
  const data = (
    await repository.listExecutions(
      webhook.rid,
      user.tenant,
      limit,
    )
  ).map((row) => redactExecutionForViewer(row, user.id, privileged));
  res.status(200).json({ data });
});

export const getExecution = handler("history.get", async (req, res) => {
  const user = extractUser(req);
  requireScope(user, "connectivity:read");
  const row = await repository.getExecution(
    req.params.executionRid,
    user.tenant,
  );
  const webhook = await repository.getByRid(row.webhookRid, user.tenant);
  await connections.findByRid(webhook.connectionRid, user.tenant);
  const privileged = user.scopes.includes("webhooks:read-privileged-data");
  res
    .status(200)
    .json(redactExecutionForViewer(row, user.id, privileged));
});
