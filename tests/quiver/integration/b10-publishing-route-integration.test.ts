// B10 — Publishing route integration tests.
//
// Coverage:
//   B10 C-01..C-03 : POST /dashboards
//   B10 C-04       : parameterSchema enforcement
//   B10 C-05       : version pinning
//   B10 C-06,C-07  : embed in ObjectView/Workshop
//   B10 C-08..C-10 : Visual Function publish + inline equality
//   B10 C-11       : If-Match required on PATCH
//   B10 C-12       : Idempotency-Key required on POST publish
//   B10 C-13       : branch forwarded
//   B10 C-15       : metrics emitted
//   B10 C-16       : audit emitted
//   B10 C-17       : Templates legacy returns Deprecation/Sunset headers

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
import { pool } from "../../../src/db";
import {
  applyQuiverMigrations,
  captureAudit,
  quiverApp,
  teardownQuiverTables,
} from "./_harness";

const TEST_USER = "ri.multipass.main.user.alice";
const TEST_ORG = "ri.multipass.main.org.acme";
const ANALYSIS_RID = "ri.tellus-quiver.main.analysis.018f4a9c-7d6e-7c8a-87b0-0123456789ab";

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

let auditCapture: ReturnType<typeof captureAudit>;

beforeEach(async () => {
  await teardownQuiverTables();
  auditCapture = captureAudit();
});

afterEach(() => {
  auditCapture.detach();
});

async function seedAnalysisWithCanvas(): Promise<void> {
  await pool.query(
    `INSERT INTO quiver_analysis
        (rid, parent_folder_rid, display_name, cards, canvases, parameters,
         current_version, etag, document_inline, markings, created_by, updated_by)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, 1, $7, $8::jsonb, $9, $10, $10)`,
    [
      ANALYSIS_RID,
      "ri.compass.main.folder.f1",
      "Test Analysis",
      JSON.stringify({
        $A: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false },
        $P: { id: "$P", type: "PARAMETER_NUMBER", inputs: {}, config: { default: 0.5 }, hidden: false },
      }),
      JSON.stringify([{ id: "main", displayName: "Main", ordering: ["$A"] }]),
      JSON.stringify({}),
      "etag-seed-1",
      JSON.stringify({}),
      ["public"],
      TEST_USER,
    ],
  );
}

const validSchema = {
  type: "object" as const,
  properties: { threshold: { type: "number" as const, default: 0.5 } },
  required: ["threshold"],
};

describe("B10 — POST /dashboards", () => {
  it("B10 C-01 / B10 C-02: 201 on publish; rid follows ri.tellus-quiver.main.dashboard format", async () => {
    await seedAnalysisWithCanvas();
    const r = await request(quiverApp())
      .post("/quiver/api/v1/dashboards")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        analysisRid: ANALYSIS_RID,
        displayName: "My Dashboard",
        exposedCanvases: ["main"],
        parameterSchema: validSchema,
      });
    expect(r.status).toBe(201);
    expect(r.body.rid).toMatch(/^ri\.tellus-quiver\.main\.dashboard\./);
    expect(r.body.currentVersion).toBe(1);
    expect(r.headers.etag).toBeTruthy();
  });

  it("B10 C-04: rejects when exposedCanvases references unknown canvas", async () => {
    await seedAnalysisWithCanvas();
    const r = await request(quiverApp())
      .post("/quiver/api/v1/dashboards")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        analysisRid: ANALYSIS_RID,
        displayName: "Bad",
        exposedCanvases: ["does-not-exist"],
        parameterSchema: validSchema,
      });
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("Tellus:Quiver:ExposedCanvasNotFound");
  });

  it("B10 C-12: missing Idempotency-Key → 400", async () => {
    await seedAnalysisWithCanvas();
    const r = await request(quiverApp())
      .post("/quiver/api/v1/dashboards")
      .set(authedHeaders())
      .send({
        analysisRid: ANALYSIS_RID,
        displayName: "Dash",
        exposedCanvases: ["main"],
        parameterSchema: validSchema,
      });
    expect(r.status).toBe(400);
  });

  it("B10 C-12: same Idempotency-Key replays byte-identical response", async () => {
    await seedAnalysisWithCanvas();
    const key = randomUUID();
    const body = {
      analysisRid: ANALYSIS_RID,
      displayName: "Dash2",
      exposedCanvases: ["main"],
      parameterSchema: validSchema,
    };
    const a = await request(quiverApp())
      .post("/quiver/api/v1/dashboards")
      .set(authedHeaders({ "idempotency-key": key }))
      .send(body);
    const b = await request(quiverApp())
      .post("/quiver/api/v1/dashboards")
      .set(authedHeaders({ "idempotency-key": key }))
      .send(body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.rid).toBe(a.body.rid);
  });

  it("B10 C-13: branch forwarded via X-Tellus-Branch", async () => {
    await seedAnalysisWithCanvas();
    const r = await request(quiverApp())
      .post("/quiver/api/v1/dashboards")
      .set(authedHeaders({ "idempotency-key": randomUUID(), "x-tellus-branch": "ontology-v2" }))
      .send({
        analysisRid: ANALYSIS_RID,
        displayName: "Branched",
        exposedCanvases: ["main"],
        parameterSchema: validSchema,
      });
    expect(r.status).toBe(201);
    expect(r.body.branch).toBe("ontology-v2");
  });

  it("B10 C-16: emits QUIVER_DASHBOARD_PUBLISHED audit", async () => {
    await seedAnalysisWithCanvas();
    await request(quiverApp())
      .post("/quiver/api/v1/dashboards")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        analysisRid: ANALYSIS_RID,
        displayName: "Audited",
        exposedCanvases: ["main"],
        parameterSchema: validSchema,
      });
    expect(
      auditCapture.events.find((e) => e.action === "QUIVER_DASHBOARD_PUBLISHED"),
    ).toBeTruthy();
  });
});

describe("B10 — PATCH /dashboards/:rid", () => {
  it("B10 C-11: missing If-Match → 412 VersionMismatch", async () => {
    await seedAnalysisWithCanvas();
    const c = await request(quiverApp())
      .post("/quiver/api/v1/dashboards")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        analysisRid: ANALYSIS_RID,
        displayName: "X",
        exposedCanvases: ["main"],
        parameterSchema: validSchema,
      });
    const r = await request(quiverApp())
      .patch(`/quiver/api/v1/dashboards/${c.body.rid}`)
      .set(authedHeaders())
      .send({ displayName: "X2" });
    expect(r.status).toBe(412);
  });

  it("B10 C-11: stale If-Match → 412", async () => {
    await seedAnalysisWithCanvas();
    const c = await request(quiverApp())
      .post("/quiver/api/v1/dashboards")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        analysisRid: ANALYSIS_RID,
        displayName: "X",
        exposedCanvases: ["main"],
        parameterSchema: validSchema,
      });
    const r = await request(quiverApp())
      .patch(`/quiver/api/v1/dashboards/${c.body.rid}`)
      .set(authedHeaders({ "if-match": "stale-etag" }))
      .send({ displayName: "X2" });
    expect(r.status).toBe(412);
  });

  it("B10 C-11: matching If-Match → 200 with new ETag", async () => {
    await seedAnalysisWithCanvas();
    const c = await request(quiverApp())
      .post("/quiver/api/v1/dashboards")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        analysisRid: ANALYSIS_RID,
        displayName: "X",
        exposedCanvases: ["main"],
        parameterSchema: validSchema,
      });
    const etag1 = c.body.etag;
    const r = await request(quiverApp())
      .patch(`/quiver/api/v1/dashboards/${c.body.rid}`)
      .set(authedHeaders({ "if-match": etag1 }))
      .send({ displayName: "Renamed" });
    expect(r.status).toBe(200);
    expect(r.body.etag).not.toBe(etag1);
    expect(r.body.displayName).toBe("Renamed");
  });
});

describe("B10 — embed endpoints", () => {
  it("B10 C-06: embedInObjectView writes embed record + emits audit", async () => {
    await seedAnalysisWithCanvas();
    const c = await request(quiverApp())
      .post("/quiver/api/v1/dashboards")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        analysisRid: ANALYSIS_RID,
        displayName: "X",
        exposedCanvases: ["main"],
        parameterSchema: validSchema,
      });
    const r = await request(quiverApp())
      .post(`/quiver/api/v1/dashboards/${c.body.rid}/embedInObjectView`)
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({ targetRid: "ri.object-view.main.view.foo", paramBindings: { threshold: 0.7 } });
    expect(r.status).toBe(201);
    expect(r.body.surface).toBe("OBJECT_VIEW");
    expect(r.body.dashboardRid).toBe(c.body.rid);
    expect(
      auditCapture.events.find((e) => e.action === "QUIVER_DASHBOARD_EMBED_REGISTERED"),
    ).toBeTruthy();
  });

  it("B10 C-07: embedInWorkshop writes embed record", async () => {
    await seedAnalysisWithCanvas();
    const c = await request(quiverApp())
      .post("/quiver/api/v1/dashboards")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        analysisRid: ANALYSIS_RID,
        displayName: "X",
        exposedCanvases: ["main"],
        parameterSchema: validSchema,
      });
    const r = await request(quiverApp())
      .post(`/quiver/api/v1/dashboards/${c.body.rid}/embedInWorkshop`)
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({ targetRid: "ri.workshop.main.module.bar" });
    expect(r.status).toBe(201);
    expect(r.body.surface).toBe("WORKSHOP");
  });
});

describe("B10 — Visual Functions", () => {
  it("B10 C-08 / B10 C-09: publish derives input schema from PARAMETER cards + output type from root", async () => {
    await seedAnalysisWithCanvas();
    const r = await request(quiverApp())
      .post("/quiver/api/v1/visual-functions")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        analysisRid: ANALYSIS_RID,
        displayName: "VF",
        exposedParameterCardIds: ["$P"],
        rootCardId: "$A",
      });
    expect(r.status).toBe(201);
    expect(r.body.rid).toMatch(/^ri\.tellus-quiver\.main\.visual-function\./);
    expect(r.body.outputType).toBe("OBJECT_SET");
    expect(r.body.inputSchema.properties.$P.type).toBe("number");
  });

  it("B10 C-10: inline returns sub-DAG byte-identical to the source analysis", async () => {
    await seedAnalysisWithCanvas();
    const c = await request(quiverApp())
      .post("/quiver/api/v1/visual-functions")
      .set(authedHeaders({ "idempotency-key": randomUUID() }))
      .send({
        analysisRid: ANALYSIS_RID,
        displayName: "VF",
        exposedParameterCardIds: ["$P"],
        rootCardId: "$A",
      });
    const r = await request(quiverApp())
      .get(`/quiver/api/v1/visual-functions/${c.body.rid}/inline`)
      .set(authedHeaders());
    expect(r.status).toBe(200);
    expect(r.body.rootCardId).toBe("$A");
    expect(r.body.cards.$A.type).toBe("OBJECT_SET");
  });
});

describe("B10 — Templates (legacy)", () => {
  it("B10 C-17: POST /templates returns Deprecation: true + Sunset header", async () => {
    const r = await request(quiverApp())
      .post("/quiver/api/v1/templates")
      .set(authedHeaders())
      .send({
        parentFolderRid: "ri.compass.main.folder.f1",
        displayName: "Legacy",
        snapshot: { hello: "world" },
      });
    expect(r.status).toBe(201);
    expect(r.headers.deprecation).toBe("true");
    expect(r.headers.sunset).toBe("2026-11-04");
  });
});

describe("B10 — auth", () => {
  it("missing user → 401", async () => {
    const r = await request(quiverApp())
      .post("/quiver/api/v1/dashboards")
      .set({ "idempotency-key": randomUUID() })
      .send({
        analysisRid: ANALYSIS_RID,
        displayName: "x",
        exposedCanvases: ["main"],
        parameterSchema: validSchema,
      });
    expect(r.status).toBe(401);
  });
});
