// ---------------------------------------------------------------------------
// stageProgress — pure unit tests for the progress-coupled heartbeat.
//
// Background: a Temporal activity that heartbeats unconditionally can never be
// timed out, which is exactly how the funnel's merge stage sat "running"
// forever — the heartbeat kept the activity alive while the work behind it was
// deadlocked. `shouldHeartbeat` is the predicate that couples the heartbeat to
// actual forward progress, and it is deliberately pure so the decision can be
// pinned here without a worker.
//
// The back-compat branch (`reports === 0` ⇒ always heartbeat) is load-bearing:
// making silence the default would time out every stage that has not yet
// adopted reportStageProgress(), trading a rare deadlock for guaranteed
// breakage. It is asserted explicitly so nobody "tidies" it away.
// ---------------------------------------------------------------------------

import { describe, expect, it, afterEach } from "vitest";

import {
  reportStageProgress,
  runWithStageProgress,
  shouldHeartbeat,
  stallAfterMs,
  type StageProgressState,
} from "../../../src/services/funnel/temporal/stageProgress";

afterEach(() => {
  delete process.env.FUNNEL_STAGE_STALL_AFTER_MS;
});

function state(over: Partial<StageProgressState> = {}): StageProgressState {
  return { lastProgressAt: 1_000, reports: 1, lastMarker: "", ...over };
}

describe("stallAfterMs", () => {
  it("comes from the versioned profile: 60s on every profile", () => {
    for (const env of [
      {},
      { NODE_ENV: "test", TELLUS_ENVIRONMENT_ID: "tellus-tests-main" },
      { NODE_ENV: "production" },
    ] as NodeJS.ProcessEnv[]) {
      expect(stallAfterMs(env)).toBe(60_000);
    }
  });

  it("ignores the retired FUNNEL_STAGE_STALL_AFTER_MS env knob (verification §5.3)", () => {
    // A raised silence budget would let a wedged stage keep heartbeating;
    // the value is versioned config, not operator state.
    process.env.FUNNEL_STAGE_STALL_AFTER_MS = "5000";
    expect(stallAfterMs()).toBe(60_000);
    process.env.FUNNEL_STAGE_STALL_AFTER_MS = "86400000";
    expect(stallAfterMs()).toBe(60_000);
  });
});

describe("shouldHeartbeat", () => {
  it("heartbeats unconditionally for a stage that has never reported progress", () => {
    // Back-compat branch: an uninstrumented stage must not be starved of
    // heartbeats just because it reports nothing.
    const s = state({ reports: 0, lastProgressAt: 0 });
    expect(shouldHeartbeat(s, 10_000_000, 1_000)).toBe(true);
  });

  it("heartbeats while an instrumented stage is inside the stall window", () => {
    expect(shouldHeartbeat(state({ lastProgressAt: 1_000 }), 1_999, 1_000)).toBe(true);
  });

  it("goes silent once an instrumented stage exceeds the stall window", () => {
    // Silence is the point: it lets Temporal's heartbeatTimeout fire and the
    // activity be retried instead of hanging forever.
    expect(shouldHeartbeat(state({ lastProgressAt: 1_000 }), 2_000, 1_000)).toBe(false);
    expect(shouldHeartbeat(state({ lastProgressAt: 1_000 }), 60_000, 1_000)).toBe(false);
  });

  it("uses the versioned stallAfterMs() when no window is passed", () => {
    process.env.FUNNEL_STAGE_STALL_AFTER_MS = "100"; // retired — must not apply
    expect(shouldHeartbeat(state({ lastProgressAt: 1_000 }), 1_000 + 59_999)).toBe(true);
    expect(shouldHeartbeat(state({ lastProgressAt: 1_000 }), 1_000 + 60_000)).toBe(false);
  });
});

describe("runWithStageProgress / reportStageProgress", () => {
  it("exposes a fresh state and records reports made inside the scope", async () => {
    let captured: StageProgressState | undefined;
    await runWithStageProgress(async () => {
      reportStageProgress("merge:page-1");
      reportStageProgress("merge:page-2");
    }, (s) => {
      captured = s;
    });
    expect(captured?.reports).toBe(2);
    expect(captured?.lastMarker).toBe("merge:page-2");
  });

  it("advances lastProgressAt so a live stage keeps heartbeating", async () => {
    let captured: StageProgressState | undefined;
    await runWithStageProgress(async () => {
      captured!.lastProgressAt = 0; // simulate a long quiet period
      reportStageProgress("alive");
    }, (s) => {
      captured = s;
    });
    expect(captured!.lastProgressAt).toBeGreaterThan(0);
    expect(shouldHeartbeat(captured!, captured!.lastProgressAt + 10, 1_000)).toBe(true);
  });

  it("keeps an empty marker from clobbering the last real one", async () => {
    let captured: StageProgressState | undefined;
    await runWithStageProgress(async () => {
      reportStageProgress("changelog:read");
      reportStageProgress();
    }, (s) => {
      captured = s;
    });
    expect(captured?.lastMarker).toBe("changelog:read");
    expect(captured?.reports).toBe(2);
  });

  it("is a no-op outside a tracked stage — never throws", () => {
    expect(() => reportStageProgress("orphan")).not.toThrow();
  });

  it("attributes progress to the reporting activity, not to a sibling", async () => {
    // AsyncLocalStorage, not a module global: one worker process runs many
    // activities concurrently.
    let a: StageProgressState | undefined;
    let b: StageProgressState | undefined;
    await Promise.all([
      runWithStageProgress(async () => {
        reportStageProgress("a-1");
        await new Promise((r) => setTimeout(r, 5));
        reportStageProgress("a-2");
      }, (s) => {
        a = s;
      }),
      runWithStageProgress(async () => {
        reportStageProgress("b-1");
      }, (s) => {
        b = s;
      }),
    ]);
    expect(a?.reports).toBe(2);
    expect(a?.lastMarker).toBe("a-2");
    expect(b?.reports).toBe(1);
    expect(b?.lastMarker).toBe("b-1");
  });

  it("propagates the wrapped function's return value and errors", async () => {
    await expect(runWithStageProgress(async () => 42, () => {})).resolves.toBe(42);
    await expect(
      runWithStageProgress(async () => {
        throw new Error("stage blew up");
      }, () => {}),
    ).rejects.toThrow("stage blew up");
  });
});
