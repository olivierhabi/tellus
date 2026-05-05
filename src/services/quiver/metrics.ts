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

// === B5 — Compute Coordinator (C-13) =======================================
export const computeSeconds =
  existing<Histogram<"cardType" | "backend" | "cache">>("tellus_quiver_compute_seconds") ??
  new Histogram({
    name: "tellus_quiver_compute_seconds",
    help: "Latency of POST /quiver/compute/cards by cardType, backend, and cache outcome",
    labelNames: ["cardType", "backend", "cache"] as const,
    buckets: seconds,
  });

export const computeErrorsTotal =
  existing<Counter<"cardType" | "errorCode">>("tellus_quiver_compute_errors_total") ??
  new Counter({
    name: "tellus_quiver_compute_errors_total",
    help: "Compute errors by cardType and errorCode",
    labelNames: ["cardType", "errorCode"] as const,
  });

export const computeCacheHitRatio =
  existing<Gauge<never>>("tellus_quiver_compute_cache_hit_ratio") ??
  new Gauge({
    name: "tellus_quiver_compute_cache_hit_ratio",
    help: "Rolling cache hit ratio (last sweep window)",
  });

export const computeInflight =
  existing<Gauge<"backend">>("tellus_quiver_compute_inflight") ??
  new Gauge({
    name: "tellus_quiver_compute_inflight",
    help: "In-flight compute calls per backend",
    labelNames: ["backend"] as const,
  });

export const computeDeadlineExceededTotal =
  existing<Counter<"cardType">>("tellus_quiver_compute_deadline_exceeded_total") ??
  new Counter({
    name: "tellus_quiver_compute_deadline_exceeded_total",
    help: "Compute calls that returned DEADLINE_EXCEEDED at the boundary",
    labelNames: ["cardType"] as const,
  });

export const computeCircuitState =
  existing<Gauge<"backend">>("tellus_quiver_compute_circuit_state") ??
  new Gauge({
    name: "tellus_quiver_compute_circuit_state",
    help: "Per-backend circuit breaker state (0=closed, 1=half_open, 2=open)",
    labelNames: ["backend"] as const,
  });

// === B6 — OSS Object-Set Backend (C-13) ====================================
export const ossQuerySeconds =
  existing<Histogram<"operation">>("tellus_quiver_oss_query_seconds") ??
  new Histogram({
    name: "tellus_quiver_oss_query_seconds",
    help: "OSS port call latency by operation",
    labelNames: ["operation"] as const,
    buckets: seconds,
  });

export const ossQueryErrorsTotal =
  existing<Counter<"errorCode">>("tellus_quiver_oss_query_errors_total") ??
  new Counter({
    name: "tellus_quiver_oss_query_errors_total",
    help: "OSS port call errors by errorCode",
    labelNames: ["errorCode"] as const,
  });

export const ossTemporarySetCreationTotal =
  existing<Counter<never>>("tellus_quiver_oss_temporary_set_creation_total") ??
  new Counter({
    name: "tellus_quiver_oss_temporary_set_creation_total",
    help: "Temporary OSS sets created (24h TTL)",
  });

export const ossActionApplyTotal =
  existing<Counter<"outcome">>("tellus_quiver_oss_action_apply_total") ??
  new Counter({
    name: "tellus_quiver_oss_action_apply_total",
    help: "Action applies dispatched via OssBackend by outcome",
    labelNames: ["outcome"] as const,
  });

// === B3 — Operational Transform / Collab ===================================
export const otInstructionApplySeconds =
  existing<Histogram<"type">>("tellus_quiver_ot_instruction_apply_seconds") ??
  new Histogram({
    name: "tellus_quiver_ot_instruction_apply_seconds",
    help: "Latency of applying a single instruction by type",
    labelNames: ["type"] as const,
    buckets: seconds,
  });

export const otTransformSeconds =
  existing<Histogram<never>>("tellus_quiver_ot_transform_seconds") ??
  new Histogram({
    name: "tellus_quiver_ot_transform_seconds",
    help: "Latency of pairwise OT transform per submitInstructions call",
    buckets: seconds,
  });

export const otConflictsTotal =
  existing<Counter<"resolution">>("tellus_quiver_ot_conflicts_total") ??
  new Counter({
    name: "tellus_quiver_ot_conflicts_total",
    help: "Conflict resolutions by kind (lww | merge | tombstone | reorder | noop)",
    labelNames: ["resolution"] as const,
  });

export const otCollabActiveSessions =
  existing<Gauge<never>>("tellus_quiver_collab_active_sessions") ??
  new Gauge({
    name: "tellus_quiver_collab_active_sessions",
    help: "Active collab sessions (no per-rid label per G-09)",
  });

export const otWsDisconnectsTotal =
  existing<Counter<"reason">>("tellus_quiver_ws_disconnects_total") ??
  new Counter({
    name: "tellus_quiver_ws_disconnects_total",
    help: "WebSocket disconnects by reason",
    labelNames: ["reason"] as const,
  });

export const otInstructionLogSeqLag =
  existing<Gauge<never>>("tellus_quiver_instruction_log_seq_lag") ??
  new Gauge({
    name: "tellus_quiver_instruction_log_seq_lag",
    help: "Difference between latest seq and oldest unbroadcast seq (informational)",
  });

export const otDuplicateOpIdTotal =
  existing<Counter<never>>("tellus_quiver_ot_duplicate_op_id_total") ??
  new Counter({
    name: "tellus_quiver_ot_duplicate_op_id_total",
    help: "submitInstructions calls that hit a previously-seen client_op_id",
  });

export const otSubmitSeconds =
  existing<Histogram<"result">>("tellus_quiver_ot_submit_seconds") ??
  new Histogram({
    name: "tellus_quiver_ot_submit_seconds",
    help: "Latency of POST /analyses/:rid/instructions",
    labelNames: ["result"] as const,
    buckets: seconds,
  });

// === B7 — Materialization (Polars/Spark/MMDP) Backend ======================
export const matComputeSeconds =
  existing<Histogram<"tier" | "operation">>("tellus_quiver_mat_compute_seconds") ??
  new Histogram({
    name: "tellus_quiver_mat_compute_seconds",
    help: "Materialization tier execute latency by (tier, operation)",
    labelNames: ["tier", "operation"] as const,
    buckets: seconds,
  });

export const matInputRows =
  existing<Histogram<never>>("tellus_quiver_mat_input_rows") ??
  new Histogram({
    name: "tellus_quiver_mat_input_rows",
    help: "Row counts observed by materialization backend (sampled)",
    buckets: [10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000],
  });

export const matTierSelectionTotal =
  existing<Counter<"tier" | "reason">>("tellus_quiver_mat_tier_selection_total") ??
  new Counter({
    name: "tellus_quiver_mat_tier_selection_total",
    help: "Tier selection decisions by (tier, reason)",
    labelNames: ["tier", "reason"] as const,
  });

export const matIcebergSnapshotAgeSeconds =
  existing<Histogram<never>>("tellus_quiver_mat_iceberg_snapshot_age_seconds") ??
  new Histogram({
    name: "tellus_quiver_mat_iceberg_snapshot_age_seconds",
    help: "Drift between materialization read time and pinned Iceberg snapshot timestamp",
    buckets: [1, 10, 60, 600, 3600, 86_400],
  });

// === B8 — Time-Series (Codex) Backend ======================================
export const tsHydrationSeconds =
  existing<Histogram<"state">>("tellus_quiver_ts_hydration_seconds") ??
  new Histogram({
    name: "tellus_quiver_ts_hydration_seconds",
    help: "Time-series hydration latency by state (warm|cold)",
    labelNames: ["state"] as const,
    buckets: seconds,
  });

export const tsBucketsReturned =
  existing<Histogram<never>>("tellus_quiver_ts_buckets_returned") ??
  new Histogram({
    name: "tellus_quiver_ts_buckets_returned",
    help: "Bucket count returned per series (capped at 1000)",
    buckets: [10, 50, 100, 200, 500, 750, 1000],
  });

export const tsEventDetectionSeconds =
  existing<Histogram<never>>("tellus_quiver_ts_event_detection_seconds") ??
  new Histogram({
    name: "tellus_quiver_ts_event_detection_seconds",
    help: "Event detection latency",
    buckets: seconds,
  });

export const tsHydrationTimeoutsTotal =
  existing<Counter<never>>("tellus_quiver_ts_hydration_timeouts_total") ??
  new Counter({
    name: "tellus_quiver_ts_hydration_timeouts_total",
    help: "Cold-hydration timeouts (token TTL exceeded)",
  });

// === B9 — AIP Integration ===================================================
export const aipFirstTokenSeconds =
  existing<Histogram<"surface">>("tellus_quiver_aip_first_token_seconds") ??
  new Histogram({
    name: "tellus_quiver_aip_first_token_seconds",
    help: "AIP first-token latency by surface (generate|configure|assist)",
    labelNames: ["surface"] as const,
    buckets: seconds,
  });

export const aipToolInvocationTotal =
  existing<Counter<"tool">>("tellus_quiver_aip_tool_invocation_total") ??
  new Counter({
    name: "tellus_quiver_aip_tool_invocation_total",
    help: "AIP tool invocations by tool name",
    labelNames: ["tool"] as const,
  });

export const aipToolUnauthorizedTotal =
  existing<Counter<"tool">>("tellus_quiver_aip_tool_unauthorized_total") ??
  new Counter({
    name: "tellus_quiver_aip_tool_unauthorized_total",
    help: "Denied tool invocations (filtered out of manifest or refused at boundary)",
    labelNames: ["tool"] as const,
  });

export const aipTokensUsedTotal =
  existing<Counter<"surface" | "model">>("tellus_quiver_aip_tokens_used_total") ??
  new Counter({
    name: "tellus_quiver_aip_tokens_used_total",
    help: "Total tokens consumed by surface + model",
    labelNames: ["surface", "model"] as const,
  });

export const aipCostUsdMicrosTotal =
  existing<Counter<"surface" | "model">>("tellus_quiver_aip_cost_usd_micros_total") ??
  new Counter({
    name: "tellus_quiver_aip_cost_usd_micros_total",
    help: "Total cost in USD micros by surface + model",
    labelNames: ["surface", "model"] as const,
  });

export const aipPropertyHintSampleSize =
  existing<Histogram<never>>("tellus_quiver_aip_property_hint_sample_size") ??
  new Histogram({
    name: "tellus_quiver_aip_property_hint_sample_size",
    help: "Property-value hint sample size (capped per B9 C-08)",
    buckets: [10, 50, 100, 500, 1000],
  });
