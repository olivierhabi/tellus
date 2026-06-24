// ---------------------------------------------------------------------------
// Lightweight Prometheus-format metrics for the Funnel control plane.
//
// Not prom-client — keeping the dependency surface small. Exposes enough
// shape for on-call runbooks:
//   * Counter:   funnel_workflow_terminate_on_save_total
//   * Counter:   funnel_workflow_cancel_attempted_total
//   * Counter:   funnel_workflow_cancelled_cleanly_total
//   * Counter:   funnel_workflow_cancel_timeout_total
//   * Counter:   funnel_signal_with_start_total
//   * Counter:   funnel_signal_with_start_errors_total
//   * Histogram: funnel_stage_duration_seconds{stage}
//   * Gauge:     funnel_run_in_flight{object_type}
//
// Emits text in the Prometheus exposition format at /api/v1/funnel/metrics.
// A real deployment should swap this for prom-client; the API here is
// narrow on purpose so the swap is a one-file change.
// ---------------------------------------------------------------------------

type LabelMap = Record<string, string>;

interface CounterState {
  help: string;
  values: Map<string, number>;
}
interface GaugeState {
  help: string;
  values: Map<string, number>;
}
interface HistogramState {
  help: string;
  buckets: number[]; // upper bounds
  values: Map<string, { bucketCounts: number[]; sum: number; count: number }>;
}

const counters = new Map<string, CounterState>();
const gauges = new Map<string, GaugeState>();
const histograms = new Map<string, HistogramState>();

const DEFAULT_BUCKETS = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];

function registerCounter(name: string, help: string): CounterState {
  let c = counters.get(name);
  if (!c) {
    c = { help, values: new Map() };
    counters.set(name, c);
  }
  return c;
}

function registerGauge(name: string, help: string): GaugeState {
  let g = gauges.get(name);
  if (!g) {
    g = { help, values: new Map() };
    gauges.set(name, g);
  }
  return g;
}

function registerHistogram(
  name: string,
  help: string,
  buckets: number[] = DEFAULT_BUCKETS
): HistogramState {
  let h = histograms.get(name);
  if (!h) {
    h = { help, buckets, values: new Map() };
    histograms.set(name, h);
  }
  return h;
}

function labelKey(labels: LabelMap): string {
  const entries = Object.entries(labels).sort((a, b) => a[0].localeCompare(b[0]));
  return entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",");
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function incCounter(name: string, labels: LabelMap = {}, amount: number = 1): void {
  const help = COUNTER_HELP[name] ?? name;
  const c = registerCounter(name, help);
  const key = labelKey(labels);
  c.values.set(key, (c.values.get(key) ?? 0) + amount);
}

export function setGauge(name: string, value: number, labels: LabelMap = {}): void {
  const help = GAUGE_HELP[name] ?? name;
  const g = registerGauge(name, help);
  g.values.set(labelKey(labels), value);
}

export function observeHistogram(
  name: string,
  seconds: number,
  labels: LabelMap = {}
): void {
  const help = HISTOGRAM_HELP[name] ?? name;
  const h = registerHistogram(name, help);
  const key = labelKey(labels);
  let v = h.values.get(key);
  if (!v) {
    v = { bucketCounts: new Array(h.buckets.length).fill(0), sum: 0, count: 0 };
    h.values.set(key, v);
  }
  v.count += 1;
  v.sum += seconds;
  for (let i = 0; i < h.buckets.length; i++) {
    if (seconds <= h.buckets[i]) v.bucketCounts[i] += 1;
  }
}

export function renderPrometheus(): string {
  const lines: string[] = [];
  for (const [name, c] of counters) {
    lines.push(`# HELP ${name} ${c.help}`);
    lines.push(`# TYPE ${name} counter`);
    for (const [key, val] of c.values) {
      lines.push(key ? `${name}{${key}} ${val}` : `${name} ${val}`);
    }
  }
  for (const [name, g] of gauges) {
    lines.push(`# HELP ${name} ${g.help}`);
    lines.push(`# TYPE ${name} gauge`);
    for (const [key, val] of g.values) {
      lines.push(key ? `${name}{${key}} ${val}` : `${name} ${val}`);
    }
  }
  for (const [name, h] of histograms) {
    lines.push(`# HELP ${name} ${h.help}`);
    lines.push(`# TYPE ${name} histogram`);
    for (const [key, v] of h.values) {
      const keyPart = key ? `,${key}` : "";
      for (let i = 0; i < h.buckets.length; i++) {
        lines.push(
          `${name}_bucket{le="${h.buckets[i]}"${keyPart}} ${v.bucketCounts[i]}`
        );
      }
      lines.push(`${name}_bucket{le="+Inf"${keyPart}} ${v.count}`);
      lines.push(key ? `${name}_sum{${key}} ${v.sum}` : `${name}_sum ${v.sum}`);
      lines.push(key ? `${name}_count{${key}} ${v.count}` : `${name}_count ${v.count}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function __resetMetricsForTesting(): void {
  counters.clear();
  gauges.clear();
  histograms.clear();
}

// ---------------------------------------------------------------------------
// Per-metric help strings. Keep these short; the real runbook lives in docs/.
// ---------------------------------------------------------------------------
const COUNTER_HELP: Record<string, string> = {
  funnel_workflow_terminate_on_save_total:
    "Count of save-to-ontology calls that forcibly replaced an in-flight workflow.",
  funnel_workflow_cancel_attempted_total:
    "Count of graceful cancel attempts against a stuck ObjectTypeFunnelWorkflow.",
  funnel_workflow_cancelled_cleanly_total:
    "Count of workflows that exited cleanly within the cancel timeout.",
  funnel_workflow_cancel_timeout_total:
    "Count of workflows that required forced termination after cancel timeout expired.",
  funnel_signal_with_start_total:
    "Total signalWithStart calls by object type and signal type.",
  funnel_signal_with_start_errors_total:
    "Failures during signalWithStart (Temporal unreachable etc.).",
  funnel_orphan_runs_swept_total:
    "Count of funnel_run rows swept as orphans on server boot.",
  funnel_iceberg_metadata_emission_failures_total:
    "Count of S3 metadata.json emission failures requiring sweeper retry.",
  // T-01 — object-explorer read-path branch-filter audit.
  tellus_read_branch_filtered_total:
    "Count of explorer read-path queries by route and whether a branch filter was applied (scoped='true' iff branchId !== null).",
  // T-03 — SQL surface.
  tellus_sql_cache_hits_total:
    "Count of furnace-SQL cache outcomes by result label (hit/miss/inflight_join).",
  tellus_sql_invalidate_total:
    "Count of /sql/invalidate calls by caller role.",
  tellus_sql_query_total:
    "Count of /sql executions by terminal outcome (ok/timeout/execution_error/rejected).",
  tellus_sql_sandbox_set_failed_total:
    "Count of DuckDB sandbox SET statements that failed during initialisation; non-zero indicates version drift.",
  // T-04 — overlay branch isolation.
  tellus_overlay_reads_total:
    "Count of overlay reads by branch_match (match/mismatch_rejected) and source (new_key/legacy_key).",
  tellus_overlay_writes_total:
    "Count of overlay writes by outcome (ok/version_conflict).",
  tellus_overlay_legacy_hits_total:
    "Count of legacy-key overlay reads (Phase progression monitor — should trend to zero).",
  tellus_overlay_branch_mismatch_total:
    "Count of overlay reads suppressed because the only hit lived in the legacy key but the request targeted a non-main branch (MUST be zero in phase 3).",
  // T-05 — exports.
  tellus_export_jobs_total:
    "Count of export jobs by format and terminal outcome.",
  tellus_export_rows_streamed_total:
    "Count of rows streamed by export workers, partitioned by format.",
  tellus_export_download_issued_total:
    "Count of presigned download URLs returned to authenticated owners by format.",
  tellus_export_download_expired_total:
    "Count of download requests rejected with EXPORT_DOWNLOAD_EXPIRED by format.",
  // T-08 — saved explorations.
  tellus_saved_exploration_marking_misses_total:
    "Count of saved-exploration reads filtered by required_markings markings mismatch.",
  // T-09 — full-text spec syntax usage.
  tellus_full_text_spec_syntax_total:
    "Count of full-text queries by whether spec syntax (operators, wildcards, quotes) was detected.",
};
const GAUGE_HELP: Record<string, string> = {
  funnel_run_in_flight:
    "Current number of running funnel_run rows per object_type.",
};
const HISTOGRAM_HELP: Record<string, string> = {
  funnel_stage_duration_seconds:
    "Wall-clock duration of each Funnel stage (changelog/merge/indexing/hydration) in seconds.",
  funnel_workflow_cancel_latency_seconds:
    "Time between cancel signal and workflow closure.",
  // T-03 — SQL.
  tellus_sql_query_duration_seconds:
    "End-to-end duration of /sql executions in seconds, partitioned by outcome.",
  // T-05 — exports.
  tellus_export_duration_seconds:
    "End-to-end duration of export workflows by format.",
  // T-09 — search around.
  tellus_search_around_visited_pks:
    "Cardinality of accumulated visitedPKs per search-around traversal.",
  tellus_search_around_hops:
    "Number of hops per search-around traversal.",
  tellus_pagination_size:
    "Effective per-page size after MAX_PAGE_SIZE clamp.",
  // T-10 — per-route latency.
  tellus_route_duration_seconds:
    "Per-route end-to-end duration in seconds, partitioned by route and status_class.",
};
