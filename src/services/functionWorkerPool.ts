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
// HARD GUARANTEE (the fix for the production 504): as long as the worker file
// can be loaded, the pool NEVER falls back to synchronous execution — not on
// a worker error, not on a timeout. A previous version fell back to sync on
// any worker hiccup; under a burst of concurrent invokes that re-introduced
// main-loop blocking and 504'd concurrent searches. Now a hung/errored worker
// resolves that ONE task with `status: "timeout"|"error"` (the route surfaces
// it as a single failed invoke) and the worker is respawned. The main event
// loop is never blocked by a sandbox.
//
// Concurrency model (race-free): dispatch is SYNCHRONOUS. `submit` either
// dispatches to a free worker (mark busy + postMessage, same tick) or enqueues.
// A worker's message handler frees the worker and pumps the next queued task
// synchronously. There is no `await` between finding a free worker and
// dispatching, so a freed slot can never be handed to two tasks.
//
// Sync fallback (`runSandboxedWithSdkSync`) is used ONLY when the pool is
// structurally unavailable — the worker file can't be resolved or
// FUNCTION_WORKER_POOL=0. It is never used as a per-task error fallback.
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
let workerFile: string | null = null;
let workerExecArgv: string[] = [];
try {
  workerFile = require.resolve("./functionWorker");
  try {
    require.resolve("tsx/cjs"); // throws in prod (tsx is dev-only)
    workerExecArgv = ["--require", require.resolve("tsx/cjs")];
  } catch {
    workerExecArgv = []; // prod: compiled JS, no tsx
  }
} catch {
  workerFile = null;
}

const POOL_ENABLED = process.env.FUNCTION_WORKER_POOL !== "0";
const POOL_SIZE = Math.max(1, Number(process.env.FUNCTION_WORKER_POOL_SIZE ?? 4));
// The vm cap is per-phase (module eval, then invocation). Allow both phases to
// reach the cap plus slack before declaring the worker hung.
const WORKER_WALL_BUDGET_MS = FUNCTION_TIMEOUT_MS * 2 + 2_000;

interface Task {
  readonly transpiled: string;
  readonly input: unknown;
  readonly snapshot: OntologySnapshot;
}
interface Pending {
  readonly task: Task;
  readonly resolve: (v: SandboxAsyncResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
interface Slot {
  worker: Worker;
  busy: boolean;
  current: Pending | null;
  dead: boolean;
}

const pool: Slot[] = [];
const queue: Pending[] = [];
let poolInitialized = false;
let nextTaskId = 1;

function spawnSlot(): Slot | null {
  if (!workerFile) return null;
  try {
    const worker = new Worker(workerFile, { execArgv: workerExecArgv });
    const slot: Slot = { worker, busy: false, current: null, dead: false };

    worker.on("message", (msg: { type?: string; id?: number; result?: SandboxResult; edits?: OntologyEdit[] }) => {
      if (msg?.type === "__ready__") return;
      const pending = slot.current;
      slot.current = null;
      slot.busy = false;
      if (pending && msg && typeof msg.id === "number" && msg.result) {
        clearTimeout(pending.timer);
        pending.resolve({ ...msg.result, edits: msg.edits ?? [] });
      } else if (pending) {
        // Malformed worker response — fail this ONE task, keep the worker.
        clearTimeout(pending.timer);
        pending.resolve(errorResult("functionWorker: malformed response"));
      }
      pump(slot);
    });

    worker.on("error", (err) => {
      failSlot(slot, err instanceof Error ? err.message : String(err));
    });
    worker.on("exit", (code) => {
      if (!slot.dead) failSlot(slot, `functionWorker exited (code=${code})`);
    });

    try {
      worker.unref();
    } catch {
      /* best-effort */
    }
    return slot;
  } catch {
    return null;
  }
}

function failSlot(slot: Slot, message: string): void {
  slot.dead = true;
  const pending = slot.current;
  slot.current = null;
  slot.busy = false;
  if (pending) {
    clearTimeout(pending.timer);
    // Resolve (do NOT reject) with an error result — the route surfaces it
    // as a failed invoke; the main loop is never blocked.
    pending.resolve(errorResult(message));
  }
  try {
    slot.worker.terminate().catch(() => {});
  } catch {
    /* ignore */
  }
  // Respawn a fresh worker so the pool recovers its capacity.
  const idx = pool.indexOf(slot);
  if (idx >= 0) {
    const fresh = spawnSlot();
    if (fresh) {
      pool[idx] = fresh;
      pump(fresh);
    } else {
      pool.splice(idx, 1);
    }
  }
  // A worker freed (effectively) — try to drain the queue on the others.
  drainQueue();
}

function errorResult(message: string): SandboxAsyncResult {
  return {
    output: null,
    durationMs: 0,
    status: "error",
    errorMessage: message,
    logs: [],
    edits: [],
  };
}

function initPool(): void {
  if (poolInitialized) return;
  poolInitialized = true;
  if (!POOL_ENABLED || !workerFile) return;
  for (let i = 0; i < POOL_SIZE; i++) {
    const slot = spawnSlot();
    if (slot) pool.push(slot);
  }
}

/** Dispatch `pending` to `slot` synchronously (race-free: no await gap). */
function dispatch(slot: Slot, pending: Pending): void {
  slot.busy = true;
  slot.current = pending;
  const id = nextTaskId++;
  slot.worker.postMessage({
    id,
    transpiled: pending.task.transpiled,
    input: pending.task.input,
    snapshot: pending.task.snapshot,
  });
}

/** If `slot` is free and a task is queued, dispatch the next one. */
function pump(slot: Slot): void {
  if (slot.busy || slot.dead) return;
  const next = queue.shift();
  if (next) dispatch(slot, next);
}

/** Any free worker can pick up the head of the queue. */
function drainQueue(): void {
  while (queue.length) {
    const free = pool.find((s) => !s.dead && !s.busy);
    if (!free) break;
    const next = queue.shift()!;
    dispatch(free, next);
  }
}

function submitToPool(task: Task): Promise<SandboxAsyncResult> {
  return new Promise<SandboxAsyncResult>((resolve) => {
    const timer = setTimeout(() => {
      // Wall budget exceeded — the worker is hung. Resolve this ONE task as a
      // timeout (the route returns 504 for it), then terminate + respawn the
      // worker so capacity recovers. The main loop is never blocked.
      const slot = pool.find((s) => s.current && s.current.timer === timer);
      if (slot) {
        slot.dead = true;
        slot.current = null;
        slot.busy = false;
        try {
          slot.worker.terminate().catch(() => {});
        } catch {
          /* ignore */
        }
        const idx = pool.indexOf(slot);
        if (idx >= 0) {
          const fresh = spawnSlot();
          if (fresh) {
            pool[idx] = fresh;
            pump(fresh);
          } else {
            pool.splice(idx, 1);
          }
        }
        drainQueue();
      }
      resolve(timeoutResult());
    }, WORKER_WALL_BUDGET_MS);

    const pending: Pending = { task, resolve, timer };
    initPool();
    const free = pool.find((s) => !s.dead && !s.busy);
    if (free) {
      dispatch(free, pending);
    } else {
      queue.push(pending);
    }
  });
}

function timeoutResult(): SandboxAsyncResult {
  return {
    output: null,
    durationMs: WORKER_WALL_BUDGET_MS,
    status: "timeout",
    errorMessage: `Function worker exceeded the ${WORKER_WALL_BUDGET_MS}ms wall budget.`,
    logs: [],
    edits: [],
  };
}

/**
 * Execute a sandboxed function off the main event loop. ALWAYS resolves (never
 * rejects) with a SandboxResult + collected edits. A hung/errored worker
 * resolves with `status: "timeout"|"error"` for that single invocation — the
 * main event loop is never blocked. The sync fallback is used ONLY when the
 * pool is structurally unavailable (worker file missing or explicitly disabled).
 */
export async function runSandboxedWithSdkAsync(
  transpiled: string,
  input: unknown,
  snapshot: OntologySnapshot,
): Promise<SandboxAsyncResult> {
  if (!POOL_ENABLED || !workerFile) {
    return runSandboxedWithSdkSync(transpiled, input, snapshot);
  }
  return submitToPool({ transpiled, input, snapshot });
}

/**
 * Inline (main-thread) execution — the structural fallback, used only when the
 * worker pool is unavailable. Exported for direct unit testing.
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

// Test-only: reset pool state.
export function __resetPoolForTests(): void {
  poolInitialized = false;
  pool.length = 0;
  queue.length = 0;
  nextTaskId = 1;
}
