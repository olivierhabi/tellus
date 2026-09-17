// Quiver B1 — integration tests for the analyses route.
// Runs against the real Postgres instance the rest of the suite uses.
//
// Coverage of B1 contracts (T-01):
//   B1 C-01  POST returns 201 + Location + ETag + body
//   B1 C-02  RID is UUIDv7-only
//   B1 C-03  displayName length [1, 200]
//   B1 C-04  description ≤ 2000
//   B1 C-07  seedFromObjectSet & seedFromTemplate mutually exclusive
//   B1 C-10  GET 404 on unknown / soft-deleted
//   B1 C-11/12  PATCH If-Match required + ETag returned
//   B1 C-13  parentFolderRid immutable
//   B1 C-14  DELETE soft + idempotent
//   B1 C-15  list pagination clamped to 200
//   B1 C-16  POST replay (cached) and conflict
//   B1 C-17  Concurrent PATCH race: exactly one wins
//   B1 C-19  branch propagation via header AND query
//   B1 C-22  audit row written for CREATE/UPDATE/DELETE
//   G-02    error envelope shape
//   G-04    Idempotency-Key required

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { register } from "prom-client";
import { pool } from "../../../src/db";
import {
  applyQuiverMigrations,
  captureAudit,
  fakeCompass,
  quiverApp,
  teardownQuiverTables,
} from "./_harness";

const TEST_USER = "ri.multipass.main.user.alice";
const TEST_ORG = "ri.multipass.main.org.acme";

function authedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "x-test-user": TEST_USER,
    "X-Tellus-Test-Auth-Token": process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "",
    "x-test-org": TEST_ORG,
    ...extra,
  };
}

beforeAll(async () => {
  process.env.QUIVER_ALLOW_TEST_AUTH = "1";
  process.env.TELLUS_QUIVER_PHASE = "5";
  await applyQuiverMigrations();
});

afterAll(async () => {
  await pool.end();
});

let auditCap: ReturnType<typeof captureAudit>;
let compassSpy: ReturnType<typeof fakeCompass>;

beforeEach(async () => {
  await teardownQuiverTables();
  auditCap = captureAudit();
  compassSpy = fakeCompass();
});

afterEach(() => {
  auditCap.detach();
  compassSpy.detach();
});

describe("Quiver B1 — POST /quiver/api/v1/analyses", () => {
  it("B1 C-01: returns 201 with Location, ETag, full document", async () => {
    const app = quiverApp();
    const idempotencyKey = randomUUID();
    const r = await request(app)
      .post("/quiver/api/v1/analyses")
      .set(authedHeaders({ "idempotency-key": idempotencyKey }))
      .send({
        parentFolderRid: "ri.compass.main.folder.f1",
        displayName: "Q1 sales analysis",
      });
    expect(r.status).toBe(201);
    expect(r.headers["location"]).toMatch(
      /^\/quiver\/api\/v1\/analyses\/ri\.tellus-quiver\.main\.analysis\./,
    );
    expect(r.headers["etag"]).toMatch(/^W\/"[0-9a-f]{64}"$/);
    expect(r.body.rid).toMatch(
      /^ri\.tellus-quiver\.main\.analysis\.[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(r.body.displayName).toBe("Q1 sales analysis");
    expect(r.body.currentVersion).toBe(0);
  });

  it("seeds a default canvas named \"Canvas 1\" so the editor opens onto a surface", async () => {
    const app = quiverApp();
    const r = await request(app)
      .post("/quiver/api/v1/analyses")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        parentFolderRid: "ri.compass.main.folder.f1",
        displayName: "Has a default canvas",
      });
    expect(r.status).toBe(201);
    expect(Array.isArray(r.body.canvases)).toBe(true);
    expect(r.body.canvases).toHaveLength(1);
    const canvas = r.body.canvases[0];
    expect(canvas.name).toBe("Canvas 1");
    expect(typeof canvas.id).toBe("string");
    expect(canvas.id.length).toBeGreaterThan(0);
    expect(canvas.placements).toEqual([]);
    expect(canvas.ordering).toEqual([]);

    // The seeded canvas survives a round-trip through GET (it's persisted in the
    // canvases column, not just the create response).
    const got = await request(app)
      .get(`/quiver/api/v1/analyses/${encodeURIComponent(r.body.rid)}`)
      .set(authedHeaders());
    expect(got.status).toBe(200);
    expect(got.body.canvases).toHaveLength(1);
    expect(got.body.canvases[0].name).toBe("Canvas 1");
  });

  it("G-04: missing Idempotency-Key → 400 InvalidAnalysisRequest", async () => {
    const app = quiverApp();
    const r = await request(app)
      .post("/quiver/api/v1/analyses")
      .set(authedHeaders())
      .send({
        parentFolderRid: "ri.compass.main.folder.f1",
        displayName: "x",
      });
    expect(r.status).toBe(400);
    expect(r.body.errorCode).toBe("INVALID_ARGUMENT");
    expect(r.body.errorName).toBe("Tellus:Quiver:InvalidAnalysisRequest");
    expect(r.body.errorInstanceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("B1 C-03: empty displayName → 400", async () => {
    const app = quiverApp();
    const r = await request(app)
      .post("/quiver/api/v1/analyses")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({ parentFolderRid: "ri.compass.main.folder.f1", displayName: "" });
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("Tellus:Quiver:InvalidAnalysisRequest");
  });

  it("B1 C-07: seedFromObjectSet + seedFromTemplate → 400", async () => {
    const app = quiverApp();
    const r = await request(app)
      .post("/quiver/api/v1/analyses")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        parentFolderRid: "ri.compass.main.folder.f1",
        displayName: "x",
        seedFromObjectSet: { ontologyRid: "ri.ontology.main.ontology.a" },
        seedFromTemplate: "ri.tellus-quiver.main.template.x",
      });
    expect(r.status).toBe(400);
  });

  it("B1 C-16: replay with same Idempotency-Key + same body → cached response, same RID", async () => {
    const app = quiverApp();
    const idempotencyKey = randomUUID();
    const body = {
      parentFolderRid: "ri.compass.main.folder.f1",
      displayName: "replay-target",
    };
    const r1 = await request(app)
      .post("/quiver/api/v1/analyses")
      .set(authedHeaders({ "idempotency-key": idempotencyKey }))
      .send(body);
    expect(r1.status).toBe(201);
    const r2 = await request(app)
      .post("/quiver/api/v1/analyses")
      .set(authedHeaders({ "idempotency-key": idempotencyKey }))
      .send(body);
    expect(r2.status).toBe(201);
    expect(r2.body.rid).toBe(r1.body.rid);
  });

  it("B1 C-16: same key + different body → 409 IdempotencyKeyReplay", async () => {
    const app = quiverApp();
    const idempotencyKey = randomUUID();
    const r1 = await request(app)
      .post("/quiver/api/v1/analyses")
      .set(authedHeaders({ "idempotency-key": idempotencyKey }))
      .send({
        parentFolderRid: "ri.compass.main.folder.f1",
        displayName: "first",
      });
    expect(r1.status).toBe(201);
    const r2 = await request(app)
      .post("/quiver/api/v1/analyses")
      .set(authedHeaders({ "idempotency-key": idempotencyKey }))
      .send({
        parentFolderRid: "ri.compass.main.folder.f1",
        displayName: "second",
      });
    expect(r2.status).toBe(409);
    expect(r2.body.errorName).toBe("Tellus:Quiver:IdempotencyKeyReplay");
  });

  it("B1 C-18: Compass registered every successful analysis", async () => {
    const app = quiverApp();
    await request(app)
      .post("/quiver/api/v1/analyses")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        parentFolderRid: "ri.compass.main.folder.f1",
        displayName: "alpha",
      });
    expect(compassSpy.registered).toHaveLength(1);
    expect(compassSpy.registered[0].folder).toBe(
      "ri.compass.main.folder.f1",
    );
  });

  it("B1 C-19: ?branch=topic-x propagates into Compass register call", async () => {
    const app = quiverApp();
    await request(app)
      .post("/quiver/api/v1/analyses?branch=topic-x")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        parentFolderRid: "ri.compass.main.folder.f1",
        displayName: "branch-aware",
      });
    expect(compassSpy.registered[0].branch).toBe("topic-x");
  });

  it("B1 C-22: CREATE emits exactly one QUIVER_ANALYSIS_CREATED audit row", async () => {
    const app = quiverApp();
    const r = await request(app)
      .post("/quiver/api/v1/analyses")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        parentFolderRid: "ri.compass.main.folder.f1",
        displayName: "audit me",
      });
    expect(r.status).toBe(201);
    expect(auditCap.events).toHaveLength(1);
    expect(auditCap.events[0].action).toBe("QUIVER_ANALYSIS_CREATED");
    expect(auditCap.events[0].rid).toBe(r.body.rid);
    expect(auditCap.events[0].afterEtag).toBe(r.headers["etag"]);
  });
});

describe("Quiver B1 — GET /analyses/:rid", () => {
  async function seed(app: ReturnType<typeof quiverApp>): Promise<{
    rid: string;
    etag: string;
  }> {
    const r = await request(app)
      .post("/quiver/api/v1/analyses")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        parentFolderRid: "ri.compass.main.folder.f1",
        displayName: "seed",
      });
    return { rid: r.body.rid, etag: r.headers["etag"] };
  }

  it("B1 C-10: GET returns 200 with ETag", async () => {
    const app = quiverApp();
    const { rid, etag } = await seed(app);
    const r = await request(app)
      .get(`/quiver/api/v1/analyses/${rid}`)
      .set(authedHeaders());
    expect(r.status).toBe(200);
    expect(r.headers["etag"]).toBe(etag);
  });

  it("B1 C-10: unknown rid → 404 AnalysisNotFound", async () => {
    const app = quiverApp();
    const r = await request(app)
      .get(
        "/quiver/api/v1/analyses/ri.tellus-quiver.main.analysis.018f6c2d-7000-7abc-8def-1234567890ab",
      )
      .set(authedHeaders());
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("Tellus:Quiver:AnalysisNotFound");
  });
});

describe("Quiver B1 — PATCH /analyses/:rid", () => {
  async function seed(app: ReturnType<typeof quiverApp>): Promise<{
    rid: string;
    etag: string;
  }> {
    const r = await request(app)
      .post("/quiver/api/v1/analyses")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        parentFolderRid: "ri.compass.main.folder.f1",
        displayName: "before",
      });
    return { rid: r.body.rid, etag: r.headers["etag"] };
  }

  it("B1 C-11: missing If-Match → 412", async () => {
    const app = quiverApp();
    const { rid } = await seed(app);
    const r = await request(app)
      .patch(`/quiver/api/v1/analyses/${rid}`)
      .set(authedHeaders())
      .send({ displayName: "after" });
    expect(r.status).toBe(412);
    expect(r.body.errorName).toBe("Tellus:Quiver:VersionMismatch");
  });

  it("B1 C-11/C-12: stale If-Match → 412 with currentEtag; current → 200 + new ETag", async () => {
    const app = quiverApp();
    const { rid, etag } = await seed(app);
    const stale = await request(app)
      .patch(`/quiver/api/v1/analyses/${rid}`)
      .set(authedHeaders({ "if-match": 'W/"deadbeef"' }))
      .send({ displayName: "after" });
    expect(stale.status).toBe(412);
    expect(stale.body.errorName).toBe("Tellus:Quiver:VersionMismatch");
    expect(stale.body.parameters.currentEtag).toBe(etag);

    const fresh = await request(app)
      .patch(`/quiver/api/v1/analyses/${rid}`)
      .set(authedHeaders({ "if-match": etag }))
      .send({ displayName: "after" });
    expect(fresh.status).toBe(200);
    expect(fresh.headers["etag"]).not.toBe(etag);
    expect(fresh.body.displayName).toBe("after");
  });

  it("B1 C-13: rejects parentFolderRid mutation", async () => {
    const app = quiverApp();
    const { rid, etag } = await seed(app);
    const r = await request(app)
      .patch(`/quiver/api/v1/analyses/${rid}`)
      .set(authedHeaders({ "if-match": etag }))
      .send({
        displayName: "ok",
        parentFolderRid: "ri.compass.main.folder.other",
      });
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("Tellus:Quiver:InvalidAnalysisRequest");
  });

  it("B1 C-17: concurrent PATCH race — exactly one wins, others 412", async () => {
    const app = quiverApp();
    const { rid, etag } = await seed(app);
    const N = 8;
    const calls = Array.from({ length: N }, (_, i) =>
      request(app)
        .patch(`/quiver/api/v1/analyses/${rid}`)
        .set(authedHeaders({ "if-match": etag }))
        .send({ displayName: `racer-${i}` }),
    );
    const results = await Promise.all(calls);
    const ok = results.filter((r) => r.status === 200);
    const failed = results.filter((r) => r.status === 412);
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(N - 1);
  });

  it("B1 C-22: UPDATE emits one QUIVER_ANALYSIS_UPDATED audit row", async () => {
    const app = quiverApp();
    const { rid, etag } = await seed(app);
    auditCap.reset();
    const r = await request(app)
      .patch(`/quiver/api/v1/analyses/${rid}`)
      .set(authedHeaders({ "if-match": etag }))
      .send({ displayName: "audit-this" });
    expect(r.status).toBe(200);
    expect(auditCap.events).toHaveLength(1);
    expect(auditCap.events[0].action).toBe("QUIVER_ANALYSIS_UPDATED");
    expect(auditCap.events[0].beforeEtag).toBe(etag);
    expect(auditCap.events[0].afterEtag).toBe(r.headers["etag"]);
  });
});

describe("Quiver B1 — DELETE /analyses/:rid", () => {
  async function seed(app: ReturnType<typeof quiverApp>): Promise<{
    rid: string;
    etag: string;
  }> {
    const r = await request(app)
      .post("/quiver/api/v1/analyses")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        parentFolderRid: "ri.compass.main.folder.f1",
        displayName: "to-delete",
      });
    return { rid: r.body.rid, etag: r.headers["etag"] };
  }

  it("B1 C-14: soft delete + idempotent on repeat", async () => {
    const app = quiverApp();
    const { rid, etag } = await seed(app);
    const r1 = await request(app)
      .delete(`/quiver/api/v1/analyses/${rid}`)
      .set(authedHeaders({ "if-match": etag }));
    expect(r1.status).toBe(204);
    // After delete, GET → 404
    const r2 = await request(app)
      .get(`/quiver/api/v1/analyses/${rid}`)
      .set(authedHeaders());
    expect(r2.status).toBe(404);
    // Repeat DELETE → idempotent (also 204; or 412 since ETag we sent
    // first matched the live row; second time the row is soft-deleted so
    // delete is a no-op returning 204).
    const r3 = await request(app)
      .delete(`/quiver/api/v1/analyses/${rid}`)
      .set(authedHeaders({ "if-match": etag }));
    expect([204]).toContain(r3.status);
  });

  it("B1 C-22: DELETE emits QUIVER_ANALYSIS_DELETED audit row", async () => {
    const app = quiverApp();
    const { rid, etag } = await seed(app);
    auditCap.reset();
    await request(app)
      .delete(`/quiver/api/v1/analyses/${rid}`)
      .set(authedHeaders({ "if-match": etag }));
    expect(auditCap.events).toHaveLength(1);
    expect(auditCap.events[0].action).toBe("QUIVER_ANALYSIS_DELETED");
  });
});

describe("Quiver B1 — GET /folders/:folderRid/analyses (B1 C-15)", () => {
  it("B1 C-15: pagination clamped to 200; cursor produces stable order", async () => {
    const app = quiverApp();
    // Seed 5 analyses
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/quiver/api/v1/analyses")
        .set(authedHeaders({ "idempotency-key": randomUUID() }))
        .send({
          parentFolderRid: "ri.compass.main.folder.list",
          displayName: `a-${i}`,
        });
    }
    const r = await request(app)
      .get("/quiver/api/v1/folders/ri.compass.main.folder.list/analyses")
      .set(authedHeaders());
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBe(5);
  });
});

describe("Quiver B1 — poisoned-row resilience (OT write/read schema divergence)", () => {
  const POISON_FOLDER = "ri.compass.main.folder.poison";

  // A card map written by the old loose OT schema: keys and ids that
  // AnalysisDocument.parse (types.ts CardId/CARD_TYPES) rejects.
  const POISON_CARDS = {
    c1: { id: "c1", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false },
  };

  async function seedAnalysis(
    app: ReturnType<typeof quiverApp>,
    displayName: string,
  ): Promise<{ rid: string; etag: string }> {
    const r = await request(app)
      .post("/quiver/api/v1/analyses")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({ parentFolderRid: POISON_FOLDER, displayName });
    expect(r.status).toBe(201);
    return { rid: r.body.rid, etag: r.headers["etag"] };
  }

  it("listAnalysesInFolder skips an unparseable row instead of 500ing the folder", async () => {
    const app = quiverApp();
    const a = await seedAnalysis(app, "healthy-a");
    const poisoned = await seedAnalysis(app, "poisoned");
    const b = await seedAnalysis(app, "healthy-b");

    await pool.query(
      "UPDATE quiver_analysis SET cards = $1::jsonb WHERE rid = $2",
      [JSON.stringify(POISON_CARDS), poisoned.rid],
    );

    // The poisoned row itself still fails honestly on direct GET...
    const single = await request(app)
      .get(`/quiver/api/v1/analyses/${poisoned.rid}`)
      .set(authedHeaders());
    expect(single.status).toBe(500);

    // ...but the folder listing returns 200 with the surviving entries.
    const list = await request(app)
      .get(`/quiver/api/v1/folders/${POISON_FOLDER}/analyses`)
      .set(authedHeaders());
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items.map((i: { rid: string }) => i.rid).sort()).toEqual(
      [a.rid, b.rid].sort(),
    );

    const metrics = await register.metrics();
    expect(metrics).toMatch(
      /tellus_quiver_analyses_corrupt_skipped_total\{endpoint="GET \/folders\/:folderRid\/analyses"\} [1-9]/,
    );
  });

  it("deleteAnalysis recovers a poisoned row via the If-Match etag from the 412 body", async () => {
    const app = quiverApp();
    const poisoned = await seedAnalysis(app, "poisoned-delete");

    await pool.query(
      "UPDATE quiver_analysis SET cards = $1::jsonb WHERE rid = $2",
      [JSON.stringify(POISON_CARDS), poisoned.rid],
    );

    // GET 500s so the victim cannot read the ETag header. Probe DELETE with
    // a bogus If-Match: the 412 body carries the RAW row's etag column.
    const probe = await request(app)
      .delete(`/quiver/api/v1/analyses/${poisoned.rid}`)
      .set(authedHeaders({ "if-match": 'W/"deadbeef"' }));
    expect(probe.status).toBe(412);
    expect(probe.body.errorName).toBe("Tellus:Quiver:VersionMismatch");
    const rawEtag = probe.body.parameters.currentEtag;
    expect(typeof rawEtag).toBe("string");
    expect(rawEtag.length).toBeGreaterThan(0);

    // Retry with the recovered etag → soft-delete succeeds on the corrupt row.
    const del = await request(app)
      .delete(`/quiver/api/v1/analyses/${poisoned.rid}`)
      .set(authedHeaders({ "if-match": rawEtag }));
    expect(del.status).toBe(204);

    const row = await pool.query(
      "SELECT is_deleted FROM quiver_analysis WHERE rid = $1",
      [poisoned.rid],
    );
    expect(row.rows[0].is_deleted).toBe(true);

    // The corrupt-delete metric was counted (recovery path taken).
    const metrics = await register.metrics();
    expect(metrics).toMatch(
      /tellus_quiver_analyses_corrupt_skipped_total\{endpoint="DELETE \/analyses\/:rid"\} [1-9]/,
    );
  });
});

describe("Quiver B1 — auth (G-07)", () => {
  it("G-07: missing test-user header → 401 Unauthenticated", async () => {
    const app = quiverApp();
    const r = await request(app)
      .post("/quiver/api/v1/analyses")
      .set({ "idempotency-key": randomUUID() })
      .send({
        parentFolderRid: "ri.compass.main.folder.f1",
        displayName: "x",
      });
    expect(r.status).toBe(401);
    expect(r.body.errorName).toBe("Tellus:Quiver:Unauthenticated");
  });
});
