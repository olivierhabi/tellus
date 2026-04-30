// ---------------------------------------------------------------------------
// T-06 — /summary marking + visibility unit tests.
//
// Covers contracts C-92 (no |"system" fallback), C-93 (marking filter),
// C-94 (hidden visibility), C-95 (user-scoped favorites/recents),
// C-96 (LIMIT 20 cap), and the route's UNAUTHORIZED throw.
//
// We do not run real Postgres here; we mock the `query` import from
// `../db` and assert the SQL string includes the marking + visibility
// predicates and the right parameter set is bound.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the db module BEFORE importing the route so the route picks up
// our spy.
vi.mock("../../../src/db", () => {
  return {
    query: vi.fn(),
    default: { query: vi.fn() },
  };
});

import express from "express";
import request from "supertest";
import summaryRouter from "../../../src/routes/summary";
import { query as queryMock } from "../../../src/db";

const ONT = "ontology-1";

function makeApp(opts: {
  user?: { id?: string };
  markings?: string[];
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.user !== undefined) (req as any).user = opts.user;
    (req as any).security = {
      userId: opts.user?.id ?? "anonymous",
      markings: opts.markings ?? [],
      organizations: [],
      cbac: [],
      markingMode: "disjunctive",
      systemPrincipal: false,
    };
    next();
  });
  app.use("/api/v1/ontology/:ontologyId/summary", summaryRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res
      .status(err.code === "UNAUTHORIZED" ? 401 : 500)
      .json({ errorCode: err.code ?? "INTERNAL_ERROR", message: err.message });
  });
  return app;
}

describe("T-06 GET /summary/ — bundle (C-92, C-93, C-94, C-95, C-96)", () => {
  beforeEach(() => {
    (queryMock as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it("T-06 C-92: phantom user (req.user undefined) → 401 UNAUTHORIZED", async () => {
    const app = makeApp({});
    const r = await request(app).get(`/api/v1/ontology/${ONT}/summary/`);
    expect(r.status).toBe(401);
    expect(r.body.errorCode).toBe("UNAUTHORIZED");
    // No query should have been issued — UNAUTHORIZED is thrown before
    // any data-layer call.
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("T-06 C-93/C-94: object-types query carries marking + visibility predicates and bound user-markings array", async () => {
    (queryMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [],
      rowCount: 0,
    });
    const app = makeApp({ user: { id: "alice" }, markings: ["PUBLIC", "INTERNAL"] });
    const r = await request(app).get(`/api/v1/ontology/${ONT}/summary/`);
    expect(r.status).toBe(200);
    // Four queries: types, groups, favorites, recents.
    expect(queryMock).toHaveBeenCalledTimes(4);

    const typesCall = (queryMock as any).mock.calls[0];
    const typesSql = typesCall[0] as string;
    const typesParams = typesCall[1];
    expect(typesSql).toMatch(/FROM object_type/i);
    expect(typesSql).toMatch(/visibility[^!]*!=\s*'hidden'/i);
    expect(typesSql).toMatch(/marking_required IS NULL OR marking_required <@ \$2::text\[\]/);
    // C-96: bounded LIMIT 20.
    expect(typesSql).toMatch(/LIMIT 20/);
    expect(typesParams).toEqual([ONT, ["PUBLIC", "INTERNAL"]]);
  });

  it("T-06 C-93: groups query carries marking predicate", async () => {
    (queryMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [],
      rowCount: 0,
    });
    const app = makeApp({ user: { id: "alice" }, markings: [] });
    const r = await request(app).get(`/api/v1/ontology/${ONT}/summary/`);
    expect(r.status).toBe(200);

    const groupsCall = (queryMock as any).mock.calls[1];
    expect(groupsCall[0]).toMatch(/FROM object_type_group/);
    expect(groupsCall[0]).toMatch(/marking_required IS NULL OR marking_required <@ \$2::text\[\]/);
    expect(groupsCall[1]).toEqual([ONT, []]);
  });

  it("T-06 C-95: favorites and recents bind the *current* user id, not 'system'", async () => {
    (queryMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [],
      rowCount: 0,
    });
    const app = makeApp({ user: { id: "bob" }, markings: [] });
    const r = await request(app).get(`/api/v1/ontology/${ONT}/summary/`);
    expect(r.status).toBe(200);

    const favCall = (queryMock as any).mock.calls[2];
    const recCall = (queryMock as any).mock.calls[3];
    expect(favCall[0]).toMatch(/FROM user_favorite/);
    expect(favCall[0]).toMatch(/LIMIT 20/);
    expect(favCall[1]).toEqual(["bob"]);
    expect(recCall[0]).toMatch(/FROM user_recent_activity/);
    expect(recCall[0]).toMatch(/LIMIT 20/);
    expect(recCall[1]).toEqual(["bob"]);
  });
});

describe("T-06 GET /summary/:apiName — single (C-93, C-94)", () => {
  beforeEach(() => {
    (queryMock as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it("T-06 C-93/C-94: SQL carries marking + visibility predicates", async () => {
    (queryMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [{ api_name: "Employee" }],
      rowCount: 1,
    });
    const app = makeApp({ user: { id: "alice" }, markings: ["PUBLIC"] });
    const r = await request(app).get(`/api/v1/ontology/${ONT}/summary/Employee`);
    expect(r.status).toBe(200);
    const call = (queryMock as any).mock.calls[0];
    expect(call[0]).toMatch(/visibility[^!]*!=\s*'hidden'/i);
    expect(call[0]).toMatch(/(?:ot\.)?marking_required IS NULL OR (?:ot\.)?marking_required <@ \$3::text\[\]/);
    expect(call[1]).toEqual([ONT, "Employee", ["PUBLIC"]]);
  });

  it("T-06: 404 OBJECT_TYPE_NOT_FOUND when row is hidden by marking filter (IDOR-prevention)", async () => {
    (queryMock as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [],
      rowCount: 0,
    });
    const app = makeApp({ user: { id: "alice" }, markings: [] });
    const r = await request(app).get(`/api/v1/ontology/${ONT}/summary/SecretType`);
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe("OBJECT_TYPE_NOT_FOUND");
  });
});
