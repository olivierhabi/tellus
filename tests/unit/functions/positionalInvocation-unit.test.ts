// ---------------------------------------------------------------------------
// positionalInvocation — typescript-v2-positional-v2 runtime invocation.
//
// The new contract: every configured parameter resolves BY PUBLISHED NAME
// and the function is invoked POSITIONALLY in PUBLISHED ORDER. No wrapper
// object is ever passed; the first declared parameter is never skipped;
// no synthetic client is assumed; fn.length is never consulted.
// Legacy-contract behavior is preserved byte-identically.
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import {
  buildPositionalCallArgs,
  type SandboxBinding,
} from "../../../src/services/functionRuntime";
import { runSandboxedWithSdkSync } from "../../../src/services/functionWorkerPool";
import {
  readCanonicalSignature,
  runtimeParametersFromCanonical,
  TYPESCRIPT_V2_POSITIONAL_V2,
  LEGACY_OBJECT_ENVELOPE_V1,
} from "../../../src/services/functions/canonicalSignature";
import type { OntologySnapshot } from "../../../src/services/functions/ontologyRuntime";

const EMPTY: OntologySnapshot = {
  byType: new Map(),
  ontologyId: "ont-1",
  objectCount: 0,
  objectTypes: [],
};

function bindingFor(rawSignature: unknown): SandboxBinding {
  const canonical = readCanonicalSignature(rawSignature);
  return {
    contract: TYPESCRIPT_V2_POSITIONAL_V2,
    parameters: runtimeParametersFromCanonical(canonical),
  };
}

describe("buildPositionalCallArgs", () => {
  it("builds args in published order, never the bag", () => {
    const args = buildPositionalCallArgs(
      { zeta: "Z", alpha: "A" },
      [
        { name: "alpha", position: 0, optional: false },
        { name: "zeta", position: 1, optional: false },
      ],
    );
    expect(args).toEqual(["A", "Z"]);
  });

  it("zero parameters → empty arg list", () => {
    expect(buildPositionalCallArgs({}, [])).toEqual([]);
  });

  it("injected client params receive the stub, resolved params skip it", () => {
    const args = buildPositionalCallArgs(
      { orderId: "o-1" },
      [
        { name: "client", position: 0, optional: false, injected: "client" },
        { name: "orderId", position: 1, optional: false },
      ],
    );
    expect(args).toHaveLength(2);
    expect(args[1]).toBe("o-1");
    expect(Object.is(args[0], args[1])).toBe(false);
    let threw = false;
    try {
      (args[0] as Record<string, unknown>).query;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("typescript-v2-positional-v2 execution", () => {
  it("helloWorld(name: string) receives the value — never the wrapper object", async () => {
    const transpiled = `
      module.exports = function helloWorld(name) {
        return "Hello, " + name;
      };
    `;
    const r = await runSandboxedWithSdkSync(
      transpiled,
      { name: "Olivier" },
      EMPTY,
      bindingFor({
        parameters: [{ name: "name", type: "string", optional: false }],
        output: "string",
      }),
    );
    expect(r.status).toBe("ok");
    expect(r.output).toBe("Hello, Olivier");
  });

  it("zero-parameter functions are invoked as fn()", async () => {
    const r = await runSandboxedWithSdkSync(
      `module.exports = function ping() { return "pong"; };`,
      {},
      EMPTY,
      bindingFor({ parameters: [], output: "string" }),
    );
    expect(r.status).toBe("ok");
    expect(r.output).toBe("pong");
  });

  it("shuffled binding keys still bind by published order and name", async () => {
    const r = await runSandboxedWithSdkSync(
      `module.exports = function concat(a, b, c) { return [a, b, c].join("|"); };`,
      { c: "C", a: "A", b: "B" },
      EMPTY,
      bindingFor({
        parameters: [
          { name: "b", position: 1, type: "string", optional: false },
          { name: "a", position: 0, type: "string", optional: false },
          { name: "c", position: 2, type: "string", optional: false },
        ],
        output: "string",
      }),
    );
    expect(r.status).toBe("ok");
    expect(r.output).toBe("A|B|C");
  });

  it("a two-parameter function is NOT given a synthetic client (no skipping)", async () => {
    // The legacy heuristic would have called this (CLIENT_STUB, b).
    const r = await runSandboxedWithSdkSync(
      `module.exports = function add(a, b) { return typeof a + ":" + (a + b); };`,
      { a: 20, b: 3 },
      EMPTY,
      bindingFor({
        parameters: [
          { name: "a", type: "number", optional: false },
          { name: "b", type: "number", optional: false },
        ],
        output: "number",
      }),
    );
    expect(r.status).toBe("ok");
    expect(r.output).toBe("number:23");
  });

  it("optional omitted parameters preserve JavaScript default-parameter behavior", async () => {
    const r = await runSandboxedWithSdkSync(
      `module.exports = function greet(name, punctuation = "!") {
         return "Hello, " + name + punctuation;
       };`,
      { name: "Olivier" },
      EMPTY,
      bindingFor({
        parameters: [
          { name: "name", position: 0, type: "string", optional: false, hasDefault: false },
          { name: "punctuation", position: 1, type: "string", optional: true, hasDefault: true },
        ],
        output: "string",
      }),
    );
    expect(r.status).toBe("ok");
    expect(r.output).toBe("Hello, Olivier!");
  });

  it("async functions are awaited", async () => {
    const r = await runSandboxedWithSdkSync(
      `module.exports = async function slow(name) {
         return "Hello, " + name;
       };`,
      { name: "Olivier" },
      EMPTY,
      bindingFor({
        parameters: [{ name: "name", type: "string", optional: false }],
        output: "Promise<string>",
      }),
    );
    expect(r.status).toBe("ok");
    expect(r.output).toBe("Hello, Olivier");
  });

  it("typed values arrive typed (numbers stay numbers, booleans stay booleans)", async () => {
    const r = await runSandboxedWithSdkSync(
      `module.exports = function types(label, count, enabled) {
         return [typeof label, typeof count, typeof enabled, count + 1, !enabled].join(",");
       };`,
      { label: "x", count: 41, enabled: false },
      EMPTY,
      bindingFor({
        parameters: [
          { name: "label", position: 0, type: "string", optional: false },
          { name: "count", position: 1, type: "number", optional: false },
          { name: "enabled", position: 2, type: "boolean", optional: false },
        ],
        output: "string",
      }),
    );
    expect(r.status).toBe("ok");
    expect(r.output).toBe("string,number,boolean,42,true");
  });
});

describe("legacy-object-envelope-v1 execution (preserved verbatim)", () => {
  it("single-envelope functions receive the whole bindings object", async () => {
    const r = await runSandboxedWithSdkSync(
      `module.exports = function verifyMarker(input) { return "fn-v1:" + input.input; };`,
      { input: "world" },
      EMPTY,
      { contract: LEGACY_OBJECT_ENVELOPE_V1 },
    );
    expect(r.status).toBe("ok");
    expect(r.output).toBe("fn-v1:world");
  });

  it("legacy multi-param functions keep the placeholder-client convention", async () => {
    const r = await runSandboxedWithSdkSync(
      `module.exports = function fn(client, orderId, percent) {
         return [orderId, percent];
       };`,
      { orderId: "o-7", percent: 5 },
      EMPTY,
      {
        contract: LEGACY_OBJECT_ENVELOPE_V1,
        parameters: [
          { name: "client", optional: false },
          { name: "orderId", optional: false },
          { name: "percent", optional: false },
        ],
      },
    );
    expect(r.status).toBe("ok");
    expect(r.output).toEqual(["o-7", 5]);
  });

  it("a bare SignatureParameter[] binding is treated as the legacy contract", async () => {
    const r = await runSandboxedWithSdkSync(
      `module.exports = function fn(client, orderId) { return orderId; };`,
      { orderId: "legacy-1" },
      EMPTY,
      [
        { name: "client", optional: false },
        { name: "orderId", optional: false },
      ],
    );
    expect(r.status).toBe("ok");
    expect(r.output).toBe("legacy-1");
  });
});

describe("contract isolation — one contract never silently becomes the other", () => {
  it("positional contract NEVER routes a multi-param artifact through the legacy client-stub path", async () => {
    // Legacy heuristics would have parsed (client, orderId) from toString
    // and invoked fn(CLIENT_STUB, "o-9"). The persisted positional contract
    // must invoke BOTH params by published name — never fallback.
    const r = await runSandboxedWithSdkSync(
      `module.exports = function fn(client, orderId) {
         return typeof client + "|" + orderId;
       };`,
      { client: "injected-value", orderId: "o-9" },
      EMPTY,
      {
        contract: TYPESCRIPT_V2_POSITIONAL_V2,
        parameters: [
          { name: "client", position: 0, optional: false, injected: "client" as const },
          { name: "orderId", position: 1, optional: false },
        ],
      },
    );
    expect(r.status).toBe("ok");
    expect(r.output).toBe("object|o-9"); // injected stub object, real orderId
  });

  it("contract selection ignores fn.length and fn.toString entirely (minified artifact)", async () => {
    // A transpiled/minified artifact whose toString exposes mangled names
    // must still bind by PUBLISHED name+position. Under the old behavior
    // the parse would mis-bind or fall back to the envelope.
    const source = `module.exports = function x(z9, q2) { return z9 + ":" + q2; };`;
    const r = await runSandboxedWithSdkSync(
      source,
      { first: "A", second: "B" },
      EMPTY,
      {
        contract: TYPESCRIPT_V2_POSITIONAL_V2,
        parameters: [
          { name: "first", position: 0, optional: false },
          { name: "second", position: 1, optional: false },
        ],
      },
    );
    expect(r.status).toBe("ok");
    expect(r.output).toBe("A:B");
  });
});
