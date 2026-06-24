// G-04 — /api/v1/workshop/metrics endpoint smoke test.
//
// Asserts:
//   - Endpoint returns 200 with `text/plain` content type
//   - Response surface lists at least one workshop_*_seconds metric
//   - The endpoint does not require auth bypass (auth is mocked at the
//     express layer here, same as other workshop integration tests)
//
// This is a smoke test — full per-metric assertions are covered in unit
// tests (`metrics-emission-unit.test.ts`). The endpoint exists primarily
// for Prometheus scrapes; we want to know the endpoint binds and the
// content-type is right so a scraper doesn't reject it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import workshopModulesRouter from "../../../src/routes/workshopModules";

let app: Express;

beforeAll(() => {
  app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: "u-metrics" };
    next();
  });
  app.use("/api/v1/workshop", workshopModulesRouter);
});

afterAll(() => {
  // No persistent state to tear down.
});

describe("G-04 /api/v1/workshop/metrics", () => {
  it("returns 200 and a Prometheus-formatted text body", async () => {
    // Touch a metric so that at least one HELP/TYPE block exists in
    // the registry. We import the histogram and call observe() so the
    // scrape body is non-empty even if no other test has emitted yet.
    const { histLoad } = await import(
      "../../../src/services/workshop/metrics"
    );
    histLoad.observe({ result: "success" }, 0.001);

    const r = await request(app).get("/api/v1/workshop/metrics");
    expect(r.status).toBe(200);
    expect(r.header["content-type"]).toMatch(/text\/plain/);
    // Body should contain Prometheus exposition format markers and at
    // least one of our histograms.
    expect(r.text).toContain("# HELP");
    expect(r.text).toContain("# TYPE");
    expect(r.text).toContain("tellus_workshop_module_load_seconds");
  });

  it("surfaces the validate, resolve, aggregate, apply families when each is observed", async () => {
    const m = await import("../../../src/services/workshop/metrics");
    m.histValidate.observe({ result: "success" }, 0.001);
    m.histResolve.observe({ track: "latest", cache_hit: "true" }, 0.001);
    m.histAggregate.observe({ result: "success" }, 0.001);
    m.histApply.observe({ phase: "validate", result: "success" }, 0.001);

    const r = await request(app).get("/api/v1/workshop/metrics");
    expect(r.status).toBe(200);
    expect(r.text).toContain("tellus_workshop_validate_seconds");
    expect(r.text).toContain("tellus_workshop_resolve_seconds");
    expect(r.text).toContain("tellus_workshop_aggregate_seconds");
    expect(r.text).toContain("tellus_workshop_apply_seconds");
  });
});
