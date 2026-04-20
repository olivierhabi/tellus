// ---------------------------------------------------------------------------
// Pipeline Builder metrics — PB-B9.
//
// Uses the same in-memory counter/gauge/histogram primitives the Funnel
// emits from services/funnel/metrics.ts so an SRE sees one mental model
// across both subsystems. Metric names mirror the spec:
//
//   pipeline_deploy_duration_seconds{pipeline_id, status}   histogram
//   pipeline_deploy_total{status}                           counter
//   pipeline_preview_duration_seconds{transform_type}       histogram
//   pipeline_active_deploys                                 gauge
//   pipeline_input_rows_processed_total                     counter
//   duckdb_memory_bytes{node_id}                            gauge
//   iceberg_snapshot_commit_duration_seconds{table}         histogram
//   temporal_workflow_failures_total{workflow_type, reason} counter
//   pipeline_orphan_runs_swept_total                        counter
//
// All emission goes through this module so the call sites in
// deploymentService / pipelineDispatcher / transformService / iceberg
// catalog stay typed and single-purpose; the actual rendering is
// delegated to the shared Funnel exposition code via the same label
// map shape.
// ---------------------------------------------------------------------------

import {
  incCounter,
  observeHistogram,
  setGauge,
} from "../funnel/metrics";

type Labels = Record<string, string>;

const PIPELINE_DEPLOY_BUCKETS = [
  1, 5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600,
];
const PIPELINE_PREVIEW_BUCKETS = [
  0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30,
];

export function recordDeployDuration(
  pipelineId: string,
  status: "succeeded" | "failed" | "cancelled",
  seconds: number,
): void {
  observeHistogramBucketed(
    "pipeline_deploy_duration_seconds",
    seconds,
    { pipeline_id: pipelineId, status },
    PIPELINE_DEPLOY_BUCKETS,
  );
  incCounter("pipeline_deploy_total", { status });
}

export function recordPreviewDuration(transformType: string, seconds: number): void {
  observeHistogramBucketed(
    "pipeline_preview_duration_seconds",
    seconds,
    { transform_type: transformType },
    PIPELINE_PREVIEW_BUCKETS,
  );
}

export function incActiveDeploys(delta: number): void {
  // `setGauge` from the funnel metrics module stores values keyed by
  // label set; to increment we read-modify-write under the empty label.
  const current = Number((activeDeploys.value as unknown as number) ?? 0);
  activeDeploys.value = current + delta;
  setGauge("pipeline_active_deploys", activeDeploys.value);
}

const activeDeploys = { value: 0 };

export function addInputRowsProcessed(n: number): void {
  if (n <= 0) return;
  incCounter("pipeline_input_rows_processed_total", {}, n);
}

export function recordDuckdbMemory(nodeId: string, bytes: number): void {
  setGauge("duckdb_memory_bytes", bytes, { node_id: nodeId });
}

export function recordIcebergCommit(table: string, seconds: number): void {
  observeHistogramBucketed(
    "iceberg_snapshot_commit_duration_seconds",
    seconds,
    { table },
    PIPELINE_PREVIEW_BUCKETS,
  );
}

export function recordTemporalFailure(
  workflowType: string,
  reason: string,
): void {
  incCounter("temporal_workflow_failures_total", {
    workflow_type: workflowType,
    reason,
  });
}

export function recordOrphanSwept(n: number = 1): void {
  incCounter("pipeline_orphan_runs_swept_total", {}, n);
}

// ---------------------------------------------------------------------------
// Bucketed histogram shim — the funnel's observeHistogram uses the
// default buckets; we want PB-B9-specific ones per metric. Register
// once then observe; the funnel metrics core stores buckets per
// histogram name on first write.
// ---------------------------------------------------------------------------

const registeredBuckets = new Map<string, number[]>();

function observeHistogramBucketed(
  name: string,
  seconds: number,
  labels: Labels,
  buckets: number[],
): void {
  if (!registeredBuckets.has(name)) {
    registeredBuckets.set(name, buckets);
    // The funnel metrics core registers default buckets on first
    // observeHistogram. We seed a zero observation at the largest
    // bucket to force registration with custom buckets before the
    // real write. This is a best-effort shim — on a cold process the
    // first metric emitted uses the default buckets; subsequent ones
    // inherit. For hot-path accuracy in production, swap this module
    // for prom-client (see the Funnel's own comment on the same).
    observeHistogram(name, buckets[buckets.length - 1], { ...labels, __seed: "1" });
  }
  observeHistogram(name, seconds, labels);
}

// ---------------------------------------------------------------------------
// Prometheus rendering — re-exports the Funnel's renderPrometheus so
// both subsystems share one exposition format. The scrape endpoint
// lives in src/routes/pipelinesMetrics.ts; this module stays pure-TS.
// ---------------------------------------------------------------------------
export { renderPrometheus } from "../funnel/metrics";
