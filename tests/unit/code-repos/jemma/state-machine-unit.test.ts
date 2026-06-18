// ---------------------------------------------------------------------------
// B6 — Jemma run state machine unit tests.
//
// Covers every transition + every illegal pair. The state machine is total:
// any (state, event.kind) combination not explicitly tested as legal must
// throw IllegalRunTransition.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  IllegalRunTransition,
  STAGE_NAMES,
  TERMINAL_STATES,
  type RunContext,
  type RunEvent,
  type RunState,
} from "../../../../src/services/jemma/state/types";
import {
  makeQueuedContext,
  transition,
} from "../../../../src/services/jemma/state/stateMachine";

const T0 = "2026-05-01T00:00:00.000Z";
const T1 = "2026-05-01T00:00:01.000Z";
const T2 = "2026-05-01T00:00:02.000Z";

function queued(): RunContext {
  return makeQueuedContext(T0);
}

function running(): RunContext {
  const r = transition(queued(), {
    kind: "scheduler-picked",
    podName: "pod-abc",
    nowIso: T0,
  });
  return r.nextContext;
}

function runningWithStage(stage: (typeof STAGE_NAMES)[number]): RunContext {
  let ctx = running();
  for (const s of STAGE_NAMES) {
    if (s === stage) {
      ctx = transition(ctx, { kind: "stage-started", stage: s, nowIso: T0 }).nextContext;
      return ctx;
    }
    ctx = transition(ctx, { kind: "stage-started", stage: s, nowIso: T0 }).nextContext;
    ctx = transition(ctx, { kind: "stage-succeeded", stage: s, nowIso: T0 }).nextContext;
  }
  return ctx;
}

describe("Jemma state machine — happy path", () => {
  it("makeQueuedContext: state=QUEUED, all stages PENDING, podName null", () => {
    const ctx = queued();
    expect(ctx.state).toBe("QUEUED");
    expect(ctx.podName).toBeNull();
    expect(ctx.startedAt).toBeNull();
    expect(ctx.finishedAt).toBeNull();
    expect(ctx.stages.map((s) => s.state)).toEqual([
      "PENDING",
      "PENDING",
      "PENDING",
      "PENDING",
      "PENDING",
    ]);
    expect(ctx.stages.map((s) => s.name)).toEqual([
      "setup",
      "lint",
      "test",
      "build",
      "publish",
    ]);
  });

  it("scheduler-picked QUEUED→RUNNING; sets podName + startedAt", () => {
    const r = transition(queued(), {
      kind: "scheduler-picked",
      podName: "pod-xyz",
      nowIso: T1,
    });
    expect(r.terminal).toBe(false);
    expect(r.nextContext.state).toBe("RUNNING");
    expect(r.nextContext.podName).toBe("pod-xyz");
    expect(r.nextContext.startedAt).toBe(T1);
  });

  it("full SUCCEEDED path: 5 stages × (start, succeed) → all-stages-succeeded", () => {
    let ctx = running();
    for (const s of STAGE_NAMES) {
      ctx = transition(ctx, { kind: "stage-started", stage: s, nowIso: T0 }).nextContext;
      expect(ctx.currentStage).toBe(s);
      expect(ctx.stages.find((x) => x.name === s)?.state).toBe("RUNNING");
      ctx = transition(ctx, { kind: "stage-succeeded", stage: s, nowIso: T0 }).nextContext;
      expect(ctx.stages.find((x) => x.name === s)?.state).toBe("SUCCEEDED");
    }
    const r = transition(ctx, { kind: "all-stages-succeeded", nowIso: T2 });
    expect(r.terminal).toBe(true);
    expect(r.nextContext.state).toBe("SUCCEEDED");
    expect(r.nextContext.finishedAt).toBe(T2);
    expect(r.nextContext.currentStage).toBeNull();
  });

  it("stage-failed (non-publish) → FAILED; subsequent stages SKIPPED", () => {
    let ctx = runningWithStage("test");
    const r = transition(ctx, {
      kind: "stage-failed",
      stage: "test",
      reason: "stage-failed",
      nowIso: T2,
    });
    expect(r.terminal).toBe(true);
    expect(r.nextContext.state).toBe("FAILED");
    expect(r.nextContext.failureReason).toBe("stage-failed");
    const stagesByName = Object.fromEntries(r.nextContext.stages.map((s) => [s.name, s.state]));
    expect(stagesByName.setup).toBe("SUCCEEDED");
    expect(stagesByName.lint).toBe("SUCCEEDED");
    expect(stagesByName.test).toBe("FAILED");
    expect(stagesByName.build).toBe("SKIPPED");
    expect(stagesByName.publish).toBe("SKIPPED");
  });

  it("stage-failed on publish → FAILED; no subsequent stages to skip", () => {
    let ctx = runningWithStage("publish");
    const r = transition(ctx, {
      kind: "stage-failed",
      stage: "publish",
      reason: "stage-failed",
      nowIso: T2,
    });
    expect(r.nextContext.state).toBe("FAILED");
    const stagesByName = Object.fromEntries(r.nextContext.stages.map((s) => [s.name, s.state]));
    expect(stagesByName.publish).toBe("FAILED");
  });
});

describe("Jemma state machine — cancel + timeout + image-unavailable", () => {
  it("cancel from QUEUED → CANCELLED; all stages SKIPPED", () => {
    const r = transition(queued(), {
      kind: "cancel",
      reason: "cancelled-by-user",
      nowIso: T1,
    });
    expect(r.terminal).toBe(true);
    expect(r.nextContext.state).toBe("CANCELLED");
    expect(r.nextContext.failureReason).toBe("cancelled-by-user");
    expect(r.nextContext.stages.every((s) => s.state === "SKIPPED")).toBe(true);
  });

  it("cancel from RUNNING (mid-stage) → CANCELLED; running stage marked SKIPPED", () => {
    const ctx = runningWithStage("test");
    const r = transition(ctx, {
      kind: "cancel",
      reason: "cancelled-by-newer-push",
      nowIso: T2,
    });
    expect(r.nextContext.state).toBe("CANCELLED");
    const stagesByName = Object.fromEntries(r.nextContext.stages.map((s) => [s.name, s.state]));
    expect(stagesByName.setup).toBe("SUCCEEDED");
    expect(stagesByName.lint).toBe("SUCCEEDED");
    expect(stagesByName.test).toBe("SKIPPED");
    expect(stagesByName.build).toBe("SKIPPED");
    expect(stagesByName.publish).toBe("SKIPPED");
  });

  it("timeout(scope=run) from RUNNING → TIMED_OUT; reason='timeout-run'", () => {
    const ctx = running();
    const r = transition(ctx, { kind: "timeout", scope: "run", nowIso: T2 });
    expect(r.terminal).toBe(true);
    expect(r.nextContext.state).toBe("TIMED_OUT");
    expect(r.nextContext.failureReason).toBe("timeout-run");
  });

  it("timeout(scope=stage) from RUNNING → TIMED_OUT; reason='timeout-stage'", () => {
    const ctx = runningWithStage("build");
    const r = transition(ctx, { kind: "timeout", scope: "stage", nowIso: T2 });
    expect(r.nextContext.state).toBe("TIMED_OUT");
    expect(r.nextContext.failureReason).toBe("timeout-stage");
  });

  it("image-unavailable from QUEUED → FAILED with reason 'image-unavailable'", () => {
    const r = transition(queued(), { kind: "image-unavailable", nowIso: T1 });
    expect(r.terminal).toBe(true);
    expect(r.nextContext.state).toBe("FAILED");
    expect(r.nextContext.failureReason).toBe("image-unavailable");
  });
});

describe("Jemma state machine — illegal transitions throw with code", () => {
  const TERMINAL_LIST: RunState[] = ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"];

  it("terminal states absorb every event", () => {
    for (const term of TERMINAL_LIST) {
      const ctx: RunContext = { ...queued(), state: term, finishedAt: T0 };
      const events: RunEvent[] = [
        { kind: "scheduler-picked", podName: "p", nowIso: T0 },
        { kind: "stage-started", stage: "lint", nowIso: T0 },
        { kind: "cancel", reason: "cancelled-by-user", nowIso: T0 },
        { kind: "timeout", scope: "run", nowIso: T0 },
        { kind: "image-unavailable", nowIso: T0 },
        { kind: "all-stages-succeeded", nowIso: T0 },
      ];
      for (const ev of events) {
        expect(() => transition(ctx, ev)).toThrow(IllegalRunTransition);
      }
    }
  });

  it("scheduler-picked from non-QUEUED throws", () => {
    expect(() =>
      transition(running(), { kind: "scheduler-picked", podName: "p", nowIso: T1 }),
    ).toThrow(IllegalRunTransition);
  });

  it("stage-started from QUEUED throws", () => {
    expect(() =>
      transition(queued(), { kind: "stage-started", stage: "lint", nowIso: T0 }),
    ).toThrow(IllegalRunTransition);
  });

  it("stage-started for unknown stage throws", () => {
    expect(() =>
      transition(running(), {
        kind: "stage-started",
        stage: "bogus" as never,
        nowIso: T0,
      }),
    ).toThrow(IllegalRunTransition);
  });

  it("stage-succeeded for non-RUNNING stage throws", () => {
    const ctx = running();
    expect(() =>
      transition(ctx, { kind: "stage-succeeded", stage: "lint", nowIso: T0 }),
    ).toThrow(IllegalRunTransition);
  });

  it("all-stages-succeeded with stages still PENDING throws", () => {
    const ctx = running(); // all stages PENDING
    expect(() =>
      transition(ctx, { kind: "all-stages-succeeded", nowIso: T2 }),
    ).toThrow(IllegalRunTransition);
  });

  it("image-unavailable from RUNNING throws", () => {
    expect(() =>
      transition(running(), { kind: "image-unavailable", nowIso: T1 }),
    ).toThrow(IllegalRunTransition);
  });

  it("IllegalRunTransition carries machine-readable code + fromState + event", () => {
    try {
      transition(queued(), { kind: "stage-started", stage: "lint", nowIso: T0 });
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(IllegalRunTransition);
      const err = e as IllegalRunTransition;
      expect(err.code).toBe("ILLEGAL_RUN_TRANSITION");
      expect(err.fromState).toBe("QUEUED");
      expect(err.event).toBe("stage-started");
      expect(err.name).toBe("IllegalRunTransition");
    }
  });
});

describe("Jemma state machine — invariants", () => {
  it("transition is pure: input ctx is not mutated", () => {
    const before = queued();
    const beforeJson = JSON.stringify(before);
    transition(before, { kind: "scheduler-picked", podName: "p", nowIso: T1 });
    expect(JSON.stringify(before)).toBe(beforeJson);
  });

  it("terminal flag matches TERMINAL_STATES set", () => {
    const r = transition(queued(), { kind: "image-unavailable", nowIso: T1 });
    expect(r.terminal).toBe(true);
    expect(TERMINAL_STATES.has(r.nextContext.state)).toBe(true);
  });

  it("podName persists across stage transitions", () => {
    let ctx = queued();
    ctx = transition(ctx, { kind: "scheduler-picked", podName: "pod-1", nowIso: T0 }).nextContext;
    ctx = transition(ctx, { kind: "stage-started", stage: "setup", nowIso: T0 }).nextContext;
    ctx = transition(ctx, { kind: "stage-succeeded", stage: "setup", nowIso: T0 }).nextContext;
    expect(ctx.podName).toBe("pod-1");
  });
});
