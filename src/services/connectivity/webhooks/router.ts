// ---------------------------------------------------------------------------
// F9 — Webhook execution routing layer.
//
// Single classification seam for the three webhook systems documented in
// docs/data-connection/webhook-systems.md. Callers that need to execute a
// webhook ref (writeback, side-effect worker) SHOULD route through
// `dispatchWebhookRef` so the canonical System A path is the only
// non-deprecated execution route.
//
// Routing rule:
//   - ref starts with `ri.magritte.main.webhook.` → System A
//     (connectivity `executeWebhook`).
//   - anything else → legacy System B/C path. A deprecation warning is
//     emitted on every legacy dispatch so operators can track the remaining
//     legacy footprint and plan migration. The router does NOT rewrite a
//     legacy binding into a connectivity binding (that would change
//     authentication semantics); it only classifies + warns + delegates.
//
// NOTE: `isConnectivityWebhookRef` is also exported from
// `src/actions/writebackExecutor.ts` (the original definition site). It is
// redefined here to keep this module free of a circular import with the
// writeback executor (which imports `warnLegacyWebhookDispatch` from here).
// ---------------------------------------------------------------------------

const CONNECTIVITY_WEBHOOK_RID_PREFIX = "ri.magritte.main.webhook.";

export function isConnectivityWebhookRef(webhookId: string): boolean {
  return webhookId.startsWith(CONNECTIVITY_WEBHOOK_RID_PREFIX);
}

export type WebhookSystem = "connectivity" | "legacy-registry" | "legacy-inline-url";

let legacyDeprecationEmitted = 0;

/**
 * Classify a webhook reference into the system that owns its execution.
 * `ri.magritte.main.webhook.*` → System A; anything else → a legacy system.
 */
export function classifyWebhookRef(webhookId: string): WebhookSystem {
  if (isConnectivityWebhookRef(webhookId)) return "connectivity";
  // The legacy registry (System B) and inline-URL (System C) are not
  // distinguishable by ref alone — both accept a free-form name/URL. The
  // caller knows which it is; the router treats both as "legacy" for the
  // deprecation warning.
  return "legacy-registry";
}

/**
 * Emit a one-line deprecation warning for a legacy webhook dispatch. Safe to
 * call on every dispatch — the counter is exposed for operator dashboards.
 * Returns the warning text for structured logging.
 */
export function warnLegacyWebhookDispatch(
  webhookId: string,
  caller: string,
): string {
  legacyDeprecationEmitted += 1;
  const message =
    `[F9 deprecation] ${caller} dispatched a LEGACY webhook ref ` +
    `'${webhookId}' (not a connectivity RID). Legacy webhook systems ` +
    `(B: webhook_definition registry, C: inline-URL writeback) are ` +
    `deprecated; bind a connectivity webhook RID ` +
    `('ri.magritte.main.webhook.<uuid>') instead. ` +
    `See docs/data-connection/webhook-systems.md.`;
  // eslint-disable-next-line no-console
  console.warn(message);
  return message;
}

/** Test/ops helper: count of legacy deprecation warnings emitted by this process. */
export function legacyWebhookDeprecationCount(): number {
  return legacyDeprecationEmitted;
}
