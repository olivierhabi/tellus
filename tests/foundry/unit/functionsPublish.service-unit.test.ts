import { describe, expect, it } from "vitest";

import {
  FunctionsPublishError,
  discoverTypeScriptV2FunctionPaths,
  inspectTypeScriptV2Function,
  retryEligibility,
} from "../../../src/services/functionsPublish/service";

describe("TypeScript v2 functions-publish discovery", () => {
  it("discovers nested v2 functions and excludes tests and declarations", () => {
    expect(discoverTypeScriptV2FunctionPaths([
      { path: "typescript-functions/src/functions/hello.ts", type: "blob" },
      { path: "typescript-functions/src/functions/orders/score.ts", type: "blob" },
      { path: "typescript-functions/src/functions/orders/score.test.ts", type: "blob" },
      { path: "typescript-functions/src/functions/types.d.ts", type: "blob" },
      { path: "typescript-functions/src/functions/orders", type: "tree" },
    ])).toEqual([
      "typescript-functions/src/functions/hello.ts",
      "typescript-functions/src/functions/orders/score.ts",
    ]);
  });

  it("extracts an explicit public signature", () => {
    expect(inspectTypeScriptV2Function(
      "typescript-functions/src/functions/hello.ts",
      "export default function hello(name: string, title?: string): string { return name; }",
    )).toEqual({
      parameters: [
        {
          name: "name",
          type: "string",
          optional: false,
          position: 0,
          hasDefault: false,
          typeModel: { kind: "string" },
        },
        {
          name: "title",
          type: "string",
          optional: true,
          position: 1,
          hasDefault: false,
          typeModel: { kind: "string" },
        },
      ],
      output: "string",
    });
  });

  it("rejects file/name mismatches and implicit types", () => {
    expect(() => inspectTypeScriptV2Function(
      "typescript-functions/src/functions/hello.ts",
      "export default function renamed(name: string): string { return name; }",
    )).toThrow(FunctionsPublishError);
    expect(() => inspectTypeScriptV2Function(
      "typescript-functions/src/functions/hello.ts",
      "export default function hello(name) { return name; }",
    )).toThrow(/explicitly type/);
  });
});

describe("functions-publish retry eligibility", () => {
  it("blocks an obsolete release and recommends the next patch", () => {
    expect(retryEligibility("ri.jemma.main.run.test", "0.0.4", [
      "0.0.3",
      "1.0.1",
      "1.0.2",
    ])).toEqual({
      runRid: "ri.jemma.main.run.test",
      retryable: false,
      reason: "VERSION_OUTDATED",
      attemptedSemver: "0.0.4",
      latestSemver: "1.0.2",
      suggestedSemver: "1.0.3",
    });
  });

  it("allows retrying the current version", () => {
    expect(retryEligibility("ri.jemma.main.run.test", "1.0.2", ["1.0.2"]))
      .toMatchObject({ retryable: true, reason: null, suggestedSemver: null });
  });
});
