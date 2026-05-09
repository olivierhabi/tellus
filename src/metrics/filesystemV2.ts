// ---------------------------------------------------------------------------
// Filesystem v2 Prometheus metrics
// ---------------------------------------------------------------------------
// Contracts: tasks/files-projects/contracts.md (B3-C-60..62).
//
// Names match the spec verbatim. Buckets are the canonical Tellus set
// declared in the global brief. Cardinality is bounded: the `endpoint`
// label is one of a fixed enum (~20 values) and `status` is the HTTP
// status code (~10 distinct values in practice).
// ---------------------------------------------------------------------------

import { Counter, Histogram, register } from "prom-client";

const CANONICAL_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

function getOrCreateHistogram(opts: ConstructorParameters<typeof Histogram>[0]): Histogram<string> {
  const existing = register.getSingleMetric(opts.name);
  if (existing) return existing as Histogram<string>;
  return new Histogram(opts);
}

function getOrCreateCounter(opts: ConstructorParameters<typeof Counter>[0]): Counter<string> {
  const existing = register.getSingleMetric(opts.name);
  if (existing) return existing as Counter<string>;
  return new Counter(opts);
}

/** B3-C-60 — request latency histogram per endpoint × status. */
export const v2RequestSeconds = getOrCreateHistogram({
  name: "tellus_filesystem_v2_request_seconds",
  help: "Filesystem v2 endpoint request latency (seconds).",
  labelNames: ["endpoint", "status"] as const,
  buckets: [...CANONICAL_BUCKETS],
});

/** B3-C-61 — counter incremented every time `If-Match` is stale (412). */
export const v2EtagMismatchTotal = getOrCreateCounter({
  name: "tellus_filesystem_v2_etag_mismatch_total",
  help: "Number of If-Match mismatches per endpoint.",
  labelNames: ["endpoint"] as const,
});

/** B3-C-62 — counter incremented every time an Idempotency-Key replays. */
export const v2IdempotentReplayTotal = getOrCreateCounter({
  name: "tellus_filesystem_v2_idempotent_replay_total",
  help: "Number of Idempotency-Key replays returned from cache.",
});
