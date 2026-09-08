// ---------------------------------------------------------------------------
// Unit tests for the extracted settings router
// (src/services/codeRepository/admin/routers/settingsRouter.ts).
//
// Registration is asserted structurally: the sub-router must expose exactly
// the routes it owned in admin/routes.ts. Wire behaviour is covered by the
// code-repos integration suites.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { Router } from "express";
import { createSettingsRouter } from "../../../src/services/codeRepository/admin/routers/settingsRouter";
import { createTagsRouter } from "../../../src/services/codeRepository/admin/routers/tagsRouter";
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

describe("settingsRouter — registration", () => {
  it("exposes settings + resource-imports routes", () => {
    expect(routesOf(createSettingsRouter(stubCtx()))).toEqual([
      { method: "get", path: "/:rid/settings" },
      { method: "put", path: "/:rid/settings" },
      { method: "get", path: "/:rid/resource-imports" },
      { method: "put", path: "/:rid/resource-imports" },
    ]);
  });
});

describe("tagsRouter — registration", () => {
  it("exposes the tag & release route", () => {
    expect(routesOf(createTagsRouter(stubCtx()))).toEqual([
      { method: "post", path: "/:rid/tags" },
    ]);
  });
});
