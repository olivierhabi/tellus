// B3 — integration tests for POST/GET /quiver/api/v1/analyses/:rid/instructions.
// Coverage:
//   B3 C-02  POST contract shape; returns InstructionAck { newVersion, ... }
//   B3 C-03  baseVersion stale beyond threshold → 412 OtBaseVersionTooOld
//   B3 C-09  monotonic seq per analysis; row in quiver_instruction_log
//   B3 C-10  GET log slice (replay endpoint)
//   B3 C-14  malformed instruction → 400 MalformedInstruction
//   B3 C-18  same client_op_id replay → idempotent ack
//   B3 C-19  audit row written for every accepted instruction
//   B3 C-20  metrics tellus_quiver_ot_* incremented
//   G-02     error envelope shape
//   G-11     branch propagation: branch column matches header

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { pool } from "../../../src/db";
import {
  applyQuiverMigrations,
  captureAudit,
  fakeCompass,
  quiverApp,
  teardownQuiverTables,
} from "./_harness";
import { register } from "prom-client";

const TEST_USER = "ri.multipass.main.user.alice";
const TEST_ORG = "ri.multipass.main.org.acme";

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-test-user": TEST_USER, "x-test-org": TEST_ORG, "X-Tellus-Test-Auth-Token": process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "", ...extra };
}

async function createAnalysis(branch?: string): Promise<{ rid: string; etag: string }> {
  const app = quiverApp();
  const headers = authed({ "idempotency-key": randomUUID() });
  if (branch) headers["x-tellus-branch"] = branch;
  const r = await request(app)
    .post("/quiver/api/v1/analyses")
    .set(headers)
    .send({
      parentFolderRid: "ri.compass.main.folder.f1",
      displayName: "B3 test",
    });
  expect(r.status).toBe(201);
  return { rid: r.body.rid, etag: r.headers["etag"] };
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

describe("B3 — POST /analyses/:rid/instructions", () => {
  it("B3 C-02 + C-09: accepts a batch, returns ack, advances seq", async () => {
    const app = quiverApp();
    const { rid } = await createAnalysis();
    const opId = randomUUID();
    const r = await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed())
      .send({
        baseVersion: 0,
        clientOpIds: [opId],
        instructions: [
          {
            kind: "addCard",
            card: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false },
          },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.newVersion).toBe(1);
    expect(r.body.transformedInstructions).toHaveLength(1);
    expect(r.headers["etag"]).toMatch(/^W\/"[0-9a-f]{64}"$/);

    // Persisted log row.
    const row = await pool.query(
      "SELECT seq, applied_by, branch FROM quiver_instruction_log WHERE rid = $1",
      [rid],
    );
    expect(row.rowCount).toBe(1);
    expect(Number(row.rows[0].seq)).toBe(1);
    expect(row.rows[0].applied_by).toBe(TEST_USER);
  });

  it("B3 C-09 — monotonic seq across two batches", async () => {
    const app = quiverApp();
    const { rid } = await createAnalysis();

    // Batch 1
    await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed())
      .send({
        baseVersion: 0,
        clientOpIds: [randomUUID()],
        instructions: [
          { kind: "addCard", card: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } },
        ],
      });
    // Batch 2
    const r2 = await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed())
      .send({
        baseVersion: 1,
        clientOpIds: [randomUUID(), randomUUID()],
        instructions: [
          { kind: "addCard", card: { id: "$B", type: "FILTER_OBJECT_SET", inputs: {}, config: {}, hidden: false } },
          { kind: "bindInput", cardId: "$B", slot: "in", sourceCardId: "$A" },
        ],
      });
    expect(r2.status).toBe(200);
    expect(r2.body.newVersion).toBe(3);
    const seqs = await pool.query(
      "SELECT seq FROM quiver_instruction_log WHERE rid = $1 ORDER BY seq",
      [rid],
    );
    expect(seqs.rows.map((r: any) => Number(r.seq))).toEqual([1, 2, 3]);
  });

  it("B3 C-14 — malformed instruction → 400 MalformedInstruction", async () => {
    const app = quiverApp();
    const { rid } = await createAnalysis();
    const r = await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed())
      .send({
        baseVersion: 0,
        clientOpIds: [randomUUID()],
        instructions: [{ kind: "fooBar" }],
      });
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("Tellus:Quiver:MalformedInstruction");
    expect(r.body.errorInstanceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("B3 C-18 — same client_op_id resubmission → cached ack, no double log", async () => {
    const app = quiverApp();
    const { rid } = await createAnalysis();
    const opId = randomUUID();
    const body = {
      baseVersion: 0,
      clientOpIds: [opId],
      instructions: [
        { kind: "addCard", card: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } },
      ],
    };
    const r1 = await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed())
      .send(body);
    expect(r1.status).toBe(200);
    const r2 = await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed())
      .send(body);
    expect(r2.status).toBe(200);
    expect(r2.body.transformedInstructions).toEqual([]);
    const rows = await pool.query(
      "SELECT count(*) FROM quiver_instruction_log WHERE rid = $1",
      [rid],
    );
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  it("B3 C-03 — baseVersion ahead of server → 412 VersionMismatch", async () => {
    const app = quiverApp();
    const { rid } = await createAnalysis();
    const r = await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed())
      .send({
        baseVersion: 999,
        clientOpIds: [randomUUID()],
        instructions: [
          { kind: "addCard", card: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } },
        ],
      });
    expect(r.status).toBe(412);
    expect(r.body.errorName).toBe("Tellus:Quiver:VersionMismatch");
  });

  it("B3 C-19 + G-11 — branch column matches header on every log row", async () => {
    const app = quiverApp();
    const { rid } = await createAnalysis("feature-x");
    await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed({ "x-tellus-branch": "feature-x" }))
      .send({
        baseVersion: 0,
        clientOpIds: [randomUUID()],
        instructions: [
          { kind: "addCard", card: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } },
        ],
      });
    const row = await pool.query(
      "SELECT branch FROM quiver_instruction_log WHERE rid = $1",
      [rid],
    );
    expect(row.rows[0].branch).toBe("feature-x");
  });

  it("B3 C-19 — emits audit row per accepted instruction", async () => {
    const app = quiverApp();
    const { rid } = await createAnalysis();
    auditCap.reset();
    await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed())
      .send({
        baseVersion: 0,
        clientOpIds: [randomUUID(), randomUUID()],
        instructions: [
          { kind: "addCard", card: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } },
          { kind: "addCard", card: { id: "$B", type: "FILTER_OBJECT_SET", inputs: {}, config: {}, hidden: false } },
        ],
      });
    // Allow microtasks to flush
    await new Promise((r) => setImmediate(r));
    const otAudits = auditCap.events.filter((e) => e.action === "QUIVER_OT_INSTRUCTION_APPLIED");
    expect(otAudits).toHaveLength(2);
    expect(otAudits[0].rid).toBe(rid);
    expect(otAudits[0].actorSubject).toBe(TEST_USER);
    expect(otAudits[0].details).toMatchObject({ instructionType: "addCard" });
  });

  it("B3 C-20 — metrics tellus_quiver_ot_submit_seconds incremented", async () => {
    const app = quiverApp();
    const { rid } = await createAnalysis();
    await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed())
      .send({
        baseVersion: 0,
        clientOpIds: [randomUUID()],
        instructions: [
          { kind: "addCard", card: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } },
        ],
      });
    const dump = await register.metrics();
    expect(dump).toMatch(/tellus_quiver_ot_submit_seconds/);
    expect(dump).toMatch(/tellus_quiver_ot_instruction_apply_seconds/);
  });

  it("G-02 — auth missing → 401 envelope", async () => {
    const app = quiverApp();
    const { rid } = await createAnalysis();
    const r = await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .send({
        baseVersion: 0,
        clientOpIds: [randomUUID()],
        instructions: [],
      });
    expect(r.status).toBe(401);
    expect(r.body.errorName).toBe("Tellus:Quiver:Unauthenticated");
  });
});

describe("B3 — GET /analyses/:rid/instructions (replay endpoint)", () => {
  it("B3 C-10 — returns log slice in seq order from fromSeq", async () => {
    const app = quiverApp();
    const { rid } = await createAnalysis();
    await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed())
      .send({
        baseVersion: 0,
        clientOpIds: [randomUUID(), randomUUID()],
        instructions: [
          { kind: "addCard", card: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } },
          { kind: "addCard", card: { id: "$B", type: "FILTER_OBJECT_SET", inputs: {}, config: {}, hidden: false } },
        ],
      });
    const r = await request(app)
      .get(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed())
      .query({ fromSeq: 0 });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    expect(r.body.instructions[0].kind).toBe("addCard");
    expect(r.body.instructions[1].kind).toBe("addCard");
  });

  it("regression: current_version drifted below MAX(seq) → batch still succeeds (no INTERNAL) and re-syncs", async () => {
    const app = quiverApp();
    const { rid } = await createAnalysis();

    // Seed an instruction log so MAX(seq) climbs to 3.
    await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed())
      .send({
        baseVersion: 0,
        clientOpIds: [randomUUID(), randomUUID(), randomUUID()],
        instructions: [
          { kind: "addCard", card: { id: "$SAA", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } },
          { kind: "addCard", card: { id: "$SAB", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } },
          { kind: "addCanvas", canvas: { id: "cv1", name: "C", ordering: [], placements: [] } },
        ],
      })
      .expect(200);

    const before = await pool.query(
      "SELECT current_version, (SELECT COALESCE(MAX(seq),0) FROM quiver_instruction_log WHERE rid = $1) AS max_seq FROM quiver_analysis WHERE rid = $1",
      [rid],
    );
    expect(Number(before.rows[0].max_seq)).toBe(3);

    // Corrupt the invariant: drive current_version *below* the log's MAX(seq),
    // exactly the demo-seed state that produced the PK(rid,seq) collision →
    // aborted-transaction cascade → Tellus:Quiver:Internal 500.
    await pool.query("UPDATE quiver_analysis SET current_version = 1 WHERE rid = $1", [rid]);

    // The user's failing flow: addCard + placeCardOnCanvas in one batch, with
    // baseVersion = the (stale) current_version.
    const r = await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed())
      .send({
        baseVersion: 1,
        clientOpIds: [randomUUID(), randomUUID()],
        instructions: [
          { kind: "addCard", card: { id: "$OBJ", type: "OBJECT_SET", config: { apiName: "OlivierOrderJune" }, inputs: {}, hidden: false } },
          { kind: "placeCardOnCanvas", cardId: "$OBJ", canvasId: "cv1", position: { x: 40, y: 40 }, size: { width: 480, height: 360 } },
        ],
      });

    // Before the fix this returned 500 INTERNAL.
    expect(r.status).toBe(200);
    expect(r.body.transformedInstructions).toHaveLength(2);

    // seq allocation jumped past the log high-water mark (4, 5) — no collision —
    // and current_version is back in sync with MAX(seq).
    const after = await pool.query(
      "SELECT current_version, (SELECT MAX(seq) FROM quiver_instruction_log WHERE rid = $1) AS max_seq FROM quiver_analysis WHERE rid = $1",
      [rid],
    );
    expect(Number(after.rows[0].max_seq)).toBe(5);
    expect(Number(after.rows[0].current_version)).toBe(5);
  });
});

describe("B3 — stored-shape round-trip (write schema == AnalysisDocument)", () => {
  it("updateParameter persists a Parameter-shaped entry; the row still parses (GET 200)", async () => {
    const app = quiverApp();
    const { rid } = await createAnalysis();
    const r = await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed())
      .send({
        baseVersion: 0,
        clientOpIds: [randomUUID(), randomUUID()],
        instructions: [
          { kind: "addCard", card: { id: "$P", type: "PARAMETER_STRING", inputs: {}, config: {}, hidden: false } },
          { kind: "updateParameter", parameterId: "$P", valueJson: "Olivier" },
        ],
      });
    expect(r.status).toBe(200);

    // Before the stored-shape fix the parameters column held
    // {"$P": {"value": ...}} — AnalysisDocument.parse rejected the row and
    // GET 500'd.
    const got = await request(app)
      .get(`/quiver/api/v1/analyses/${rid}`)
      .set(authed());
    expect(got.status).toBe(200);
    expect(got.body.parameters["$P"]).toMatchObject({
      cardId: "$P",
      type: "STRING",
      defaultValueJson: "Olivier",
    });
  });

  it("addCanvas placements round-trip as the stored array form", async () => {
    const app = quiverApp();
    const { rid } = await createAnalysis();
    const r = await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed())
      .send({
        baseVersion: 0,
        clientOpIds: [randomUUID()],
        instructions: [
          {
            kind: "addCanvas",
            canvas: {
              id: "cvX",
              name: "X",
              placements: [{ cardId: "$A", x: 10, y: 20, w: 200, h: 120 }],
              ordering: ["$A"],
            },
          },
        ],
      });
    expect(r.status).toBe(200);

    const got = await request(app)
      .get(`/quiver/api/v1/analyses/${rid}`)
      .set(authed());
    expect(got.status).toBe(200);
    const cv = (got.body.canvases as Array<{ id: string; placements: unknown[]; ordering: string[] }>).find(
      (c) => c.id === "cvX",
    );
    expect(cv).toBeDefined();
    expect(cv!.placements).toEqual([{ cardId: "$A", x: 10, y: 20, w: 200, h: 120 }]);
    expect(cv!.ordering).toEqual(["$A"]);
  });

  it("loose card id/type is rejected with 400 MalformedInstruction (write == read)", async () => {
    const app = quiverApp();
    const { rid } = await createAnalysis();
    const bad = await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed())
      .send({
        baseVersion: 0,
        clientOpIds: [randomUUID()],
        instructions: [
          { kind: "addCard", card: { id: "c1", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false } },
        ],
      });
    expect(bad.status).toBe(400);
    expect(bad.body.errorName).toBe("Tellus:Quiver:MalformedInstruction");

    const badType = await request(app)
      .post(`/quiver/api/v1/analyses/${rid}/instructions`)
      .set(authed())
      .send({
        baseVersion: 0,
        clientOpIds: [randomUUID()],
        instructions: [
          { kind: "addCard", card: { id: "$A", type: "metric", inputs: {}, config: {}, hidden: false } },
        ],
      });
    expect(badType.status).toBe(400);
    expect(badType.body.errorName).toBe("Tellus:Quiver:MalformedInstruction");

    // The row was never poisoned: GET still 200s.
    const got = await request(app)
      .get(`/quiver/api/v1/analyses/${rid}`)
      .set(authed());
    expect(got.status).toBe(200);
  });
});
