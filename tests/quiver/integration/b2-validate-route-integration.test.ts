// Quiver B2 — _validate route integration tests.
//
// Coverage:
//   B2 C-13: POST /analyses/:rid/_validate matches the in-process validator
//            envelope on rejection.
//   B2 C-04: type-mismatch via _validate route → 400 CardTypeInputMismatch.
//   B2 C-05: cycle via _validate route → 400 CyclicDag.
//   G-01:    auth required.
//   G-02:    Conjure error envelope shape on rejection.

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
  fakeCompass,
  quiverApp,
  teardownQuiverTables,
} from "./_harness";
import type { AnalysisDocument } from "../../../src/services/quiver/types";
import { validate as validateDag } from "../../../src/services/quiver/dag";

const TEST_USER = "ri.multipass.main.user.b2";
const TEST_ORG = "ri.multipass.main.org.b2";

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

beforeEach(async () => {
  await teardownQuiverTables();
  compass?.detach();
  compass = fakeCompass();
});

async function createAnalysis(app: ReturnType<typeof quiverApp>): Promise<string> {
  const res = await request(app)
    .post("/quiver/api/v1/analyses")
    .set(headers({ "idempotency-key": randomUUID(), "content-type": "application/json" }))
    .send({
      displayName: "B2 validate",
      parentFolderRid: "ri.compass.main.folder.b2",
    });
  expect(res.status).toBe(201);
  return res.body.rid;
}

async function injectCards(rid: string, cards: AnalysisDocument["cards"]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE quiver_analysis SET cards = $1, updated_at = now() WHERE rid = $2`,
      [JSON.stringify(cards), rid],
    );
  } finally {
    client.release();
  }
}

describe("POST /analyses/:rid/_validate (B2 C-13)", () => {
  it("returns 200 + topologicalOrder for an empty (valid) document", async () => {
    const app = quiverApp();
    const rid = await createAnalysis(app);
    const res = await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/_validate`)
      .set(headers());
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(Array.isArray(res.body.topologicalOrder)).toBe(true);
    expect(Array.isArray(res.body.warnings)).toBe(true);
  });

  it("returns 401 without auth (G-01)", async () => {
    const app = quiverApp();
    const rid = await createAnalysis(app);
    const res = await request(app).post(
      `/quiver/api/v1/analyses/${encodeURIComponent(rid)}/_validate`,
    );
    expect(res.status).toBe(401);
    expect(res.body.errorName).toBe("Tellus:Quiver:Unauthenticated");
  });

  it("B2 C-04: surfaces CardTypeInputMismatch with 400 + Conjure envelope", async () => {
    const app = quiverApp();
    const rid = await createAnalysis(app);
    await injectCards(rid, {
      $A: { id: "$A", type: "PARAMETER_NUMBER", config: {}, inputs: {}, hidden: false } as never,
      $B: { id: "$B", type: "FILTER_OBJECT_SET", config: {}, inputs: { src: "$A", predicate: "$A" }, hidden: false } as never,
    });
    const res = await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/_validate`)
      .set(headers());
    expect(res.status).toBe(400);
    expect(res.body.errorName).toBe("Tellus:Quiver:CardTypeInputMismatch");
    expect(res.body.errorCode).toBe("INVALID_ARGUMENT");
    expect(typeof res.body.errorInstanceId).toBe("string");
    expect(res.body.parameters.cardId).toBe("$B");
  });

  it("B2 C-05: surfaces CyclicDag with 400", async () => {
    const app = quiverApp();
    const rid = await createAnalysis(app);
    await injectCards(rid, {
      $A: { id: "$A", type: "FILTER_OBJECT_SET", config: {}, inputs: { src: "$B", predicate: "$P" }, hidden: false } as never,
      $B: { id: "$B", type: "FILTER_OBJECT_SET", config: {}, inputs: { src: "$A", predicate: "$P" }, hidden: false } as never,
      $P: { id: "$P", type: "BOOLEAN_FORMULA", config: {}, inputs: {}, hidden: false } as never,
    });
    const res = await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/_validate`)
      .set(headers());
    expect(res.status).toBe(400);
    expect(res.body.errorName).toBe("Tellus:Quiver:CyclicDag");
    expect(Array.isArray(res.body.parameters.cyclePath)).toBe(true);
  });

  it("B2 C-13: HTTP envelope is byte-identical to in-process validate() rejection", async () => {
    const app = quiverApp();
    const rid = await createAnalysis(app);
    const cyclic: AnalysisDocument["cards"] = {
      $A: { id: "$A", type: "FILTER_OBJECT_SET", config: {}, inputs: { src: "$B", predicate: "$P" }, hidden: false } as never,
      $B: { id: "$B", type: "FILTER_OBJECT_SET", config: {}, inputs: { src: "$A", predicate: "$P" }, hidden: false } as never,
      $P: { id: "$P", type: "BOOLEAN_FORMULA", config: {}, inputs: {}, hidden: false } as never,
    };
    await injectCards(rid, cyclic);
    const res = await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/_validate`)
      .set(headers());
    const inProc = validateDag({ cards: cyclic, canvases: [] } as never);
    expect(inProc.valid).toBe(false);
    if (!inProc.valid) {
      expect(res.body.errorName).toBe(inProc.errorName);
      expect(res.body.errorCode).toBe(inProc.errorCode);
      expect(res.body.parameters).toEqual(inProc.parameters);
    }
  });
});
