// ---------------------------------------------------------------------------
// functionWorkerPool.ts — off-main-thread execution for sandboxed functions.
//
// `runSandboxedWithSdkAsync` dispatches a function invocation to a pool of
// persistent `worker_threads` workers (functionWorker.ts). The sandbox's
// synchronous `vm.runInContext` — which previously blocked the main event
// loop for up to FUNCTION_TIMEOUT_MS and starved concurrent object-search
// reads to 504 — now blocks only a worker's loop. The main thread stays free
// to serve requests.
//
// Robustness contract:
//   • If the worker file can't be resolved, or a worker errors / exceeds its
//     wall budget, the call falls back to `runSandboxedWithSdkSync` (the old
//     inline behaviour). Correctness never depends on the pool being healthy;
//     a broken pool only degrades latency, never data.
//   • Each task carries a wall-clock budget (FUNCTION_TIMEOUT_MS × 2 + slack,
//     to cover both vm phases). On expiry the worker is terminated + respawned
//     and the caller falls back to sync for that invocation.
//   • A crashed worker is respawned so subsequent calls recover automatically.
//
// Toggle: set FUNCTION_WORKER_POOL=0 to force the sync fallback everywhere
// (escape hatch for prod rollout / debugging).
// ---------------------------------------------------------------------------

import { Worker } from "worker_threads";
import {
  FUNCTION_TIMEOUT_MS,
  runSandboxedWithSdk,
  type SandboxResult,
} from "./functionRuntime";
import {
  buildOntologySdk,
  type OntologySnapshot,
  type OntologyEdit,
} from "./functions/ontologyRuntime";

export interface SandboxAsyncResult extends SandboxResult {
  readonly edits: OntologyEdit[];
}

// ---- Worker file resolution + dev/prod execArgv ---------------------------
//
// `require.resolve('./functionWorker')` resolves to the `.ts` in dev (tsx)
// and the compiled `.js` in prod. We pass `--require tsx/cjs` to the worker
// ONLY when tsx is installed (dev); prod runs compiled JS with no tsx.
let workerFile: string | null = null;
let workerExecArgv: string[] = [];
try {
  workerFile = require.resolve("./functionWorker");
  try {
    // Throws in prod (tsx is dev-only) → workerExecArgv stays [].
    require.resolve("tsx/cjs");
    workerExecArgv = ["--require", require.resolve("tsx/cjs")];
  } catch {
    workerExecArgv = [];
  }
} catch {
  workerFile = null;
}

const POOL_ENABLED = process.env.FUNCTION_WORKER_POOL !== "0";
const POOL_SIZE = Math.max(1, Number(process.env.FUNCTION_WORKER_POOL_SIZE ?? 4));
// The vm cap is per-phase (module eval, then invocation); allow both phases to
// run to the cap plus slack before we give up on the worker.
const WORKER_WALL_BUDGET_MS = FUNCTION_TIMEOUT_MS * 2 + 2_000;

interface Pending {
  resolve: (v: SandboxAsyncResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Slot {
  worker: Worker;
  busy: boolean;
  pending: Pending | null;
  dead: boolean;
}

const pool: Slot[] = [];
const waitQueue: Array<(slot: Slot) => void> = [];
let nextTaskId = 1;
let poolInitialized = false;

function spawnSlot(): Slot | null {
  if (!workerFile) return null;
  try {
    const worker = new Worker(workerFile, { execArgv: workerExecArgv });
    const slot: Slot = { worker, busy: false, pending: null, dead: false };

    worker.on("message", (msg: { type?: string; id?: number; result?: SandboxResult; edits?: OntologyEdit[] }) => {
      if (msg?.type === "__ready__") return; // worker loaded OK
      const pending = slot.pending;
      slot.pending = null;
      slot.busy = false;
      if (pending && msg && typeof msg.id === "number" && msg.result) {
        clearTimeout(pending.timer);
        pending.resolve({ ...msg.result, edits: msg.edits ?? [] });
      } else if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("functionWorker: malformed response"));
      }
      drainWaitQueue();
    });

    worker.on("error", (err) => {
      failSlot(slot, err instanceof Error ? err : new Error(String(err)));
    });

    // A worker shouldn't exit while the pool is alive; treat exit as death.
    worker.on("exit", (code) => {
      if (!slot.dead) {
        failSlot(slot, new Error(`functionWorker exited (code=${code})`));
      }
    });

    try {
      worker.unref();
    } catch {
      /* unref is best-effort */
    }
    return slot;
  } catch {
    return null;
  }
}

function failSlot(slot: Slot, err: Error): void {
  slot.dead = true;
  const pending = slot.pending;
  slot.pending = null;
  slot.busy = false;
  if (pending) {
    clearTimeout(pending.timer);
    pending.reject(err);
  }
  try {
    slot.worker.terminate().catch(() => {});
  } catch {
    /* ignore */
  }
  // Respawn a fresh worker so the pool recovers for subsequent calls.
  const idx = pool.indexOf(slot);
  if (idx >= 0) {
    const fresh = spawnSlot();
    if (fresh) pool[idx] = fresh;
    else pool.splice(idx, 1);
  }
  drainWaitQueue();
}

function initPool(): void {
  if (poolInitialized || !POOL_ENABLED || !workerFile) {
    poolInitialized = true;
    return;
  }
  poolInitialized = true;
  for (let i = 0; i < POOL_SIZE; i++) {
    const slot = spawnSlot();
    if (slot) pool.push(slot);
  }
}

function drainWaitQueue(): void {
  while (waitQueue.length) {
    const free = pool.find((s) => !s.dead && !s.busy);
    if (!free) break;
    const waiter = waitQueue.shift()!;
    waiter(free);
  }
}

function acquireSlot(): Promise<Slot | null> {
  initPool();
  const free = pool.find((s) => !s.dead && !s.busy);
  if (free) return Promise.resolve(free);
  if (!POOL_ENABLED || !workerFile || pool.length === 0) return Promise.resolve(null);
  return new Promise<Slot | null>((resolve) => {
    waitQueue.push((slot) => resolve(slot));
    // Safety: if no worker ever frees (all dead), don't hang forever.
    setTimeout(() => resolve(null), WORKER_WALL_BUDGET_MS);
  });
}

function dispatchToWorker(
  slot: Slot,
  transpiled: string,
  input: unknown,
  snapshot: OntologySnapshot,
): Promise<SandboxAsyncResult> {
  return new Promise<SandboxAsyncResult>((resolve, reject) => {
    const id = nextTaskId++;
    const timer = setTimeout(() => {
      // Wall budget exceeded — terminate the worker (it's likely stuck) and
      // reject so the caller falls back to sync. The slot will respawn via
      // the exit handler.
      slot.dead = true;
      slot.pending = null;
      slot.busy = false;
      try {
        slot.worker.terminate().catch(() => {});
      } catch {
        /* ignore */
      }
      const idx = pool.indexOf(slot);
      if (idx >= 0) {
        const fresh = spawnSlot();
        if (fresh) pool[idx] = fresh;
        else pool.splice(idx, 1);
      }
      drainWaitQueue();
      reject(new Error(`functionWorker: wall budget (${WORKER_WALL_BUDGET_MS}ms) exceeded`));
    }, WORKER_WALL_BUDGET_MS);

    slot.busy = true;
    slot.pending = { resolve, reject, timer };
    slot.worker.postMessage({ id, transpiled, input, snapshot });
  });
}

/**
 * Execute a sandboxed function off the main event loop, falling back to
 * inline synchronous execution if the worker pool is unavailable or errors.
 * `edits` carries the side-channel edits the function collected (Foundry
 * TS v2 `Edits` API / `createEditBatch().getEdits()`), empty unless status is "ok".
 */
export async function runSandboxedWithSdkAsync(
  transpiled: string,
  input: unknown,
  snapshot: OntologySnapshot,
): Promise<SandboxAsyncResult> {
  if (!POOL_ENABLED || !workerFile) {
    return runSandboxedWithSdkSync(transpiled, input, snapshot);
  }
  const slot = await acquireSlot();
  if (!slot) {
    return runSandboxedWithSdkSync(transpiled, input, snapshot);
  }
  try {
    return await dispatchToWorker(slot, transpiled, input, snapshot);
  } catch {
    // Worker unavailable / errored / timed out — run inline. The sandbox will
    // block the main loop as before, but the result is correct.
    return runSandboxedWithSdkSync(transpiled, input, snapshot);
  }
}

/**
 * Inline (main-thread) execution — the previous behaviour and the safe
 * fallback. Exported so it can be unit-tested directly and so the route
 * can use it in contexts where offloading is undesired.
 */
export function runSandboxedWithSdkSync(
  transpiled: string,
  input: unknown,
  snapshot: OntologySnapshot,
): SandboxAsyncResult {
  const { sdk, getEdits } = buildOntologySdk(snapshot);
  const result = runSandboxedWithSdk(transpiled, input, {
    Objects: sdk.Objects,
    Edits: sdk.Edits,
    createEditBatch: sdk.createEditBatch,
    __ontologyTypes: sdk.objectTypeDescriptors,
  });
  return { ...result, edits: result.status === "ok" ? getEdits() : [] };
}

// Test-only: reset pool state (workers are terminated by process teardown).
export function __resetPoolForTests(): void {
  poolInitialized = false;
  pool.length = 0;
  waitQueue.length = 0;
  nextTaskId = 1;
}
