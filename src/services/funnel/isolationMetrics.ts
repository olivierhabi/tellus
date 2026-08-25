// ---------------------------------------------------------------------------
// FUNN-ISO — Deployment environment isolation metrics.
//
// Counters/gauges for the environment fence + fail-closed projection layer.
// Rendered by the existing Funnel control-plane exposition
// (`GET /api/v1/funnel/metrics` — services/funnel/metrics.ts), so alert
// queries can reference these names directly:
//
//   funnel_environment_mismatch_total              worker/DB/ctx env diverged (fence fired)
//   funnel_missing_object_type_total               projection/activity found no expected OT
//   funnel_missing_datasource_total                changelog stage had no backing source
//   funnel_projection_skipped_total                terminal projection rejected (CAS/stage-verify)
//   funnel_runs_stuck_total                        reconciliation marked an abandoned run failed
//   funnel_terminal_projection_failed_total        terminal projection activity failed outright
//   funnel_dispatch_pending_age_seconds            age histogram of dispatch_pending rows
//   funnel_indexing_age_seconds                    age histogram of funnel_state stuck in indexing
//   funnel_stage_environment_inconsistency_total   terminal verify: stage rows missing/cross-env
//   temporal_unexpected_poller_total               poller identity audit found foreign env
// ---------------------------------------------------------------------------

import { incCounter, observeHistogram } from "./metrics";

export const ISO_METRICS = {
  environmentMismatch: "funnel_environment_mismatch_total",
  missingObjectType: "funnel_missing_object_type_total",
  missingDatasource: "funnel_missing_datasource_total",
  projectionSkipped: "funnel_projection_skipped_total",
  runsStuck: "funnel_runs_stuck_total",
  terminalProjectionFailed: "funnel_terminal_projection_failed_total",
  dispatchPendingAge: "funnel_dispatch_pending_age_seconds",
  indexingAge: "funnel_indexing_age_seconds",
  stageEnvironmentInconsistency: "funnel_stage_environment_inconsistency_total",
  unexpectedPoller: "temporal_unexpected_poller_total",
} as const;

type Labels = Record<string, string>;

export function recordEnvironmentMismatch(labels: Labels): void {
  incCounter(ISO_METRICS.environmentMismatch, labels);
}
export function recordMissingObjectType(labels: Labels): void {
  incCounter(ISO_METRICS.missingObjectType, labels);
}
export function recordMissingDatasource(labels: Labels): void {
  incCounter(ISO_METRICS.missingDatasource, labels);
}
export function recordProjectionSkipped(labels: Labels): void {
  incCounter(ISO_METRICS.projectionSkipped, labels);
}
export function recordRunStuck(labels: Labels): void {
  incCounter(ISO_METRICS.runsStuck, labels);
}
export function recordTerminalProjectionFailed(labels: Labels): void {
  incCounter(ISO_METRICS.terminalProjectionFailed, labels);
}
export function observeDispatchPendingAge(seconds: number, labels: Labels): void {
  observeHistogram(ISO_METRICS.dispatchPendingAge, seconds, labels);
}
export function observeIndexingAge(seconds: number, labels: Labels): void {
  observeHistogram(ISO_METRICS.indexingAge, seconds, labels);
}
export function recordStageEnvironmentInconsistency(labels: Labels): void {
  incCounter(ISO_METRICS.stageEnvironmentInconsistency, labels);
}
export function recordUnexpectedPoller(labels: Labels): void {
  incCounter(ISO_METRICS.unexpectedPoller, labels);
}
