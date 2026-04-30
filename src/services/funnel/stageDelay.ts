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
