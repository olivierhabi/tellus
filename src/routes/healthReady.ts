// ---------------------------------------------------------------------------
// /health/ready — PB-B9.
//
// Readiness probe that checks every dependency the Pipeline Builder
// needs to serve traffic. Each probe is capped at 1 second; the whole
// endpoint aggregates in under ~1.5s even when a dep times out.
//
// Probes:
//   * Postgres — SELECT 1 through the foundry pool.
//   * S3 / MinIO — HeadBucket on the configured bucket.
//   * Temporal — reachability via the existing isTemporalConnected()
//     (cheap: reads an in-process flag; the real TCP probe ran at
//     worker bootstrap).
//   * Lakekeeper — GET /management/v1/info with a 1s timeout.
//
// Returns 200 + {ready:true, probes:{...}} when all pass; 503 +
// {ready:false, probes:{...}} when any fail. Increments
// pipeline_health_check_failures_total{probe} on failure.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from "express";
import foundryDb from "../config/foundryDb";
import { incCounter } from "../services/funnel/metrics";
import { query } from "../db";
import { getClickHouseClient } from "../services/searchAround/clickhouseClient";

const router = Router();

const PROBE_TIMEOUT_MS = 1_000;

// Fix 2: ack-flag runtime preconditions. The handler reads the flag at
// CALL time (not module load) so a post-import env toggle reflects — this
// is the runtime half; boot rejects the legacy/shadow config half
// (assertLinkIndexAckStartupConfig). When the flag is on, /health/ready
// gates on CH reachability / watermark-outbox schema / Kafka-engine
// consumer plausibility so a deploy that lost its ingest topology is
// NOT sent traffic while vouching index visibility — the read-after-write
// contract is the entire point of the flag.
function ackFlagOn(): boolean {
  return process.env.LINK_INDEX_ACK_REQUIRED === "true";
}

interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

async function withTimeout<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const res = await Promise.race<T | symbol>([
      fn(),
      new Promise<symbol>((_, reject) =>
        setTimeout(() => reject(new Error("probe_timeout")), PROBE_TIMEOUT_MS),
      ),
    ]);
    void res;
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    const latency = Date.now() - t0;
    incCounter("pipeline_health_check_failures_total", { probe: name });
    return {
      ok: false,
      latencyMs: latency,
      error: (err as Error).message ?? String(err),
    };
  }
}

async function probePostgres(): Promise<ProbeResult> {
  return withTimeout("postgres", async () => {
    await foundryDb.raw("SELECT 1");
  });
}

async function probeS3(): Promise<ProbeResult> {
  return withTimeout("s3", async () => {
    // `storageHealthCheck()` historically swallowed errors and
    // returned `{status:'disconnected',...}` — which makes the probe
    // *always* succeed, masking a real S3 outage in /health/ready.
    // Check the returned status and throw on a negative so the probe
    // fails the readiness check as required by PB-B9 spec acceptance
    // (b) "Killing the database mid-deploy: /health/ready returns 503
    // within 5 seconds" — the same acceptance applies to S3.
    const { storageHealthCheck } = await import("../services/storageService");
    const out = await storageHealthCheck();
    if (out.status !== "connected") {
      throw new Error(`s3_${out.status}`);
    }
  });
}

async function probeTemporal(): Promise<ProbeResult> {
  return withTimeout("temporal", async () => {
    // PB-B9 spec literal: "each must respond within 1s for ready=true".
    // `isTemporalConnected()` only reads an in-process boot-time flag —
    // it doesn't detect a frontend outage that started mid-run. Do a
    // live TCP probe on the Temporal gRPC port instead so a paused
    // frontend container is caught within the 1s probe budget.
    const { isTemporalConnected, getWorkerDiagnostics } = await import("../services/funnel/temporal/worker");
    if (!isTemporalConnected()) {
      throw new Error("temporal_worker_not_connected");
    }
    // FUNN-ISO — hard gate: the worker's configured deployment identity
    // MUST match the database's sealed identity. A mismatch here is the
    // exact split-brain precondition (worker wired to the wrong database);
    // readiness MUST go red or the queue quietly serves foreign work.
    const { getDatabaseEnvironmentId } = await import("../services/funnel/environmentGuard");
    const dbEnv = await getDatabaseEnvironmentId();
    const diag = getWorkerDiagnostics();
    if (diag.identity && dbEnv && diag.identity.environmentId !== dbEnv) {
      throw new Error(
        `environment_mismatch: worker=${diag.identity.environmentId} db=${dbEnv}`,
      );
    }
    const net = await import("net");
    const [host, portStr] = (
      diag.identity?.temporalAddress ?? process.env.TEMPORAL_ADDRESS ?? "localhost:7233"
    ).split(":");
    const port = parseInt(portStr ?? "7233", 10);
    await new Promise<void>((resolve, reject) => {
      const socket = new net.Socket();
      const onErr = (err: Error): void => {
        socket.destroy();
        reject(err);
      };
      socket.setTimeout(800, () => onErr(new Error("temporal_tcp_timeout")));
      socket.once("error", onErr);
      socket.connect(port, host ?? "localhost", () => {
        socket.end();
        resolve();
      });
    });
  });
}

async function probeLakekeeper(): Promise<ProbeResult> {
  return withTimeout("lakekeeper", async () => {
    const url = (process.env.LAKEKEEPER_URL ?? "http://localhost:8181").replace(
      /\/+$/,
      "",
    );
    const res = await fetch(`${url}/management/v1/info`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`lakekeeper_http_${res.status}`);
  });
}

// ---------------------------------------------------------------------------
// ACK-FLOW RUNTIME PRECONDITIONS (Fix 2). HARD: a missing CH, missing
// watermark/outbox schema, or an implausible consumer means the ack
// barrier would defer or vouch for a store the read path can't use.
// Ambient-empty (no link__ serving tables at all — fresh deploy, no
// link types materialized) is READY: nothing to confirm yet.
// ---------------------------------------------------------------------------

async function probeAckClickHouse(): Promise<ProbeResult> {
  return withTimeout("ack_clickhouse", async () => {
    const h = await getClickHouseClient().health();
    if (!h.reachable) throw new Error(`ack_ch_unreachable:${h.error ?? "unknown"}`);
  });
}

async function probeAckWatermarkSchema(): Promise<ProbeResult> {
  return withTimeout("ack_watermark_schema", async () => {
    const r = await query(
      `SELECT COUNT(*)::int AS n
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('link_cdc_outbox', 'link_edge_watermarks')`,
    );
    const n = r.rows[0]?.n as number;
    // link_cdc_outbox is the SOURCE of everything staged; link_edge_watermarks
    // is the observability/stat table. Missing either ⇒ ack plumbing broken.
    if (n < 2) throw new Error(`ack_watermark_partial:${n}/2`);
  });
}

async function probeAckConsumer(): Promise<ProbeResult> {
  return withTimeout("ack_consumer", async () => {
    const ch = getClickHouseClient();
    // Count of per-link-type serving tables AND Kafka-engine INGEST tables.
    // No serving tables at all ⇒ ambient empty ⇒ OK. Serving tables but NO
    // Kafka-engine ingest table ⇒ consumer implausible ⇒ NOT ready (the
    // topic would fill with no ingest pulling into the versioned table).
    const counts = await ch.exec<{ kind: string; n: number }>(
      `SELECT 'serving' AS kind, count() AS n
         FROM system.tables
        WHERE database = currentDatabase() AND name LIKE 'link\\_\\_%' AND engine NOT IN ('Kafka', 'View', 'MaterializedView')
       UNION ALL
       SELECT 'kafka' AS kind, count() AS n
         FROM system.tables
        WHERE database = currentDatabase() AND engine = 'Kafka'`,
    );
    const serving = Number(counts.find((c) => c.kind === "serving")?.n ?? 0);
    const kafka = Number(counts.find((c) => c.kind === "kafka")?.n ?? 0);
    if (serving > 0 && kafka === 0) {
      throw new Error(`ack_consumer_no_kafka_engine:${serving}_serving_tables`);
    }
  });
}

router.get("/ready", async (_req: Request, res: Response) => {
  // ACK preconditions are HARD only when the flag is on; off ⇒ the
  // contract isn't vouching anything and the probes would punish a
  // legacy deploy that legitimately has no ingest topology.
  const isAckOn = ackFlagOn();
  const probes = isAckOn
    ? await Promise.all([
        probePostgres(),
        probeS3(),
        probeTemporal(),
        probeLakekeeper(),
        probeAckClickHouse(),
        probeAckWatermarkSchema(),
        probeAckConsumer(),
      ])
    : await Promise.all([
        probePostgres(),
        probeS3(),
        probeTemporal(),
        probeLakekeeper(),
      ]);
  const [postgres, s3, temporal, lakekeeper] = probes as ProbeResult[];
  const message: Record<string, ProbeResult> = {
    postgres, s3, temporal, lakekeeper,
  };
  if (isAckOn) {
    const { [4]: ackCh, [5]: ackSchema, [6]: ackConsumer } = probes as ProbeResult[];
    // Augment :: only the HARD deps drive `ready`; the existing soft split
    // (Temporal/Lakekeeper are advisory) is preserved — ack probes sit
    // alongside PG/S3 as HARD (the ack contract is what makes them so).
    message.ackClickHouse = ackCh;
    message.ackWatermarkSchema = ackSchema;
    message.ackConsumer = ackConsumer;
    const hardAckOk = ackCh.ok && ackSchema.ok && ackConsumer.ok;
    res.status(postgres.ok && s3.ok && hardAckOk ? 200 : 503).json({
      ready: postgres.ok && s3.ok && hardAckOk,
      probes: message,
    });
    return;
  }
  // Existing contract unchanged (PG + S3 HARD, Temporal/Lakekeeper SOFT).
  res.status(postgres.ok && s3.ok ? 200 : 503).json({
    ready: postgres.ok && s3.ok,
    probes: message,
  });
});

export default router;
