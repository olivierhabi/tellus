// ---------------------------------------------------------------------------
// T-02 — Legacy chart endpoints deletion proof.
//
// Mounts the chartsRouter on a bare Express app and asserts that the four
// endpoints removed in T-02 (`/charts/{listogram,histogram,dateHistogram,auto}`)
// return 404. Also asserts `/charts/batch` continues to be mounted so we
// haven't broken the surface that replaced them.
//
// Contracts covered: C-200 (legacy delete), C-201 (PG-direct path removed).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import chartsRouter from "../../../src/routes/charts";
import { client as osClient } from "../../../src/services/opensearch/client";

function makeApp() {
  const app = express();
  app.use(express.json());
  // Minimal security context shim — shape mirrors `SecurityContext` in
  // src/middleware/securityContext.ts so `buildSecurityFilter` returns
  // a valid clause. None of the legacy endpoints reach this branch
  // because they no longer exist; /charts/batch does.
  app.use((req, _res, next) => {
    (req as Record<string, unknown>).security = {
      userId: "test-user",
      markings: ["PUBLIC"],
      organizations: [],
      cbac: [],
      markingMode: "disjunctive",
      systemPrincipal: false,
    };
    next();
  });
  app.use("/api/v1", chartsRouter);
  return app;
}

describe("T-02 C-200: legacy chart endpoints removed", () => {
  const app = makeApp();

  it.each([
    ["/api/v1/charts/listogram"],
    ["/api/v1/charts/histogram"],
    ["/api/v1/charts/dateHistogram"],
    ["/api/v1/charts/auto"],
  ])("POST %s returns 404 (route removed)", async (path) => {
    const res = await request(app).post(path).send({
      ontologyId: "11111111-1111-1111-1111-111111111111",
      objectType: "flight",
      field: "status",
    });
    expect(res.status).toBe(404);
  });
});

describe("T-02 C-201: /charts/batch survives the cull", () => {
  beforeEach(() => {
    vi.spyOn(osClient, "count").mockResolvedValue({
      body: { count: 0 },
    } as Awaited<ReturnType<typeof osClient.count>>);
    vi.spyOn(osClient, "msearch").mockResolvedValue({
      body: { responses: [{ aggregations: { chart: { buckets: [] } } }] },
    } as Awaited<ReturnType<typeof osClient.msearch>>);
  });

  it("POST /api/v1/charts/batch returns 200 with empty buckets when index is empty", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/v1/charts/batch")
      .send({ objectType: "flight", specs: [{ type: "terms", field: "status" }] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.engine).toBe("opensearch-msearch");
    expect(Array.isArray(res.body.data.charts)).toBe(true);
    expect(res.body.data.charts).toHaveLength(1);
  });
});

describe("T-02 C-201: charts.ts no longer imports polarsAggregator", () => {
  it("polarsAggregator.ts is absent from src/services/", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const target = path.resolve(
      process.cwd(),
      "src/services/polarsAggregator.ts",
    );
    expect(fs.existsSync(target)).toBe(false);
  });

  it("charts.ts source has no remaining executable polarsAggregator or loadObjectRows reference", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const raw = fs.readFileSync(
      path.resolve(process.cwd(), "src/routes/charts.ts"),
      "utf8",
    );
    // Strip line comments, block comments, and JSDoc so the deletion-rationale
    // banner that *describes* the removal does not fail this assertion.
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/from\s+['"][^'"]*polarsAggregator['"]/);
    expect(stripped).not.toMatch(/\bloadObjectRows\s*\(/);
    expect(stripped).not.toMatch(/function\s+loadObjectRows\b/);
  });
});
