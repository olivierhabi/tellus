// ---------------------------------------------------------------------------
// Side-Effect Worker — Phase 5 stateless worker
//
// Drains the `action_side_effect_job` outbox. Claims via SELECT FOR UPDATE
// SKIP LOCKED, dispatches per-kind through a transport (webhook dispatcher
// or NotificationProvider), updates status to 'succeeded' / 'retrying' /
// 'dead' with bounded exponential backoff + jitter.
//
// Phase 5 ships the worker module + claim/dispatch logic + retry policy
// implementation. Production wiring (a background loop spawned by the BE
// server process vs a separate CLI process) is left to deployment — the
// worker's `runOnce(limit)` public entry is the single-shot primitive so
// tests + production can drive it identically.
//
// Phase 6 ships:
//   * Prometheus metrics + structured logs + OpenTelemetry spans around
//     each claim-dispatch-update cycle.
//   * Per-ontology rate-limit / circuit-breaker guards (currently the
//     writebackExecutor's webhookSafeTransport covers the network-level
//     SSRF + body cap, but not per-endpoint concurrency / circuit breaking).
//   * Operator UI for the 'dead' queue + retry. The model-layer
//     `requeueDeadSideEffectJob` is the API surface.
// ---------------------------------------------------------------------------

import {
  claimSideEffectJobs,
  markSideEffectJobSucceeded,
  markSideEffectJobRetryOrDead,
  getSideEffectQueueStats,
  type SideEffectJobRow,
} from "../../models/actionSideEffectJob";
import { deliverOneWebhook, type ActionWebhookSpec, type ActionWebhookPayload } from "../../actions/actionWebhooks";
import { deriveIdempotencyKey } from "../../services/webhookSafeTransport";
import { incCounter, setGauge, observeHistogram } from "../../services/funnel/metrics";
// Phase 6.3 — OpenTelemetry spans around the claim-dispatch-update cycle
// for the side-effect outbox worker. Lazy-import via `require` so unit
// tests + cold-boot sandboxes (where `OTEL_SDK_DISABLED=true`) don't drag
// the full OTel SDK into the worker module's import graph.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const otelApi: typeof import("@opentelemetry/api") =
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("@opentelemetry/api");
const tracer = otelApi.trace.getTracer("tellus.sideEffectWorker", "1");
import { getNotificationProvider, type NotificationRequest, type NotificationChannel, type NotificationRecipient } from "../../actions/notificationProviders";
import {
  recipientVisibilityFilter,
  makeProductionRecipientResolver,
  type AffectedObjectInfo,
  type RecipientPreFilter,
} from "../../actions/notificationRecipientFilter";
import { getKeycloakAdminService } from "../../services/keycloakAdminService";
import { executeWebhook } from "../connectivity/webhooks/executor";
import * as connectivityWebhooks from "../connectivity/webhooks/repository";
import * as connectivityConnections from "../connectivity/store/connections.repo";
import { warnLegacyWebhookDispatch } from "../connectivity/webhooks/router";
import { query } from "../../db";
import { executeWebhookInputFunction } from "../../actions/webhookInputFunctionExecutor";

// ---------------------------------------------------------------------------
// Default retry policy — bounded exponential backoff + jitter. Matches
// the §10 spec exactly. The webhook's own `retry_policy` from the
// webhook_definition row (Phase 3 schema) overrides this when set; the
// action-side-effect-job row doesn't carry its own retry_policy today
// (Phase 6 ships that — the row's payload carries the same shape).
// ---------------------------------------------------------------------------

export const DEFAULT_RETRY_POLICY = {
  maxAttempts: 5,           // 1 initial + 4 retries
  initialBackoffMs: 1_000,  // 1 second
  maxBackoffMs: 60_000,     // 1 minute ceiling
  multiplier: 2,            // exponential
  jitterMs: 500,            // ± 500ms random jitter
};

// ---------------------------------------------------------------------------
// Dispatch a single side-effect job. The injected `dispatch` function
// throws on infra failure; the loop catches + records the error in the
// job row. The function returns the next-status transitions; the caller
// (claim-dispatch loop) doesn't need to know the kind.
// ---------------------------------------------------------------------------

/** The kind-type of dispatch function the loop calls — one per kind. */
export type SideEffectDispatchFn = (
  job: SideEffectJobRow
) => Promise<{
  ok: boolean;
  receiptId?: string;
  error?: string;
  /** Phase 6.1 — when ok=true, mark the dispatch as a "dropped"
   * outcome (the worker didn't actually call the provider; instead
   * the recipient-data-filter refused the dispatch). The worker
   * records this in the job's `external_receipt` column + the
   * structured log + the relevant counter. */
  dropped?: boolean;
  droppedReason?: string;
  missingMarkings?: string[];
}>;

/**
 * Dispatch a single side-effect job via the kind-appropriate transport.
 * The function is intact-testable (mocking the injector) — production
 * wires the real transports via `productionDispatchers`.
 *
 * On success: returns `{ ok: true, receiptId }`.
 * On infra failure: throws; the loop catches + records the error in the
 * job row via `markSideEffectJobRetryOrDead`.
 */
export const productionWebhookDispatch: SideEffectDispatchFn = async (job) => {
  // The side_effect_job.payload carries `{ spec, context }` — the
  // spec is the Webhook spec + the context is the ActionWebhookPayload
  // (actionExecutor / execution context).
  const payload = (job.payload ?? {}) as {
    spec?: Partial<ActionWebhookSpec> & {
      kind?: string;
      webhookId?: string;
      webhookVersion?: number;
      inputs?: Record<string, unknown>;
      inputFunction?: {
        functionRid?: string;
        repositoryRid?: string;
        apiName?: string;
        branch?: string;
        semver?: string;
        arguments?: Record<string, unknown>;
        resultMode?: string;
        suppressWhenNull?: boolean;
      };
    };
    context?: Partial<ActionWebhookPayload> & { tenant?: string };
  };
  if (payload.spec?.kind === "connectivity") {
    const tenant = String(payload.context?.tenant ?? "default");
    const webhookId = String(payload.spec.webhookId ?? "");
    const version = Number(payload.spec.webhookVersion);
    const webhook = await connectivityWebhooks.getByRid(webhookId, tenant, version);
    const connection = await connectivityConnections.findByRid(
      webhook.connectionRid,
      tenant,
    );
    const resolveObjectProperty = async (value: unknown): Promise<unknown> => {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (value as { source?: unknown }).source !== "resolvedObjectProperty"
      ) {
        return value;
      }
      const descriptor = value as {
        objectType?: unknown;
        primaryKey?: unknown;
        path?: unknown;
      };
      const objectType = String(descriptor.objectType ?? "");
      const primaryKey = String(descriptor.primaryKey ?? "");
      const path = String(descriptor.path ?? "");
      const objectResult = await query(
        `SELECT properties FROM object_instances
          WHERE ontology_id = $1
            AND object_type_api_name = $2
            AND primary_key = $3
          ORDER BY updated_at DESC
          LIMIT 1`,
        [String(payload.context?.ontologyId ?? ""), objectType, primaryKey],
      );
      const properties = objectResult.rows[0]?.properties;
      return path
        .split("/")
        .filter(Boolean)
        .reduce<unknown>((current, segment) => {
          if (!current || typeof current !== "object" || Array.isArray(current)) {
            return undefined;
          }
          return (current as Record<string, unknown>)[segment];
        }, properties);
    };
    const directInputs = Object.fromEntries(
      await Promise.all(
        Object.entries(payload.spec.inputs ?? {}).map(async ([name, value]) => [
          name,
          await resolveObjectProperty(value),
        ]),
      ),
    );
    let payloads: Record<string, unknown>[] = [directInputs];
    if (payload.spec.inputFunction) {
      const functionArguments = Object.fromEntries(
        await Promise.all(
          Object.entries(payload.spec.inputFunction.arguments ?? {}).map(
            async ([name, value]) => [name, await resolveObjectProperty(value)],
          ),
        ),
      );
      const output = await executeWebhookInputFunction({
        ontologyId: String(payload.context?.ontologyId ?? ""),
        binding: {
          functionRid: String(payload.spec.inputFunction.functionRid ?? ""),
          repositoryRid: String(payload.spec.inputFunction.repositoryRid ?? ""),
          apiName: String(payload.spec.inputFunction.apiName ?? ""),
          branch: String(payload.spec.inputFunction.branch ?? ""),
          semver: String(payload.spec.inputFunction.semver ?? ""),
        },
        arguments: functionArguments,
      });
      if (output == null && payload.spec.inputFunction.suppressWhenNull) {
        return { ok: true, receiptId: "suppressed:null-function-output" };
      }
      const candidates =
        payload.spec.inputFunction.resultMode === "list" ? output : [output];
      if (
        !Array.isArray(candidates) ||
        candidates.some(
          (candidate) =>
            !candidate || typeof candidate !== "object" || Array.isArray(candidate),
        )
      ) {
        throw new Error(
          "Webhook input Function returned a value that does not match its configured payload mode.",
        );
      }
      payloads = candidates as Record<string, unknown>[];
    }
    const results = await Promise.all(
      payloads.map((inputs, index) =>
        executeWebhook({
          webhook,
          connection,
          tenant,
          actor: String(payload.context?.executedBy ?? "system"),
          kind: "production",
          inputs,
          idempotencyKey: `${
            job.idempotency_key ?? `${job.execution_id}:${job.side_effect_index}`
          }:${index}`,
        }),
      ),
    );
    const failed = results.find(
      (result) => result.execution.status !== "succeeded",
    );
    if (failed) {
      const error = new Error(
        `Connectivity webhook execution ${failed.execution.rid} ended in '${failed.execution.status}'.`,
      ) as Error & { code?: string };
      error.code =
        failed.execution.errorCode ?? "CONNECTIVITY_WEBHOOK_FAILED";
      throw error;
    }
    return {
      ok: true,
      receiptId: results.map((result) => result.execution.rid).join(","),
    };
  }
  const spec: ActionWebhookSpec = {
    url: String(payload.spec?.url ?? ""),
    method: (payload.spec?.method ?? "POST") as string,
    headers: payload.spec?.headers ?? {},
    timeoutMs: payload.spec?.timeoutMs ?? 5_000,
  };
  // F9 — legacy inline-URL writeback (System C). DEPRECATED. Emit a warning
  // so operators can track the remaining legacy footprint; new action
  // side-effects MUST bind a connectivity webhook RID
  // (`payload.spec.kind === "connectivity"`). See
  // docs/data-connection/webhook-systems.md.
  warnLegacyWebhookDispatch(
    spec.url || "(inline-url)",
    "sideEffectWorker.productionWebhookDispatch",
  );
  const context: ActionWebhookPayload = {
    executionId: String(payload.context?.executionId ?? ""),
    actionTypeApiName: String(payload.context?.actionTypeApiName ?? ""),
    ontologyId: String(payload.context?.ontologyId ?? ""),
    branchId: payload.context?.branchId ?? null,
    result: String(payload.context?.result ?? ""),
    executedBy: String(payload.context?.executedBy ?? "system"),
    affectedObjects: payload.context?.affectedObjects ?? [],
    firedAt: String(payload.context?.firedAt ?? new Date().toISOString()),
  };
  // fireOneWebhook's transport = the existing per-webhook dispatch path
  // reused by actionExecutor Stage 7. Phase 5 reuses it so the
  // in-process + worker paths share the egress guard + the
  // delivery semantics.
  // Stable idempotency key — the SAME derivation as the connectivity
  // path above: the job row's idempotency_key (or its deterministic
  // fallback). Retries of this job re-send the SAME key, so a
  // dedup-aware receiver collapses at-least-once delivery into
  // exactly-once effect.
  const r = await deliverOneWebhook(spec, context, {
    idempotencyKey: job.idempotency_key ?? `${job.execution_id}:${job.side_effect_index}`,
  });
  if (!r.ok) {
    const err = new Error(`Webhook dispatch failed: ${r.error ?? "unknown"}`) as Error & { code?: string };
    err.code = "WEBHOOK_DISPATCHER_REJECTED";
    throw err;
  }
  return { ok: true, receiptId: r.receiptId ?? deriveIdempotencyKey(job.execution_id, job.attempt_count) };
};

export const productionNotificationDispatch: SideEffectDispatchFn = async (job) => {
  const payload = (job.payload ?? {}) as {
    spec?: any;
    recipient?: any;
    context?: any;
  };
  // The notification spec carries channel + templateId + templateParameters;
  // the per-recipient field carries the resolved NotificationRecipient.
  const channel = (payload.spec?.channel ?? "in_app") as NotificationChannel;
  const provider = getNotificationProvider(channel);
  if (!provider) {
    throw new Error(`No NotificationProvider registered for channel '${channel}'.`);
  }
  const recipientRaw = (payload.recipient ?? {
    principal: "?",
    principalKind: "user",
  });
  // Phase 6.1 — recipient-data-filter. Drops recipients who lack
  // visibility on every affected object touched by the source action.
  // The recipient is the per-job resolved principal (a single user);
  // the affectedObjects list is the action's `result.affectedObjects`
  // (post-apply pre-commit). Filter is best-effort — an exception
  // during the resolver or markings-lookup degrades to "drop" so the
  // worker never dispatches without an authz check.
  const ctx = payload.context ?? {};
  const affectedObjects: AffectedObjectInfo[] = Array.isArray(ctx.affectedObjects)
    ? (ctx.affectedObjects as AffectedObjectInfo[])
    : [];
  const recipientPreFilter: RecipientPreFilter = {
    principal: String(recipientRaw.principal ?? recipientRaw.email ?? "?"),
    principalKind: recipientRaw.principalKind === "group" ? "group" : "user",
  };
  const ontologyId = String(ctx.ontologyId ?? "");
  const resolver = makeProductionRecipientResolver(
    (email: string) => getKeycloakAdminService().findUserByEmail(email),
  );
  let filterResult;
  try {
    filterResult = await recipientVisibilityFilter(
      ontologyId,
      affectedObjects,
      recipientPreFilter,
      resolver,
    );
  } catch (err: any) {
    // Defensive — never crash the worker on a filter bug.
    filterResult = {
      ok: false,
      droppedReason: "lookup_error",
      resolvedUserId: null,
    };
  }
  if (!filterResult.ok) {
    // Drop → mark the job succeeded with a structured receipt
    // (no provider call). The worker's success-path code records
    // this in external_receipt + the structured log + bumps the
    // tellus_side_effect_notification_dropped_total counter; the
    // dispatch's own counter increment is delegated upward so we
    // don't double-count.
    return {
      ok: true,
      receiptId: `dropped:${filterResult.droppedReason ?? "unknown"}`,
      dropped: true,
      droppedReason: filterResult.droppedReason ?? "unknown",
      missingMarkings: filterResult.missingMarkings,
    };
  }
  const req: NotificationRequest = {
    templateId: String(payload.spec?.templateId ?? ""),
    templateParameters: payload.spec?.templateParameters ?? {},
    channel,
    // Phase 6.4 — thread the resolved user UUID into the recipient
    // so the InApp provider can INSERT a notification_inbox row keyed
    // by users.id; the Email/Slack providers also log it in the body
    // for downstream correlation when the vendor supports it.
    recipient: {
      ...(recipientRaw ?? {}),
      principal: String(recipientRaw.principal ?? recipientRaw.email ?? "?"),
      principalKind: recipientRaw.principalKind === "group" ? "group" : "user",
      // Only set on the recipient when present — recipients without a
      // UUID (the recipient filter refused to resolve) already short-
      // circuited above into the "dropped" branch, so we only reach
      // here on filterResult.ok. The resolved UUID is mandatory for
      // the InApp provider's INSERT; downstream providers treat it
      // as best-effort metadata.
      ...(filterResult.resolvedUserId
        ? { userUuid: filterResult.resolvedUserId }
        : {}),
    } as NotificationRecipient,
    executionId: String(ctx.executionId ?? ""),
    actionTypeApiName: String(ctx.actionTypeApiName ?? ""),
    ontologyId,
  };
  const r = await provider.send(req);
  if (!r.ok) {
    const err = new Error(`Notification provider '${channel}' reported failure: ${r.diagnostic ?? ""}`) as Error & { code?: string };
    err.code = "NOTIFICATION_PROVIDER_FAILED";
    throw err;
  }
  return { ok: true, receiptId: r.receiptId };
};

export function productionDispatchForKind(job: SideEffectJobRow): SideEffectDispatchFn {
  if (job.kind === "webhook") return productionWebhookDispatch;
  if (job.kind === "notification") return productionNotificationDispatch;
  throw new Error(`Unknown side-effect job kind '${(job as any).kind}'.`);
}

// ---------------------------------------------------------------------------
// Single-shot cycle: claim a batch, dispatch, update statuses. Returns
// the count of jobs claimed + the success/retry/dead heights for
// operator dashboards + tests. Idempotent + stateless — the caller is
// free to invoke from a periodic timer, a CLI loop, or a
// distributed-worker framework.
// ---------------------------------------------------------------------------

export interface OnceResult {
  claimed: number;
  succeeded: number;
  retrying: number;
  dead: number;
  durationMs: number;
}

export async function runOnce(
  limit: number = 16,
  retryPolicy = DEFAULT_RETRY_POLICY,
  injectDispatch?: (job: SideEffectJobRow) => SideEffectDispatchFn,
): Promise<OnceResult> {
  return tracer.startActiveSpan("side_effect_worker.runOnce", async (span) => {
    const start = Date.now();
    const result: OnceResult = { claimed: 0, succeeded: 0, retrying: 0, dead: 0, durationMs: 0 };
    const jobs = await claimSideEffectJobs(limit);
    result.claimed = jobs.length;
    span.setAttribute("side_effect.claimed", result.claimed);
    for (const job of jobs) {
    incCounter("tellus_side_effect_claim_total", { kind: job.kind });
    const dispatcher = (injectDispatch ?? productionDispatchForKind)(job);
    const dispatchStart = Date.now();
    try {
      const r = await dispatcher(job);
      const dispatchDurationSeconds = (Date.now() - dispatchStart) / 1000;
      observeHistogram("tellus_side_effect_dispatch_duration_seconds", dispatchDurationSeconds, {
        kind: job.kind, outcome: r.dropped ? `dropped_${r.droppedReason ?? "unknown"}` : "ok",
      });
      // Phase 6.1 — when the dispatch was a "drop" outcome (recipient-
      // data-filter refused), record the drop reason in the job's
      // external_receipt column + the structured log + the relevant
      // counter. The job still transitions to "succeeded" (no
      // delivery was attempted) so the worker's queue drains cleanly.
      const externalReceipt: Record<string, unknown> | undefined = r.receiptId
        ? r.dropped
          ? {
              receiptId: r.receiptId,
              dropped: true,
              droppedReason: r.droppedReason ?? "unknown",
              ...(r.missingMarkings && r.missingMarkings.length > 0
                ? { missingMarkings: r.missingMarkings }
                : {}),
            }
          : { receiptId: r.receiptId }
        : undefined;
      await markSideEffectJobSucceeded(job.job_id, externalReceipt);
      result.succeeded += 1;
      if (r.dropped) {
        incCounter("tellus_side_effect_notification_dropped_total", {
          reason: r.droppedReason ?? "unknown",
        });
        console.info(JSON.stringify({
          type: "side_effect_dispatch_dropped",
          jobId: job.job_id,
          executionId: job.execution_id,
          kind: job.kind,
          droppedReason: r.droppedReason ?? "unknown",
          missingMarkings: r.missingMarkings,
        }));
      } else {
        incCounter("tellus_side_effect_succeeded_total", { kind: job.kind });
      }
    } catch (err: any) {
      const code = err?.code ?? String(err?.message ?? "DISPATCH_FAILED").slice(0, 200);
      const message = err?.message ?? String(err);
      const dispatchDurationSeconds = (Date.now() - dispatchStart) / 1000;
      const next = await markSideEffectJobRetryOrDead(job.job_id, code, message.slice(0, 500), retryPolicy);
      if (next === "dead") {
        result.dead += 1;
        incCounter("tellus_side_effect_dead_total", { kind: job.kind, error_code: code });
        observeHistogram("tellus_side_effect_dispatch_duration_seconds", dispatchDurationSeconds, {
          kind: job.kind, outcome: "dead",
        });
      } else {
        result.retrying += 1;
        incCounter("tellus_side_effect_retry_total", { kind: job.kind, error_code: code });
        observeHistogram("tellus_side_effect_dispatch_duration_seconds", dispatchDurationSeconds, {
          kind: job.kind, outcome: "retry",
        });
      }
      console.warn(JSON.stringify({
        type: "side_effect_dispatch_failed",
        jobId: job.job_id,
        executionId: job.execution_id,
        actionTypeId: job.action_type_id,
        sideEffectIndex: job.side_effect_index,
        kind: job.kind,
        errorCode: code,
        attemptCountNext: job.attempt_count + 1,
        nextStatus: next,
      }));
    }
  }
  result.durationMs = Date.now() - start;
  // P5 — expose the queue depth gauge so operators can alert on backlog.
  try {
    const stats = await getSideEffectQueueStats();
    for (const [state, count] of Object.entries(stats)) {
      setGauge("tellus_side_effect_queue_size", Number(count) || 0, { status: state });
    }
  } catch {
    // Best-effort — the worker MUST NOT crash on a gauge-read failure.
  }
  // Phase 6.3 — stamp the structured outcome onto the OTel span so the
  // operator dashboard surfaces throughput/retry/dead-letter together.
  span.setAttribute("side_effect.succeeded", result.succeeded);
  span.setAttribute("side_effect.retrying", result.retrying);
  span.setAttribute("side_effect.dead", result.dead);
  span.setAttribute("side_effect.duration_ms", result.durationMs);
  span.end();
  return result;
  });
}

/**
 * Production loop wrapper — runs `runOnce` periodically until cancelled.
 * A separate CLI process or BE-server background task can spawn this.
 * Phase 6 ships the metrics + structured logs + tracing spans around
 * every iteration; Phase 5 logs the bare asserted result.
 */
export async function runWorkerLoop(opts: {
  intervalMs?: number;
  limit?: number;
  retryPolicy?: typeof DEFAULT_RETRY_POLICY;
  signal?: AbortSignal;
} = {}): Promise<void> {
  const intervalMs = opts.intervalMs ?? 2_000;
  const limit = opts.limit ?? 16;
  const retryPolicy = opts.retryPolicy ?? DEFAULT_RETRY_POLICY;
  while (!opts.signal?.aborted) {
    try {
      const r = await runOnce(limit, retryPolicy);
      if (r.claimed > 0) {
        console.info(JSON.stringify({
          type: "side_effect_worker_cycle",
          ...r,
        }));
      }
    } catch (err: any) {
      console.error(JSON.stringify({
        type: "side_effect_worker_cycle_error",
        error: err?.message ?? String(err),
      }));
    }
    // Sleep interruptible by the abort signal.
    if (opts.signal?.aborted) break;
    await sleepInterruptible(intervalMs, opts.signal);
  }
}

function sleepInterruptible(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    }
  });
}
