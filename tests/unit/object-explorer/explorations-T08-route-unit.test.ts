// ---------------------------------------------------------------------------
// T-08 — saved-exploration route IDOR / marking-filter unit tests.
//
// Covers contracts:
//   C-114 GET /:id 404s WITHOUT distinguishing "not found" from "filtered
//          by markings" — the OBJECT_NOT_FOUND envelope is identical in
//          both cases (IDOR-prevention).
//   C-115 GET / list filters via `required_markings <@ user_markings`.
//   C-116 GET /:id increments tellus_saved_exploration_marking_misses_total
//          when the row exists but is filtered by markings.
//   C-117 POST / and PUT / re-resolve required_markings and reject the
//          write if the caller does not hold every required marking
//          (privilege-escalation guard).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import request from "supertest";

// Mocks must be hoisted above the route import. `vi.hoisted` carries
// the mock fns across the hoist boundary without a TDZ error.
const { queryMock, resolveMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  resolveMock: vi.fn(),
}));
vi.mock("../../../src/db", () => ({
  default: { query: queryMock },
  query: (sql: string, args: unknown[]) => queryMock(sql, args),
}));
vi.mock("../../../src/services/explorations/configMarkingResolver", () => ({
  resolveRequiredMarkings: (config: unknown) => resolveMock(config),
}));

import {
  __resetMetricsForTesting,
  renderPrometheus,
} from "../../../src/services/funnel/metrics";
import explorationsRouter from "../../../src/routes/explorations";

beforeEach(() => {
  queryMock.mockReset();
  resolveMock.mockReset();
  __resetMetricsForTesting();
});

function makeApp(opts: {
  userId?: string;
  markings?: string[];
  systemPrincipal?: boolean;
}): express.Express {
  const app = express();
  app.use(express.json());
  // Inject a security-context-equivalent middleware. The real middleware
  // populates req.security from the JWT; we bypass auth here and inject
  // directly so we can drive the marking filter from test fixtures.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: opts.userId ?? "alice" };
    (req as any).security = {
      userId: opts.userId ?? "alice",
      markings: opts.markings ?? [],
      organizations: [],
      cbac: [],
      markingMode: "disjunctive",
      systemPrincipal: opts.systemPrincipal ?? false,
    };
    (req as any).correlationId = "req-T08";
    next();
  });
  app.use("/api/v1/ontologies/:ontologyId/explorations", explorationsRouter);
  return app;
}

describe("T-08 GET /:id — IDOR / marking filter (C-114, C-116)", () => {
  it("T-08 C-114a: not-found row → OBJECT_NOT_FOUND with kind:saved_exploration; no marking-miss counter", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/required_markings <@/.test(sql) && !/NOT \(required_markings/.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/NOT \(required_markings/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const app = makeApp({ markings: [] });
    const r = await request(app).get(
      "/api/v1/ontologies/ont-1/explorations/exp-x",
    );
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe("OBJECT_NOT_FOUND");
    expect(r.body.parameters.kind).toBe("saved_exploration");
    // No marking-miss event was recorded — the row genuinely doesn't
    // exist. Counter must remain at 0 (absent or "0" in render).
    const prom = renderPrometheus();
    expect(prom).not.toContain("tellus_saved_exploration_marking_misses_total 1");
  });

  it("T-08 C-114b/C-116: row exists but markings short → SAME 404 envelope + marking-miss counter increments", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/required_markings <@/.test(sql) && !/NOT \(required_markings/.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/NOT \(required_markings/.test(sql)) {
        return { rows: [{ "?column?": 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const app = makeApp({ markings: [] });
    const r = await request(app).get(
      "/api/v1/ontologies/ont-1/explorations/exp-secret",
    );
    expect(r.status).toBe(404);
    // C-114b: envelope is INDISTINGUISHABLE from "doesn't exist".
    expect(r.body.errorCode).toBe("OBJECT_NOT_FOUND");
    expect(r.body.parameters.kind).toBe("saved_exploration");
    // C-116: counter incremented for SOC dashboard.
    const prom = renderPrometheus();
    expect(prom).toContain("tellus_saved_exploration_marking_misses_total 1");
  });

  it("T-08 C-114c: row exists AND markings match → 200 with row body", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/required_markings <@/.test(sql) && !/NOT \(required_markings/.test(sql)) {
        return {
          rows: [
            {
              exploration_id: "exp-ok",
              ontology_id: "ont-1",
              owner_id: "alice",
              title: "Q1",
              required_markings: ["SECRET"],
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const app = makeApp({ userId: "alice", markings: ["SECRET"] });
    const r = await request(app).get(
      "/api/v1/ontologies/ont-1/explorations/exp-ok",
    );
    expect(r.status).toBe(200);
    expect(r.body.exploration_id).toBe("exp-ok");
  });
});

describe("T-08 POST / — write-time marking gate (C-117)", () => {
  it("T-08 C-117a: caller missing required marking → 403 FORBIDDEN with structured missingMarkings list", async () => {
    resolveMock.mockResolvedValue(["SECRET"]);
    const app = makeApp({ userId: "alice", markings: [] });
    const r = await request(app)
      .post("/api/v1/ontologies/ont-1/explorations")
      .send({
        title: "Q1",
        config: { objectType: "Trip", where: { field: "ssn" } },
      });
    expect(r.status).toBe(403);
    expect(r.body.errorCode).toBe("FORBIDDEN");
    expect(r.body.parameters.missingMarkings).toEqual(["SECRET"]);
    // Must NOT have inserted (no INSERT query made).
    const inserts = queryMock.mock.calls.filter((c: any[]) => /INSERT/.test(c[0]));
    expect(inserts.length).toBe(0);
  });

  it("T-08 C-117b: caller holds every marking → INSERT issued with required_markings array", async () => {
    resolveMock.mockResolvedValue(["SECRET", "TS"]);
    queryMock.mockImplementation(async (sql: string) => {
      if (/INSERT/.test(sql)) {
        return {
          rows: [{ exploration_id: "exp-new", required_markings: ["SECRET", "TS"] }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const app = makeApp({ userId: "alice", markings: ["SECRET", "TS"] });
    const r = await request(app)
      .post("/api/v1/ontologies/ont-1/explorations")
      .send({
        title: "Q1",
        config: { objectType: "Trip", where: { field: "ssn" } },
      });
    expect(r.status).toBe(201);
    const insertCalls = queryMock.mock.calls.filter((c: any[]) => /INSERT/.test(c[0]));
    expect(insertCalls.length).toBe(1);
    // 7th param is the required_markings array.
    expect(insertCalls[0][1][6]).toEqual(["SECRET", "TS"]);
  });

  it("T-08 C-117c: missing title → VALIDATION_ERROR (canonical code emitted natively)", async () => {
    const app = makeApp({});
    const r = await request(app)
      .post("/api/v1/ontologies/ont-1/explorations")
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.errorCode).toBe("VALIDATION_ERROR");
  });
});

describe("T-08 GET / — list filter (C-115)", () => {
  it("T-08 C-115: list query carries `required_markings <@ $3::text[]` with caller markings", async () => {
    queryMock.mockImplementation(async () => ({
      rows: [{ exploration_id: "e1" }],
      rowCount: 1,
    }));
    const app = makeApp({ userId: "alice", markings: ["PUBLIC"] });
    const r = await request(app).get("/api/v1/ontologies/ont-1/explorations");
    expect(r.status).toBe(200);
    const listCalls = queryMock.mock.calls.filter((c: any[]) =>
      /SELECT \* FROM saved_exploration[\s\S]*required_markings <@ \$3::text\[\]/.test(c[0]),
    );
    expect(listCalls.length).toBe(1);
    expect(listCalls[0][1][2]).toEqual(["PUBLIC"]);
  });
});
