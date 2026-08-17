// ---------------------------------------------------------------------------
// Side-Effect Job Extractor — parse an action_type's `side_effects` JSONB
// blob into the canonical list of outbox side-effect jobs.
//
// The action_type.side_effects JSONB shape (legacy compatible) is:
//   {
//     "webhooks": [ { "url", "method"?, "headers"?, "timeoutMs"? } ],
//     "notifications": [ NotificationSpec ]
//   }
//
// Phase 5 normalises each entry into a (kind, payload) pair that the
// durable outbox worker dispatches. Webhook specs and notification specs
// keep the exact same shape the existing `actionWebhooks.ts` /
// `sideEffectNotifier.ts` already understand — the worker dispatches
// via the same transport so legacy semantics are preserved.
// ---------------------------------------------------------------------------

import type { SideEffectJobKind } from "../models/actionSideEffectJob";

/** One entry the worker claims + dispatches. */
export interface ExtractedSideEffectJob {
  kind: SideEffectJobKind;
  payload: Record<string, unknown>;
  /** Stable idempotency-key seed combined with executionId later — the
   * BE record's `idempotency_key` is computed at worker-claim time. */
  idempotencySeed: string;
}

/**
 * Parse the persisted `side_effects` JSONB blob into the canonical list
 * of outbox jobs. Returns an empty array when `sideEffects` is null/absent
 * or has no entries (the legitimate case for actions with no side effects).
 *
 * Pure: no DB IO. Testable in isolation.
 */
export function extractSideEffectJobs(
  sideEffects: unknown,
  executionContext: SideEffectExecutionContext,
): ExtractedSideEffectJob[] {
  if (!sideEffects || typeof sideEffects !== "object" || Array.isArray(sideEffects)) return [];
  const se = sideEffects as Record<string, unknown>;
  const out: ExtractedSideEffectJob[] = [];
  const { resolvedParameters: _resolvedParameters, ...persistedContext } =
    executionContext;

  // Webhook fanouts — one row per webhook spec.
  const webhookSpecs = Array.isArray(se.webhooks) ? (se.webhooks as Array<Record<string, unknown>>) : [];
  for (let i = 0; i < webhookSpecs.length; i++) {
    const spec = webhookSpecs[i];
    if (!spec || typeof spec !== "object") continue;
    const resolvedSpec =
      spec.kind === "connectivity"
        ? {
            ...spec,
            inputs: Object.fromEntries(
              Object.entries(
                spec.inputs && typeof spec.inputs === "object" && !Array.isArray(spec.inputs)
                  ? spec.inputs as Record<string, unknown>
                  : {},
              ).map(([name, source]) => [
                name,
                resolveValueSource(source, executionContext),
              ]),
            ),
            ...(spec.inputFunction &&
            typeof spec.inputFunction === "object" &&
            !Array.isArray(spec.inputFunction)
              ? {
                  inputFunction: {
                    ...(spec.inputFunction as Record<string, unknown>),
                    arguments: Object.fromEntries(
                      Object.entries(
                        (spec.inputFunction as Record<string, unknown>).arguments &&
                          typeof (spec.inputFunction as Record<string, unknown>).arguments ===
                            "object" &&
                          !Array.isArray(
                            (spec.inputFunction as Record<string, unknown>).arguments,
                          )
                          ? ((spec.inputFunction as Record<string, unknown>)
                              .arguments as Record<string, unknown>)
                          : {},
                      ).map(([name, source]) => [
                        name,
                        resolveValueSource(source, executionContext),
                      ]),
                    ),
                  },
                }
              : {}),
          }
        : spec;
    out.push({
      kind: "webhook",
      // The payload is the spec + the runtime execution context — the
      // worker's dispatch function consumes both.
      payload: {
        spec: resolvedSpec,
        context: persistedContext,
      },
      idempotencySeed: `wb:${i}`,
    });
  }

  // Notification dispatches — one row per recipient. The legacy
  // spec carries full notifications; split into one job per recipient so
  // a single recipient's failure doesn't block others.
  const notificationSpecs = Array.isArray(se.notifications) ? (se.notifications as Array<Record<string, unknown>>) : [];
  for (let i = 0; i < notificationSpecs.length; i++) {
    const spec = notificationSpecs[i];
    if (!spec || typeof spec !== "object") continue;
    const recipients: Array<Record<string, unknown>> = Array.isArray(spec.recipients)
      ? (spec.recipients as Array<Record<string, unknown>>)
      : [];
    for (let j = 0; j < recipients.length; j++) {
      out.push({
        kind: "notification",
        payload: {
          spec,
          recipientIndex: j,
          recipient: recipients[j] ?? null,
          context: persistedContext,
        },
        idempotencySeed: `notif:${i}:${j}`,
      });
    }
  }

  return out;
}

/** The execution context the worker uses for log enrichment + idempotency-key derivation. */
export interface SideEffectExecutionContext {
  executionId: string;
  actionTypeApiName: string;
  actionTypeId: string;
  actionTypeVersion: number;
  ontologyId: string;
  executedBy: string;
  tenant: string;
  /** Used only while extracting jobs. The extractor persists mapped values,
   * never the complete action parameter bag, into the outbox payload. */
  resolvedParameters: Record<string, unknown>;
  parameterDefinitions?: Array<{
    apiName?: string;
    type?: string;
    objectType?: string;
  }>;
  result: string;
  affectedObjects: Array<{ objectType: string; primaryKey: string; operation: string }>;
  firedAt: string;
  /**
   * Migration 173 — the Security page's "Notification settings" card,
   * snapshotted into the outbox payload at enqueue time rather than
   * re-read by the worker. Snapshotting is deliberate: the job must be
   * dispatched under the policy that was in force when the action ran,
   * not whatever an editor flipped to while the job sat in the queue.
   *
   * Absent on jobs enqueued before this field existed; the worker
   * resolves absence to the documented defaults.
   */
  notificationPolicy?: {
    /** "all" | "any" — see ActionSecuritySettings.actionFailurePolicy. */
    failurePolicy: string;
    /** Bypass the recipient visibility filter entirely. */
    disableRedaction: boolean;
  };
}

function resolveValueSource(
  value: unknown,
  context: SideEffectExecutionContext,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  switch (source.source) {
    case "parameter":
      return context.resolvedParameters[String(source.param ?? "")];
    case "static":
      return source.value;
    case "currentTimestamp":
      return context.firedAt;
    case "currentUser":
      return context.executedBy;
    case "objectProperty": {
      const parameterName = String(source.param ?? "");
      const reference = context.resolvedParameters[parameterName];
      const definition = context.parameterDefinitions?.find(
        (candidate) => candidate.apiName === parameterName,
      );
      if (
        typeof reference !== "string" ||
        definition?.type !== "object_reference" ||
        typeof definition.objectType !== "string"
      ) {
        return undefined;
      }
      return {
        source: "resolvedObjectProperty",
        objectType: definition.objectType,
        primaryKey: reference,
        path: String(source.path ?? ""),
      };
    }
    default:
      return undefined;
  }
}
