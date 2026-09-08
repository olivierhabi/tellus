// ---------------------------------------------------------------------------
// Unit tests for the extracted functions / function-invoke routers and the
// invoke phases (src/services/codeRepository/admin/routers/).
//
// Registration is asserted structurally; the pure phases (body parsing,
// transpile) are exercised directly; source resolution runs against stub
// adapters. Sandbox execution and ontology loads are covered by the
// code-repos integration suites.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { Router } from "express";
import { createFunctionsRouter } from "../../../src/services/codeRepository/admin/routers/functionsRouter";
import { createFunctionInvokeRouter } from "../../../src/services/codeRepository/admin/routers/functionInvokeRouter";
import {
  loadInvokeSnapshot,
  parseInvokeBody,
  resolveInvokeSource,
  transpileForInvoke,
} from "../../../src/services/codeRepository/admin/routers/functionInvokePhases";
import { createRouteContext } from "../../../src/services/codeRepository/admin/routeContext";

function stubCtx() {
  return createRouteContext({
    pool: {} as never,
    compass: {} as never,
    stemma: {} as never,
    template: {} as never,
  });
}

function routesOf(router: Router): Array<{ method: string; path: string }> {
  const stack = (router as unknown as { stack: Array<{
    route?: { path: string; methods: Record<string, boolean> };
  }> }).stack;
  return stack
    .filter((l) => l.route)
    .map((l) => ({
      method: Object.keys(l.route!.methods).filter((m) => m !== "_all")[0] ?? "?",
      path: String(l.route!.path),
    }));
}

describe("functionsRouter — registration", () => {
  it("exposes the functions listing route", () => {
    expect(routesOf(createFunctionsRouter(stubCtx()))).toEqual([
      { method: "get", path: "/:rid/functions" },
    ]);
  });
});

describe("functionInvokeRouter — registration", () => {
  it("exposes the invoke route", () => {
    expect(routesOf(createFunctionInvokeRouter(stubCtx()))).toEqual([
      { method: "post", path: "/:rid/functions/invoke" },
    ]);
  });
});

describe("invokePhases — parseInvokeBody", () => {
  it("accepts a minimal body and defaults branch to null", () => {
    const r = parseInvokeBody({ apiName: "calc" });
    expect(r).toEqual({
      kind: "ok",
      body: {
        apiName: "calc",
        args: undefined,
        branch: null,
        source: undefined,
        inlineSource: null,
        inlineSourcePath: null,
        applyEdits: undefined,
      },
    });
  });

  it("accepts nested function identities", () => {
    expect(parseInvokeBody({ apiName: "orders/calc" }).kind).toBe("ok");
  });

  it("rejects bad apiName / args / inlineSource / inlineSourcePath", () => {
    expect(parseInvokeBody({})).toMatchObject({
      kind: "invalid",
      errorName: "CodeRepos:InvalidArgumentBody",
      parameters: { field: "apiName" },
    });
    expect(parseInvokeBody({ apiName: "calc", args: [1] })).toMatchObject({
      kind: "invalid",
      parameters: { field: "args" },
    });
    expect(parseInvokeBody({ apiName: "calc", args: null })).toMatchObject({
      kind: "invalid",
      parameters: { field: "args" },
    });
    expect(parseInvokeBody({ apiName: "calc", inlineSource: 42 })).toMatchObject({
      kind: "invalid",
      parameters: { field: "inlineSource" },
    });
    expect(parseInvokeBody({ apiName: "calc", inlineSource: "x".repeat(257 * 1024) })).toMatchObject({
      kind: "invalid",
      parameters: { field: "inlineSource" },
    });
    expect(parseInvokeBody({ apiName: "calc", inlineSourcePath: "x".repeat(1025) })).toMatchObject({
      kind: "invalid",
      parameters: { field: "inlineSourcePath" },
    });
    // empty inlineSource stays null (no shortcut)
    const r = parseInvokeBody({ apiName: "calc", inlineSource: "" });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.body.inlineSource).toBeNull();
  });
});

describe("invokePhases — transpileForInvoke", () => {
  it("transpiles TS and surfaces the default export", () => {
    const r = transpileForInvoke("calc", "export default function calc(a: number) { return a * 2; }");
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.transpiled).toContain("exports.default");
    expect(r.transpiled).toContain("module.exports =");
  });

  it("is content-addressed (same input → same output, cached)", () => {
    const src = "export default function f() { return 1; }";
    const a = transpileForInvoke("f", src);
    const b = transpileForInvoke("f", src);
    expect(a).toEqual(b);
  });
});

describe("invokePhases — resolveInvokeSource", () => {
  const pool = {
    query: async () => ({ rows: [{ rid: "r1", default_branch: "main", state: "ACTIVE" }] }),
  } as never;

  it("returns RepositoryNotFound when the repo row is missing", async () => {
    const r = await resolveInvokeSource(
      { pool: { query: async () => ({ rows: [] }) } as never, stemma: {} as never },
      { rid: "missing", bodyBranch: null, apiName: "f", source: undefined, inlineSource: null, inlineSourcePath: null },
    );
    expect(r).toMatchObject({ kind: "error", errorName: "CodeRepos:RepositoryNotFound" });
  });

  it("inline source shortcuts Stemma and infers python from the path", async () => {
    const stemma = { listTree: async () => { throw new Error("must not be called"); } } as never;
    const r = await resolveInvokeSource(
      { pool, stemma },
      { rid: "r1", bodyBranch: null, apiName: "f", source: undefined, inlineSource: "code", inlineSourcePath: "f.py" },
    );
    expect(r).toMatchObject({ kind: "error", errorName: "CodeRepos:RuntimeNotSupported" });

    const ok = await resolveInvokeSource(
      { pool, stemma },
      { rid: "r1", bodyBranch: "dev", apiName: "f", source: undefined, inlineSource: "code", inlineSourcePath: "f.ts" },
    );
    expect(ok).toMatchObject({ kind: "ok", source: "code", runtime: "NODE_20", branch: "dev" });
  });

  it("working-tree path resolves nested identities and skips test files", async () => {
    const stemma = {
      listTree: async () => ({
        kind: "ok" as const,
        entries: [
          { type: "blob", path: "typescript-functions/src/functions/orders/calc.test.ts", name: "calc.test.ts" },
          { type: "blob", path: "typescript-functions/src/functions/orders/calc.ts", name: "calc.ts" },
        ],
      }),
      readBlob: async () => ({ kind: "ok" as const, content: new TextEncoder().encode("export default 1") }),
    } as never;
    const r = await resolveInvokeSource(
      { pool, stemma },
      { rid: "r1", bodyBranch: null, apiName: "orders/calc", source: undefined, inlineSource: null, inlineSourcePath: null },
    );
    expect(r).toMatchObject({
      kind: "ok",
      source: "export default 1",
      runtime: "NODE_20",
      resolvedPath: "typescript-functions/src/functions/orders/calc.ts",
      branch: "main",
    });
  });

  it("missing function in tree → FunctionNotFound; missing branch → BranchNotFound", async () => {
    const emptyTree = { listTree: async () => ({ kind: "ok" as const, entries: [] }) } as never;
    expect(await resolveInvokeSource(
      { pool, stemma: emptyTree },
      { rid: "r1", bodyBranch: null, apiName: "nope", source: undefined, inlineSource: null, inlineSourcePath: null },
    )).toMatchObject({ kind: "error", errorName: "CodeRepos:FunctionNotFound" });

    const noBranch = { listTree: async () => ({ kind: "branch-not-found" as const }) } as never;
    expect(await resolveInvokeSource(
      { pool, stemma: noBranch },
      { rid: "r1", bodyBranch: null, apiName: "f", source: undefined, inlineSource: null, inlineSourcePath: null },
    )).toMatchObject({ kind: "error", errorName: "CodeRepos:BranchNotFound" });
  });
});

describe("invokePhases — loadInvokeSnapshot", () => {
  it("returns undefined without touching the pool when there is no ontology", async () => {
    const pool = { query: async () => { throw new Error("must not be called"); } } as never;
    const r = await loadInvokeSnapshot(pool, { ontologyId: null, importedTypes: [], importedLinkTypes: [] });
    expect(r.snapshot).toBeUndefined();
    expect(typeof r.durationMs).toBe("number");
  });
});
