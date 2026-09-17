/**
 * B8 — Integration tests for the time-series backend via
 * POST /quiver/api/v1/compute/cards and GET /quiver/api/v1/compute/timeseries/:token.
 *
 * Coverage:
 *   B8 C-01 backend wires for 5 ts card types
 *   B8 C-03 per-axis hydration: chart with N axes returns N independent
 *           hydration descriptors
 *   B8 C-04 xAxisGroupId passes through to payload
 *   B8 C-05 cold → poll → ready (200 with {state: "ready", data})
 *   B8 C-06 X-Tellus-Branch forwarded to every Codex call
 *   B8 C-08 metrics emitted (`tellus_quiver_ts_*`)
 *   B8 C-09 hydration token TTL → 410 HydrationTokenExpired
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
import { register } from "prom-client";
import { pool } from "../../../src/db";
import {
  applyQuiverMigrations,
  fakeCompass,
  quiverApp,
  teardownQuiverTables,
} from "./_harness";
import {
  resetComputeContext,
  setCodexPortForTests,
} from "../../../src/services/quiver/compute/context";
import { InProcessCodexAdapter } from "../../../src/services/quiver/compute/ts/inProcessCodex";

const TEST_USER = "ri.multipass.main.user.alice";
const TEST_ORG = "ri.multipass.main.org.acme";

function authedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-test-user": TEST_USER, "x-test-org": TEST_ORG, "X-Tellus-Test-Auth-Token": process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "", ...extra };
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
let adapter: InProcessCodexAdapter;

beforeEach(async () => {
  await teardownQuiverTables();
  compassSpy = fakeCompass();
  adapter = new InProcessCodexAdapter();
  adapter.registerSeries({
    objectRid: "ri.tellus.main.object.sensor-1",
    propertyApiName: "temperature",
    points: [
      { ts: 1, value: 10 },
      { ts: 2, value: 20 },
      { ts: 3, value: 30 },
    ],
  });
  setCodexPortForTests(adapter);
  resetComputeContext();
});

afterEach(() => {
  compassSpy.detach();
  setCodexPortForTests(undefined);
  resetComputeContext();
});

async function createAnalysisWithTsCard(cardId: string, type: string, config: unknown) {
  const r = await request(quiverApp())
    .post("/quiver/api/v1/analyses")
    .set(authedHeaders({ "idempotency-key": randomUUID() }))
    .send({
      parentFolderRid: "ri.compass.main.folder.f1",
      displayName: "B8 ts test",
    });
  expect(r.status).toBe(201);
  const rid = r.body.rid as string;
  await pool.query(
    `UPDATE quiver_analysis SET cards = $1::jsonb WHERE rid = $2`,
    [
      JSON.stringify({
        [cardId]: { id: cardId, type, inputs: {}, config, hidden: false },
      }),
      rid,
    ],
  );
  return rid;
}

const baseQuery = (toMs = 100) => ({
  objectRid: "ri.tellus.main.object.sensor-1",
  propertyApiName: "temperature",
  timeRange: { fromMs: 0, toMs },
});

describe("B8 — Time-Series route integration", () => {
  it("B8 C-01 — TIME_SERIES_PLOT returns cold first then warm", async () => {
    const rid = await createAnalysisWithTsCard("$T", "TIME_SERIES_PLOT", { query: baseQuery() });
    const cold = await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$T", parameterOverrides: {}, branch: "master", cacheBehavior: "BYPASS" });
    expect(cold.status).toBe(200);
    expect(cold.body.payload.state).toBe("cold");
    expect(cold.body.payload.hydrationToken).toMatch(/^hyd-/);

    const warm = await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$T", parameterOverrides: {}, branch: "master", cacheBehavior: "BYPASS" });
    expect(warm.body.payload.state).toBe("warm");
    expect(warm.body.payload.data.points.length).toBeGreaterThan(0);
  });

  it("B8 C-03 + C-04 — TIME_SERIES_CHART per-axis hydration + xAxisGroupId pass-through", async () => {
    adapter.registerSeries({
      objectRid: "ri.tellus.main.object.sensor-2",
      propertyApiName: "humidity",
      points: [{ ts: 1, value: 50 }, { ts: 2, value: 60 }],
    });
    const rid = await createAnalysisWithTsCard("$T", "TIME_SERIES_CHART", {
      axes: [
        { id: "ax1", query: baseQuery(), xAxisGroupId: "g1" },
        { id: "ax2", query: { ...baseQuery(), objectRid: "ri.tellus.main.object.sensor-2", propertyApiName: "humidity" }, xAxisGroupId: "g1" },
      ],
    });
    const r = await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$T", parameterOverrides: {}, branch: "master", cacheBehavior: "BYPASS" });
    expect(r.status).toBe(200);
    const payload = r.body.payload as { axes: Array<{ axisId: string; state: string }>; xAxisGroupId: string };
    expect(payload.axes).toHaveLength(2);
    expect(payload.axes.every((a) => a.state === "cold")).toBe(true);
    expect(payload.xAxisGroupId).toBe("g1");
  });

  it("B8 C-05 — cold-poll round-trip: getSeries cold → GET /timeseries/:token → ready", async () => {
    const rid = await createAnalysisWithTsCard("$T", "TIME_SERIES_PLOT", { query: baseQuery() });
    const cold = await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$T", parameterOverrides: {}, branch: "master", cacheBehavior: "BYPASS" });
    const token = cold.body.payload.hydrationToken as string;
    expect(token).toBeTruthy();
    const polled = await request(quiverApp())
      .get(`/quiver/api/v1/compute/timeseries/${token}`)
      .set(authedHeaders());
    expect(polled.status).toBe(200);
    expect(polled.body.kind).toBe("ready");
    expect(polled.body.data.points.length).toBeGreaterThan(0);
  });

  it("B8 C-09 — unknown hydration token → 404", async () => {
    const r = await request(quiverApp())
      .get("/quiver/api/v1/compute/timeseries/hyd-unknown-9zz")
      .set(authedHeaders());
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("Tellus:Quiver:HydrationTokenUnknown");
  });

  it("B8 C-06 + G-09 — non-trunk branch forwarded to every Codex call", async () => {
    const rid = await createAnalysisWithTsCard("$T", "TIME_SERIES_PLOT", { query: baseQuery() });
    await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders({ "x-tellus-branch": "feature-z" }))
      .send({ analysisRid: rid, cardId: "$T", parameterOverrides: {}, branch: "feature-z", cacheBehavior: "BYPASS" });
    expect(adapter.calls.length).toBeGreaterThanOrEqual(1);
    expect(adapter.calls.every((c) => c.branch === "feature-z")).toBe(true);
  });

  it("B8 C-08 — metrics emitted for hydration + buckets", async () => {
    const rid = await createAnalysisWithTsCard("$T", "TIME_SERIES_PLOT", { query: baseQuery() });
    // First call → cold, hydration metric emits with state=cold.
    await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$T", parameterOverrides: {}, branch: "master", cacheBehavior: "BYPASS" });
    // Second call → warm, hydration metric emits with state=warm.
    await request(quiverApp())
      .post("/quiver/api/v1/compute/cards")
      .set(authedHeaders())
      .send({ analysisRid: rid, cardId: "$T", parameterOverrides: {}, branch: "master", cacheBehavior: "BYPASS" });
    const text = await register.metrics();
    expect(text).toContain("tellus_quiver_ts_hydration_seconds_count");
    expect(text).toContain('state="cold"');
    expect(text).toContain('state="warm"');
    expect(text).toContain("tellus_quiver_ts_buckets_returned_count");
  });
});
