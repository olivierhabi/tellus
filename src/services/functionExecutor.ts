// ---------------------------------------------------------------------------
// functionExecutor.ts — the Function execution boundary.
//
// Every sandbox invocation flows through the FunctionExecutor interface so
// the isolation substrate can be moved (worker_threads → isolated process →
// container/microVM) behind a stable contract without touching callers.
//
// HONEST ISOLATION POSTURE (do not overclaim):
//   The current production executor (WorkerPoolFunctionExecutor) runs user
//   code with Node's `vm` module inside a `worker_threads` Worker. That is
//   NOT a security boundary: `vm` contexts share the heap with the host
//   thread within the same process. The mitigations in place today:
//     • user code runs OUTSIDE the API request event loop (worker thread)
//     • per-invocation CPU timeout enforced by V8 (FUNCTION_TIMEOUT_MS)
//     • per-worker V8 old-space cap (resourceLimits)
//     • worker env whitelist (NODE_ENV/TZ only — no credentials, no PATH/HOME)
//     • require() shim: only the Ontology SDK resolves; unknown imports
//       throw at evaluation, and publication rejects unsupported imports
//       before artifacts are stored
//     • no network/filesystem API is exposed to the sandbox context
//     • codeGeneration DISABLED in every sandbox context (no eval / Function /
//       WebAssembly string compilation inside the guest realm)
//     • REALM BOUNDARY (functions/sandboxBoundary.ts, Strix CWE-94 2026):
//       every host value crossing into the context is trap-sealed so
//       `.constructor`/`__proto__` chains resolve to the guest realm's own
//       intrinsics — the host Function constructor is unreachable, closing
//       the demonstrated constructor-chain escape class in-process
//     • escape-probe source scans (observable, not a control) reject naive
//       `.constructor`/`__proto__`/`.mainModule` patterns at preview and
//       publish time
//
// REMAINING GAP (unchanged in kind, reduced in reach): a vm context still
//   shares the heap with the host process — the realm boundary closes all
//   KNOWN in-process escape vectors but is not a substitute for isolation.
//   Full isolation (separate process with seccomp, or container/microVM per
//   execution with default-deny egress) remains the declared target
//   architecture; this interface is its seam.
// ---------------------------------------------------------------------------

import type { OntologySnapshot } from "./functions/ontologyRuntime";
import type {
  SandboxBinding,
  SignatureParameter,
} from "./functionRuntime";
import type { SandboxAsyncResult } from "./functionWorkerPool";

export interface FunctionExecutionRequest {
  /** Transpiled CommonJS artifact (publication-built, immutable). */
  readonly transpiled: string;
  /** Resolved parameter values keyed by published parameter name. */
  readonly input: unknown;
  readonly snapshot: OntologySnapshot;
  /** Persisted invocation contract + published parameter metadata. */
  readonly binding?: SandboxBinding | SignatureParameter[];
}

/**
 * The execution contract. Implementations MUST always resolve (never
 * reject): failures are represented as SandboxAsyncResult.status.
 */
export interface FunctionExecutor {
  execute(request: FunctionExecutionRequest): Promise<SandboxAsyncResult>;
}
