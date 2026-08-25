// ---------------------------------------------------------------------------
// Connectivity operational metrics.
//
// Scraped via the existing auth-exempt /api/metrics endpoint (server.ts). The
// HTTP-level series (tellus_connectivity_request_duration_seconds,
// tellus_connectivity_errors_total) live in handlers/connections.handler.ts;
// this module carries the series you cannot get from request telemetry:
//
//   - probe duration/outcome  — is the fleet of sources actually healthy, and
//                               how slow are the ones that are?
//   - live pool count         — pool-cache growth is the leak signature for a
//                               per-source connector.
//   - egress blocks           — SECURITY ALARM. A sustained non-zero rate here
//                               means something is aiming the connector at
//                               reserved/internal address space. Alert on it.
//
// Registration is idempotent (getSingleMetric guard) because vitest re-imports
// modules across test files against one shared prom-client registry.
// ---------------------------------------------------------------------------

import { Counter, Gauge, Histogram, register as metricsRegistry } from "prom-client";

function getOrCreateHistogram(
  opts: ConstructorParameters<typeof Histogram>[0],
): Histogram<string> {
  const existing = metricsRegistry.getSingleMetric(opts.name);
  if (existing) return existing as Histogram<string>;
  return new Histogram(opts);
}

function getOrCreateCounter(
  opts: ConstructorParameters<typeof Counter>[0],
): Counter<string> {
  const existing = metricsRegistry.getSingleMetric(opts.name);
  if (existing) return existing as Counter<string>;
  return new Counter(opts);
}

function getOrCreateGauge(opts: ConstructorParameters<typeof Gauge>[0]): Gauge<string> {
  const existing = metricsRegistry.getSingleMetric(opts.name);
  if (existing) return existing as Gauge<string>;
  return new Gauge(opts);
}

/**
 * Probe latency, split by outcome. `outcome` is the recorded health state
 * (HEALTHY / UNREACHABLE / AUTH_FAILED / TLS_FAILED) so a single query answers
 * "what fraction of probes fail, and for which reason".
 */
export const probeDuration = getOrCreateHistogram({
  name: "tellus_connectivity_probe_duration_seconds",
  help: "Connection probe latency, by source kind and recorded outcome.",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  labelNames: ["kind", "outcome"] as const,
});

// The pool cache is the authority on how many pools exist, so the gauge reads
// it at scrape time rather than being inc/dec'd at each mutation site — a
// missed decrement in an error path would silently fake a leak forever. pool.ts
// registers its provider at import time; metrics.ts must not import pool.ts
// (that would be a cycle: pool → egress → metrics).
let poolCountProvider: (() => number) | null = null;

/** Called once by connectors/postgresql/pool.ts at module load. */
export function setPoolCountProvider(fn: () => number): void {
  poolCountProvider = fn;
}

/** Cached per-source pg.Pool instances currently held open. */
export const livePools = getOrCreateGauge({
  name: "tellus_connectivity_pools_open",
  help: "Per-source PostgreSQL pools currently held in the pool cache.",
  collect(): void {
    if (poolCountProvider) this.set(poolCountProvider());
  },
});

/**
 * SECURITY ALARM. Incremented every time the egress guard refuses a target.
 * `guard` distinguishes the allowlist gate from the reserved-range/DNS gates so
 * a policy misconfiguration (allowlist) is separable from an SSRF probe
 * (reserved). Alert on any sustained rate of guard="reserved".
 */
export const egressBlocked = getOrCreateCounter({
  name: "tellus_connectivity_egress_blocked_total",
  help: "Egress attempts refused by the connectivity egress guards.",
  labelNames: ["guard", "reason"] as const,
});

/** Credential rotations attempted by the background worker, by outcome. */
export const credentialRotations = getOrCreateCounter({
  name: "tellus_connectivity_credential_rotations_total",
  help: "Credential rewrap attempts by the rotation worker, by outcome.",
  labelNames: ["outcome"] as const,
});

/**
 * Background-worker lease acquisition attempts. In a multi-replica deployment
 * exactly one replica should report outcome="acquired" per tick; a flat zero
 * across the fleet means the advisory lock is stuck and the worker is dead.
 */
export const workerLease = getOrCreateCounter({
  name: "tellus_connectivity_worker_lease_total",
  help: "Background-worker leader-lease attempts, by worker and outcome.",
  labelNames: ["worker", "outcome"] as const,
});

/** Observe a probe, converting from the ms the callers already measure. */
export function observeProbe(kind: string, outcome: string, ms: number): void {
  probeDuration.labels(kind, outcome).observe(ms / 1000);
}
