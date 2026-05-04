// ---------------------------------------------------------------------------
// Code Repositories — Prometheus metric name registry + emit helpers.
//
// Spec contracts:
//   §1.8 (G-C-44..50)   — every service emits standard counters/histograms
//                         (request rate, latency, error rate by errorName,
//                         downstream call latency).
//   G-C-54              — Audit chain tamper-evidence requires a metric
//                         emitted on AUDIT_CHAIN_HEAD_MISSING so on-call
//                         can be paged before the chain breaks publicly.
//   B10-C-14            — Pre-receive P99 < 2 s — needs a histogram to
//                         measure.
//
// We name-register every code-repos metric here so cardinality is bounded
// (label sets are listed; nothing else may be added at the call site
// without updating this file). The actual emission goes through the
// existing in-house Prometheus shim at src/services/funnel/metrics.ts —
// chosen so we don't pull in a second metrics library, and so dashboards
// already wired to that shim see code-repos metrics in the same scrape.
// ---------------------------------------------------------------------------

import {
  incCounter,
  observeHistogram,
  setGauge,
} from "../../funnel/metrics";

// ---------------------------------------------------------------------------
// Metric names — pinned here, referenced everywhere else.
//
// Naming convention: `tellus_code_repos_<subsystem>_<verb>_<unit>` so
// dashboards can group by `tellus_code_repos_*` selector and so tests
// can assert exact names.
// ---------------------------------------------------------------------------

export const METRICS = Object.freeze({
  // §1.8 — request rate, error rate, latency at the route layer.
  requestsTotal: "tellus_code_repos_requests_total",
  errorsTotal: "tellus_code_repos_errors_total",
  requestDurationSeconds: "tellus_code_repos_request_duration_seconds",

  // G-C-54 — audit chain integrity.
  auditChainHeadMissingTotal:
    "tellus_code_repos_audit_chain_head_missing_total",
  auditChainAppendedTotal: "tellus_code_repos_audit_chain_appended_total",

  // G-C-22 — idempotency outcomes (replay vs conflict vs fresh).
  idempotencyOutcomeTotal: "tellus_code_repos_idempotency_outcome_total",

  // B10-C-04..10 — pre-receive policy outcomes (allow vs deny by step).
  preReceiveDecisionTotal: "tellus_code_repos_pre_receive_decision_total",
  // B10-C-14 — pre-receive latency.
  preReceiveDurationSeconds:
    "tellus_code_repos_pre_receive_duration_seconds",

  // B2-C-10 — tree listing.
  treeRequestsTotal: "tellus_code_repos_tree_requests_total",
  treeDurationSeconds: "tellus_code_repos_tree_duration_seconds",
  treeEntriesReturned: "tellus_code_repos_tree_entries_returned",

  // B2-C-11 — file read.
  fileReadTotal: "tellus_code_repos_file_read_total",
  fileReadBytes: "tellus_code_repos_file_read_bytes",
  fileReadDurationSeconds:
    "tellus_code_repos_file_read_duration_seconds",
} as const);

export type MetricName = (typeof METRICS)[keyof typeof METRICS];

// ---------------------------------------------------------------------------
// Label sets — exhaustively documented so an unexpected label combo at the
// call site is a compile-time error.
//
// Cardinality budget per metric (rule of thumb: <= 100 distinct combos
// per process; the actual scrape budget is much higher but we want
// dashboards to render fast).
// ---------------------------------------------------------------------------

export interface RequestLabels {
  /** "stemma" | "code_repo" | "stemma_events" | ... — one per service. */
  readonly service: string;
  /** Method + path-template, e.g. "POST /repositories". Cardinality bounded
   *  by the number of routes (small). */
  readonly route: string;
  /** "2xx" | "4xx" | "5xx" — bucketing keeps cardinality at 3. */
  readonly status_class: "2xx" | "4xx" | "5xx";
}

export interface ErrorLabels {
  readonly service: string;
  readonly route: string;
  /** Namespaced errorName — bounded by the union of every error name
   *  declared per service. */
  readonly error_name: string;
}

export type IdempotencyOutcome = "fresh" | "replay" | "conflict" | "rejected";
export interface IdempotencyLabels {
  readonly service: string;
  readonly route: string;
  readonly outcome: IdempotencyOutcome;
}

export type PreReceiveDecision =
  | "allow"
  | "deny.regex"
  | "deny.delete_protected"
  | "deny.force_protected"
  | "deny.requires_pr"
  | "deny.tag_immutable"
  | "deny.permission";

export interface PreReceiveLabels {
  /** "branch" | "tag". Coarse so cardinality is 2. */
  readonly ref_kind: "branch" | "tag";
  readonly decision: PreReceiveDecision;
}

// ---------------------------------------------------------------------------
// Emit helpers — typed thin wrappers over incCounter/observeHistogram.
// Tests can call these directly to assert metric values without standing
// up the route layer.
// ---------------------------------------------------------------------------

/** Increment the request-counter for one HTTP request that has finished. */
export function recordRequest(labels: RequestLabels): void {
  incCounter(METRICS.requestsTotal, {
    service: labels.service,
    route: labels.route,
    status_class: labels.status_class,
  });
}

/** Increment the error-counter for one request that returned an error envelope. */
export function recordError(labels: ErrorLabels): void {
  incCounter(METRICS.errorsTotal, {
    service: labels.service,
    route: labels.route,
    error_name: labels.error_name,
  });
}

/** Observe one request's wall-clock latency in seconds. */
export function observeRequestDuration(
  labels: RequestLabels,
  seconds: number,
): void {
  observeHistogram(METRICS.requestDurationSeconds, seconds, {
    service: labels.service,
    route: labels.route,
    status_class: labels.status_class,
  });
}

/** G-C-54 — count of audit-head-missing failures. P1 alert page-on. */
export function recordAuditChainHeadMissing(): void {
  incCounter(METRICS.auditChainHeadMissingTotal, {});
}

/** Healthy-path counter — every successful audit append. Pair with the
 *  page-on counter for ratio-based dashboards. */
export function recordAuditChainAppended(): void {
  incCounter(METRICS.auditChainAppendedTotal, {});
}

/** Tracks the idempotency middleware's three outcome paths. */
export function recordIdempotencyOutcome(labels: IdempotencyLabels): void {
  incCounter(METRICS.idempotencyOutcomeTotal, {
    service: labels.service,
    route: labels.route,
    outcome: labels.outcome,
  });
}

/** B10-C-04..10 — count pre-receive decisions per ref. */
export function recordPreReceiveDecision(labels: PreReceiveLabels): void {
  incCounter(METRICS.preReceiveDecisionTotal, {
    ref_kind: labels.ref_kind,
    decision: labels.decision,
  });
}

/** B10-C-14 — pre-receive latency for SLO tracking. */
export function observePreReceiveDuration(
  labels: PreReceiveLabels,
  seconds: number,
): void {
  observeHistogram(METRICS.preReceiveDurationSeconds, seconds, {
    ref_kind: labels.ref_kind,
    decision: labels.decision,
  });
}

// ---------------------------------------------------------------------------
// B2-C-10 / B2-C-11 — tree + file read metrics.
//
// Cardinality budget: `status` ∈ {2xx, 3xx, 4xx, 5xx} = 4 values.
// `truncated` ∈ {true, false} = 2 values. We deliberately do NOT label
// by `rid` (unbounded) or by `branch` (unbounded). Tracing spans carry
// the rid/branch as attributes for high-cardinality drill-down.
// ---------------------------------------------------------------------------

export type ReadStatusClass = "2xx" | "3xx" | "4xx" | "5xx";

export interface TreeReadLabels {
  readonly status_class: ReadStatusClass;
}

export interface FileReadLabels {
  readonly status_class: ReadStatusClass;
  readonly truncated: "true" | "false";
}

export function recordTreeRequest(labels: TreeReadLabels): void {
  incCounter(METRICS.treeRequestsTotal, {
    status_class: labels.status_class,
  });
}

export function observeTreeDuration(
  labels: TreeReadLabels,
  seconds: number,
): void {
  observeHistogram(METRICS.treeDurationSeconds, seconds, {
    status_class: labels.status_class,
  });
}

export function observeTreeEntriesReturned(count: number): void {
  observeHistogram(METRICS.treeEntriesReturned, count, {});
}

export function recordFileRead(labels: FileReadLabels): void {
  incCounter(METRICS.fileReadTotal, {
    status_class: labels.status_class,
    truncated: labels.truncated,
  });
}

export function observeFileReadBytes(bytes: number): void {
  observeHistogram(METRICS.fileReadBytes, bytes, {});
}

export function observeFileReadDuration(
  labels: FileReadLabels,
  seconds: number,
): void {
  observeHistogram(METRICS.fileReadDurationSeconds, seconds, {
    status_class: labels.status_class,
    truncated: labels.truncated,
  });
}

/** Re-export setGauge for callers that need to set a gauge with a named
 *  metric (the registry is on us; the emission is on the shim). */
export { setGauge };

// ---------------------------------------------------------------------------
// Test-only introspection.
//
// The funnel/metrics shim exposes `renderPrometheus()` (Prometheus text
// format) but no direct getter. For tests we parse that text to extract
// counter values. Bounded scope: only used in tests under
// tests/{unit,integration}/code-repos/. Production code never imports
// these helpers — the names start with `__` to mark them as test-only.
// ---------------------------------------------------------------------------

import { renderPrometheus, __resetMetricsForTesting } from "../../funnel/metrics";

/**
 * Read the current value of a counter from the metrics registry. Returns
 * 0 if the metric is unregistered or no sample with these labels has
 * been recorded yet.
 *
 * Labels match if the rendered line contains the same `key="value"` pair
 * for every entry in `labels`. Extra labels on the line are ignored
 * (this matches the Prometheus query semantics for label matchers).
 */
export function __getCounterValueForTest(
  name: string,
  labels: Record<string, string> = {},
): number {
  const text = renderPrometheus();
  const labelMatchers = Object.entries(labels).map(
    ([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`,
  );
  const lines = text.split("\n");
  let total = 0;
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    if (!line.startsWith(`${name}{`) && line !== name && !line.startsWith(`${name} `)) {
      continue;
    }
    if (labels && Object.keys(labels).length > 0) {
      const allMatch = labelMatchers.every((m) => line.includes(m));
      if (!allMatch) continue;
    }
    // The value is the last whitespace-separated token on the line.
    const lastSpace = line.lastIndexOf(" ");
    if (lastSpace < 0) continue;
    const valueStr = line.slice(lastSpace + 1);
    const v = Number(valueStr);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

/** Re-export the funnel-shim reset for test-suite isolation. */
export { __resetMetricsForTesting };
