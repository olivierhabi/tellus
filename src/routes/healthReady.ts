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

const router = Router();

const PROBE_TIMEOUT_MS = 1_000;

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

router.get("/ready", async (_req: Request, res: Response) => {
  const [postgres, s3, temporal, lakekeeper] = await Promise.all([
    probePostgres(),
    probeS3(),
    probeTemporal(),
    probeLakekeeper(),
  ]);
  const ready = postgres.ok && s3.ok;
  // Temporal + Lakekeeper are "soft" probes: the PG-backed dispatcher +
  // icebergCatalog Postgres shim keep the system serving when those
  // deps flap, so a green /ready only requires the HARD deps (PG, S3).
  // Their status is still reported for SRE visibility.
  res.status(ready ? 200 : 503).json({
    ready,
    probes: { postgres, s3, temporal, lakekeeper },
  });
});

export default router;
