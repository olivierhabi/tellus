// ---------------------------------------------------------------------------
// Webhook execution reaper (F2 fix).
//
// A process death mid-execution leaves rows in connectivity_webhook_execution
// stuck in 'queued' or 'running' forever. The idempotency replay then returns
// a stale non-terminal result, and per-webhook concurrency limits leak
// capacity. This worker periodically sweeps stale executions and marks them
// 'failed' with error_code='ORPHANED' so history is accurate, replays return a
// terminal result, and capacity is released.
//
// Lifecycle mirrors the credential rotation + health prober workers: a guarded
// setInterval that unrefs (so it never holds the event loop open), an opt-out
// env var, and a first sweep on boot. Reaping is best-effort.
// ---------------------------------------------------------------------------

import { reapOrphanedExecutions } from "./repository";

let timer: NodeJS.Timeout | null = null;

/** Default poll interval — 5 minutes. */
const POLL_MS = Number(
  process.env.TELLUS_WEBHOOK_REAPER_POLL_MS ?? 5 * 60_000,
);

/** An execution older than this in queued/running is presumed orphaned. */
const STALE_AFTER_MS = Number(
  process.env.TELLUS_WEBHOOK_REAPER_STALE_MS ?? 5 * 60_000,
);

export function startWebhookReaper(): void {
  if (process.env.TELLUS_DISABLE_WEBHOOK_REAPER === "1") return;
  if (timer) return;
  timer = setInterval(() => {
    void reapOrphanedExecutions(STALE_AFTER_MS).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[connectivity.webhooks.reaper] tick failed", err);
    });
  }, POLL_MS);
  // setInterval keeps the loop alive otherwise; the reaper is background-only.
  timer.unref?.();
  // First sweep on boot so a freshly-restarted process recovers orphans from
  // the previous incarnation.
  void reapOrphanedExecutions(STALE_AFTER_MS).catch(() => undefined);
}

export function stopWebhookReaper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
