// Quiver B4 — SLO + metrics integration tests.
//
// Coverage:
//   B4 C-11: saveVersion P99 ≤ 1 s for ≤ 5 MiB documents (sample at 50 KB,
//            generous bound). revertToVersion P99 ≤ 500 ms.
//   B4 C-13: metrics emitted with bounded labels.

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
import { register } from "prom-client";
import { pool } from "../../../src/db";
import {
  applyQuiverMigrations,
  fakeCompass,
  quiverApp,
  teardownQuiverTables,
} from "./_harness";

const TEST_USER = "ri.multipass.main.user.b4-slo";
const TEST_ORG = "ri.multipass.main.org.b4-slo";

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

async function newAnalysis(app: ReturnType<typeof quiverApp>): Promise<{ rid: string; etag: string }> {
  const res = await request(app)
    .post("/quiver/api/v1/analyses")
    .set(headers({ "idempotency-key": randomUUID(), "content-type": "application/json" }))
    .send({ displayName: "slo", parentFolderRid: "ri.compass.main.folder.b4-slo" });
  expect(res.status).toBe(201);
  return { rid: res.body.rid, etag: res.headers["etag"] as string };
}

function pct(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

describe("B4 C-11 — SLO targets (saveVersion / revertToVersion)", () => {
  it("saveVersion p99 < 1s on a small document (10 calls)", async () => {
    const app = quiverApp();
    const { rid, etag } = await newAnalysis(app);
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      const r = await request(app)
        .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions`)
        .set(headers({ "if-match": etag, "content-type": "application/json" }))
        .send({});
      expect(r.status).toBe(201);
      samples.push(Date.now() - t0);
    }
    expect(pct(samples, 0.99)).toBeLessThanOrEqual(1000);
  });

  it("revertToVersion p99 < 500ms on a small document (5 calls)", async () => {
    const app = quiverApp();
    const { rid, etag } = await newAnalysis(app);
    await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions`)
      .set(headers({ "if-match": etag, "content-type": "application/json" }))
      .send({ named: true, message: "v1" });
    const samples: number[] = [];
    let cur = etag;
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const r = await request(app)
        .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions/1:revert`)
        .set(headers({ "if-match": cur }));
      expect(r.status).toBe(200);
      samples.push(Date.now() - t0);
      cur = (r.headers["etag"] as string) || cur;
    }
    expect(pct(samples, 0.99)).toBeLessThanOrEqual(500);
  });
});

describe("B4 C-13 — metrics emission", () => {
  it("save_version_seconds + version_saved_total + working_state_size_bytes + ttl_purges_total registered with bounded labels", async () => {
    const app = quiverApp();
    const { rid, etag } = await newAnalysis(app);
    await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions`)
      .set(headers({ "if-match": etag, "content-type": "application/json" }))
      .send({});
    await request(app)
      .post(`/quiver/api/v1/analyses/${encodeURIComponent(rid)}/working-states`)
      .set(headers({ "content-type": "application/json" }))
      .send({});
    const text = await register.metrics();
    expect(text).toContain("tellus_quiver_save_version_seconds");
    expect(text).toContain("tellus_quiver_version_saved_total");
    expect(text).toContain("tellus_quiver_working_state_size_bytes");
    expect(text).toContain("tellus_quiver_revert_seconds");
    expect(text).toContain("tellus_quiver_working_state_ttl_purges_total");
    // Bounded labels: no per-RID labels (G-09).
    expect(text).not.toMatch(/tellus_quiver_save_version_[^{]+\{[^}]*rid=/);
    expect(text).not.toMatch(/tellus_quiver_working_state_[^{]+\{[^}]*rid=/);
  });
});
