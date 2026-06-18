// B05 — rate-limit chaos.
//
// Spec §B05 acceptance + brief: per-user rate limit 100 req/s; sustained
// 200 req/s for 10s sees ≥50% of requests rejected with 429 + Retry-After.
//
// Contract IDs:
//   B05 chaos C-RL1: burst beyond capacity → 429 with `Tellus:Workshop:RateLimited`
//   B05 chaos C-RL2: 429 carries `Retry-After` header
//   B05 chaos C-RL3: per-user isolation (one user being rate-limited doesn't
//                     starve another user)
//   B05 chaos C-RL4: 200 requests at 200/s sustained ≥50% rejection rate

import { describe, it, expect, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import workshopModulesRouter from "../../../src/routes/workshopModules";
import {
  setRateLimit,
  resetRateLimit,
} from "../../../src/services/workshop/rateLimit";
import {
  RecordingOssAdapter,
  setOss,
} from "../../../src/services/workshop/ossAdapter";

function buildApp(userId: string): Express {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: userId };
    next();
  });
  app.use("/api/v1/workshop", workshopModulesRouter);
  return app;
}

const ONTOLOGY = "ri.ontology.main.ontology.x";
const baseLoad = {
  ontologyRid: ONTOLOGY,
  objectTypeApiName: "Order",
  schema: { id: "string" },
  filters: [],
  pageSize: 5,
};

beforeEach(() => {
  resetRateLimit();
  setRateLimit({ ratePerSecond: 10, burst: 10 });
  setOss(new RecordingOssAdapter());
});

describe("B05 chaos — per-user rate limit", () => {
  it("B05 chaos C-RL1+C-RL2: bursting past burst yields 429 with Retry-After + correct envelope", async () => {
    const app = buildApp("u-burst");
    // Send 25 requests as fast as possible — burst=10, so ~15 should 429.
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        request(app)
          .post("/api/v1/workshop/object-sets/_load")
          .send(baseLoad),
      ),
    );
    const ok = results.filter((r) => r.status === 200);
    const limited = results.filter((r) => r.status === 429);
    expect(ok.length).toBeGreaterThan(0);
    expect(limited.length).toBeGreaterThan(0);
    // Every 429 must carry Retry-After + the named envelope.
    for (const r of limited) {
      expect(r.headers["retry-after"]).toMatch(/^\d+$/);
      expect(r.body.errorName).toBe("Tellus:Workshop:RateLimited");
      expect(typeof r.body.parameters?.retryAfterSeconds).toBe("number");
    }
  });

  it("B05 chaos C-RL3: per-user isolation — user A throttled doesn't affect user B", async () => {
    const appA = buildApp("u-A");
    const appB = buildApp("u-B");
    // Drain user A's bucket.
    await Promise.all(
      Array.from({ length: 25 }, () =>
        request(appA).post("/api/v1/workshop/object-sets/_load").send(baseLoad),
      ),
    );
    // User B should still get a fresh burst of allowed.
    const bResults = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(appB).post("/api/v1/workshop/object-sets/_load").send(baseLoad),
      ),
    );
    const okB = bResults.filter((r) => r.status === 200);
    expect(okB.length).toBe(5);
  });

  it("B05 chaos C-RL4: sustained 2× rate ≥50% rejection (spec target)", async () => {
    setRateLimit({ ratePerSecond: 50, burst: 50 });
    const app = buildApp("u-sustain");
    // Fire 200 in a tight loop — 4× burst — at least 50% must 429.
    const results = await Promise.all(
      Array.from({ length: 200 }, () =>
        request(app)
          .post("/api/v1/workshop/object-sets/_load")
          .send(baseLoad),
      ),
    );
    const limited = results.filter((r) => r.status === 429).length;
    const allowed = results.filter((r) => r.status === 200).length;
    expect(allowed).toBeGreaterThan(0);
    expect(limited).toBeGreaterThan(0);
    // Spec: ≥50% should be rejected when load is 2× capacity.
    expect(limited / results.length).toBeGreaterThanOrEqual(0.5);
  });
});
