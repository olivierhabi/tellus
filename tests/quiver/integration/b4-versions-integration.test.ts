// Quiver B4 — version + working-state integration tests.
//
// Coverage:
//   B4 C-01: saveVersion requires If-Match; allocates monotonic version.
//   B4 C-02: named save requires non-empty message; namedOnly filter.
//   B4 C-03: revertToVersion requires If-Match; writes new version + new doc.
//   B4 C-04: listVersions paginates DESC.
//   B4 C-05: getVersion 404 → VersionNotFound.
//   B4 C-07: stateId is base36(10).
//   B4 C-08: createWorkingState with optional fromVersion.
//   B4 C-09: getWorkingState 404 → WorkingStateNotFound.
//   B4 C-10: TTL purge — advance updated_at past expires_at, sweeper removes row.
//   B4 C-12: audit rows for VERSION_SAVED + REVERTED.
//   B4 C-14: branch forwarded on every working-state read/write.
//   G-03:    If-Match enforcement.

import {
  afterAll,
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
  fakeCompass,
  quiverApp,
  teardownQuiverTables,
} from "./_harness";

const TEST_USER = "ri.multipass.main.user.b4";
const TEST_ORG = "ri.multipass.main.org.b4";
const FOLDER = "ri.compass.main.folder.b4";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-test-user": TEST_USER, "x-test-org": TEST_ORG, ...extra };
}

beforeAll(async () => {
  process.env.QUIVER_ALLOW_TEST_AUTH = "1";
  process.env.TELLUS_QUIVER_PHASE = "5";
  await applyQuiverMigrations();
});

afterAll(async () => {
  await pool.end();
});

let compass: ReturnType<typeof fakeCompass>;
let audit: ReturnType<typeof captureAudit>;

beforeEach(async () => {
  await teardownQuiverTables();
  compass?.detach();
  audit?.detach();
  compass = fakeCompass();
  audit = captureAudit();
});

async function newAnalysis(app: ReturnType<typeof quiverApp>): Promise<{ rid: string; etag: string }> {
  const res = await request(app)
    .post("/quiver/api/v1/analyses")
    .set(headers({ "idempotency-key": randomUUID(), "content-type": "application/json" }))
    .send({ displayName: "B4 analysis", parentFolderRid: FOLDER });
  expect(res.status).toBe(201);
  return { rid: res.body.rid, etag: res.headers["etag"] as string };
}

describe("Versions — saveVersion / list / get / revert (B4 C-01..C-05/C-12)", () => {
  it("B4 C-01: saveVersion requires If-Match (G-03)", async () => {
    const app = quiverApp();
    const { rid } = await newAnalysis(app);
    const r = await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions`)
      .set(headers({ "content-type": "application/json" }))
      .send({});
    expect(r.status).toBe(412);
    expect(r.body.errorName).toBe("Tellus:Quiver:VersionMismatch");
  });

  it("B4 C-01: allocates monotonic versions per (rid, branch)", async () => {
    const app = quiverApp();
    const { rid, etag } = await newAnalysis(app);
    const v1 = await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions`)
      .set(headers({ "if-match": etag, "content-type": "application/json" }))
      .send({});
    expect(v1.status).toBe(201);
    expect(v1.body.version).toBe(1);
    const v2 = await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions`)
      .set(headers({ "if-match": etag, "content-type": "application/json" }))
      .send({});
    expect(v2.status).toBe(201);
    expect(v2.body.version).toBe(2);
    expect(v2.body.parentVersion).toBe(1);
  });

  it("B4 C-02: named save requires a non-empty message", async () => {
    const app = quiverApp();
    const { rid, etag } = await newAnalysis(app);
    const r = await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions`)
      .set(headers({ "if-match": etag, "content-type": "application/json" }))
      .send({ named: true });
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("Tellus:Quiver:InvalidAnalysisRequest");
  });

  it("B4 C-02 / C-04: namedOnly filter returns only named saves; pagination DESC", async () => {
    const app = quiverApp();
    const { rid, etag } = await newAnalysis(app);
    // 3 saves: 1 autosave, 2 named
    await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions`)
      .set(headers({ "if-match": etag, "content-type": "application/json" }))
      .send({ named: false });
    await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions`)
      .set(headers({ "if-match": etag, "content-type": "application/json" }))
      .send({ named: true, message: "first named" });
    await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions`)
      .set(headers({ "if-match": etag, "content-type": "application/json" }))
      .send({ named: true, message: "second named" });

    const all = await request(app)
      .get(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions`)
      .set(headers());
    expect(all.body.items).toHaveLength(3);
    expect(all.body.items[0].version).toBeGreaterThan(all.body.items[1].version);

    const named = await request(app)
      .get(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions?namedOnly=true`)
      .set(headers());
    expect(named.body.items.every((v: { isNamedSave: boolean }) => v.isNamedSave)).toBe(true);
    expect(named.body.items).toHaveLength(2);
  });

  it("B4 C-05: getVersion → 404 VersionNotFound for missing version", async () => {
    const app = quiverApp();
    const { rid } = await newAnalysis(app);
    const r = await request(app)
      .get(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions/999`)
      .set(headers());
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("Tellus:Quiver:VersionNotFound");
  });

  it("B4 C-03: revert requires If-Match; writes new version + restores doc; B4 C-12 audit emitted", async () => {
    const app = quiverApp();
    const { rid, etag } = await newAnalysis(app);
    // Save initial empty version.
    const v1 = await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions`)
      .set(headers({ "if-match": etag, "content-type": "application/json" }))
      .send({ named: true, message: "init" });
    expect(v1.status).toBe(201);

    // Mutate the doc directly so revert has something to restore.
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE quiver_analysis SET cards = $1::jsonb, updated_at = now() WHERE rid = $2`,
        [JSON.stringify({ $A: { id: "$A", type: "OBJECT_SET", config: {}, inputs: {}, hidden: false } }), rid],
      );
    } finally {
      client.release();
    }

    const noIf = await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions/1:revert`)
      .set(headers());
    expect(noIf.status).toBe(412);

    const rev = await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions/1:revert`)
      .set(headers({ "if-match": etag }));
    expect(rev.status).toBe(200);
    expect(rev.body.revertedTo).toBe(1);
    expect(rev.body.newVersion).toBe(2);

    const post = await request(app)
      .get(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}`)
      .set(headers());
    expect(post.status).toBe(200);
    expect(Object.keys(post.body.cards)).toEqual([]);

    expect(audit.events.some((e) => e.action === "QUIVER_ANALYSIS_VERSION_SAVED")).toBe(true);
    expect(audit.events.some((e) => e.action === "QUIVER_ANALYSIS_REVERTED")).toBe(true);
  });
});

describe("Working state — create / get / TTL purge (B4 C-07..C-10/C-14)", () => {
  it("B4 C-07/C-08: create returns base36(10) stateId + expiresAt 24h ahead", async () => {
    const app = quiverApp();
    const { rid } = await newAnalysis(app);
    const r = await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/working-states`)
      .set(headers({ "content-type": "application/json" }))
      .send({});
    expect(r.status).toBe(201);
    expect(r.body.stateId).toMatch(/^[a-z0-9]{10}$/);
    const exp = new Date(r.body.expiresAt).getTime();
    const now = Date.now();
    expect(exp - now).toBeGreaterThan(23 * 3600 * 1000);
    expect(exp - now).toBeLessThan(25 * 3600 * 1000);
  });

  it("B4 C-09: get returns 404 WorkingStateNotFound for unknown stateId", async () => {
    const app = quiverApp();
    const { rid } = await newAnalysis(app);
    const r = await request(app)
      .get(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/working-states/0000000000`)
      .set(headers());
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("Tellus:Quiver:WorkingStateNotFound");
  });

  it("B4 C-08: PUT upserts the document, GET returns it", async () => {
    const app = quiverApp();
    const { rid } = await newAnalysis(app);
    const created = await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/working-states`)
      .set(headers({ "content-type": "application/json" }))
      .send({});
    const sid = created.body.stateId as string;
    const payload = { cards: { $A: { id: "$A", type: "OBJECT_SET", config: {}, inputs: {} } } };
    const put = await request(app)
      .put(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/working-states/${sid}`)
      .set(headers({ "content-type": "application/json" }))
      .send(payload);
    expect(put.status).toBe(200);
    const get = await request(app)
      .get(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/working-states/${sid}`)
      .set(headers());
    expect(get.body.document.cards).toEqual(payload.cards);
  });

  it("B4 C-10: TTL purge removes rows past expires_at", async () => {
    const app = quiverApp();
    const { rid } = await newAnalysis(app);
    const r = await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/working-states`)
      .set(headers({ "content-type": "application/json" }))
      .send({});
    const sid = r.body.stateId as string;

    // Force expiry by rewriting the row (simulating 24h+1s elapsed).
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE quiver_working_state SET expires_at = now() - INTERVAL '1 second'
          WHERE rid = $1 AND state_id = $2`,
        [rid, sid],
      );
    } finally {
      client.release();
    }

    const purge = await request(app)
      .post(`/quiver/api/v1/_admin/purge-working-states`)
      .set(headers());
    expect(purge.status).toBe(200);
    expect(purge.body.purged).toBeGreaterThanOrEqual(1);

    const get = await request(app)
      .get(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/working-states/${sid}`)
      .set(headers());
    expect(get.status).toBe(404);
  });

  it("B4 C-14: branch forwarded — different X-Tellus-Branch isolates state", async () => {
    const app = quiverApp();
    const { rid } = await newAnalysis(app);
    const mainCreate = await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/working-states`)
      .set(headers({ "content-type": "application/json", "x-tellus-branch": "main" }))
      .send({});
    const otherGet = await request(app)
      .get(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/working-states/${mainCreate.body.stateId}`)
      .set(headers({ "x-tellus-branch": "feature-x" }));
    // Other branch cannot see the main-branch row.
    expect(otherGet.status).toBe(404);
  });
});
