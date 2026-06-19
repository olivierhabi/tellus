// Unit tests for the build queue's admission + slot accounting (spec §B4).
//
// These lock in the production fix for the execute-path 504:
//   - `enqueue` is NON-BLOCKING admission (it never awaits submit/dispatch),
//   - slots are accounted per buildRid and FREED on a terminal event so the
//     queue can never wedge at the global cap (the original leak),
//   - the single-active lock is RELEASED on terminal (not left for 1h TTL),
//   - submit failures synthesize a `failed` event AND free the slot,
//   - runtime events are forwarded to subscribers (the DB-persistence hook).
import { beforeEach, describe, it, expect } from "vitest";
import { makeBuildQueue } from "../../../src/services/orchestration/queue/build-queue";
import {
  acquireOrJoin,
  _reset as resetLocks,
} from "../../../src/services/orchestration/queue/single-active-build";
import type {
  JobSpec,
  RuntimeEvent,
  WorkerRuntimeAdapter,
} from "../../../src/services/orchestration/runners/runtime-adapter";

const GLOBAL_CAP = Number(process.env.TELLUS_BUILD_GLOBAL_CONCURRENCY ?? 8);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function spec(buildRid: string, importRid = `ri.magritte.main.extract.${buildRid}`): JobSpec {
  return {
    buildRid,
    importRid,
    connectionRid: "ri.magritte.main.source.x",
    tenant: "default",
    actor: "tester",
    kind: "foundryWorker",
    egress: { allow: [], cidrs: [] },
    workloadJwt: "jwt",
    payload: {},
    deadlineMs: 1000,
  };
}

function terminal(buildRid: string, kind: RuntimeEvent["kind"] = "succeeded"): RuntimeEvent {
  return { buildRid, ts: new Date().toISOString(), kind, data: {} };
}

/** Controllable fake runtime: records submits and lets the test emit events. */
function makeFakeRuntime(opts: { submitThrows?: boolean } = {}) {
  const listeners = new Set<(e: RuntimeEvent) => void>();
  const submitted: JobSpec[] = [];
  const adapter: WorkerRuntimeAdapter = {
    async submit(s) {
      submitted.push(s);
      if (opts.submitThrows) throw new Error("submit boom");
    },
    async cancel() {},
    onEvent(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async shutdown() {},
  };
  return {
    adapter,
    submitted,
    emit(e: RuntimeEvent) {
      for (const l of listeners) l(e);
    },
  };
}

describe("build queue — admission + slot accounting", () => {
  beforeEach(() => resetLocks());

  it("enqueue does NOT block on submit — even a submit that never resolves", async () => {
    // A submit that hangs forever models a wedged worker/connection — the exact
    // failure that used to hold the HTTP response until the 5s budget tripped.
    const listeners = new Set<(e: RuntimeEvent) => void>();
    let submitCalls = 0;
    const adapter: WorkerRuntimeAdapter = {
      submit() {
        submitCalls += 1;
        return new Promise<void>(() => {}); // never resolves
      },
      async cancel() {},
      onEvent(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      async shutdown() {},
    };
    const q = makeBuildQueue(adapter);

    // If enqueue awaited submit, this line would never return.
    q.enqueue(spec("b1"));
    expect(q.activeCount()).toBe(1); // slot reserved synchronously

    await flush(); // give the background runJob a chance to run
    expect(submitCalls).toBe(1); // dispatched...
    expect(q.activeCount()).toBe(1); // ...and still in-flight, not blocking anyone
  });

  it("frees the slot AND releases the single-active lock on a terminal event", async () => {
    const rt = makeFakeRuntime();
    const q = makeBuildQueue(rt.adapter);
    const imp = "ri.magritte.main.extract.lock1";

    // Simulate the handler having taken the coalescing lock for this build.
    await acquireOrJoin(imp, "b1");
    q.enqueue(spec("b1", imp));
    expect(q.activeCount()).toBe(1);

    rt.emit(terminal("b1", "succeeded"));
    expect(q.activeCount()).toBe(0);

    // Lock must now be free: a fresh execute gets a NEW (non-coalesced) build.
    const next = await acquireOrJoin(imp, "b2");
    expect(next).toEqual({ buildRid: "b2", coalesced: false });
  });

  it("never exceeds the global concurrency cap and drains the backlog", async () => {
    const rt = makeFakeRuntime();
    const q = makeBuildQueue(rt.adapter);

    const total = GLOBAL_CAP + 2;
    for (let i = 0; i < total; i++) q.enqueue(spec(`b${i}`));

    expect(q.activeCount()).toBe(GLOBAL_CAP);
    expect(q.pendingCount()).toBe(2);

    // Completing one in-flight build admits exactly one backlog item.
    rt.emit(terminal("b0"));
    expect(q.activeCount()).toBe(GLOBAL_CAP);
    expect(q.pendingCount()).toBe(1);

    // Drain the rest.
    for (let i = 1; i < total; i++) rt.emit(terminal(`b${i}`));
    expect(q.activeCount()).toBe(0);
    expect(q.pendingCount()).toBe(0);
  });

  it("synthesizes a failed event and frees the slot when submit throws", async () => {
    const rt = makeFakeRuntime({ submitThrows: true });
    const q = makeBuildQueue(rt.adapter);
    const seen: RuntimeEvent[] = [];
    q.onEvent((e) => seen.push(e));

    q.enqueue(spec("b1"));
    await flush(); // let runJob's submit reject and synthesize the failure

    expect(q.activeCount()).toBe(0);
    const failed = seen.find((e) => e.kind === "failed");
    expect(failed?.buildRid).toBe("b1");
    expect(String(failed?.data?.reason)).toContain("submit boom");
  });

  it("forwards runtime events to subscribers (the DB-persistence hook)", async () => {
    const rt = makeFakeRuntime();
    const q = makeBuildQueue(rt.adapter);
    const seen: RuntimeEvent[] = [];
    q.onEvent((e) => seen.push(e));

    q.enqueue(spec("b1"));
    rt.emit({ buildRid: "b1", ts: new Date().toISOString(), kind: "started", data: {} });
    rt.emit(terminal("b1", "succeeded"));

    expect(seen.map((e) => e.kind)).toEqual(["started", "succeeded"]);
  });
});
