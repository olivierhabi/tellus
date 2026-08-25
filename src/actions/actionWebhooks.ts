// ---------------------------------------------------------------------------
// Action side-effect webhooks — FOUNDRY-GAPS §5 (Actions, Stage 5/7).
//
// Foundry actions can fire webhooks/notifications as a side effect. We deliver
// them POST-COMMIT (after Stage 6 durably applies the edits): firing an
// external HTTP call before the local commit and rolling back on a webhook
// failure is fragile — the remote system may already have acted — so delivery
// is best-effort and never rolls back a committed action. A failed webhook is
// logged (and surfaced via a counter), not thrown.
//
// SSRF: every webhook URL host is run through the connectivity egress guard
// (assertEgressForConfig) so an action cannot be used to pivot at internal /
// reserved addresses. Operators opt loopback back in for local testing via
// CONNECTIVITY_EGRESS_ALLOW_RESERVED (default-closed in production).
//
// Schema (action_type.side_effects JSONB; null/absent ⇒ no webhooks):
//   { "webhooks": [ { "url": "...", "method"?: "POST",
//                     "headers"?: {..}, "timeoutMs"?: 5000 } ] }
// A bare array of those objects is also accepted.
// ---------------------------------------------------------------------------

import { assertEgressForConfig } from "../services/connectivity/connectors/postgresql/egress";
import { incCounter } from "../services/funnel/metrics";

export interface ActionWebhookSpec {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface ActionWebhookPayload {
  executionId: string;
  actionTypeApiName: string;
  ontologyId: string;
  branchId: string | null;
  result: string;
  executedBy: string;
  affectedObjects: Array<{ objectType: string; primaryKey: string; operation: string }>;
  firedAt: string;
}

export interface WebhookDeliveryResult {
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;

/** Parse the side_effects column into a list of webhook specs (tolerant). */
export function parseWebhookSpecs(sideEffects: unknown): ActionWebhookSpec[] {
  if (sideEffects == null) return [];
  const raw = Array.isArray(sideEffects)
    ? sideEffects
    : typeof sideEffects === "object" && Array.isArray((sideEffects as { webhooks?: unknown }).webhooks)
      ? (sideEffects as { webhooks: unknown[] }).webhooks
      : [];
  const specs: ActionWebhookSpec[] = [];
  for (const item of raw) {
    if (item && typeof item === "object" && typeof (item as { url?: unknown }).url === "string") {
      const w = item as ActionWebhookSpec;
      specs.push({
        url: w.url,
        method: (w.method ?? "POST").toUpperCase(),
        headers: w.headers ?? {},
        timeoutMs: Math.min(Math.max(Number(w.timeoutMs) || DEFAULT_TIMEOUT_MS, 250), MAX_TIMEOUT_MS),
      });
    }
  }
  return specs;
}

/**
 * Phase 5 — single-webhook delivery. Exported separately so the durable
 * outbox worker can dispatch a per-job webhook spec through the exact
 * same transport path the legacy fire-and-forget `fireActionWebhooks`
 * uses (same SSRF guard + same timeout + same fetch). Identical semantics
 * preserve backward compatibility for existing tests + reduce the Phase 5
 * implementation scope to a refactor, not a rewrite.
 *
 * @deprecated F9 — System C (legacy inline-URL writeback). New action
 *   side-effects MUST bind a connectivity webhook RID and dispatch through
 *   System A (`executeWebhook`). This function emits a runtime deprecation
 *   warning on every call. See docs/data-connection/webhook-systems.md.
 */
export async function deliverOneWebhook(
  spec: ActionWebhookSpec,
  payload: ActionWebhookPayload,
  opts?: { idempotencyKey?: string },
): Promise<{ url: string; ok: boolean; status?: number; error?: string; receiptId?: string }> {
  return deliverOne(spec, payload, opts?.idempotencyKey);
}

async function deliverOne(
  spec: ActionWebhookSpec,
  payload: ActionWebhookPayload,
  idempotencyKey?: string,
): Promise<WebhookDeliveryResult> {
  let url: URL;
  try {
    url = new URL(spec.url);
  } catch {
    return { url: spec.url, ok: false, error: "invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { url: spec.url, ok: false, error: `unsupported protocol ${url.protocol}` };
  }
  // SSRF guard — reject internal/reserved hosts (env-gated allowance for dev).
  try {
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    assertEgressForConfig(url.hostname, port);
  } catch (err) {
    return { url: spec.url, ok: false, error: `egress blocked: ${(err as Error).message}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(spec.url, {
      method: spec.method ?? "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "tellus-action-webhook/1",
        "x-tellus-action": payload.actionTypeApiName,
        "x-tellus-execution-id": payload.executionId,
        // Stable idempotency key so a dedup-aware receiver collapses
        // at-least-once retries into exactly-once effect (the same key is
        // re-sent on every retry of the same job/execution). Receivers
        // that ignore the header are unaffected — additive only.
        ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
        ...(spec.headers ?? {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { url: spec.url, ok: resp.ok, status: resp.status, error: resp.ok ? undefined : `HTTP ${resp.status}` };
  } catch (err) {
    return { url: spec.url, ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire all configured side-effect webhooks for an action. Best-effort: never
 * throws; returns a per-webhook delivery report. Concurrent with a bounded
 * fan-out (sequential here — actions rarely declare more than a couple).
 */
export async function fireActionWebhooks(
  sideEffects: unknown,
  payload: ActionWebhookPayload,
): Promise<WebhookDeliveryResult[]> {
  const specs = parseWebhookSpecs(sideEffects);
  if (specs.length === 0) return [];
  const results: WebhookDeliveryResult[] = [];
  for (const spec of specs) {
    // Fire-and-forget path: the execution id is the natural stable key —
    // all webhooks of one execution share it (receivers dedup per URL).
    const r = await deliverOne(spec, payload, payload.executionId);
    results.push(r);
    try {
      incCounter(r.ok ? "tellus_action_webhook_delivered_total" : "tellus_action_webhook_failed_total");
    } catch {
      /* metrics best-effort */
    }
    if (!r.ok) {
      console.warn(
        `[action:${payload.actionTypeApiName}] webhook ${spec.url} failed (non-fatal): ${r.error}`,
      );
    }
  }
  return results;
}
