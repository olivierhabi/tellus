// ---------------------------------------------------------------------------
// T-01 — /charts/batch route handler unit tests.
//
// Verifies the same C-08/C-09/C-12/C-13 contracts as comparisons but on
// the charts surface. Mounts the chartsRouter on a bare Express app
// with security middleware shim, mocks osClient.count + osClient.msearch.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import chartsRouter from "../../../src/routes/charts";
import { client as osClient } from "../../../src/services/opensearch/client";
import {
  __resetMetricsForTesting,
  renderPrometheus,
} from "../../../src/services/funnel/metrics";

const BRANCH = "33333333-3333-3333-3333-333333333333";

function makeApp(securityCtx: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (securityCtx) (req as any).security = securityCtx;
    next();
  });
  app.use("/api/v1", chartsRouter);
  return app;
}

const VALID_BODY = {
  objectType: "Employee",
  specs: [
    { type: "terms", field: "department" },
    { type: "histogram", field: "salary", interval: 1000 },
    { type: "date_histogram", field: "hireDate", interval: "1d" },
  ],
};

describe("T-01 /charts/batch — branch + security (C-08, C-12, C-13)", () => {
  let msearchSpy: ReturnType<typeof vi.spyOn>;
  let countSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetMetricsForTesting();
    countSpy = vi
      .spyOn(osClient as any, "count")
      .mockResolvedValue({ body: { count: 100 } });
    msearchSpy = vi.spyOn(osClient as any, "msearch").mockResolvedValue({
      body: {
        responses: VALID_BODY.specs.map(() => ({
          aggregations: { chart: { buckets: [] } },
        })),
      },
    });
  });

  afterEach(() => {
    msearchSpy.mockRestore();
    countSpy.mockRestore();
  });

  it("T-01 C-12: aggs block is NOT wrapped; only query field is", async () => {
    const app = makeApp({
      userId: "alice",
      markings: ["PUBLIC"],
      organizations: [],
      cbac: [],
      markingMode: "disjunctive",
      systemPrincipal: false,
    });
    const r = await request(app).post("/api/v1/charts/batch").send(VALID_BODY);
    expect(r.status).toBe(200);
    const msearchBody = (msearchSpy.mock.calls[0][0] as any).body as unknown[];
    // Layout: [{index}, sub0, {index}, sub1, {index}, sub2]
    expect(msearchBody).toHaveLength(6);
    for (const i of [1, 3, 5]) {
      const sub = msearchBody[i] as Record<string, unknown>;
      const aggs = sub.aggs as Record<string, unknown>;
      expect(aggs.bool).toBeUndefined();
      expect(aggs.chart).toBeDefined();
      // Without a branch header but with a security context, the query
      // is wrapped under bool.must (security clause appended).
      const q = sub.query as { bool?: { must?: unknown[] } };
      expect(q.bool?.must).toBeInstanceOf(Array);
    }
  });

  it("T-01 C-13: branch header propagates a branch-disjunct into every sub-body's query and into the count() body", async () => {
    const app = makeApp({
      userId: "alice",
      markings: ["PUBLIC"],
      organizations: [],
      cbac: [],
      markingMode: "disjunctive",
      systemPrincipal: false,
    });
    const r = await request(app)
      .post("/api/v1/charts/batch")
      .set("x-branch-id", BRANCH)
      .send(VALID_BODY);
    expect(r.status).toBe(200);

    // Count body must carry branch-disjunct.
    const countBody = (countSpy.mock.calls[0][0] as any).body;
    const countMust = countBody.query.bool.must as unknown[];
    const countBranch = countMust[countMust.length - 1] as any;
    expect(countBranch.bool.should).toEqual([
      { term: { __branch: BRANCH } },
      { bool: { must_not: [{ exists: { field: "__branch" } }] } },
    ]);

    // Every msearch sub-body query carries branch-disjunct.
    const msearchBody = (msearchSpy.mock.calls[0][0] as any).body as unknown[];
    for (const i of [1, 3, 5]) {
      const sub = msearchBody[i] as Record<string, unknown>;
      const must = (sub.query as any).bool.must as unknown[];
      const branchClause = must[must.length - 1] as any;
      expect(branchClause.bool.minimum_should_match).toBe(1);
      expect(branchClause.bool.should).toEqual([
        { term: { __branch: BRANCH } },
        { bool: { must_not: [{ exists: { field: "__branch" } }] } },
      ]);
    }
  });

  it("T-01 C-08, C-09: increments tellus_read_branch_filtered_total exactly once with route='charts.batch'", async () => {
    const app = makeApp({
      userId: "alice",
      markings: ["PUBLIC"],
      organizations: [],
      cbac: [],
      markingMode: "disjunctive",
      systemPrincipal: false,
    });
    const r = await request(app)
      .post("/api/v1/charts/batch")
      .set("x-branch-id", BRANCH)
      .send(VALID_BODY);
    expect(r.status).toBe(200);
    const prom = renderPrometheus();
    expect(prom).toContain(
      'tellus_read_branch_filtered_total{route="charts.batch",scoped="true"} 1',
    );
  });

  it("T-01 C-08: scoped='false' when no branch header", async () => {
    const app = makeApp({
      userId: "alice",
      markings: ["PUBLIC"],
      organizations: [],
      cbac: [],
      markingMode: "disjunctive",
      systemPrincipal: false,
    });
    const r = await request(app).post("/api/v1/charts/batch").send(VALID_BODY);
    expect(r.status).toBe(200);
    const prom = renderPrometheus();
    expect(prom).toContain(
      'tellus_read_branch_filtered_total{route="charts.batch",scoped="false"} 1',
    );
  });
});
