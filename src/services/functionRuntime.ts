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

// ---------------------------------------------------------------------------
// Palantir v2 calling convention — `(client: Client, ...params)`.
//
// TypeScript v2 Ontology edit functions declare an injected `client` as
// their FIRST parameter, followed by the Action's parameters:
//
//   export default function updateEmployee(
//     client: Client,
//     employee: Osdk.Instance<Employee>,
//   ): OntologyEdit[] { ... }
//
// The sandbox's own edit runtime (`createEditBatchImpl`) ignores the
// client — edits are collected from the returned batch — so a PLACEHOLDER
// client is sufficient for execution parity. The placeholder throws a
// precise error if user code actually calls into it (no query surface
// exists on the sandbox client; reads go through `Objects.*`).
//
// Detection is signature-based: a function declaring 2+ simple identifier
// parameters is treated as v2-style. Its declared parameter NAMES are
// mapped onto the input object's properties (Action parameters arrive by
// name), mirroring Foundry's parameter binding. Functions with 0–1 params,
// or params we cannot statically parse (destructuring/rest), keep the
// legacy single-argument convention `fn(input)` — the Workshop column
// contract `(page) => …` is untouched.
// ---------------------------------------------------------------------------

/** Placeholder for the injected v2 `client`. Edit batches ignore it. */
const CLIENT_STUB: Readonly<Record<string, never>> = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(
        `client.${String(prop)} is not available in the Functions sandbox — ` +
          "the injected client is a placeholder. Read via Objects.* and edit via createEditBatch(client).",
      );
    },
  },
);

/**
 * The runtime view of a published signature parameter — the metadata
 * written ONCE at publish time by the shared analysis
 * (functionsPublish/service.ts PublishedFunctionMetadata.signature) and
 * stored on function_registry_function_version.signature. Structurally
 * compatible with the publish-side type; redeclared here so the runtime
 * never imports the publish service.
 */
export interface SignatureParameter {
  name: string;
  optional: boolean;
  /** Immutable published ordinal (v2 signatures). Legacy metadata upgrades
   *  to the array index — NEVER object-key order. */
  position?: number;
  /** Published as an injected runtime dependency (canonical type kind
   *  "client", e.g. the Foundry v2 edit `client: Client`). Injection is
   *  signature-driven — NEVER arity-driven and never the first parameter
   *  by assumption. */
  injected?: "client";
}

/**
 * The invocation contract persisted per published immutable version
 * (function_registry_function_version.invocation_contract). Execution
 * branches ONLY on this persisted value — never on arity, fn.length, or
 * source parsing. (Mirror of canonicalSignature.ts's InvocationContract;
 * redeclared so the runtime/worker never imports the validator.)
 */
export type InvocationContract =
  | "legacy-object-envelope-v1"
  | "typescript-v2-positional-v2";

export const LEGACY_OBJECT_ENVELOPE_V1: InvocationContract =
  "legacy-object-envelope-v1";

/**
 * Execution binding handed to the sandbox: the persisted invocation
 * contract plus the published parameters. A bare SignatureParameter[]
 * argument is ACCEPTED for backward compatibility (existing callers/tests)
 * and ALWAYS treated as the legacy contract.
 */
export interface SandboxBinding {
  contract: InvocationContract;
  parameters?: SignatureParameter[];
}

export function normalizeSandboxBinding(
  binding?: SandboxBinding | SignatureParameter[],
): SandboxBinding {
  if (!binding) return { contract: LEGACY_OBJECT_ENVELOPE_V1 };
  if (Array.isArray(binding)) {
    return {
      contract: LEGACY_OBJECT_ENVELOPE_V1,
      parameters: binding.map((p, index) => ({ ...p, position: p.position ?? index })),
    };
  }
  if (binding.parameters) {
    return {
      contract: binding.contract,
      parameters: binding.parameters.map((p, index) => ({
        ...p,
        position: p.position ?? index,
      })),
    };
  }
  return { contract: binding.contract };
}

/**
 * Validate registry/manifest signature metadata for binding. Returns the
 * parameter list when well-formed, or null when the metadata is absent or
 * malformed — callers then use the legacy fn.toString() path (fail-safe).
 * `optional` must be an explicit boolean; anything else is malformed.
 */
export function parseSignatureParameters(raw: unknown): SignatureParameter[] | null {
  if (!raw || typeof raw !== "object") return null;
  const parameters = (raw as { parameters?: unknown }).parameters;
  if (!Array.isArray(parameters) || parameters.length === 0) return null;
  const parsed: SignatureParameter[] = [];
  for (const entry of parameters) {
    if (!entry || typeof entry !== "object") return null;
    const name = (entry as { name?: unknown }).name;
    const optional = (entry as { optional?: unknown }).optional;
    if (typeof name !== "string" || name.length === 0) return null;
    if (typeof optional !== "boolean") return null;
    parsed.push({ name, optional });
  }
  return parsed;
}

/**
 * Best-effort extraction of a function's declared parameter names from its
 * source. Returns null when the signature is not a simple identifier list
 * (destructuring, rest, or an unparseable shape) — callers then fall back
 * to the legacy single-argument call.
 */
function declaredParamNames(fn: (...args: never[]) => unknown): string[] | null {
  const src = Function.prototype.toString.call(fn).trim();
  const match =
    /^(?:async\s+)?function\s*[\w$]*\s*\(([^)]*)\)/.exec(src) ??
    /^(?:async\s+)?\(([^)]*)\)\s*=>/.exec(src) ??
    /^(?:async\s+)?([\w$]+)\s*=>/.exec(src);
  if (!match) return null;
  const raw = (match[1] ?? match[2] ?? "").trim();
  if (raw === "") return [];
  const names = raw.split(",").map((part) => part.split("=")[0].trim());
  if (names.some((name) => !/^[\w$]+$/.test(name))) return null;
  return names;
}

/**
 * Build the invocation argument list for a v2-style function
 * `(client, ...params)`: the placeholder client first, then each declared
 * parameter resolved BY NAME from the input object (Foundry binds Action
 * parameters by name). Returns null for legacy single-arg functions.
 *
 * Phase 4: when published signature metadata is supplied (the exact
 * pinned version's registry signature), the PUBLISHED names/order/
 * optionality are the primary binding source — the fn.toString() parse
 * is only a cross-check. A minified/transformed artifact whose toString
 * is unusable (or whose params were renamed) still binds correctly.
 * When both sources are readable they must agree on ARITY: a mismatch
 * means the metadata contradicts the selected artifact and execution
 * fails closed (throws) rather than binding garbage.
 */
function buildV2CallArgs(
  fn: (...args: never[]) => unknown,
  input: unknown,
  signatureParams?: SignatureParameter[],
): unknown[] | null {
  const bag =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (signatureParams && signatureParams.length >= 2) {
    const declared = declaredParamNames(fn);
    // Cross-check only a MEANINGFUL parse: null (unparseable) and []
    // (native/bound toString, e.g. wrapped or transformed artifacts)
    // carry no information, so the metadata wins. A parse that
    // recovered real names must agree on arity — minification renames
    // but never changes arity; a mismatch means the metadata was
    // written for a different artifact (fail closed).
    if (declared !== null && declared.length > 0 && declared.length !== signatureParams.length) {
      throw new Error(
        `Published signature metadata contradicts the function artifact: ` +
          `registry declares ${signatureParams.length} parameter(s) ` +
          `(${signatureParams.map((p) => p.name).join(", ")}) but the ` +
          `artifact declares ${declared.length} (${declared.join(", ")}).`,
      );
    }
    return [CLIENT_STUB, ...signatureParams.slice(1).map((p) => bag[p.name])];
  }
  const params = declaredParamNames(fn);
  if (!params || params.length < 2) return null;
  return [CLIENT_STUB, ...params.slice(1).map((name) => bag[name])];
}

/**
 * Positional v2 invocation (typescript-v2-positional-v2): every declared
 * parameter is resolved BY PUBLISHED NAME and invoked POSITIONALLY in
 * PUBLISHED ORDER. Zero params → fn(); one param → fn(value); many →
 * fn(a, b, ...). Omitted optional parameters pass `undefined` so declared
 * JS defaults apply. A parameter published as injected ("client") receives
 * the placeholder client — signature-driven, never positional assumption.
 * The full parameter object is NEVER passed as an argument here.
 */
export function buildPositionalCallArgs(
  input: unknown,
  parameters: SignatureParameter[] | undefined,
): unknown[] {
  const bag =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return [...(parameters ?? [])]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((parameter) =>
      parameter.injected === "client" ? CLIENT_STUB : bag[parameter.name],
    );
}

/**
 * Single entry point for argument construction. Branches ONLY on the
 * persisted invocation contract:
 *   • typescript-v2-positional-v2 → buildPositionalCallArgs (never null)
 *   • legacy-object-envelope-v1   → buildV2CallArgs (byte-identical
 *     pre-contract behavior; null keeps the single-envelope fallback)
 */
function buildSandboxCallArgs(
  fn: (...args: never[]) => unknown,
  input: unknown,
  binding: SandboxBinding,
): unknown[] | null {
  if (binding.contract === "typescript-v2-positional-v2") {
    return buildPositionalCallArgs(input, binding.parameters);
  }
  return buildV2CallArgs(fn, input, binding.parameters);
}

export function runSandboxedWithSdk(
  transpiledCjs: string,
  input: unknown,
  sdkGlobals: Record<string, unknown>,
  binding?: SandboxBinding | SignatureParameter[],
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
  // v2-style `(client, ...params)` functions get the placeholder client
  // plus per-parameter values bound BY NAME from the input; everything
  // else keeps the single-argument convention. When published signature
  // metadata is supplied it is the PRIMARY binding source; a metadata/
  // artifact contradiction fails closed as a sandbox error (no garbage
  // binding, no execution).
  let callArgs: unknown[] | null;
  try {
    callArgs = buildSandboxCallArgs(
      fn as (...args: never[]) => unknown,
      input,
      normalizeSandboxBinding(binding),
    );
  } catch (err) {
    return {
      output: null,
      durationMs: Date.now() - start,
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      logs,
    };
  }
  context.__callArgs = callArgs;
  const callExpression = callArgs
    ? "__result = __fn(...__callArgs);"
    : "__result = __fn(__input);";
  try {
    new vm.Script(callExpression).runInContext(context, {
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
