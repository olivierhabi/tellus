// ---------------------------------------------------------------------------
// src/metrics/eventLoopLag.ts
//
// F-P4-13 observability — event-loop lag gauge.
//
// Tellus runs DuckDB as an in-process native binding that blocks the Node
// event loop during execution. A 200 ms aggregation freezes every other
// in-flight request for 200 ms, shifting p99 latency above the 250 ms SLO.
//
// This module measures event-loop lag and emits:
//   - tellus_event_loop_lag_ms (gauge) — current sample
//   - tellus_event_loop_lag_ms_max (gauge) — peak since last emit
//
// Technique: setInterval at 1 s cadence. When the callback fires, we
// compare `actual elapsed` (process.hrtime) against `scheduled elapsed`
// (1000 ms). The difference IS the event-loop lag at that moment.
// Healthy systems see < 10 ms. A native-module freeze shows as a
// multi-hundred ms spike at the end of the freeze.
//
// Alert rule in ops/prometheus/alerts/:
//   - warning if p99 > 50 ms over 5 minutes
//   - critical if p99 > 200 ms over 1 minute
// ---------------------------------------------------------------------------

import { setGauge } from "../services/funnel/metrics";

const SAMPLE_INTERVAL_MS = 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let lastTick: bigint | null = null;
let peakLagMs = 0;

function tick(): void {
  const now = process.hrtime.bigint();
  if (lastTick === null) {
    lastTick = now;
    return;
  }
  const elapsedMs = Number(now - lastTick) / 1_000_000;
  const lagMs = Math.max(0, elapsedMs - SAMPLE_INTERVAL_MS);
  lastTick = now;
  if (lagMs > peakLagMs) peakLagMs = lagMs;
  try {
    setGauge("tellus_event_loop_lag_ms", lagMs, {});
    setGauge("tellus_event_loop_lag_ms_max", peakLagMs, {});
  } catch {
    // metrics subsystem may not be ready — silent
  }
}

/**
 * Start the lag sampler. Idempotent — no-op on repeat call.
 * Called from src/server.ts during boot.
 */
export function startEventLoopLagMonitor(): void {
  if (timer !== null) return;
  lastTick = process.hrtime.bigint();
  timer = setInterval(tick, SAMPLE_INTERVAL_MS);
  // Do not block process exit on this timer.
  if (typeof timer.unref === "function") timer.unref();
}

/** Stop the sampler. For tests and graceful shutdown. */
export function stopEventLoopLagMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
  lastTick = null;
}

/** Reset the rolling peak. Callers should drain it periodically so the
 * gauge does not pin at the all-time high. */
export function resetEventLoopLagPeak(): void {
  peakLagMs = 0;
}
