// ---------------------------------------------------------------------------
// functionSignatureBinding — Phase 4 unit tests.
//
// Registry/manifest signature metadata (written ONCE by the shared
// publish-time analysis) is the PRIMARY runtime-binding path. The
// fn.toString() parser remains as the legacy fallback with its
// fail-safe behavior unchanged.
//
// Covers:
//   • minified/transformed artifact whose toString() parameter names
//     are unusable → binds correctly from metadata
//   • artifact whose toString() is unparseable (destructured/rest
//     params) → binds correctly from metadata
//   • parameter ORDERING comes from the metadata
//   • OPTIONAL parameters bind undefined when absent (defaults apply)
//   • metadata/artifact ARITY contradiction → fail closed (error)
//   • missing metadata → legacy fallback (unchanged behavior)
//   • malformed metadata → parseSignatureParameters rejects → fallback
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import {
  parseSignatureParameters,
  type SignatureParameter,
} from "../../../src/services/functionRuntime";
import { runSandboxedWithSdkSync } from "../../../src/services/functionWorkerPool";
import type { OntologySnapshot } from "../../../src/services/functions/ontologyRuntime";

const EMPTY: OntologySnapshot = {
  byType: new Map(),
  ontologyId: "ont-1",
  objectCount: 0,
  objectTypes: [],
};

const sig = (
  ...params: Array<[string, boolean]>
): SignatureParameter[] => params.map(([name, optional]) => ({ name, optional }));

describe("parseSignatureParameters — metadata validation", () => {
  it("accepts a well-formed signature", () => {
    expect(
      parseSignatureParameters({
        parameters: [
          { name: "client", type: "Client", optional: false },
          { name: "order", type: "Osdk.Instance<Order>", optional: false },
          { name: "percent", type: "number", optional: true },
        ],
        output: "Edits.Object<Order>[]",
      }),
    ).toEqual(sig(["client", false], ["order", false], ["percent", true]));
  });

  it.each([
    ["null", null],
    ["non-object", "nope"],
    ["empty object (legacy default '{}'::jsonb)", {}],
    ["parameters not an array", { parameters: "nope" }],
    ["empty parameters", { parameters: [] }],
    ["entry not an object", { parameters: [42] }],
    ["name not a string", { parameters: [{ name: 5, optional: false }] }],
    ["name empty", { parameters: [{ name: "", optional: false }] }],
    ["optional missing", { parameters: [{ name: "x" }] }],
    ["optional not boolean", { parameters: [{ name: "x", optional: "yes" }] }],
  ])("rejects malformed metadata: %s", (_label, raw) => {
    expect(parseSignatureParameters(raw)).toBeNull();
  });
});

describe("metadata-primary binding (Phase 4)", () => {
  it("binds from metadata when the artifact is minified (toString names unusable)", async () => {
    // A minifier renames parameters: toString() yields (a, b), which
    // cannot resolve `orderId`/`percent` from the input bag.
    const MINIFIED = `
      module.exports = function applyPercentIncrease(a, b, c) {
        return [b, c];
      };
    `;
    const metadata = sig(["client", false], ["orderId", false], ["percent", false]);
    const r = await runSandboxedWithSdkSync(
      MINIFIED,
      { orderId: "o-1", percent: 10 },
      EMPTY,
      metadata,
    );
    expect(r.status).toBe("ok");
    expect(r.output).toEqual(["o-1", 10]);
  });

  it("binds from metadata when toString() is unparseable (bound/wrapped export)", async () => {
    // A bundler wrap via .bind() yields a native toString
    // (`function () { [native code] }`) — the parser recovers no
    // names. Legacy code would call fn(input); metadata binds.
    // (bind(null) fixes only `this`, so all params pass through.)
    const WRAPPED = `
      const impl = function fn(client, orderId, percent) {
        return [orderId, percent];
      };
      module.exports = impl.bind(null);
    `;
    const metadata = sig(["client", false], ["orderId", false], ["percent", false]);
    const r = await runSandboxedWithSdkSync(
      WRAPPED,
      { orderId: "o-9", percent: 25 },
      EMPTY,
      metadata,
    );
    expect(r.status).toBe("ok");
    expect(r.output).toEqual(["o-9", 25]);
  });

  it("binds parameters in METADATA order, not input insertion order", async () => {
    const FN = `
      module.exports = function fn(client, first, second, third) {
        return [first, second, third];
      };
    `;
    const metadata = sig(
      ["client", false],
      ["gamma", false],
      ["alpha", false],
      ["beta", false],
    );
    // Insertion order deliberately differs from metadata order.
    const r = await runSandboxedWithSdkSync(
      FN,
      { beta: "B", alpha: "A", gamma: "G" },
      EMPTY,
      metadata,
    );
    expect(r.status).toBe("ok");
    expect(r.output).toEqual(["G", "A", "B"]);
  });

  it("optional parameters bind undefined when absent (function default applies)", async () => {
    const FN = `
      module.exports = function fn(client, required, optional = "DEFAULT") {
        return [required, optional];
      };
    `;
    const metadata = sig(["client", false], ["required", false], ["optional", true]);
    const r = await runSandboxedWithSdkSync(FN, { required: "R" }, EMPTY, metadata);
    expect(r.status).toBe("ok");
    expect(r.output).toEqual(["R", "DEFAULT"]);
  });

  it("fails CLOSED when metadata contradicts the artifact (arity mismatch)", async () => {
    const FN = `
      module.exports = function fn(client, only) { return only; };
    `;
    // Metadata claims 3 params; the artifact declares 2.
    const metadata = sig(["client", false], ["only", false], ["phantom", false]);
    const r = await runSandboxedWithSdkSync(FN, { only: 1, phantom: 2 }, EMPTY, metadata);
    expect(r.status).toBe("error");
    expect(r.errorMessage).toContain("contradicts the function artifact");
  });

  it("missing metadata keeps the legacy toString() binding unchanged", async () => {
    const FN = `
      module.exports = function fn(client, orderId) { return orderId; };
    `;
    const r = await runSandboxedWithSdkSync(FN, { orderId: "legacy-1" }, EMPTY);
    expect(r.status).toBe("ok");
    expect(r.output).toBe("legacy-1");
  });

  it("undefined-from-parse metadata (legacy '{}') keeps the toString() path", async () => {
    // Executor maps parseSignatureParameters('{}'::jsonb) → null → undefined.
    const fromRegistry: unknown = {};
    const params = parseSignatureParameters(fromRegistry) ?? undefined;
    const FN = `
      module.exports = function fn(client, orderId) { return orderId; };
    `;
    const r = await runSandboxedWithSdkSync(FN, { orderId: "legacy-2" }, EMPTY, params);
    expect(r.status).toBe("ok");
    expect(r.output).toBe("legacy-2");
  });
});
