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

  // Webhook fanouts — one row per webhook spec.
  const webhookSpecs = Array.isArray(se.webhooks) ? (se.webhooks as Array<Record<string, unknown>>) : [];
  for (let i = 0; i < webhookSpecs.length; i++) {
    const spec = webhookSpecs[i];
    if (!spec || typeof spec !== "object") continue;
    out.push({
      kind: "webhook",
      // The payload is the spec + the runtime execution context — the
      // worker's dispatch function consumes both.
      payload: {
        spec,
        context: executionContext,
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
          context: executionContext,
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
  result: string;
  affectedObjects: Array<{ objectType: string; primaryKey: string; operation: string }>;
  firedAt: string;
}
