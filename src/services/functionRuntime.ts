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
  /**
   * Set when the function returned a Promise (async). `vm.runInContext` is
   * synchronous and cannot await it, so the sandbox hands the pending Promise
   * to the caller (the worker, or the sync fallback) which resolves it under
   * the timeout via `awaitSandboxPromise`. Always undefined once settled / on
   * the wire (Promises can't cross postMessage).
   */
  pendingPromise?: Promise<unknown>;
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

// ---------------------------------------------------------------------------
// Ontology-aware runtime — runs a TypeScript Function v2 with a real Ontology
// SDK injected. Unlike `runSandboxed`, this builds ONE context that holds the
// SDK, then both compiles AND invokes the user function in it — so the
// function's closure resolves `Objects`/`Edits` (whether referenced as ambient
// globals or imported via the `require` shim below).
//
// The SDK reaches the function two ways, mirroring Foundry's authoring styles:
//   • `import { Objects, Edits } from "@foundry/functions"`  (transpiles to
//     `require("@foundry/functions")` → resolved by the shim), and
//   • bare ambient `Objects` / `Edits` references.
// Unknown module specifiers throw, like Foundry's restricted runtime.
// ---------------------------------------------------------------------------

/** Module specifiers whose `require(...)` resolves to the injected Ontology SDK. */
const SDK_MODULE_SPECIFIERS = new Set([
  "@foundry/functions",
  "@foundry/functions-api",
  "@foundry/ontology-api",
  "@ontology/sdk",
  "@osdk/functions",
  "@osdk/client",
]);

export function runSandboxedWithSdk(
  transpiledCjs: string,
  input: unknown,
  sdkGlobals: Record<string, unknown>,
): SandboxResult {
  const start = Date.now();
  const logs: string[] = [];
  const sandboxConsole = {
    log: (...a: unknown[]) => logs.push(a.map(stringify).join(" ")),
    error: (...a: unknown[]) => logs.push("[err] " + a.map(stringify).join(" ")),
    warn: (...a: unknown[]) => logs.push(a.map(stringify).join(" ")),
    info: (...a: unknown[]) => logs.push(a.map(stringify).join(" ")),
  };

  // The SDK namespace returned by `require(<known module>)` and also spread as
  // ambient globals. Numeric type aliases are identity no-ops (types are erased
  // at transpile; only value-position uses would hit these).
  const numericAlias = (x: unknown) => x;
  const sdkNamespace: Record<string, unknown> = {
    ...sdkGlobals,
    Integer: numericAlias, Long: numericAlias, Float: numericAlias,
    Double: numericAlias, Short: numericAlias, Byte: numericAlias,
    // No-op decorator factories so v1-style `@Function()` / `@Query()` /
    // `@OntologyEditFunction()` imports don't crash if present.
    Function: () => () => undefined,
    Query: () => () => undefined,
    OntologyEditFunction: () => () => undefined,
    Edits: sdkGlobals.Edits,
    createEditBatch: sdkGlobals.createEditBatch,
  };
  // The generated ontology SDK (`@ontology/sdk`) exposes the object-TYPE
  // descriptors (so `import { Flight } from "@ontology/sdk"` resolves to a
  // `{ apiName }` usable in `batch.create(Flight, …)`), plus the runtime SDK.
  const ontologyTypes = (sdkGlobals.__ontologyTypes as Record<string, unknown>) ?? {};
  const ontologySdkNamespace: Record<string, unknown> = { ...sdkNamespace, ...ontologyTypes };
  const requireShim = (spec: string): unknown => {
    if (spec === "@ontology/sdk") return ontologySdkNamespace;
    if (SDK_MODULE_SPECIFIERS.has(spec)) return sdkNamespace;
    throw new Error(
      `Cannot import "${spec}" in the Functions sandbox — only the Ontology SDK is available.`,
    );
  };

  const moduleObj: { exports: unknown } = { exports: {} };
  const context: Record<string, unknown> = {
    module: moduleObj,
    exports: moduleObj.exports,
    require: requireShim,
    console: sandboxConsole,
    __input: input,
    __result: undefined,
    ...sdkGlobals, // ambient Objects / Edits
  };
  vm.createContext(context);

  // Phase 1 — evaluate the module to populate module.exports.
  try {
    new vm.Script(transpiledCjs, { filename: "user-function.js" }).runInContext(context, {
      timeout: FUNCTION_TIMEOUT_MS,
      breakOnSigint: true,
    });
  } catch (err) {
    return errorResult(start, logs, err);
  }

  const exported = (context.module as { exports: unknown }).exports;
  const fn =
    typeof exported === "function"
      ? exported
      : exported && typeof (exported as Record<string, unknown>).default === "function"
        ? (exported as Record<string, unknown>).default
        : undefined;
  if (typeof fn !== "function") {
    return {
      output: null, durationMs: Date.now() - start, status: "error", logs,
      errorMessage: "Function source must export a callable (export default fn).",
    };
  }
  context.__fn = fn;

  // Phase 2 — invoke it against the input, in the SAME context.
  try {
    new vm.Script("__result = __fn(__input);").runInContext(context, {
      timeout: FUNCTION_TIMEOUT_MS,
      breakOnSigint: true,
    });
  } catch (err) {
    return errorResult(start, logs, err);
  }

  const out = context.__result;
  if (out && typeof (out as { then?: unknown }).then === "function") {
    // Foundry Functions v2 are async (Promise<T>). vm.runInContext is sync and
    // can't await — hand the pending Promise to the caller via `pendingPromise`;
    // the worker / sync fallback resolves it under the timeout (awaitSandboxPromise).
    return {
      output: undefined,
      pendingPromise: out as Promise<unknown>,
      durationMs: Date.now() - start,
      status: "ok",
      logs,
    };
  }
  return { output: out, durationMs: Date.now() - start, status: "ok", logs };
}

/**
 * Resolve a Promise returned by an async sandbox function, with a hard timeout.
 * `vm` can't time a Promise, so the consumer (worker / sync fallback) calls this
 * after `runSandboxedWithSdk` returns a `pendingPromise`. Always resolves (never
 * rejects) to { output, status, errorMessage? }: ok / error (rejection) / timeout.
 */
export async function awaitSandboxPromise(
  p: Promise<unknown>,
  timeoutMs: number = FUNCTION_TIMEOUT_MS,
): Promise<{
  output: unknown;
  status: "ok" | "error" | "timeout";
  errorMessage?: string;
}> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Function exceeded the ${timeoutMs}ms budget.`)),
      timeoutMs,
    );
  });
  try {
    const output = await Promise.race([p, timeout]);
    return { output, status: "ok" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes("exceeded the");
    return {
      output: undefined,
      status: isTimeout ? "timeout" : "error",
      errorMessage: msg,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function errorResult(start: number, logs: string[], err: unknown): SandboxResult {
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
