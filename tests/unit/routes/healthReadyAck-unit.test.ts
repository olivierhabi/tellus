// ---------------------------------------------------------------------------
// Fix 2 readiness-gate: when LINK_INDEX_ACK_REQUIRED=true, /health/ready
// adds three HARD ack-precondition probes (CH reachability, watermark/outbox
// PG schema, and Kafka-engine consumer plausibility) and pulls them into
// `ready`. Flag off ⇒ probes not run and absent (legacy /ready contract
// unchanged). Hard = PG + S3 + ack-*; soft = Temporal/Lakekeeper.
// ---------------------------------------------------------------------------

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const { queryMock, chMock, metricsMock, foundryMock, storageMock, temporalMock } =
  vi.hoisted(() => ({
    queryMock: vi.fn(),
    chMock: vi.fn(),
    metricsMock: { incCounter: vi.fn(), setGauge: vi.fn() },
    foundryMock: { raw: vi.fn() },
    storageMock: { storageHealthCheck: vi.fn() },
    temporalMock: {
      isTemporalConnected: () => true,
      getWorkerDiagnostics: () => ({}),
    },
  }));

vi.mock("../../../src/config/foundryDb", () => ({ default: foundryMock }));
vi.mock("../../../src/db", () => ({ query: queryMock }));
vi.mock("../../../src/services/funnel/metrics", () => metricsMock);
vi.mock("../../../src/services/storageService", () => storageMock);
vi.mock("../../../src/services/funnel/temporal/worker", () => temporalMock);
vi.mock("../../../src/services/funnel/environmentGuard", () => ({
  getDatabaseEnvironmentId: async () => null,
}));
vi.mock("../../../src/services/searchAround/clickhouseClient", () => ({
  getClickHouseClient: chMock,
}));

// healthReady reads the flag at CALL time now, so a single eager import is
// fine — env state at call time wins, not at import time.
import healthReadyRouter from "../../../src/routes/healthReady";

function buildApp(): Express {
  return express().use("/health", healthReadyRouter);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Soft probes always pass for this suite — ack probes drive `ready`.
  foundryMock.raw.mockResolvedValue(undefined);
  storageMock.storageHealthCheck.mockResolvedValue({ status: "connected" });
});

// CH mock returns a fresh client per probe call; pop health() / exec().
function mockChHealth(reachable: boolean, error?: string) {
  chMock.mockReturnValueOnce({ health: async () => ({ reachable, error }) });
}
function mockChExec(rows: Array<Record<string, unknown>>) {
  chMock.mockReturnValueOnce({ exec: async () => rows });
}

const GREEN_ACK = () => {
  mockChHealth(true);
  queryMock.mockResolvedValueOnce({ rows: [{ n: 2 }] });
  mockChExec([
    { kind: "serving", n: 1 },
    { kind: "kafka", n: 1 },
  ]);
};

afterAll(() => {
  delete process.env.LINK_INDEX_ACK_REQUIRED;
});

describe("/health/ready — LINK_INDEX_ACK_REQUIRED gate (Fix 2)", () => {
  it("flag OFF ⇒ no ack-probe fields; legacy /ready (hard = PG + S3) preserved, ready=true", async () => {
    delete process.env.LINK_INDEX_ACK_REQUIRED;
    const r = await request(buildApp()).get("/health/ready");
    expect(r.status).toBe(200);
    expect(r.body.ready).toBe(true);
    expect(r.body.probes.ackClickHouse).toBeUndefined();
    expect(r.body.probes.ackWatermarkSchema).toBeUndefined();
    expect(r.body.probes.ackConsumer).toBeUndefined();
  });

  it("flag ON + all ack preconditions green ⇒ 200 ready=true; ack.* probes reported", async () => {
    process.env.LINK_INDEX_ACK_REQUIRED = "true";
    GREEN_ACK();
    const r = await request(buildApp()).get("/health/ready");
    expect(r.status).toBe(200);
    expect(r.body.ready).toBe(true);
    expect(r.body.probes.ackClickHouse.ok).toBe(true);
    expect(r.body.probes.ackWatermarkSchema.ok).toBe(true);
    expect(r.body.probes.ackConsumer.ok).toBe(true);
  });

  it("flag ON + CH unreachable ⇒ 503 NOT ready (the ack barrier can never confirm without a connection)", async () => {
    process.env.LINK_INDEX_ACK_REQUIRED = "true";
    mockChHealth(false, "fetch failed");
    queryMock.mockResolvedValueOnce({ rows: [{ n: 2 }] });
    mockChExec([
      { kind: "serving", n: 1 },
      { kind: "kafka", n: 1 },
    ]);
    const r = await request(buildApp()).get("/health/ready");
    expect(r.status).toBe(503);
    expect(r.body.ready).toBe(false);
    expect(r.body.probes.ackClickHouse.ok).toBe(false);
    expect(r.body.probes.ackClickHouse.error).toContain("ack_ch_unreachable");
  });

  it("flag ON + watermark/outbox schema missing ⇒ 503 (ack plumbing broken)", async () => {
    process.env.LINK_INDEX_ACK_REQUIRED = "true";
    mockChHealth(true);
    queryMock.mockResolvedValueOnce({ rows: [{ n: 1 }] }); // only one table present
    mockChExec([{ kind: "serving", n: 1 }, { kind: "kafka", n: 1 }]);
    const r = await request(buildApp()).get("/health/ready");
    expect(r.status).toBe(503);
    expect(r.body.ready).toBe(false);
    expect(r.body.probes.ackWatermarkSchema.ok).toBe(false);
    expect(r.body.probes.ackWatermarkSchema.error).toMatch(/ack_watermark_partial:1\/2/);
  });

  it("flag ON + serving tables exist but no Kafka-engine consumer ⇒ 503 (consumer implausible — acks can never confirm)", async () => {
    process.env.LINK_INDEX_ACK_REQUIRED = "true";
    mockChHealth(true);
    queryMock.mockResolvedValueOnce({ rows: [{ n: 2 }] });
    mockChExec([{ kind: "serving", n: 1 }, { kind: "kafka", n: 0 }]);
    const r = await request(buildApp()).get("/health/ready");
    expect(r.status).toBe(503);
    expect(r.body.ready).toBe(false);
    expect(r.body.probes.ackConsumer.ok).toBe(false);
    expect(r.body.probes.ackConsumer.error).toMatch(/ack_consumer_no_kafka_engine:1_serving_tables/);
  });

  it("flag ON + ambient empty (zero serving tables) ⇒ 200 READY (nothing to confirm yet)", async () => {
    process.env.LINK_INDEX_ACK_REQUIRED = "true";
    mockChHealth(true);
    queryMock.mockResolvedValueOnce({ rows: [{ n: 2 }] });
    mockChExec([{ kind: "serving", n: 0 }, { kind: "kafka", n: 0 }]);
    const r = await request(buildApp()).get("/health/ready");
    expect(r.status).toBe(200);
    expect(r.body.ready).toBe(true);
    expect(r.body.probes.ackConsumer.ok).toBe(true);
  });
});
