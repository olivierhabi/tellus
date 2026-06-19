// GATE-02 — Compute Coordinator Cache & Deadline Gate (in-process equivalent).
//
// Spec: 10K compute requests across all card-type backends; cache hit ratio
// >= 80%; zero deadlines exceeded by > 50ms; zero cache-key collisions;
// branch propagation observed on every downstream call.
//
// In-process equivalent (per D-23): 200 compute requests over 10 distinct
// (cardId, branch) combos -> at least 80% cache hit ratio. Branch
// propagation asserted on every recorded backend invocation.
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
import {
  resetComputeContext,
  setComputeContextForTests,
} from "../../../src/services/quiver/compute/context";
import type { CardBackend } from "../../../src/services/quiver/compute/types";

const TEST_USER = "ri.multipass.main.user.alice";
const TEST_ORG = "ri.multipass.main.org.acme";
function authedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-test-user": TEST_USER, "x-test-org": TEST_ORG, ...extra };
}

beforeAll(async () => {
  process.env.QUIVER_ALLOW_TEST_AUTH = "1";
  process.env.TELLUS_QUIVER_PHASE = "5";
  await applyQuiverMigrations();
});
afterAll(async () => { await pool.end(); });

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

async function seedAnalysisWithCards(cardIds: string[]): Promise<string> {
  const app = quiverApp();
  const create = await request(app)
    .post("/quiver/api/v1/analyses")
    .set(authedHeaders({ "idempotency-key": randomUUID() }))
    .send({
      parentFolderRid: "ri.compass.main.folder.gate-02",
      displayName: "GATE-02 analysis",
    });
  expect(create.status).toBe(201);
  const rid = create.body.rid as string;
  const cards: Record<string, unknown> = {};
  for (const id of cardIds) {
    cards[id] = { id, type: "OBJECT_SET", inputs: {}, config: { seedSize: id.length }, hidden: false };
  }
  await pool.query(`UPDATE quiver_analysis SET cards = $1::jsonb WHERE rid = $2`, [JSON.stringify(cards), rid]);
  return rid;
}

describe("GATE-02 — compute cache + deadline + branch", () => {
  it("achieves >= 80% cache hit ratio on a warm mix; branch propagation on every call", async () => {
    const cardIds = ["$A","$B","$C","$D","$E","$F","$G","$H","$I","$J"];
    const rid = await seedAnalysisWithCards(cardIds);

    let backendCallCount = 0;
    const branchesSeen = new Set<string>();
    const recorderBackend: CardBackend = {
      cardType: "OBJECT_SET",
      backendName: "GATE-02-recorder",
      execute: async (input) => {
        backendCallCount++;
        if (input.branch) branchesSeen.add(input.branch);
        else branchesSeen.add("__missing__");
        return {
          resultType: "OBJECT_SET",
          payload: { rows: [{ cardId: input.cardId, run: backendCallCount }] },
          contentHash: `${input.cardId}:${input.branch ?? "trunk"}`,
        };
      },
    };
    setComputeContextForTests({ backends: [recorderBackend] });

    const app = quiverApp();
    const branches = ["trunk", "feature/x"];

    let hits = 0;
    let misses = 0;
    for (const branch of branches) {
      for (const cardId of cardIds) {
        const res = await request(app)
          .post("/quiver/api/v1/compute/cards")
          .set(authedHeaders())
          .send({ analysisRid: rid, cardId, parameterOverrides: {}, branch, cacheBehavior: "READ_WRITE" });
        expect(res.status).toBe(200);
        if (res.body.cacheOutcome === "hit") hits++;
        else if (res.body.cacheOutcome === "miss") misses++;
      }
    }
    expect(misses).toBe(20);
    expect(hits).toBe(0);

    const N = 200;
    for (let i = 0; i < N - 20; i++) {
      const branch = branches[i % branches.length]!;
      const cardId = cardIds[i % cardIds.length]!;
      const res = await request(app)
        .post("/quiver/api/v1/compute/cards")
        .set(authedHeaders())
        .send({ analysisRid: rid, cardId, parameterOverrides: {}, branch, cacheBehavior: "READ_WRITE" });
      expect(res.status).toBe(200);
      if (res.body.cacheOutcome === "hit") hits++;
      else if (res.body.cacheOutcome === "miss") misses++;
    }

    const total = hits + misses;
    expect(total).toBe(N);
    expect(hits / total).toBeGreaterThanOrEqual(0.8);

    expect(branchesSeen.has("__missing__")).toBe(false);
    expect(branchesSeen.size).toBe(2);
    expect(branchesSeen.has("trunk")).toBe(true);
    expect(branchesSeen.has("feature/x")).toBe(true);

    // Backend was only called on the warm misses (cache served the hot phase).
    expect(backendCallCount).toBe(20);
  }, 60_000);

  it("returns DEADLINE_EXCEEDED at the boundary, not after backend completion", async () => {
    const rid = await seedAnalysisWithCards(["$SLOW"]);
    const slowBackend: CardBackend = {
      cardType: "OBJECT_SET",
      backendName: "GATE-02-slow",
      execute: async () => {
        await new Promise((r) => setTimeout(r, 800));
        return {
          resultType: "OBJECT_SET",
          payload: { rows: [] },
          contentHash: "slow",
        };
      },
    };
    setComputeContextForTests({ backends: [slowBackend] });

    const app = quiverApp();
    const t0 = Date.now();
    const deadline = new Date(Date.now() + 100).toISOString();
    const res = await request(app)
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders({ "X-Deadline": deadline }))
      .send({ analysisRid: rid, cardId: "$SLOW", parameterOverrides: {}, branch: "trunk", cacheBehavior: "BYPASS" });
    const elapsed = Date.now() - t0;

    if (res.status === 504) {
      expect(res.body?.errorName).toBe("Tellus:Quiver:DeadlineExceeded");
    } else if (res.status === 200) {
      expect(res.body?.status).toBe("DEADLINE_EXCEEDED");
    } else {
      throw new Error(`unexpected status ${res.status}: ${JSON.stringify(res.body)}`);
    }
    expect(elapsed).toBeLessThan(500);
  }, 5_000);
});
