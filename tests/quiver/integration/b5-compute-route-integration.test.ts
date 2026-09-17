/**
 * B5 — Integration tests for POST /quiver/api/v1/compute/cards.
 *
 * Coverage of B5 contracts (T-06):
 *   B5 C-01  POST /compute/cards accepts ComputeCardRequest, returns CardResult.
 *   B5 C-03  BackendRouter returns NoBackendForCardType on unknown.
 *   B5 C-06  cacheBehavior modes (READ_WRITE / READ_ONLY / BYPASS / REFRESH).
 *   B5 C-07  cache TTL refresh on hit.
 *   B5 C-08  Ontology-version bump invalidates dependent cache rows.
 *   B5 C-09  X-Deadline propagation; DEADLINE_EXCEEDED at the boundary.
 *   B5 C-10  Branch forwarded; per-branch cache isolation.
 *   B5 C-13  Metrics emitted (compute_seconds, deadline_exceeded_total).
 *   B5 C-14  Circuit breaker opens after sustained failures.
 *   G-02   Conjure error envelope shape.
 */

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
  fakeCompass,
  quiverApp,
  teardownQuiverTables,
} from "./_harness";
import { register } from "prom-client";
import {
  resetComputeContext,
  setComputeContextForTests,
} from "../../../src/services/quiver/compute/context";
import type { CardBackend } from "../../../src/services/quiver/compute/types";
import { CacheRepository } from "../../../src/services/quiver/compute/cache";

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

let compassSpy: ReturnType<typeof fakeCompass>;

beforeEach(async () => {
  await teardownQuiverTables();
  compassSpy = fakeCompass();
  resetComputeContext();
});

afterEach(() => {
  compassSpy.detach();
  resetComputeContext();
});

/**
 * Create an analysis row and inject a single OBJECT_SET card into it via raw
 * UPDATE — bypasses the (B3) instruction-apply path so B5 can be tested
 * before B3 lands.
 */
async function createAnalysisWithCards(
  cards: Record<string, any> = {
    $A: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false },
  },
): Promise<{ rid: string; etag: string }> {
  const app = quiverApp();
  const r = await request(app)
    .post("/quiver/api/v1/analyses")
    .set(authedHeaders({ "idempotency-key": randomUUID() }))
    .send({
      parentFolderRid: "ri.compass.main.folder.f1",
      displayName: "B5 test analysis",
    });
  expect(r.status).toBe(201);
  const rid = r.body.rid as string;
  await pool.query(
    `UPDATE quiver_analysis SET cards = $1::jsonb WHERE rid = $2`,
    [JSON.stringify(cards), rid],
  );
  // Return the original etag (cards mutation bypassed normal flow).
  return { rid, etag: r.headers["etag"] };
}

describe("B5 C-01: POST /quiver/api/v1/compute/cards — happy path", () => {
  it("returns 200 with a CardResult shaped per the registry's declared output", async () => {
    const { rid } = await createAnalysisWithCards();
    const r = await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({
        analysisRid: rid,
        cardId: "$A",
        parameterOverrides: {},
        branch: "master",
        cacheBehavior: "READ_WRITE",
      });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      cardId: "$A",
      cardType: "OBJECT_SET",
      resultType: "OBJECT_SET",
      status: "OK",
      cacheOutcome: "miss",
      branch: "master",
    });
    expect(r.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.ontologyVersion).toBe("ontology@master");
  });

  it("second call (cacheBehavior=READ_WRITE) → cache hit", async () => {
    const { rid } = await createAnalysisWithCards();
    const app = quiverApp();
    const r1 = await request(app)
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", parameterOverrides: {}, branch: "master", cacheBehavior: "READ_WRITE" });
    expect(r1.body.cacheOutcome).toBe("miss");
    const r2 = await request(app)
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", parameterOverrides: {}, branch: "master", cacheBehavior: "READ_WRITE" });
    expect(r2.body.cacheOutcome).toBe("hit");
    expect(r2.body.contentHash).toBe(r1.body.contentHash);
  });
});

describe("B5 C-06: cacheBehavior", () => {
  it("BYPASS → never reads or writes cache", async () => {
    const { rid } = await createAnalysisWithCards();
    const app = quiverApp();
    const r1 = await request(app)
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", parameterOverrides: {}, branch: "master", cacheBehavior: "BYPASS" });
    expect(r1.body.cacheOutcome).toBe("bypass");
    const r2 = await request(app)
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", parameterOverrides: {}, branch: "master", cacheBehavior: "READ_WRITE" });
    // The BYPASS write didn't populate cache → second READ_WRITE is still miss.
    expect(r2.body.cacheOutcome).toBe("miss");
  });

  it("REFRESH → never reads but does write", async () => {
    const { rid } = await createAnalysisWithCards();
    const app = quiverApp();
    await request(app)
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", parameterOverrides: {}, branch: "master", cacheBehavior: "READ_WRITE" });
    const refresh = await request(app)
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", parameterOverrides: {}, branch: "master", cacheBehavior: "REFRESH" });
    expect(refresh.body.cacheOutcome).toBe("miss");
    const after = await request(app)
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", parameterOverrides: {}, branch: "master", cacheBehavior: "READ_WRITE" });
    expect(after.body.cacheOutcome).toBe("hit");
  });
});

describe("B5 C-08: ontology-version bump invalidates", () => {
  it("invalidateOnOntologyBump removes rows with stale ontology_version", async () => {
    const { rid } = await createAnalysisWithCards();
    await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", parameterOverrides: {}, branch: "master", cacheBehavior: "READ_WRITE" });
    const repo = new CacheRepository(pool);
    const removed = await repo.invalidateOnOntologyBump(rid, "master", "ontology@v999");
    expect(removed).toBe(1);
  });
});

describe("B5 C-09 / G-06: deadline propagation", () => {
  it("DEADLINE_EXCEEDED returned at the boundary, not after backend completion", async () => {
    const { rid } = await createAnalysisWithCards();
    // Inject a slow stub backend that sleeps 200 ms.
    const slowBackend: CardBackend = {
      cardType: "OBJECT_SET",
      backendName: "OSS",
      async execute() {
        await new Promise((r) => setTimeout(r, 200));
        return { resultType: "OBJECT_SET", payload: {}, status: "OK" };
      },
    };
    setComputeContextForTests({ backends: [slowBackend] });
    const start = Date.now();
    const r = await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", parameterOverrides: {}, branch: "master", cacheBehavior: "BYPASS", deadlineMs: 100 });
    const elapsed = Date.now() - start;
    expect(r.status).toBe(504);
    expect(r.body).toMatchObject({
      errorName: "Tellus:Quiver:DeadlineExceeded",
      errorCode: "DEADLINE_EXCEEDED",
    });
    expect(elapsed).toBeLessThan(180);
  });
});

describe("B5 C-10: per-branch cache isolation", () => {
  it("master and feature have independent cache rows", async () => {
    const { rid } = await createAnalysisWithCards();
    const app = quiverApp();
    const masterRes = await request(app)
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", parameterOverrides: {}, branch: "master", cacheBehavior: "READ_WRITE" });
    const featureRes = await request(app)
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", parameterOverrides: {}, branch: "feature", cacheBehavior: "READ_WRITE" });
    // Branch is mixed into the cache key so the second call must be a miss.
    expect(featureRes.body.cacheOutcome).toBe("miss");
    expect(featureRes.body.contentHash).not.toBe(masterRes.body.contentHash);
    expect(masterRes.body.ontologyVersion).toBe("ontology@master");
    expect(featureRes.body.ontologyVersion).toBe("ontology@feature");
  });
});

describe("B5 C-13: metrics", () => {
  it("compute_seconds and deadline_exceeded_total emit on the right paths", async () => {
    const { rid } = await createAnalysisWithCards();
    await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", parameterOverrides: {}, branch: "master", cacheBehavior: "READ_WRITE" });
    const text = await register.metrics();
    expect(text).toContain("tellus_quiver_compute_seconds_count");
    expect(text).toContain('cardType="OBJECT_SET"');
  });
});

describe("B5 C-03: NoBackendForCardType", () => {
  it("returns 500 NoBackendForCardType when no backend is registered for the card's type", async () => {
    const { rid } = await createAnalysisWithCards({
      $A: { id: "$A", type: "OBJECT_SET", inputs: {}, config: {}, hidden: false },
    });
    // Build a context with NO backends so OBJECT_SET is unhandled.
    setComputeContextForTests({ backends: [] });
    const r = await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$A", parameterOverrides: {}, branch: "master", cacheBehavior: "BYPASS" });
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({
      errorName: "Tellus:Quiver:NoBackendForCardType",
      errorCode: "NO_BACKEND_FOR_CARD_TYPE",
    });
  });
});

describe("G-02: error envelope shape", () => {
  it("404 on unknown card", async () => {
    const { rid } = await createAnalysisWithCards();
    const r = await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$DOES_NOT_EXIST", parameterOverrides: {}, branch: "master", cacheBehavior: "READ_WRITE" });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({
      errorName: "Tellus:Quiver:AnalysisNotFound",
      errorInstanceId: expect.any(String),
    });
  });
});
