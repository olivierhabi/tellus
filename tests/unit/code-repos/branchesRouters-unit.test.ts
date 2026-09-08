// ---------------------------------------------------------------------------
// Unit tests for the extracted branches/tree/commits routers
// (src/services/codeRepository/admin/routers/).
//
// Building a router performs no I/O — registration is asserted
// structurally: each sub-router must expose exactly the routes it owned in
// admin/routes.ts. Wire behaviour is covered by the code-repos integration
// suites.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { Router } from "express";
import { createBranchesRouter } from "../../../src/services/codeRepository/admin/routers/branchesRouter";
import { createTreeRouter } from "../../../src/services/codeRepository/admin/routers/treeRouter";
import { createCommitsRouter } from "../../../src/services/codeRepository/admin/routers/commitsRouter";
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

describe("branchesRouter — registration", () => {
  it("exposes list / create / delete branch routes", () => {
    expect(routesOf(createBranchesRouter(stubCtx()))).toEqual([
      { method: "get", path: "/:rid/branches" },
      { method: "post", path: "/:rid/branches" },
      { method: "delete", path: "/:rid/branches/:branch" },
    ]);
  });
});

describe("treeRouter — registration", () => {
  it("exposes tree + file read routes", () => {
    expect(routesOf(createTreeRouter(stubCtx()))).toEqual([
      { method: "get", path: "/:rid/branches/:branch/tree" },
      { method: "get", path: "/:rid/branches/:branch/files" },
    ]);
  });
});

describe("commitsRouter — registration", () => {
  it("exposes the commits route", () => {
    expect(routesOf(createCommitsRouter(stubCtx()))).toEqual([
      { method: "post", path: "/:rid/branches/:branch/commits" },
    ]);
  });
});
