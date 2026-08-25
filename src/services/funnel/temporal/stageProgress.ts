// ---------------------------------------------------------------------------
// src/services/funnel/temporal/stageProgress.ts
//
// Progress-COUPLED liveness for funnel activities.
//
// WHY THIS EXISTS — 2026-08-16 incident. Every funnel activity was wrapped in
// a free-running 5s heartbeat timer:
//
//     const tick = () => { Context.current().heartbeat(); setTimeout(tick, 5000) }
//
// A timer proves the *process* is alive. It proves nothing about the *activity*.
// When the merge stage deadlocked on a never-settling Redis connect, the timer
// kept beating, so `heartbeatTimeout: "120s"` could never fire: Temporal saw
// LastHeartbeatTime 56s ago on an activity that had been wedged for three days.
// The stage sat on "Merge changes" until a human noticed. The 120s heartbeat
// timeout — the single mechanism designed to catch exactly this — was inert by
// construction, and would have stayed inert for ANY future deadlock: a blocked
// PG query, a hung S3 read, a DuckDB spin.
//
// THE FIX — heartbeats must be evidence of forward progress, not of a live
// event loop. An activity that opts in by calling `reportStageProgress()` gets:
//
//   * a heartbeat on each tick while progress advanced recently, and
//   * SILENCE once no progress has been reported for STALL_AFTER_MS.
//
// The silence is the point: it lets Temporal's heartbeatTimeout expire, fail the
// attempt, and retry it on a healthy worker.
//
// COMPATIBILITY / BLAST-RADIUS CONTROL — an activity that never reports
// progress keeps the old unconditional-heartbeat behaviour. Stall detection
// arms itself only after the FIRST progress report. This is deliberate: making
// silence the default would time out every not-yet-instrumented stage, trading
// a rare deadlock for guaranteed breakage. Coverage grows as stages adopt
// `reportStageProgress()`; the merge PG tail and the changelog reader (the two
// long tails, and the ones that actually hung) are instrumented today.
//
// AsyncLocalStorage, not a module global: a Temporal worker runs many
// activities concurrently in one process, so progress must be attributed to the
// activity that reported it.
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from "node:async_hooks";

export interface StageProgressState {
  /** Epoch ms of the most recent reportStageProgress() call. */
  lastProgressAt: number;
  /** Monotonic count of progress reports (observability / tests). */
  reports: number;
  /** Free-text marker of the last reported step, surfaced in the stall log. */
  lastMarker: string;
}

const storage = new AsyncLocalStorage<StageProgressState>();

/** Grace period after the last progress report before we stop heartbeating. */
export function stallAfterMs(): number {
  const raw = Number(process.env.FUNNEL_STAGE_STALL_AFTER_MS ?? 60_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/**
 * Signal that the current activity made forward progress. Cheap by design
 * (two field writes) so it can sit inside a per-batch loop. A no-op when
 * called outside a tracked stage.
 */
export function reportStageProgress(marker = ""): void {
  const state = storage.getStore();
  if (!state) return;
  state.lastProgressAt = Date.now();
  state.reports += 1;
  if (marker) state.lastMarker = marker;
}

/** Run `fn` with a fresh progress state, exposing that state to the caller. */
export function runWithStageProgress<T>(
  fn: () => Promise<T>,
  onState: (state: StageProgressState) => void,
): Promise<T> {
  const state: StageProgressState = {
    lastProgressAt: Date.now(),
    reports: 0,
    lastMarker: "",
  };
  onState(state);
  return storage.run(state, fn);
}

/**
 * Decide whether to emit a heartbeat now. Pure — the whole point is that this
 * predicate is unit-testable without a Temporal worker.
 *
 * Returns `true` (heartbeat) when the stage has never reported progress
 * (back-compat), or when the last report is within the stall window.
 * Returns `false` (stay silent, let heartbeatTimeout fire) when an
 * instrumented stage has gone quiet for longer than the stall window.
 */
export function shouldHeartbeat(
  state: StageProgressState,
  now: number,
  stallMs: number = stallAfterMs(),
): boolean {
  if (state.reports === 0) return true;
  return now - state.lastProgressAt < stallMs;
}
