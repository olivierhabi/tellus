// ---------------------------------------------------------------------------
// Funnel stage pacing — dev/demo UX knob
//
// Controls an OPTIONAL artificial delay inserted at the start of each
// funnel stage activity (changelog, merge, indexing, hydration). The
// purpose is purely UX: sub-second dev pipelines otherwise flash every
// node in the WorkflowDiagram green before the browser can paint a
// single "running" frame. With `FUNNEL_STAGE_DELAY_MS=5000`, each
// stage spends ~5 s in the "running" state so the user can see the
// pipeline advance.
//
// Contract:
//   * Default is **0** — production MUST stay fast. Add the env var
//     only in dev/staging / demo environments.
//   * Read once at module-load. A caller changing the env at runtime
//     will not see the new value until the Node process restarts.
//     This is intentional — we never want a runtime knob to
//     unpredictably slow the pipeline mid-flight.
//   * Non-numeric / negative values coerce to 0 so a mistyped env
//     cannot stall a production pipeline by many seconds.
//   * Applied to BOTH the PG dispatcher path and the Temporal activity
//     path so the toggle works regardless of which worker is live.
// ---------------------------------------------------------------------------

const RAW = process.env.FUNNEL_STAGE_DELAY_MS ?? "0";
const PARSED = Number(RAW);
export const FUNNEL_STAGE_DELAY_MS: number =
  Number.isFinite(PARSED) && PARSED > 0 ? Math.floor(PARSED) : 0;

/**
 * Sleep for the configured stage delay. Resolves immediately (no
 * scheduler hop, no microtask work) when the delay is 0 so the
 * production default adds zero observable latency.
 */
export function sleepForStageDelay(): Promise<void> {
  if (FUNNEL_STAGE_DELAY_MS <= 0) return Promise.resolve();
  return new Promise<void>((resolve) =>
    setTimeout(resolve, FUNNEL_STAGE_DELAY_MS),
  );
}

/**
 * Stage-scope receipts (FUNN-ISO-7 multi-replica attribution): when
 * FUNNEL_STAGE_RECEIPT_FILE is set, every stage start writes one JSONL line
 * `{stage, label, pid}` to that file. Which PROCESS executed which stage is
 * otherwise invisible in Temporal's history (workflow task events carry the
 * identity but activity events do not) — receipts close that attribution
 * hole for replica tests. Receipts are ALSO useful to the failure-injection
 * matrix (they prove WHICH stage was interrupted).
 */
export const FUNNEL_STAGE_RECEIPT_FILE: string | undefined =
  process.env.FUNNEL_STAGE_RECEIPT_FILE?.trim() || undefined;
export const FUNNEL_STAGE_RECEIPT_LABEL: string =
  process.env.FUNNEL_STAGE_RECEIPT_LABEL?.trim() || `pid-${process.pid}`;

export function writeStageReceipt(stage: string): void {
  if (!FUNNEL_STAGE_RECEIPT_FILE) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs") as typeof import("fs");
    fs.appendFileSync(
      FUNNEL_STAGE_RECEIPT_FILE,
      JSON.stringify({
        stage,
        label: FUNNEL_STAGE_RECEIPT_LABEL,
        pid: process.pid,
        at: new Date().toISOString(),
      }) + "\n",
    );
  } catch {
    /* receipt writes are observability, never pipeline semantics */
  }
}
