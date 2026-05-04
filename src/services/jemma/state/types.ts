// ---------------------------------------------------------------------------
// B6 — Jemma run state-machine types.
//
// Spec §B6: state ∈ {QUEUED, RUNNING, SUCCEEDED, FAILED, CANCELLED, TIMED_OUT}.
// Forward path: QUEUED → RUNNING → {SUCCEEDED|FAILED|CANCELLED|TIMED_OUT}.
//
// Terminal states (4): SUCCEEDED, FAILED, CANCELLED, TIMED_OUT.
// Active states  (2):  QUEUED, RUNNING.
//
// Stages (in order): setup, lint, test, build, publish.
// On failure of a non-publish stage, subsequent stages are skipped and the
// run is FAILED.
// ---------------------------------------------------------------------------

export const RUN_STATES = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const ACTIVE_STATES: ReadonlySet<RunState> = new Set(["QUEUED", "RUNNING"]);
export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

export const RUN_TRIGGERS = ["PUSH", "PR", "TAG", "MANUAL"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const STAGE_NAMES = [
  "setup",
  "lint",
  "test",
  "build",
  "publish",
] as const;

export type StageName = (typeof STAGE_NAMES)[number];

export const STAGE_STATES = [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
] as const;

export type StageState = (typeof STAGE_STATES)[number];

/**
 * Failure-reason classifier. Used as `failure_reason` column on jemma_run when
 * state ∈ {FAILED, TIMED_OUT}. The string is human-friendly + structured for
 * UI banner messaging (per spec §B6 edge cases).
 */
export type FailureReason =
  | "stage-failed"
  | "OOM"
  | "stemma-unreachable"
  | "image-unavailable"
  | "timeout-run"
  | "timeout-stage"
  | "cancelled-by-user"
  | "cancelled-by-newer-push"
  | "internal-error";

/**
 * Events that drive the run state machine. The state machine is the single
 * authority on whether a transition is legal.
 */
export type RunEvent =
  // Scheduler signals.
  | { kind: "scheduler-picked"; podName: string; nowIso: string }

  // Worker pod signals.
  | { kind: "stage-started"; stage: StageName; nowIso: string }
  | { kind: "stage-succeeded"; stage: StageName; nowIso: string }
  | { kind: "stage-failed"; stage: StageName; reason: FailureReason; nowIso: string }
  | { kind: "all-stages-succeeded"; nowIso: string }

  // Operator / user / scheduler signals.
  | { kind: "cancel"; reason: "cancelled-by-user" | "cancelled-by-newer-push"; nowIso: string }
  | { kind: "timeout"; scope: "run" | "stage"; nowIso: string }
  | { kind: "image-unavailable"; nowIso: string };

/**
 * The run snapshot the state machine operates on. Mirrors the persisted shape
 * minus repository_rid / commit_sha / etc. (those don't affect transitions).
 */
export interface RunContext {
  readonly state: RunState;
  readonly podName: string | null;
  readonly currentStage: StageName | null;
  readonly stages: ReadonlyArray<{
    readonly name: StageName;
    readonly state: StageState;
  }>;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly failureReason: FailureReason | null;
}

/**
 * Outcome of `transition()`. The `nextContext` is the *fully patched* context;
 * callers persist it as-is. `terminal` is true iff the next state is terminal.
 */
export interface TransitionResult {
  readonly nextContext: RunContext;
  readonly terminal: boolean;
}

export class IllegalRunTransition extends Error {
  readonly code: "ILLEGAL_RUN_TRANSITION";
  readonly fromState: RunState;
  readonly event: RunEvent["kind"];
  constructor(fromState: RunState, event: RunEvent["kind"], detail: string) {
    super(`Illegal run transition: ${fromState} + ${event} (${detail})`);
    this.code = "ILLEGAL_RUN_TRANSITION";
    this.fromState = fromState;
    this.event = event;
    this.name = "IllegalRunTransition";
  }
}
