// ---------------------------------------------------------------------------
// B6 — Jemma run pure state machine.
//
// `transition(ctx, event)` is the single authority on legal transitions.
// Total over `(RunState, RunEvent.kind)` — every illegal pair throws
// IllegalRunTransition with a deterministic detail string.
//
// Side-effect-free: produces a fully-patched RunContext + a terminal flag.
// Callers persist `result.nextContext` as-is.
// ---------------------------------------------------------------------------

import {
  ACTIVE_STATES,
  IllegalRunTransition,
  STAGE_NAMES,
  TERMINAL_STATES,
  type FailureReason,
  type RunContext,
  type RunEvent,
  type RunState,
  type StageName,
  type TransitionResult,
} from "./types";

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function illegal(state: RunState, ev: RunEvent, detail: string): never {
  throw new IllegalRunTransition(state, ev.kind, detail);
}

function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

function nextStageAfter(stage: StageName): StageName | null {
  const idx = STAGE_NAMES.indexOf(stage);
  if (idx < 0 || idx === STAGE_NAMES.length - 1) return null;
  return STAGE_NAMES[idx + 1];
}

function setStageState(
  ctx: RunContext,
  stage: StageName,
  newState: "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED",
): RunContext["stages"] {
  return ctx.stages.map((s) => (s.name === stage ? { ...s, state: newState } : s));
}

/**
 * Mark all not-yet-terminal stages after `stage` as SKIPPED. Used on stage
 * failure (non-publish) per spec §B6: "On failure of a non-`publish` stage,
 * subsequent stages are skipped and the run is FAILED."
 */
function skipSubsequentStages(
  ctx: RunContext,
  stage: StageName,
): RunContext["stages"] {
  const startIdx = STAGE_NAMES.indexOf(stage);
  return ctx.stages.map((s) => {
    const idx = STAGE_NAMES.indexOf(s.name);
    if (idx > startIdx && s.state === "PENDING") {
      return { ...s, state: "SKIPPED" as const };
    }
    return s;
  });
}

// ---------------------------------------------------------------------------
// Transition.
// ---------------------------------------------------------------------------

/**
 * Pure state-machine transition. Caller-immutable input + caller-immutable
 * output. The state machine is total — every (state, event.kind) pair is
 * either an explicit transition or an explicit `illegal()` throw.
 */
export function transition(ctx: RunContext, event: RunEvent): TransitionResult {
  // Terminal states absorb nothing.
  if (isTerminal(ctx.state)) {
    illegal(ctx.state, event, "terminal state absorbs all events");
  }

  switch (event.kind) {
    case "scheduler-picked": {
      if (ctx.state !== "QUEUED") {
        illegal(ctx.state, event, "scheduler-picked only legal from QUEUED");
      }
      return {
        nextContext: {
          ...ctx,
          state: "RUNNING",
          podName: event.podName,
          startedAt: event.nowIso,
        },
        terminal: false,
      };
    }

    case "image-unavailable": {
      if (ctx.state !== "QUEUED") {
        illegal(ctx.state, event, "image-unavailable only legal from QUEUED");
      }
      return {
        nextContext: {
          ...ctx,
          state: "FAILED",
          finishedAt: event.nowIso,
          failureReason: "image-unavailable",
        },
        terminal: true,
      };
    }

    case "stage-started": {
      if (ctx.state !== "RUNNING") {
        illegal(ctx.state, event, "stage-started only legal from RUNNING");
      }
      // Optional invariant: stage must be the next PENDING stage in order.
      const stageRow = ctx.stages.find((s) => s.name === event.stage);
      if (!stageRow) {
        illegal(ctx.state, event, `unknown stage ${event.stage}`);
      }
      if (stageRow.state !== "PENDING") {
        illegal(
          ctx.state,
          event,
          `stage ${event.stage} not PENDING (current=${stageRow.state})`,
        );
      }
      return {
        nextContext: {
          ...ctx,
          currentStage: event.stage,
          stages: setStageState(ctx, event.stage, "RUNNING"),
        },
        terminal: false,
      };
    }

    case "stage-succeeded": {
      if (ctx.state !== "RUNNING") {
        illegal(ctx.state, event, "stage-succeeded only legal from RUNNING");
      }
      const stageRow = ctx.stages.find((s) => s.name === event.stage);
      if (!stageRow) {
        illegal(ctx.state, event, `unknown stage ${event.stage}`);
      }
      if (stageRow.state !== "RUNNING") {
        illegal(
          ctx.state,
          event,
          `stage ${event.stage} not RUNNING (current=${stageRow.state})`,
        );
      }
      const next = nextStageAfter(event.stage);
      return {
        nextContext: {
          ...ctx,
          currentStage: next,
          stages: setStageState(ctx, event.stage, "SUCCEEDED"),
        },
        terminal: false,
      };
    }

    case "stage-failed": {
      if (ctx.state !== "RUNNING") {
        illegal(ctx.state, event, "stage-failed only legal from RUNNING");
      }
      const stageRow = ctx.stages.find((s) => s.name === event.stage);
      if (!stageRow) {
        illegal(ctx.state, event, `unknown stage ${event.stage}`);
      }
      if (stageRow.state !== "RUNNING") {
        illegal(
          ctx.state,
          event,
          `stage ${event.stage} not RUNNING (current=${stageRow.state})`,
        );
      }
      // Mark the failing stage FAILED; SKIP all subsequent PENDING stages.
      let stages = setStageState(ctx, event.stage, "FAILED");
      stages = skipSubsequentStagesFromArray(stages, event.stage);
      return {
        nextContext: {
          ...ctx,
          state: "FAILED",
          currentStage: null,
          stages,
          finishedAt: event.nowIso,
          failureReason: event.reason,
        },
        terminal: true,
      };
    }

    case "all-stages-succeeded": {
      if (ctx.state !== "RUNNING") {
        illegal(ctx.state, event, "all-stages-succeeded only legal from RUNNING");
      }
      // Invariant: every stage must be SUCCEEDED.
      const notDone = ctx.stages.find((s) => s.state !== "SUCCEEDED");
      if (notDone) {
        illegal(
          ctx.state,
          event,
          `stage ${notDone.name} not SUCCEEDED (current=${notDone.state})`,
        );
      }
      return {
        nextContext: {
          ...ctx,
          state: "SUCCEEDED",
          currentStage: null,
          finishedAt: event.nowIso,
        },
        terminal: true,
      };
    }

    case "cancel": {
      if (!ACTIVE_STATES.has(ctx.state)) {
        illegal(ctx.state, event, "cancel only legal from QUEUED|RUNNING");
      }
      // SKIP all PENDING + RUNNING stages.
      const stages = ctx.stages.map((s) =>
        s.state === "PENDING" || s.state === "RUNNING"
          ? { ...s, state: "SKIPPED" as const }
          : s,
      );
      return {
        nextContext: {
          ...ctx,
          state: "CANCELLED",
          currentStage: null,
          stages,
          finishedAt: event.nowIso,
          failureReason: event.reason,
        },
        terminal: true,
      };
    }

    case "timeout": {
      if (!ACTIVE_STATES.has(ctx.state)) {
        illegal(ctx.state, event, "timeout only legal from QUEUED|RUNNING");
      }
      const stages = ctx.stages.map((s) =>
        s.state === "PENDING" || s.state === "RUNNING"
          ? { ...s, state: "SKIPPED" as const }
          : s,
      );
      const reason: FailureReason =
        event.scope === "run" ? "timeout-run" : "timeout-stage";
      return {
        nextContext: {
          ...ctx,
          state: "TIMED_OUT",
          currentStage: null,
          stages,
          finishedAt: event.nowIso,
          failureReason: reason,
        },
        terminal: true,
      };
    }

    default: {
      // Exhaustiveness check.
      const _: never = event;
      throw new Error(`unreachable: unknown event ${JSON.stringify(_)}`);
    }
  }
}

function skipSubsequentStagesFromArray(
  stages: RunContext["stages"],
  stage: StageName,
): RunContext["stages"] {
  const startIdx = STAGE_NAMES.indexOf(stage);
  return stages.map((s) => {
    const idx = STAGE_NAMES.indexOf(s.name);
    if (idx > startIdx && s.state === "PENDING") {
      return { ...s, state: "SKIPPED" as const };
    }
    return s;
  });
}

/**
 * Helper: build a fresh QUEUED context with all stages PENDING. Used by the
 * route layer + tests.
 */
export function makeQueuedContext(nowIso: string): RunContext {
  return {
    state: "QUEUED",
    podName: null,
    currentStage: null,
    stages: STAGE_NAMES.map((name) => ({ name, state: "PENDING" as const })),
    queuedAt: nowIso,
    startedAt: null,
    finishedAt: null,
    failureReason: null,
  };
}
