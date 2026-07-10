// ---------------------------------------------------------------------------
// functionWorker.ts — the worker_threads entry point for sandboxed function
// execution.
//
// WHY A WORKER: `vm.Script.runInContext` is SYNCHRONOUS — it blocks the Node
// event loop for up to FUNCTION_TIMEOUT_MS (5s) per phase. A Workshop Object
// Table fires function invokes concurrently with object-search reads; a
// sandbox running to its cap starved the concurrent ~6ms search past its
// request budget → 504. Moving execution here means the sandbox blocks THIS
// worker's event loop, not the main thread's, so request handling stays
// responsive. (See functionWorkerPool.ts for the pool + sync fallback.)
//
// LOADING: this file is `.ts`. In dev it is loaded via tsx (the main thread
// passes `--require tsx/cjs` in execArgv); in prod tsc compiles it to `.js`
// and it is loaded with plain node (no tsx, not installed in prod). It uses
// `import` syntax so both paths work.
// ---------------------------------------------------------------------------

import { parentPort } from "worker_threads";
import {
  buildOntologySdk,
  type OntologySnapshot,
  type OntologyEdit,
} from "./functions/ontologyRuntime";
import { runSandboxedWithSdk, awaitSandboxPromise, type SandboxResult } from "./functionRuntime";

interface WorkerRequest {
  /** Correlates the response with the pending task on the main thread. */
  readonly id: number;
  readonly transpiled: string;
  readonly input: unknown;
  readonly snapshot: OntologySnapshot;
}

interface WorkerResponse {
  readonly id: number;
  readonly result: SandboxResult;
  readonly edits: OntologyEdit[];
  /** Object types the function queried via Objects.search/get (post-run). */
  readonly requestedTypes: string[];
}

if (!parentPort) {
  // Should be impossible — this module only runs inside a Worker.
  throw new Error("functionWorker.ts must be spawned as a worker_threads Worker");
}
const port = parentPort;

port.on("message", async (msg: WorkerRequest) => {
  const { id, transpiled, input, snapshot } = msg;
  try {
    const { sdk, getEdits, getRequestedTypes } = buildOntologySdk(snapshot);
    let result: SandboxResult = runSandboxedWithSdk(transpiled, input, {
      Objects: sdk.Objects,
      Edits: sdk.Edits,
      createEditBatch: sdk.createEditBatch,
      __ontologyTypes: sdk.objectTypeDescriptors,
    });
    // Async function: the sandbox returned a Promise (vm can't await it).
    // Resolve it here under the timeout BEFORE posting — Promises can't cross
    // postMessage. The pool's wall budget is the backstop; the per-Promise
    // timeout (FUNCTION_TIMEOUT_MS) is tighter.
    if (result.pendingPromise) {
      const settled = await awaitSandboxPromise(result.pendingPromise);
      result = {
        ...result,
        output: settled.output,
        status: settled.status,
        errorMessage: settled.errorMessage,
        pendingPromise: undefined,
      };
    }
    const edits: OntologyEdit[] =
      result.status === "ok" ? getEdits() : [];
    // Requested types are collected regardless of run status — a function
    // that queried a non-imported type then threw still surfaces the warning.
    const requestedTypes = getRequestedTypes();
    const response: WorkerResponse = { id, result, edits, requestedTypes };
    port.postMessage(response);
  } catch (err) {
    // runSandboxedWithSdk catches its own vm errors; this is a belt-and-braces
    // guard for any unexpected throw (e.g. a non-cloneable return value).
    const result: SandboxResult = {
      output: null,
      durationMs: 0,
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      logs: [],
    };
    const response: WorkerResponse = { id, result, edits: [], requestedTypes: [] };
    port.postMessage(response);
  }
});

// Tell the main thread the worker loaded successfully (especially important
// under tsx, where a loader failure would otherwise only surface as a silent
// hang until the wall budget fires).
port.postMessage({ type: "__ready__" });
