// ---------------------------------------------------------------------------
// Unit tests for src/services/workers/sideEffectWorker.ts — Phase 5.
//
// Mocks the model layer (claimSideEffectJobs, markSideEffectJobSucceeded,
// markSideEffectJobRetryOrDead) and injects a fake dispatcher so the
// worker's claim-dispatch-update cycle can be tested without any DB IO
// or network IO. The injected dispatcher lets each test simulate success,
// infra-failure (retry), or exhaust-retries (dead-letter).
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the model layer — every claim/mark call becomes in-memory state.
const store = {
  claimed: [] as any[],
  succeeded: new Set<string>(),
  retrying: new Map<string, number>(),
  dead: new Set<string>(),
  // Errors thrown by the injected dispatcher — keyed by job_id.
  failOn: new Map<string, Error>(),
};

vi.mock("../../../src/models/actionSideEffectJob", () => ({
  claimSideEffectJobs: async (limit: number) => {
    const taken = store.claimed.slice(0, limit);
    store.claimed = store.claimed.slice(limit);
    return taken;
  },
  markSideEffectJobSucceeded: async (jobId: string) => {
    store.succeeded.add(jobId);
  },
  markSideEffectJobRetryOrDead: async (jobId: string, code: string, message: string, policy: any) => {
    const count = (store.retrying.get(jobId) ?? 0) + 1;
    store.retrying.set(jobId, count);
    if (count >= policy.maxAttempts) {
      store.dead.add(jobId);
      store.retrying.delete(jobId);
      return "dead" as const;
    }
    return "retrying" as const;
  },
  requeueDeadSideEffectJob: async (jobId: string) => {
    if (store.dead.has(jobId)) {
      store.dead.delete(jobId);
      store.claimed.push({ job_id: jobId, kind: "webhook" });
      return { job_id: jobId };
    }
    return null;
  },
}));

import { runOnce, DEFAULT_RETRY_POLICY } from "../../../src/services/workers/sideEffectWorker";

const fakeJob = (id: string, kind: "webhook" | "notification" = "webhook") => ({
  job_id: id,
  execution_id: "exec-1",
  action_type_id: "at-1",
  action_type_version: 1,
  side_effect_index: 0,
  kind,
  payload: kind === "webhook"
    ? { spec: { url: "https://example.com", method: "POST" } }
    : { spec: { channel: "in_app", templateId: "t" }, recipient: { principal: "u" } },
  status: "pending",
  attempt_count: 0,
  last_error_code: null,
  last_error_at: null,
  next_attempt_at: null,
  idempotency_key: null,
  external_receipt: null,
  created_at: "2026-07-25T00:00:00Z",
  updated_at: "2026-07-25T00:00:00Z",
});

beforeEach(() => {
  store.claimed = [];
  store.succeeded = new Set();
  store.retrying = new Map();
  store.dead = new Set();
  store.failOn = new Map();
});

const injectDispatcher = (job: any) =>
  async () => {
    if (store.failOn.has(job.job_id)) throw store.failOn.get(job.job_id)!;
    return { ok: true, receiptId: `r:${job.job_id}` };
  };

describe("sideEffectWorker runOnce", () => {
  it("claims a batch, succeeds all, returns correct counters", async () => {
    store.claimed = [fakeJob("a"), fakeJob("b"), fakeJob("c")];
    const r = await runOnce(8, DEFAULT_RETRY_POLICY, injectDispatcher as any);
    expect(r.claimed).toBe(3);
    expect(r.succeeded).toBe(3);
    expect(r.retrying).toBe(0);
    expect(r.dead).toBe(0);
    expect(store.succeeded.size).toBe(3);
    expect(store.claimed.length).toBe(0);
  });

  it("returns 0/0/0/0 when no jobs are claimable", async () => {
    const r = await runOnce(8, DEFAULT_RETRY_POLICY, injectDispatcher as any);
    expect(r).toEqual({ claimed: 0, succeeded: 0, retrying: 0, dead: 0, durationMs: expect.any(Number) });
  });

  it("retries on infra failure until maxAttempts → 'dead'", async () => {
    // Single job, fail-once and re-enqueue to simulate the worker retry
    // loop. Each iteration the worker claims it via the mock, fails the
    // dispatch → markSideEffectJobRetryOrDead bumps attempt_count. After
    // maxAttempts (5) iterations the row should move to 'dead'.
    store.claimed = [fakeJob("only")];
    store.failOn.set("only", Object.assign(new Error("boom"), { code: "NET_DOWN" }));
    let last: any;
    for (let i = 0; i < 5; i++) {
      // The retry path re-queues the job (in real life via
      // next_attempt_at; here it just remains 'claimable' as long as
      // the mock HACK in markSideEffectJobRetryOrDead doesn't already
      // re-push to the queue).
      // Emulate the worker loop's re-claim by re-seeding the queue:
      if (store.claimed.length === 0 && store.retrying.has("only")) {
        store.claimed.push(fakeJob("only"));
      }
      last = await runOnce(8, DEFAULT_RETRY_POLICY, injectDispatcher as any);
    }
    expect(store.dead.has("only")).toBe(true);
    expect(last.dead).toBe(1);
    expect(last.succeeded).toBe(0);
  });

  it("mixed: one success, one retry, one dead-letter (already-exhausted)", async () => {
    // 'a' succeeds, 'b' fails once then succeeds on re-claim, 'c' is set
    // up to fail repeatedly.
    store.claimed = [fakeJob("a"), fakeJob("b"), fakeJob("c")];
    store.failOn.set("c", Object.assign(new Error("perm"), { code: "ERR_PERM" }));
    let bFailed = false;
    const bFailingDispatcher = (job: any) => async () => {
      if (job.job_id === "b" && !bFailed) {
        bFailed = true;
        throw new Error("one-off");
      }
      if (store.failOn.has(job.job_id)) throw store.failOn.get(job.job_id)!;
      return { ok: true, receiptId: `r:${job.job_id}` };
    };
    // First pass.
    let r = await runOnce(8, DEFAULT_RETRY_POLICY, bFailingDispatcher as any);
    expect(r.claimed).toBe(3);
    expect(r.succeeded).toBe(1); // 'a'
    expect(r.retrying).toBe(2); // 'b' and 'c' both retried
    // Now re-queue b+c (the mock doesn't do this; emulate).
    store.claimed = [fakeJob("b"), fakeJob("c")];
    r = await runOnce(8, DEFAULT_RETRY_POLICY, bFailingDispatcher as any);
    expect(r.succeeded).toBe(1); // 'b' this round
    expect(r.retrying).toBe(1);  // 'c' retried again
    // Re-queue once more and push 'c' to attemptCount → dead.
    store.claimed = [fakeJob("c")];
    r = await runOnce(8, DEFAULT_RETRY_POLICY, bFailingDispatcher as any);
    expect(store.retrying.get("c") ?? 0).toBe(3); // b used to count here too
    // Drive 'c' to dead (still needs 2 more retries).
    store.claimed = [fakeJob("c")];
    await runOnce(8, DEFAULT_RETRY_POLICY, bFailingDispatcher as any);
    store.claimed = [fakeJob("c")];
    r = await runOnce(8, DEFAULT_RETRY_POLICY, bFailingDispatcher as any);
    expect(store.dead.has("c")).toBe(true);
  });

  it("dispatcher return value is opaque — only throw → retry", async () => {
    store.claimed = [fakeJob("ok"), fakeJob("warn")];
    const dispatcher = (job: any) => async () => {
      if (job.job_id === "warn") {
        return { ok: false, error: "soft warning" }; // no throw
      }
      return { ok: true };
    };
    const r = await runOnce(8, DEFAULT_RETRY_POLICY, dispatcher as any);
    expect(r.succeeded).toBe(2); // OK=false treated as success because no throw
    expect(store.succeeded.size).toBe(2);
  });

  it("respects the limit parameter", async () => {
    store.claimed = [
      fakeJob("a"), fakeJob("b"), fakeJob("c"), fakeJob("d"),
      fakeJob("e"), fakeJob("f"),
    ];
    const r = await runOnce(2, DEFAULT_RETRY_POLICY, injectDispatcher as any);
    expect(r.claimed).toBe(2);
    expect(r.succeeded).toBe(2);
    expect(store.claimed.length).toBe(4); // remaining
  });
});

describe("sideEffectWorker requeueDeadSideEffectJob", () => {
  it("operator-driven requeue moves a 'dead' job back to claimable", async () => {
    // Set up a row that's dead, then re-queue it and verify the next
    // worker cycle picks it up + succeeds.
    store.dead.add("revived");
    const { requeueDeadSideEffectJob } = await import("../../../src/models/actionSideEffectJob");
    const ok = await requeueDeadSideEffectJob("revived");
    expect(ok).toBeTruthy();
    expect(store.claimed.length).toBe(1);
    expect(store.dead.size).toBe(0);
    const r = await runOnce(8, DEFAULT_RETRY_POLICY, injectDispatcher as any);
    expect(r.succeeded).toBe(1);
    expect(store.succeeded.has("revived")).toBe(true);
  });

  it("requeue of a non-'dead' job is a no-op (returns null)", async () => {
    const { requeueDeadSideEffectJob } = await import("../../../src/models/actionSideEffectJob");
    const ok = await requeueDeadSideEffectJob("not-dead");
    expect(ok).toBeNull();
    expect(store.claimed.length).toBe(0);
  });
});
