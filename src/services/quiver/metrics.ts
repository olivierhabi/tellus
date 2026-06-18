// Quiver Prometheus metrics (G-09). prom-client default registry; histograms
// are `_seconds`, counters `_total`, gauges no suffix; bounded labels only
// (no per-RID labels — exemplars or DEBUG logs for high-cardinality dims).

import { Counter, Gauge, Histogram, register } from "prom-client";

function existing<T>(name: string): T | undefined {
  // prom-client throws if a metric is re-registered; tests reload modules.
  return register.getSingleMetric(name) as T | undefined;
}

const seconds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const bytes = [
  256, 1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216,
];

// === B1 — Analysis CRUD ====================================================
export const analysisCreateSeconds =
  existing<Histogram<"result">>("tellus_quiver_analysis_create_seconds") ??
  new Histogram({
    name: "tellus_quiver_analysis_create_seconds",
    help: "Latency of POST /quiver/api/v1/analyses",
    labelNames: ["result"] as const,
    buckets: seconds,
  });

export const analysisGetSeconds =
  existing<Histogram<"cache">>("tellus_quiver_analysis_get_seconds") ??
  new Histogram({
    name: "tellus_quiver_analysis_get_seconds",
    help: "Latency of GET /quiver/api/v1/analyses/:rid",
    labelNames: ["cache"] as const,
    buckets: seconds,
  });

export const analysisUpdateSeconds =
  existing<Histogram<"result">>("tellus_quiver_analysis_update_seconds") ??
  new Histogram({
    name: "tellus_quiver_analysis_update_seconds",
    help: "Latency of PATCH /quiver/api/v1/analyses/:rid",
    labelNames: ["result"] as const,
    buckets: seconds,
  });

export const analysisDeleteSeconds =
  existing<Histogram<"result">>("tellus_quiver_analysis_delete_seconds") ??
  new Histogram({
    name: "tellus_quiver_analysis_delete_seconds",
    help: "Latency of DELETE /quiver/api/v1/analyses/:rid",
    labelNames: ["result"] as const,
    buckets: seconds,
  });

export const analysisListSeconds =
  existing<Histogram<"result">>("tellus_quiver_analysis_list_seconds") ??
  new Histogram({
    name: "tellus_quiver_analysis_list_seconds",
    help: "Latency of GET /quiver/api/v1/folders/:rid/analyses",
    labelNames: ["result"] as const,
    buckets: seconds,
  });

export const analysisSizeBytes =
  existing<Histogram<never>>("tellus_quiver_analysis_size_bytes") ??
  new Histogram({
    name: "tellus_quiver_analysis_size_bytes",
    help: "AnalysisDocument serialized size in bytes (canonical JSON)",
    buckets: bytes,
  });

export const analysisActiveTotal =
  existing<Gauge<"org">>("tellus_quiver_analysis_active_total") ??
  new Gauge({
    name: "tellus_quiver_analysis_active_total",
    help: "Active (non-deleted) analyses by org",
    labelNames: ["org"] as const,
  });

export const compassRegisterFailuresTotal =
  existing<Counter<never>>("tellus_quiver_compass_register_failures_total") ??
  new Counter({
    name: "tellus_quiver_compass_register_failures_total",
    help: "Compass registration failures during analysis create",
  });

export const etagMismatchTotal =
  existing<Counter<"endpoint">>("tellus_quiver_etag_mismatch_total") ??
  new Counter({
    name: "tellus_quiver_etag_mismatch_total",
    help: "412 ETag mismatches by endpoint",
    labelNames: ["endpoint"] as const,
  });

export const idempotencyReplayTotal =
  existing<Counter<"endpoint">>("tellus_quiver_idempotency_replay_total") ??
  new Counter({
    name: "tellus_quiver_idempotency_replay_total",
    help: "Idempotency-Key replays served from cache by endpoint",
    labelNames: ["endpoint"] as const,
  });

export const idempotencyConflictTotal =
  existing<Counter<"endpoint">>("tellus_quiver_idempotency_conflict_total") ??
  new Counter({
    name: "tellus_quiver_idempotency_conflict_total",
    help: "Idempotency-Key reuse with different body",
    labelNames: ["endpoint"] as const,
  });

// === B2 — DAG Validator (C-18) =============================================
export const dagValidateSeconds =
  existing<Histogram<"result">>("tellus_quiver_dag_validate_seconds") ??
  new Histogram({
    name: "tellus_quiver_dag_validate_seconds",
    help: "Latency of DagValidator.validate() (CPU only)",
    labelNames: ["result"] as const,
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  });

export const dagValidateFailureTotal =
  existing<Counter<"error_name">>("tellus_quiver_dag_validate_failure_total") ??
  new Counter({
    name: "tellus_quiver_dag_validate_failure_total",
    help: "DagValidator failures grouped by errorName",
    labelNames: ["error_name"] as const,
  });

export const dagValidateCardCount =
  existing<Histogram<never>>("tellus_quiver_dag_validate_card_count") ??
  new Histogram({
    name: "tellus_quiver_dag_validate_card_count",
    help: "Card count per validated document",
    buckets: [1, 5, 10, 25, 50, 100, 200, 500],
  });

export const cardsPerDag =
  existing<Gauge<never>>("tellus_quiver_cards_per_dag") ??
  new Gauge({
    name: "tellus_quiver_cards_per_dag",
    help: "Last observed card count per validate call (gauge for dashboard ease)",
  });

// === B4 — Versioning + Working State (C-13) =================================
export const saveVersionSeconds =
  existing<Histogram<"named">>("tellus_quiver_save_version_seconds") ??
  new Histogram({
    name: "tellus_quiver_save_version_seconds",
    help: "Latency of POST /analyses/:rid/versions",
    labelNames: ["named"] as const,
    buckets: seconds,
  });

export const revertSeconds =
  existing<Histogram<never>>("tellus_quiver_revert_seconds") ??
  new Histogram({
    name: "tellus_quiver_revert_seconds",
    help: "Latency of POST /analyses/:rid/versions/:version:revert",
    buckets: seconds,
  });

export const workingStateSizeBytes =
  existing<Histogram<never>>("tellus_quiver_working_state_size_bytes") ??
  new Histogram({
    name: "tellus_quiver_working_state_size_bytes",
    help: "Working-state document size in bytes",
    buckets: bytes,
  });

export const workingStateTtlPurgesTotal =
  existing<Counter<never>>("tellus_quiver_working_state_ttl_purges_total") ??
  new Counter({
    name: "tellus_quiver_working_state_ttl_purges_total",
    help: "Working-state rows purged by the TTL sweeper",
  });

export const versionSavedTotal =
  existing<Counter<"named">>("tellus_quiver_version_saved_total") ??
  new Counter({
    name: "tellus_quiver_version_saved_total",
    help: "Version saves by named/autosave",
    labelNames: ["named"] as const,
  });

export const revertedTotal =
  existing<Counter<never>>("tellus_quiver_reverted_total") ??
  new Counter({
    name: "tellus_quiver_reverted_total",
    help: "Successful reverts",
  });
