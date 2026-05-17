// ---------------------------------------------------------------------------
// functionRuntime.ts — sandboxed JavaScript / TypeScript function runtime
// ---------------------------------------------------------------------------
// Ontology Platform spec §Task 18 — function execution must be isolated and
// hard-capped at 5s. Production-grade Palantir uses isolated-vm; we use
// Node's built-in `vm` module which gives us:
//   • a fresh context per invocation (no globals leak between calls)
//   • a CPU timeout enforced by V8 (kills the script when it overruns)
//   • no `require`, no `process`, no `fs`, no network
//
// The sandbox accepts either a CommonJS-style module (`module.exports = …`)
// or an ES-style default export expression that evaluates to a function.
// We intentionally do NOT support imports — sandboxed code is pure compute.
// ---------------------------------------------------------------------------

import vm from "vm";

export const FUNCTION_TIMEOUT_MS = 5000;

export interface SandboxResult {
  output: unknown;
  durationMs: number;
  status: "ok" | "error" | "timeout";
  errorMessage?: string;
  logs: string[];
}

/**
 * Compile a snippet of user code into a callable. Supports two styles:
 *
 *   // CommonJS
 *   module.exports = function(input) { return input.x + 1; };
 *
 *   // ES default-export expression (rewritten to CommonJS)
 *   export default (input) => input.x + 1;
 *
 * Throws a SyntaxError if neither shape produces a callable.
 */
function compile(source: string): (input: unknown) => unknown {
  const normalized = source
    .replace(/^\s*export\s+default\s+/m, "module.exports = ")
    .replace(/^\s*import[^;]*;?/gm, ""); // strip imports — sandbox is pure

  // Initialize `module.exports = exports = {}` so transpiled ESM code
  // (which emits `Object.defineProperty(exports, "__esModule", ...)`)
  // doesn't crash on a non-object `exports`.
  const moduleObj: { exports: unknown } = { exports: {} };
  const context: Record<string, unknown> = {
    module: moduleObj,
    exports: moduleObj.exports,
    console: undefined as unknown,
  };
  vm.createContext(context);
  const script = new vm.Script(normalized, { filename: "user-function.js" });
  script.runInContext(context, { timeout: 1000 });
  const fn = (context.module as { exports: unknown }).exports;
  if (typeof fn !== "function") {
    throw new SyntaxError(
      "Function source must export a callable (export default fn or module.exports = fn).",
    );
  }
  return fn as (input: unknown) => unknown;
}

/**
 * Execute a user function against a single input. Hard timeout enforced by
 * `vm.runInContext`'s V8 timer. Logs captured via a sandboxed `console`
 * shim so user code can debug without touching the host process.
 */
export function runSandboxed(
  source: string,
  input: unknown,
): SandboxResult {
  const start = Date.now();
  const logs: string[] = [];

  let fn: (input: unknown) => unknown;
  try {
    fn = compile(source);
  } catch (err) {
    return {
      output: null,
      durationMs: Date.now() - start,
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      logs,
    };
  }

  // Build a per-call context with a sandboxed console and the input.
  const sandboxConsole = {
    log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => logs.push("[err] " + args.map(String).join(" ")),
  };
  const context: Record<string, unknown> = {
    __fn: fn,
    __input: input,
    __result: undefined,
    console: sandboxConsole,
  };
  vm.createContext(context);

  try {
    new vm.Script("__result = __fn(__input);").runInContext(context, {
      timeout: FUNCTION_TIMEOUT_MS,
      breakOnSigint: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout =
      msg.includes("Script execution timed out") ||
      msg.includes("Script execution was interrupted");
    return {
      output: null,
      durationMs: Date.now() - start,
      status: isTimeout ? "timeout" : "error",
      errorMessage: msg,
      logs,
    };
  }

  // Resolve a returned promise (with the same hard cap).
  const out = context.__result;
  if (out && typeof (out as { then?: unknown }).then === "function") {
    // Promises can't be safely timed by vm; resolve synchronously by
    // requiring user functions to be synchronous. Promise returns are
    // surfaced as an error to keep timeout semantics honest.
    return {
      output: null,
      durationMs: Date.now() - start,
      status: "error",
      errorMessage: "Async functions are not supported in the sandbox runtime.",
      logs,
    };
  }

  return {
    output: out,
    durationMs: Date.now() - start,
    status: "ok",
    logs,
  };
}
