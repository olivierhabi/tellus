import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, withTransaction } from "../../../db";
import type {
  ConnectivityWebhook,
  WebhookDeliveryAttempt,
  WebhookExecutionSummary,
  WebhookLifecycleStatus,
  WebhookVersionConfiguration,
} from "./contracts";
import { WebhookVersionConfiguration as WebhookVersionConfigurationSchema } from "./contracts";

interface WebhookRow {
  rid: string;
  tenant: string;
  connection_rid: string;
  api_name: string;
  display_name: string;
  description: string;
  status: WebhookLifecycleStatus;
  current_version: number;
  request_config: unknown;
  input_parameters: unknown;
  output_parameters: unknown;
  storage_config: unknown;
  execution_policy: unknown;
  trigger_config: unknown;
  signature_config: unknown;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

function toWebhook(row: WebhookRow): ConnectivityWebhook {
  const configuration = WebhookVersionConfigurationSchema.parse({
    request: row.request_config,
    inputs: row.input_parameters,
    outputs: row.output_parameters,
    storage: row.storage_config,
    executionPolicy: row.execution_policy,
    trigger: row.trigger_config,
    signature: row.signature_config,
  });
  return {
    rid: row.rid,
    tenant: row.tenant,
    connectionRid: row.connection_rid,
    apiName: row.api_name,
    displayName: row.display_name,
    description: row.description,
    status: row.status,
    currentVersion: Number(row.current_version),
    configuration,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

const SELECT_CURRENT = `
  SELECT w.*,
         v.request_config, v.input_parameters, v.output_parameters,
         v.storage_config, v.execution_policy, v.trigger_config,
         v.signature_config
    FROM connectivity_webhook w
    JOIN connectivity_webhook_version v
      ON v.webhook_rid = w.rid AND v.version = w.current_version
`;

async function insertVersion(
  client: PoolClient,
  params: {
    webhookRid: string;
    version: number;
    configuration: WebhookVersionConfiguration;
    actor: string;
  },
): Promise<void> {
  const c = params.configuration;
  await client.query(
    `INSERT INTO connectivity_webhook_version (
       webhook_rid, version, request_config, input_parameters,
       output_parameters, storage_config, execution_policy,
       trigger_config, signature_config, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      params.webhookRid,
      params.version,
      JSON.stringify(c.request),
      JSON.stringify(c.inputs),
      JSON.stringify(c.outputs),
      JSON.stringify(c.storage),
      JSON.stringify(c.executionPolicy),
      JSON.stringify(c.trigger),
      c.signature === null ? null : JSON.stringify(c.signature),
      params.actor,
    ],
  );
}

export async function create(params: {
  tenant: string;
  connectionRid: string;
  apiName: string;
  displayName: string;
  description: string;
  status: "draft" | "ready" | "active";
  configuration: WebhookVersionConfiguration;
  actor: string;
}): Promise<ConnectivityWebhook> {
  const rid = `ri.magritte.main.webhook.${randomUUID()}`;
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO connectivity_webhook (
         rid, tenant, connection_rid, api_name, display_name,
         description, status, current_version, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$8)`,
      [
        rid,
        params.tenant,
        params.connectionRid,
        params.apiName,
        params.displayName,
        params.description,
        params.status,
        params.actor,
      ],
    );
    await insertVersion(client, {
      webhookRid: rid,
      version: 1,
      configuration: params.configuration,
      actor: params.actor,
    });
  });
  return getByRid(rid, params.tenant);
}

export async function listByConnection(
  connectionRid: string,
  tenant: string,
  includeArchived = false,
): Promise<ConnectivityWebhook[]> {
  const archivedClause = includeArchived ? "" : "AND w.archived_at IS NULL";
  const result = await pool.query<WebhookRow>(
    `${SELECT_CURRENT}
      WHERE w.connection_rid = $1 AND w.tenant = $2 ${archivedClause}
      ORDER BY w.updated_at DESC, w.api_name`,
    [connectionRid, tenant],
  );
  return result.rows.map(toWebhook);
}

export async function getByRid(
  webhookRid: string,
  tenant: string,
  version?: number,
): Promise<ConnectivityWebhook> {
  if (version !== undefined) {
    const result = await pool.query<WebhookRow>(
      `SELECT w.*,
              v.request_config, v.input_parameters, v.output_parameters,
              v.storage_config, v.execution_policy, v.trigger_config,
              v.signature_config,
              v.created_at AS created_at,
              v.created_by AS created_by,
              v.created_at AS updated_at,
              v.created_by AS updated_by
         FROM connectivity_webhook w
         JOIN connectivity_webhook_version v
           ON v.webhook_rid = w.rid AND v.version = $3
        WHERE w.rid = $1 AND w.tenant = $2`,
      [webhookRid, tenant, version],
    );
    if (!result.rows[0]) throw new Error("WEBHOOK_NOT_FOUND");
    const webhook = toWebhook(result.rows[0]);
    return { ...webhook, currentVersion: version };
  }
  const result = await pool.query<WebhookRow>(
    `${SELECT_CURRENT} WHERE w.rid = $1 AND w.tenant = $2`,
    [webhookRid, tenant],
  );
  if (!result.rows[0]) throw new Error("WEBHOOK_NOT_FOUND");
  return toWebhook(result.rows[0]);
}

/**
 * Returns every immutable configuration version for one webhook. The webhook
 * identity (name, source, lifecycle) is intentionally shared; each returned
 * row carries the configuration that was persisted for that exact version.
 */
export async function listVersions(
  webhookRid: string,
  tenant: string,
  options: { pageSize: number; beforeVersion?: number },
): Promise<{ data: ConnectivityWebhook[]; nextPageToken: string | null }> {
  const result = await pool.query<WebhookRow>(
    `SELECT w.*,
            v.request_config, v.input_parameters, v.output_parameters,
            v.storage_config, v.execution_policy, v.trigger_config,
            v.signature_config,
            v.version AS current_version,
            v.created_at AS created_at,
            v.created_by AS created_by,
            v.created_at AS updated_at,
            v.created_by AS updated_by
       FROM connectivity_webhook w
      JOIN connectivity_webhook_version v ON v.webhook_rid = w.rid
      WHERE w.rid = $1 AND w.tenant = $2
        AND ($3::integer IS NULL OR v.version < $3)
      ORDER BY v.version DESC
      LIMIT $4`,
    [webhookRid, tenant, options.beforeVersion ?? null, options.pageSize + 1],
  );
  if (result.rows.length === 0) throw new Error("WEBHOOK_NOT_FOUND");
  const hasMore = result.rows.length > options.pageSize;
  const pageRows = result.rows.slice(0, options.pageSize);
  const data = pageRows.map(toWebhook);
  return {
    data,
    nextPageToken: hasMore
      ? String(data[data.length - 1].currentVersion)
      : null,
  };
}

export async function updateVersion(params: {
  webhookRid: string;
  tenant: string;
  expectedVersion: number;
  displayName?: string;
  description?: string;
  configuration: WebhookVersionConfiguration;
  actor: string;
}): Promise<ConnectivityWebhook> {
  await withTransaction(async (client) => {
    const current = await client.query<{
      current_version: number;
      status: WebhookLifecycleStatus;
    }>(
      `SELECT current_version, status
         FROM connectivity_webhook
        WHERE rid=$1 AND tenant=$2 AND archived_at IS NULL
        FOR UPDATE`,
      [params.webhookRid, params.tenant],
    );
    if (!current.rows[0]) throw new Error("WEBHOOK_NOT_FOUND");
    if (Number(current.rows[0].current_version) !== params.expectedVersion) {
      throw new Error("WEBHOOK_VERSION_MISMATCH");
    }
    const nextVersion = params.expectedVersion + 1;
    await insertVersion(client, {
      webhookRid: params.webhookRid,
      version: nextVersion,
      configuration: params.configuration,
      actor: params.actor,
    });
    const nextStatus =
      current.rows[0].status === "active"
        ? "ready"
        : current.rows[0].status === "failed"
          ? "draft"
          : current.rows[0].status;
    await client.query(
      `UPDATE connectivity_webhook
          SET current_version=$3,
              display_name=COALESCE($4, display_name),
              description=COALESCE($5, description),
              status=$6,
              updated_at=now(),
              updated_by=$7
        WHERE rid=$1 AND tenant=$2`,
      [
        params.webhookRid,
        params.tenant,
        nextVersion,
        params.displayName ?? null,
        params.description ?? null,
        nextStatus,
        params.actor,
      ],
    );
  });
  return getByRid(params.webhookRid, params.tenant);
}

export async function setStatus(params: {
  webhookRid: string;
  tenant: string;
  expectedVersion: number;
  status: "ready" | "active" | "disabled" | "archived" | "failed";
  actor: string;
}): Promise<ConnectivityWebhook> {
  const result = await pool.query(
    `UPDATE connectivity_webhook
        SET status=$4, updated_at=now(), updated_by=$5,
            archived_at=CASE WHEN $4='archived' THEN now() ELSE archived_at END
      WHERE rid=$1 AND tenant=$2 AND current_version=$3
        AND archived_at IS NULL`,
    [
      params.webhookRid,
      params.tenant,
      params.expectedVersion,
      params.status,
      params.actor,
    ],
  );
  if ((result.rowCount ?? 0) === 0) {
    const exists = await pool.query(
      "SELECT current_version FROM connectivity_webhook WHERE rid=$1 AND tenant=$2",
      [params.webhookRid, params.tenant],
    );
    if (!exists.rows[0]) throw new Error("WEBHOOK_NOT_FOUND");
    throw new Error("WEBHOOK_VERSION_MISMATCH");
  }
  return getByRid(params.webhookRid, params.tenant);
}

interface ExecutionRow {
  rid: string;
  webhook_rid: string;
  webhook_version: number;
  kind: "test" | "production";
  status: WebhookExecutionSummary["status"];
  correlation_id: string;
  triggered_by: string;
  input_summary: Record<string, unknown>;
  output_summary: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  http_status: number | null;
  duration_ms: number | null;
  external_system_changed: boolean | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

function toExecution(row: ExecutionRow): WebhookExecutionSummary {
  return {
    rid: row.rid,
    webhookRid: row.webhook_rid,
    webhookVersion: Number(row.webhook_version),
    kind: row.kind,
    status: row.status,
    correlationId: row.correlation_id,
    triggeredBy: row.triggered_by,
    inputSummary: row.input_summary,
    outputSummary: row.output_summary,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    httpStatus: row.http_status,
    durationMs: row.duration_ms,
    externalSystemChanged: row.external_system_changed,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

export async function createExecution(params: {
  tenant: string;
  webhookRid: string;
  webhookVersion: number;
  kind: "test" | "production";
  correlationId: string;
  idempotencyKeyHash: string;
  triggeredBy: string;
  inputSummary: Record<string, unknown>;
  concurrencyLimit?: number | null;
  rateLimit?: { count: number; window: "second" | "minute" | "hour" | "day" } | null;
}): Promise<{ execution: WebhookExecutionSummary; replayed: boolean }> {
  const rid = `ri.magritte.main.webhook-execution.${randomUUID()}`;
  return withTransaction(async (client) => {
    // Serialize admission decisions per webhook across all server replicas.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      params.webhookRid,
    ]);
    const replay = await client.query<ExecutionRow>(
      `SELECT * FROM connectivity_webhook_execution
        WHERE tenant=$1 AND webhook_rid=$2 AND idempotency_key_hash=$3`,
      [params.tenant, params.webhookRid, params.idempotencyKeyHash],
    );
    if (replay.rows[0]) {
      return { execution: toExecution(replay.rows[0]), replayed: true };
    }
    if (params.concurrencyLimit) {
      const active = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM connectivity_webhook_execution
          WHERE tenant=$1 AND webhook_rid=$2
            AND status IN ('queued','running')`,
        [params.tenant, params.webhookRid],
      );
      if (Number(active.rows[0].count) >= params.concurrencyLimit) {
        throw new Error("WEBHOOK_CONCURRENCY_LIMIT");
      }
    }
    if (params.rateLimit) {
      const interval = `1 ${params.rateLimit.window}`;
      const recent = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM connectivity_webhook_execution
          WHERE tenant=$1 AND webhook_rid=$2
            AND created_at >= now() - $3::interval`,
        [params.tenant, params.webhookRid, interval],
      );
      if (Number(recent.rows[0].count) >= params.rateLimit.count) {
        throw new Error("WEBHOOK_RATE_LIMIT");
      }
    }
    const result = await client.query<ExecutionRow>(
      `INSERT INTO connectivity_webhook_execution (
         rid, tenant, webhook_rid, webhook_version, kind, status,
         correlation_id, idempotency_key_hash, triggered_by, input_summary
       ) VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9)
       RETURNING *`,
      [
        rid,
        params.tenant,
        params.webhookRid,
        params.webhookVersion,
        params.kind,
        params.correlationId,
        params.idempotencyKeyHash,
        params.triggeredBy,
        JSON.stringify(params.inputSummary),
      ],
    );
    return { execution: toExecution(result.rows[0]), replayed: false };
  });
}

export async function markExecutionRunning(executionRid: string): Promise<void> {
  await pool.query(
    `UPDATE connectivity_webhook_execution
        SET status='running', started_at=COALESCE(started_at, now())
      WHERE rid=$1 AND status='queued'`,
    [executionRid],
  );
}

export async function completeExecution(params: {
  executionRid: string;
  status: "succeeded" | "failed" | "cancelled" | "dead_lettered";
  outputSummary?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  httpStatus?: number | null;
  durationMs: number;
  externalSystemChanged?: boolean | null;
}): Promise<void> {
  await pool.query(
    `UPDATE connectivity_webhook_execution
        SET status=$2, output_summary=$3, error_code=$4, error_message=$5,
            http_status=$6, duration_ms=$7, external_system_changed=$8,
            completed_at=now()
      WHERE rid=$1`,
    [
      params.executionRid,
      params.status,
      params.outputSummary === undefined || params.outputSummary === null
        ? null
        : JSON.stringify(params.outputSummary),
      params.errorCode ?? null,
      params.errorMessage ?? null,
      params.httpStatus ?? null,
      params.durationMs,
      params.externalSystemChanged ?? null,
    ],
  );
}

export async function beginAttempt(params: {
  executionRid: string;
  attemptNumber: number;
  requestMethod: string;
  requestUrlRedacted: string;
  requestHeadersRedacted: Record<string, unknown>;
}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO connectivity_webhook_delivery_attempt (
       id, execution_rid, attempt_number, status, request_method,
       request_url_redacted, request_headers_redacted
     ) VALUES ($1,$2,$3,'running',$4,$5,$6)`,
    [
      id,
      params.executionRid,
      params.attemptNumber,
      params.requestMethod,
      params.requestUrlRedacted,
      JSON.stringify(params.requestHeadersRedacted),
    ],
  );
  return id;
}

export async function completeAttempt(params: {
  id: string;
  status: "succeeded" | "retryable_failure" | "terminal_failure" | "cancelled";
  responseHeadersRedacted?: Record<string, unknown> | null;
  httpStatus?: number | null;
  responsePreview?: string | null;
  responseBytes?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  nextAttemptAt?: string | null;
}): Promise<void> {
  await pool.query(
    `UPDATE connectivity_webhook_delivery_attempt
        SET status=$2, response_headers_redacted=$3, http_status=$4,
            response_preview=$5, response_bytes=$6, error_code=$7,
            error_message=$8, next_attempt_at=$9, completed_at=now()
      WHERE id=$1`,
    [
      params.id,
      params.status,
      params.responseHeadersRedacted === undefined ||
      params.responseHeadersRedacted === null
        ? null
        : JSON.stringify(params.responseHeadersRedacted),
      params.httpStatus ?? null,
      params.responsePreview ?? null,
      params.responseBytes ?? null,
      params.errorCode ?? null,
      params.errorMessage ?? null,
      params.nextAttemptAt ?? null,
    ],
  );
}

export async function listExecutions(
  webhookRid: string,
  tenant: string,
  limit = 100,
): Promise<WebhookExecutionSummary[]> {
  const result = await pool.query<ExecutionRow>(
    `SELECT e.*
       FROM connectivity_webhook_execution e
       JOIN connectivity_webhook w ON w.rid=e.webhook_rid
      WHERE e.webhook_rid=$1 AND e.tenant=$2 AND w.tenant=$2
      ORDER BY e.created_at DESC
      LIMIT $3`,
    [webhookRid, tenant, Math.min(Math.max(limit, 1), 500)],
  );
  return result.rows.map(toExecution);
}

export async function getExecution(
  executionRid: string,
  tenant: string,
): Promise<WebhookExecutionSummary> {
  const result = await pool.query<ExecutionRow>(
    `SELECT e.*
       FROM connectivity_webhook_execution e
       JOIN connectivity_webhook w ON w.rid=e.webhook_rid
      WHERE e.rid=$1 AND e.tenant=$2 AND w.tenant=$2`,
    [executionRid, tenant],
  );
  if (!result.rows[0]) throw new Error("WEBHOOK_EXECUTION_NOT_FOUND");
  const attempts = await pool.query<{
    id: string;
    attempt_number: number;
    status: WebhookDeliveryAttempt["status"];
    request_method: string;
    request_url_redacted: string;
    request_headers_redacted: Record<string, unknown>;
    response_headers_redacted: Record<string, unknown> | null;
    http_status: number | null;
    response_preview: string | null;
    response_bytes: number | null;
    error_code: string | null;
    error_message: string | null;
    started_at: string;
    completed_at: string | null;
    next_attempt_at: string | null;
  }>(
    `SELECT * FROM connectivity_webhook_delivery_attempt
      WHERE execution_rid=$1 ORDER BY attempt_number`,
    [executionRid],
  );
  return {
    ...toExecution(result.rows[0]),
    attempts: attempts.rows.map((row) => ({
      id: row.id,
      attemptNumber: row.attempt_number,
      status: row.status,
      requestMethod: row.request_method,
      requestUrlRedacted: row.request_url_redacted,
      requestHeadersRedacted: row.request_headers_redacted,
      responseHeadersRedacted: row.response_headers_redacted,
      httpStatus: row.http_status,
      responsePreview: row.response_preview,
      responseBytes: row.response_bytes,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      nextAttemptAt: row.next_attempt_at,
    })),
  };
}
