// ---------------------------------------------------------------------------
// Trace context — PB-B9.
//
// Lightweight AsyncLocalStorage-backed trace_id + span_id propagation.
// Every HTTP request gets a fresh trace_id; services opt in to add
// context fields (deployment_id, pipeline_id, etc) via `withTraceFields`.
//
// This is intentionally NOT OpenTelemetry. Full OTel auto-
// instrumentation is tracked as `PB-B9.follow-otel` — it needs a
// one-shot bootstrap before any import runs, and retrofitting it here
// would spike the risk of regressing existing routes. The manual
// trace_id pipeline below covers the spec's acceptance (a) via logs +
// the X-Trace-Id response header without the OTel SDK's overhead.
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from "async_hooks";
import { randomBytes } from "crypto";

export interface TraceFields {
  traceId: string;
  spanId: string;
  deploymentId?: string;
  pipelineId?: string;
  projectId?: string;
  actorUserId?: string;
  extra?: Record<string, unknown>;
}

const store = new AsyncLocalStorage<TraceFields>();

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Run `fn` in a context with the supplied trace fields. Nested calls
 * inherit everything from the outer context unless overridden.
 */
export function withTraceFields<T>(fields: Partial<TraceFields>, fn: () => T): T {
  const inherited = store.getStore();
  const merged: TraceFields = {
    traceId: fields.traceId ?? inherited?.traceId ?? newTraceId(),
    spanId: fields.spanId ?? newSpanId(),
    deploymentId: fields.deploymentId ?? inherited?.deploymentId,
    pipelineId: fields.pipelineId ?? inherited?.pipelineId,
    projectId: fields.projectId ?? inherited?.projectId,
    actorUserId: fields.actorUserId ?? inherited?.actorUserId,
    extra: { ...(inherited?.extra ?? {}), ...(fields.extra ?? {}) },
  };
  return store.run(merged, fn);
}

/** Read the current trace context (may be undefined off-request). */
export function currentTrace(): TraceFields | undefined {
  return store.getStore();
}

/** Enrich the active context with additional fields. No-op when off-request. */
export function annotateTrace(partial: Partial<TraceFields>): void {
  const active = store.getStore();
  if (!active) return;
  if (partial.deploymentId !== undefined) active.deploymentId = partial.deploymentId;
  if (partial.pipelineId !== undefined) active.pipelineId = partial.pipelineId;
  if (partial.projectId !== undefined) active.projectId = partial.projectId;
  if (partial.actorUserId !== undefined) active.actorUserId = partial.actorUserId;
  if (partial.extra) {
    active.extra = { ...(active.extra ?? {}), ...partial.extra };
  }
}
