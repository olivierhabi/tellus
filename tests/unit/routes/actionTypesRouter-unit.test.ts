// ---------------------------------------------------------------------------
// Route-surface guard for the split actionTypes router.
//
// The former god-file src/routes/actionTypes.ts was split into per-endpoint
// modules under src/routes/actionTypes/ (create/list/update/clone/impact/
// migrate/delete + shared). Express matches routes in REGISTRATION order, so
// this spec pins the exact method+path surface (and the relative ordering of
// /by-rid/* ahead of /:actionApiName/*) to catch accidental regressions from
// the refactor without needing a live server.
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import router from "../../../src/routes/actionTypes";

type Layer = {
  route?: { path: string; methods: Record<string, boolean> };
  regexp?: RegExp;
};

function routeEntries(): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const layer of (router as unknown as { stack: Layer[] }).stack) {
    if (!layer.route) continue; // skip router.use(dataPlaneGuard) middleware
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled) out.push({ method: method.toUpperCase(), path: layer.route.path });
    }
  }
  return out;
}

describe("actionTypes router surface (post-split)", () => {
  it("mounts exactly the historical 13 endpoint registrations", () => {
    const entries = routeEntries();
    expect(entries).toEqual([
      { method: "POST", path: "/" },
      { method: "GET", path: "/" },
      { method: "GET", path: "/by-rid/:rid" },
      { method: "POST", path: "/by-rid/batch" },
      { method: "GET", path: "/:actionApiName" },
      { method: "POST", path: "/:actionApiName/blastRadius" },
      { method: "PUT", path: "/:actionApiName" },
      { method: "PATCH", path: "/:actionApiName" },
      { method: "POST", path: "/:actionApiName/clone" },
      { method: "GET", path: "/:actionApiName/impact" },
      { method: "GET", path: "/:actionApiName/migrationAnalysis" },
      { method: "POST", path: "/:actionApiName/migrate" },
      { method: "POST", path: "/:actionApiName/migrate/rollback" },
      { method: "DELETE", path: "/:actionApiName" },
    ]);
  });

  it("registers /by-rid/batch before /:actionApiName/clone (no shadowing)", () => {
    const entries = routeEntries();
    const batchIdx = entries.findIndex(
      (e) => e.method === "POST" && e.path === "/by-rid/batch",
    );
    const cloneIdx = entries.findIndex(
      (e) => e.method === "POST" && e.path === "/:actionApiName/clone",
    );
    expect(batchIdx).toBeGreaterThanOrEqual(0);
    expect(cloneIdx).toBeGreaterThan(batchIdx);
  });

  it("keeps the dataPlaneGuard middleware mounted before all routes", () => {
    const stack = (router as unknown as { stack: Layer[] }).stack;
    expect(stack.length).toBeGreaterThan(0);
    expect(stack[0].route).toBeUndefined(); // first layer is middleware, not a route
  });
});
