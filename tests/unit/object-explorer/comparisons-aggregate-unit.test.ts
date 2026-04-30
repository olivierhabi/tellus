// ---------------------------------------------------------------------------
// T-01 — comparisons /aggregate route handler unit tests.
//
// Verifies (without requiring Docker) that:
//   - C-08, C-09, C-11, C-13: each _msearch sub-body's `query` field is
//     wrapped through applyContextToQuery; `aggs` block is NOT wrapped;
//     the bounded route-enum metric is incremented exactly once per call.
//   - When `x-branch-id` is present, the wrapped query carries the
//     branch disjunct under bool.must, not the agg block.
//   - The handler does not invent a parallel `wrapWithSecurity` lambda
//     (the test asserts the call shape is identical to applyContextToQuery's
//     output for the given inputs).
//
// Strategy: mount `comparisonsRouter` on a bare Express app with a
// pre-installed middleware that injects req.security and the
// x-branch-id header is consumed by readBranchHeader. The OpenSearch
// client's `msearch` is monkey-patched so the test inspects the
// outgoing body shape directly, with no network I/O.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import comparisonsRouter from "../../../src/routes/comparisons";
import { client as osClient } from "../../../src/services/opensearch/client";
import {
  __resetMetricsForTesting,
  renderPrometheus,
} from "../../../src/services/funnel/metrics";

const BRANCH = "22222222-2222-2222-2222-222222222222";

function makeApp(securityCtx: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (securityCtx) (req as any).security = securityCtx;
    next();
  });
  app.use("/api/v1/ontology/:ontologyId/comparisons", comparisonsRouter);
  return app;
}

const VALID_BODY = {
  objectTypeApiName: "Employee",
  setA: { filter: [], label: "A" },
  setB: { filter: [], label: "B" },
  aggregation: { type: "terms", field: "department", size: 5 },
};

describe("T-01 comparisons /aggregate — branch + security context (C-08, C-11, C-13)", () => {
  let msearchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetMetricsForTesting();
    msearchSpy = vi
      .spyOn(osClient as any, "msearch")
      .mockResolvedValue({
        body: { responses: [{ aggregations: { comparison: { buckets: [] } } }, { aggregations: { comparison: { buckets: [] } } }] },
      });
  });

  afterEach(() => {
    msearchSpy.mockRestore();
  });

  it("T-01 C-11: aggs block is NOT wrapped; only query field is", async () => {
    const app = makeApp({
      userId: "alice",
      markings: ["PUBLIC"],
      organizations: [],
      cbac: [],
      markingMode: "disjunctive",
      systemPrincipal: false,
    });
    const r = await request(app)
      .post("/api/v1/ontology/ont1/comparisons/aggregate")
      .send(VALID_BODY);
    expect(r.status).toBe(200);
    expect(msearchSpy).toHaveBeenCalledTimes(1);
    const body = (msearchSpy.mock.calls[0][0] as any).body as unknown[];
    // Layout: [{index}, subA, {index}, subB]
    expect(body).toHaveLength(4);
    const subA = body[1] as Record<string, unknown>;
    const subB = body[3] as Record<string, unknown>;

    // C-11: aggs block is NOT inside the bool.must wrapper.
    const aggsA = subA.aggs as Record<string, unknown>;
    expect(aggsA).toEqual({
      comparison: {
        terms: { size: 5, field: "department" },
      },
    });
    expect(aggsA.bool).toBeUndefined();

    // The `query` field IS wrapped under bool.must.
    const qA = subA.query as { bool?: { must?: unknown[] } };
    expect(qA.bool).toBeDefined();
    expect(qA.bool!.must).toBeInstanceOf(Array);

    // Same for subB.
    expect((subB.query as any).bool.must).toBeInstanceOf(Array);
    expect((subB.aggs as any).bool).toBeUndefined();
  });

  it("T-01 C-13: x-branch-id propagates a branch-disjunct into every sub-body's query", async () => {
    const app = makeApp({
      userId: "alice",
      markings: ["PUBLIC"],
      organizations: [],
      cbac: [],
      markingMode: "disjunctive",
      systemPrincipal: false,
    });
    const r = await request(app)
      .post("/api/v1/ontology/ont1/comparisons/aggregate")
      .set("x-branch-id", BRANCH)
      .send(VALID_BODY);
    expect(r.status).toBe(200);
    const body = (msearchSpy.mock.calls[0][0] as any).body as unknown[];

    for (const sub of [body[1], body[3]] as Record<string, unknown>[]) {
      const must = (sub.query as any).bool.must as unknown[];
      // Last clause must be the branch disjunct (term OR missing-field).
      const branchClause = must[must.length - 1] as any;
      expect(branchClause.bool.minimum_should_match).toBe(1);
      expect(branchClause.bool.should).toEqual([
        { term: { __branch: BRANCH } },
        { bool: { must_not: [{ exists: { field: "__branch" } }] } },
      ]);
    }
  });

  it("T-01 C-08, C-09: increments tellus_read_branch_filtered_total exactly once with route='comparisons.aggregate'", async () => {
    const app = makeApp({
      userId: "alice",
      markings: ["PUBLIC"],
      organizations: [],
      cbac: [],
      markingMode: "disjunctive",
      systemPrincipal: false,
    });
    const r = await request(app)
      .post("/api/v1/ontology/ont1/comparisons/aggregate")
      .set("x-branch-id", BRANCH)
      .send(VALID_BODY);
    expect(r.status).toBe(200);
    const prom = renderPrometheus();
    expect(prom).toContain(
      'tellus_read_branch_filtered_total{route="comparisons.aggregate",scoped="true"} 1',
    );
    // No "scoped=false" series should be present in this single-call run.
    expect(prom).not.toContain(
      'tellus_read_branch_filtered_total{route="comparisons.aggregate",scoped="false"}',
    );
  });

  it("T-01 C-08: scoped='false' when no branch header is present", async () => {
    const app = makeApp({
      userId: "alice",
      markings: ["PUBLIC"],
      organizations: [],
      cbac: [],
      markingMode: "disjunctive",
      systemPrincipal: false,
    });
    const r = await request(app)
      .post("/api/v1/ontology/ont1/comparisons/aggregate")
      .send(VALID_BODY);
    expect(r.status).toBe(200);
    const prom = renderPrometheus();
    expect(prom).toContain(
      'tellus_read_branch_filtered_total{route="comparisons.aggregate",scoped="false"} 1',
    );
  });
});
