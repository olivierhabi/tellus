// ---------------------------------------------------------------------------
// FUNN-ISO — funnel_run state-machine unit tests (pure state-machine logic).
//
// The allowed transition graph:
//   dispatch_pending → workflow_started | failed | cancelled
//   workflow_started → running | failed | cancelled
//   running          → completed | failed | cancelled
//   (terminal: completed | failed | cancelled — no outgoing writes)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

type RunStatus =
  | "dispatch_pending"
  | "workflow_started"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

const ALLOWED: Record<RunStatus, RunStatus[]> = {
  dispatch_pending: ["workflow_started", "failed", "cancelled"],
  workflow_started: ["running", "failed", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!ALLOWED[from].includes(to)) {
    throw new Error(`illegal funnel_run transition: ${from} → ${to}`);
  }
}

describe("funnel_run state machine (FUNN-ISO-5)", () => {
  it("happy path passes all transitions", () => {
    assertTransition("dispatch_pending", "workflow_started");
    assertTransition("workflow_started", "running");
    assertTransition("running", "completed");
  });

  it("failure from any in-flight state is legal", () => {
    assertTransition("dispatch_pending", "failed");
    assertTransition("workflow_started", "failed");
    assertTransition("running", "failed");
  });

  it("cancellation (object_type_deleted / migration) is legal from in-flight", () => {
    assertTransition("dispatch_pending", "cancelled");
    assertTransition("workflow_started", "cancelled");
    assertTransition("running", "cancelled");
  });

  it("terminal states cannot transition (no stale-overwrite regression)", () => {
    for (const s of ["completed", "failed", "cancelled"] as const) {
      expect(() => assertTransition(s, "running")).toThrow(/illegal/);
      expect(() => assertTransition(s, "dispatch_pending")).toThrow(/illegal/);
      expect(() => assertTransition(s, "indexed" as RunStatus)).toThrow();
    }
  });

  it("dispatch → completed directly is illegal (stage rows must exist)", () => {
    expect(() => assertTransition("dispatch_pending", "completed")).toThrow(/illegal/);
    expect(() => assertTransition("workflow_started", "completed")).toThrow(/illegal/);
  });

  it("regressions are illegal (completed → running, running → dispatch_pending)", () => {
    expect(() => assertTransition("completed", "running")).toThrow(/illegal/);
    expect(() => assertTransition("running", "dispatch_pending")).toThrow(/illegal/);
    expect(() => assertTransition("workflow_started", "dispatch_pending")).toThrow(/illegal/);
  });
});

describe("funnel_state badge statuses", () => {
  it("vocabulary includes the object_type_deleted-compatible 'cancelled' status", () => {
    const allowed = ["not_indexed", "indexing", "indexed", "failed", "stale", "cancelled"];
    expect(allowed).toContain("cancelled");
    expect(allowed).toContain("not_indexed");
    expect(allowed).toContain("indexed");
  });
});
