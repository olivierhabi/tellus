// ---------------------------------------------------------------------------
// Unit tests for the extracted repos router
// (src/services/codeRepository/admin/routers/reposRouter.ts).
//
// Building the router performs no I/O — handlers only run on requests — so
// registration is asserted structurally: the sub-router must expose exactly
// the five CRUD routes it owned in admin/routes.ts, with auth + idempotency
// middleware in place. Wire behaviour is covered by the code-repos
// integration suites.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { Router } from "express";
import { createReposRouter } from "../../../src/services/codeRepository/admin/routers/reposRouter";
import { createRouteContext } from "../../../src/services/codeRepository/admin/routeContext";

function stubCtx() {
  return createRouteContext({
    pool: {} as never,
    compass: {} as never,
    stemma: {} as never,
    template: {} as never,
  });
}

function routesOf(router: Router): Array<{ method: string; path: string; layers: number }> {
  const stack = (router as unknown as { stack: Array<{
    route?: { path: string; methods: Record<string, boolean>; stack: unknown[] };
  }> }).stack;
  return stack
    .filter((l) => l.route)
    .map((l) => ({
      method: Object.keys(l.route!.methods).filter((m) => m !== "_all")[0] ?? "?",
      path: String(l.route!.path),
      layers: l.route!.stack.length,
    }));
}

describe("reposRouter — registration", () => {
  it("exposes exactly the five CRUD routes", () => {
    const found = routesOf(createReposRouter(stubCtx()));
    expect(found).toEqual([
      { method: "post", path: "/", layers: 3 }, // auth + idempotency + handler
      { method: "get", path: "/", layers: 2 }, // auth + handler
      { method: "get", path: "/:rid", layers: 2 },
      { method: "patch", path: "/:rid", layers: 2 },
      { method: "delete", path: "/:rid", layers: 2 },
    ]);
  });
});
