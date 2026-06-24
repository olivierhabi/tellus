// ---------------------------------------------------------------------------
// B4 — Per-tenant FIFO with weighted fair scheduling (spec §B4 line 198).
//
// Wraps WorkerRuntimeAdapter.submit() with admission control:
//   - per-tenant FIFO ordering
//   - global concurrency cap (TELLUS_BUILD_GLOBAL_CONCURRENCY)
//   - round-robin fairness across pending tenants so no tenant starves
//
// CONTRACT (important): `enqueue` is an *admission* call. It accepts the job
// onto the queue and returns IMMEDIATELY — it does NOT await dispatch or the
// runtime submit, and it never blocks on the worker lifecycle. This is what
// lets the HTTP `execute` handler durably record the build and return
// `202 Accepted` well within the request budget; the actual run proceeds in
// the background and its outcome is observed via `onEvent`.
//
// Slot accounting is keyed on `buildRid`: every dispatched job occupies one
// global + one per-tenant slot until a TERMINAL runtime event for that
// buildRid arrives (or its submit throws). At that point the slot is freed,
// the single-active lock for the import is released, and the next pending job
// is dispatched. Keying on buildRid (rather than a best-effort tenant guess)
// is what makes the accounting correct — the previous implementation leaked
// slots and never released the lock on the success path, wedging the queue.
//
// All mutable state lives inside the closure returned by `makeBuildQueue` so
// two queues — or a singleton re-created across a hot reload — can never
// corrupt each other's counters.
// ---------------------------------------------------------------------------

import type {
  JobSpec,
  RuntimeEvent,
  WorkerRuntimeAdapter,
} from "../runners/runtime-adapter";
import * as singleActive from "./single-active-build";

const GLOBAL_CAP = Number(process.env.TELLUS_BUILD_GLOBAL_CONCURRENCY ?? 8);

/** Runtime event kinds that end a build's lifecycle. */
const TERMINAL_KINDS: ReadonlySet<RuntimeEvent["kind"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

interface PendingItem {
  spec: JobSpec;
  weight: number;
  enqueuedMs: number;
}

interface TenantQueue {
  tenant: string;
  items: PendingItem[];
  active: number;
}

export interface BuildQueueHandle {
  /**
   * Admit a job for execution. Returns immediately (synchronous, non-blocking);
   * the job dispatches in the background as a global slot frees.
   */
  enqueue(spec: JobSpec, opts?: { weight?: number }): void;
  /**
   * Subscribe to the normalized build event stream: every runtime event is
   * forwarded, plus a synthetic `failed` event when `submit` itself throws
   * (the runtime can't emit for a job it never accepted). Returns unsubscribe.
   */
  onEvent(listener: (e: RuntimeEvent) => void): () => void;
  /**
   * Abort a build. If it is still PENDING (admitted but not dispatched) it is
   * removed from its tenant queue and its coalescing lock released. If it is
   * IN-FLIGHT the runtime is asked to cancel it (which emits a terminal
   * `cancelled` event → slot + lock freed via the normal finalize path). No-op
   * if the build is unknown / already finished. The authoritative DB status
   * transition is owned by the cancel HTTP handler; this only stops the work.
   */
  cancel(buildRid: string): Promise<void>;
  pendingCount(): number;
  activeCount(): number;
}

export function makeBuildQueue(
  runtime: WorkerRuntimeAdapter,
): BuildQueueHandle {
  const tenants = new Map<string, TenantQueue>();
  const rrOrder: string[] = [];
  // buildRid -> spec for every job occupying a slot. The single source of
  // truth for "what is in flight", used to free the right slot + lock on a
  // terminal event regardless of which tenant it belongs to.
  const inflight = new Map<string, JobSpec>();
  const listeners = new Set<(e: RuntimeEvent) => void>();
  let active = 0;

  function publish(e: RuntimeEvent): void {
    for (const l of listeners) {
      try {
        l(e);
      } catch {
        /* a misbehaving listener must not break accounting */
      }
    }
  }

  /** Free the slot + lock held by `buildRid`. Idempotent. */
  function finalize(buildRid: string): void {
    const spec = inflight.get(buildRid);
    if (!spec) return; // unknown or already finalized
    inflight.delete(buildRid);
    const q = tenants.get(spec.tenant);
    if (q) q.active = Math.max(0, q.active - 1);
    active = Math.max(0, active - 1);
    void singleActive.release(spec.importRid);
    dispatch();
  }

  /** Round-robin pick of the next pending item across tenants. */
  function pickNext(): PendingItem | null {
    for (let i = 0; i < rrOrder.length; i++) {
      const t = rrOrder.shift();
      if (t === undefined) break;
      const q = tenants.get(t);
      if (q && q.items.length > 0) {
        const item = q.items.shift()!;
        // Keep the tenant in rotation if it still has work; otherwise it is
        // re-added by the next enqueue for that tenant.
        if (q.items.length > 0) rrOrder.push(t);
        return item;
      }
      // Empty tenant: drop from rotation.
    }
    return null;
  }

  function dispatch(): void {
    while (active < GLOBAL_CAP) {
      const item = pickNext();
      if (!item) return;
      const q = tenants.get(item.spec.tenant);
      if (q) q.active += 1;
      active += 1;
      inflight.set(item.spec.buildRid, item.spec);
      void runJob(item);
    }
  }

  async function runJob(item: PendingItem): Promise<void> {
    try {
      // submit() returns as soon as the job is handed to the runtime; the
      // outcome arrives asynchronously via runtime.onEvent → finalize().
      await runtime.submit(item.spec);
    } catch (err) {
      // The runtime rejected the submit — it will never emit a terminal event
      // for this build, so synthesize one to converge both the DB row (via the
      // dispatcher's subscriber) and our own slot accounting.
      publish({
        buildRid: item.spec.buildRid,
        ts: new Date().toISOString(),
        kind: "failed",
        data: { reason: err instanceof Error ? err.message : String(err) },
      });
      finalize(item.spec.buildRid);
    }
  }

  // Forward every runtime event and drive slot release on terminal ones.
  runtime.onEvent((e) => {
    publish(e);
    if (TERMINAL_KINDS.has(e.kind)) finalize(e.buildRid);
  });

  return {
    enqueue(spec: JobSpec, opts?: { weight?: number }): void {
      const weight = opts?.weight ?? 1;
      let q = tenants.get(spec.tenant);
      if (!q) {
        q = { tenant: spec.tenant, items: [], active: 0 };
        tenants.set(spec.tenant, q);
      }
      const wasEmpty = q.items.length === 0;
      q.items.push({ spec, weight, enqueuedMs: Date.now() });
      // (Re)insert the tenant into the round-robin rotation when it gains its
      // first pending item.
      if (wasEmpty && !rrOrder.includes(spec.tenant)) rrOrder.push(spec.tenant);
      dispatch();
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async cancel(buildRid: string): Promise<void> {
      // Pending (admitted, not yet dispatched): drop it from its tenant queue
      // and release the coalescing lock. No slot was held, so no finalize.
      for (const q of tenants.values()) {
        const idx = q.items.findIndex((it) => it.spec.buildRid === buildRid);
        if (idx >= 0) {
          const [removed] = q.items.splice(idx, 1);
          void singleActive.release(removed.spec.importRid);
          return;
        }
      }
      // In-flight: ask the runtime to abort. The runtime emits a terminal
      // `cancelled` event → runtime.onEvent above → finalize frees the slot +
      // lock. Nothing to do for an unknown/finished build.
      if (inflight.has(buildRid)) {
        await runtime.cancel(buildRid);
      }
    },
    pendingCount() {
      let n = 0;
      for (const q of tenants.values()) n += q.items.length;
      return n;
    },
    activeCount() {
      return active;
    },
  };
}
