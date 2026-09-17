// ---------------------------------------------------------------------------
// sandboxEscapeHardening — realm-boundary + codegen hardening tests
// (Strix CWE-94 finding, Sept 2026).
//
// The live pentest escaped the vm sandbox in <5ms through three vectors:
//   console.log.constructor("return process")()
//   Objects.search("X").constructor.constructor(...)
//   require.constructor("return process")()
// The hardening: (a) codeGeneration disabled in every sandbox context, and
// (b) every host value that crosses into the context is trap-sealed
// (functions/sandboxBoundary.ts) so `.constructor`/`__proto__` resolve to
// the GUEST realm's own (codegen-disabled) intrinsics. Every vector below
// must now fail CLOSED, while the legitimate function surface keeps working.
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import {
  runSandboxed,
  runSandboxedWithSdk,
  scanSourceForEscapePatterns,
} from "../../../src/services/functionRuntime";
import { transpileForInvoke } from "../../../src/services/codeRepository/admin/routers/functionInvokePhases";
import { typeCheckRepository } from "../../../src/services/functionsPublish/typeCheck";

/** A host SDK object standing in for an ObjectSet returned by Objects.search. */
const hostObjectSet = { marker: "ObjectSet", rows: [{ pk: "row-1" }] };
const sdkGlobals = {
  Objects: { search: (): unknown => hostObjectSet },
  Edits: { create: () => "edit" },
};

/** The exact escape payload the pentest executed successfully. */
const ESCAPE_SOURCE = `module.exports = function() { return console.log.constructor("return process")(); };`;

describe("vm realm boundary — escape vectors fail closed", () => {
  it("console.log.constructor('return process')() is blocked (Strix PoC #1)", () => {
    const result = runSandboxedWithSdk(ESCAPE_SOURCE, {}, {});
    expect(result.status).toBe("error");
    expect(result.output).toBeNull();
    // The escape payload's JSON shape must never appear in output or logs.
    expect(JSON.stringify(result)).not.toContain("typeofProcess");
  });

  it("Objects.search().constructor.constructor(...) is blocked (Strix PoC #2)", () => {
    const result = runSandboxedWithSdk(
      `module.exports = function() { return Objects.search("X").constructor.constructor("return process")(); };`,
      {},
      sdkGlobals,
    );
    expect(result.status).toBe("error");
  });

  it("require.constructor('return process')() is blocked (Strix PoC #3)", () => {
    const result = runSandboxedWithSdk(
      `module.exports = function() { return require.constructor("return process")(); };`,
      {},
      {},
    );
    expect(result.status).toBe("error");
  });

  it("direct eval / Function / WebAssembly string compilation is blocked in the guest realm", () => {
    for (const source of [
      `module.exports = function() { return eval("1+1"); };`,
      `module.exports = function() { return Function("return 42")(); };`,
      `module.exports = function() { return new Function("return 42")(); };`,
    ]) {
      const result = runSandboxedWithSdk(source, {}, {});
      expect(result.status).toBe("error");
    }
  });

  it("__proto__ prototype walks are blocked", () => {
    const result = runSandboxedWithSdk(
      `module.exports = function() { return console.log.__proto__.constructor.constructor("return process")(); };`,
      {},
      {},
    );
    expect(result.status).toBe("error");
  });

  it("input.constructor.constructor escape via the legacy runSandboxed surface is blocked", () => {
    const result = runSandboxed(
      `module.exports = function(input) { return input.constructor.constructor("return process")(); };`,
      { x: 1 },
    );
    expect(result.status).toBe("error");
  });

  it("module/exports objects do not expose the host Object constructor", () => {
    const result = runSandboxedWithSdk(
      `module.exports = function() { return { m: typeof module.constructor, e: typeof exports.constructor }; };`,
      {},
      {},
    );
    // The GUEST Function constructor is reachable (it is the guest realm's
    // own — codegen-disabled), but it cannot compile strings.
    expect(result.status).toBe("ok");
    expect(result.output).toEqual({ m: "function", e: "function" });
    const compile = runSandboxedWithSdk(
      `module.exports = function() { return module.constructor("return process")(); };`,
      {},
      {},
    );
    expect(compile.status).toBe("error");
  });
});

describe("vm realm boundary — legitimate surface keeps working", () => {
  it("runs sync functions with input, console, ambient SDK and the require shim", () => {
    const result = runSandboxedWithSdk(
      `module.exports = function(input) {
         console.log("computing");
         const sdk = require("@foundry/functions");
         return { sum: input.a + input.b, marker: sdk.Objects.search("T").marker, alias: sdk.Integer(41) + 1 };
       };`,
      { a: 2, b: 3 },
      sdkGlobals,
    );
    expect(result.status).toBe("ok");
    expect(result.output).toEqual({ sum: 5, marker: "ObjectSet", alias: 42 });
    expect(result.logs).toEqual(["computing"]);
  });

  it("restores the original host object when a function returns an SDK value (identity round-trip)", () => {
    const result = runSandboxedWithSdk(
      `module.exports = function() { return Objects.search("T"); };`,
      {},
      sdkGlobals,
    );
    expect(result.status).toBe("ok");
    expect(result.output).toBe(hostObjectSet);
  });

  it("hands async functions a pendingPromise + unseal hook, and resolved outputs unwrap", async () => {
    const result = runSandboxedWithSdk(
      `module.exports = async function(input) { return { done: true, k: input.k, rows: Objects.search("T").rows }; };`,
      { k: 7 },
      sdkGlobals,
    );
    // Guest-realm promise: not instanceof the host Promise (cross-realm),
    // but awaitable — the worker/pool await it directly.
    expect(typeof (result.pendingPromise as { then?: unknown }).then).toBe("function");
    expect(typeof result.unsealOutput).toBe("function");
    const settled = await result.pendingPromise;
    const out = result.unsealOutput!(settled) as Record<string, unknown>;
    expect(out.done).toBe(true);
    expect(out.k).toBe(7);
    expect((out.rows as unknown[]).length).toBe(1);
  });

  it("propagates host exception messages across the boundary", () => {
    const result = runSandboxedWithSdk(
      `module.exports = function() { throw new Error("boom"); };`,
      {},
      {},
    );
    expect(result.status).toBe("error");
    expect(result.errorMessage).toContain("boom");
  });
});

describe("scanSourceForEscapePatterns (defense-in-depth, not a security control)", () => {
  it("flags the escape probe patterns", () => {
    expect(scanSourceForEscapePatterns(ESCAPE_SOURCE)).toContain(".constructor member access");
    expect(scanSourceForEscapePatterns("const x = input.__proto__;")).toContain("__proto__ reference");
    expect(scanSourceForEscapePatterns("process.mainModule.require")).toContain(".mainModule member access");
    expect(scanSourceForEscapePatterns("return input.a + input.b;")).toEqual([]);
  });

  it("keeps ordinary class constructor syntax legal", () => {
    expect(scanSourceForEscapePatterns("class Foo { constructor(v) { this.v = v; } }")).toEqual([]);
    expect(scanSourceForEscapePatterns("export default function calc(x) { return x * 2; }")).toEqual([]);
  });
});

describe("escape-pattern rejection at invoke/publish surfaces", () => {
  it("transpileForInvoke rejects escape-probe sources with FunctionSourceRejected", () => {
    const result = transpileForInvoke("escapeProbe", ESCAPE_SOURCE);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.errorName).toBe("CodeRepos:FunctionSourceRejected");
      expect(String(result.parameters.reason)).toContain(".constructor");
    }
  });

  it("typeCheckRepository (jemma lint stage) rejects escape-probe function sources", () => {
    const result = typeCheckRepository([
      {
        path: "typescript-functions/src/functions/escapeProbe.ts",
        source: ESCAPE_SOURCE.replace("module.exports = function()", "export default function()"),
        kind: "function",
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.message.includes("escape probe pattern"))).toBe(true);
  });

  it("typeCheckRepository still accepts clean function sources", () => {
    const result = typeCheckRepository([
      {
        path: "typescript-functions/src/functions/legit.ts",
        source: "export default function calc(x: number): number { return x * 2; }",
        kind: "function",
      },
    ]);
    expect(result.ok).toBe(true);
  });
});
