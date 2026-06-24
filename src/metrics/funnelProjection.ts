// ---------------------------------------------------------------------------
// Funnel-projection bridge metrics
// ---------------------------------------------------------------------------
// Observability for the `projectFunnelTerminalToState` helper that
// bridges `funnel_run` (workflow audit log) → `funnel_state.status`
// (the UI-facing badge column read via `objectType.indexingState`).
//
// The helper is best-effort by design (a projection failure must not
// fail an already-successful pipeline run), which means any silent
// regression would otherwise be invisible at the page level until a
// user reports a stuck "Not indexed" badge. These metrics surface
// projection health as a first-class signal so SRE can alert on
// degradation BEFORE a user notices.
//
// Cardinality is bounded:
//   - `status` ∈ {not_indexed, indexing, indexed, failed, stale}
//   - `outcome` ∈ {ok, ot_missing, db_error}
//   - `path` ∈ {pre, post, pre_temporal} — corresponds to the dispatcher
//     code path that fired the projection.
// ---------------------------------------------------------------------------

import { Counter, Histogram, register } from "prom-client";

const CANONICAL_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
] as const;

function getOrCreateCounter(
  opts: ConstructorParameters<typeof Counter>[0],
): Counter<string> {
  const existing = register.getSingleMetric(opts.name);
  if (existing) return existing as Counter<string>;
  return new Counter(opts);
}

function getOrCreateHistogram(
  opts: ConstructorParameters<typeof Histogram>[0],
): Histogram<string> {
  const existing = register.getSingleMetric(opts.name);
  if (existing) return existing as Histogram<string>;
  return new Histogram(opts);
}

/**
 * Total projections attempted. Incremented once per
 * `projectFunnelTerminalToState` call regardless of outcome — divide
 * `_failures` by this to get the failure rate.
 */
export const funnelProjectionTotal = getOrCreateCounter({
  name: "tellus_funnel_projection_total",
  help: "Number of projection attempts from funnel_run to funnel_state.",
  labelNames: ["status", "outcome", "path"] as const,
});

/**
 * Projection failures — broken DB query, lock timeout, etc. An alert
 * threshold of >1% sustained for 5 minutes catches real regressions
 * (e.g., schema drift on the `funnel_state` table, deadlock loop)
 * before users see a stuck badge.
 */
export const funnelProjectionFailuresTotal = getOrCreateCounter({
  name: "tellus_funnel_projection_failures_total",
  help: "Number of projection attempts that threw before completing.",
  labelNames: ["status", "path", "error_class"] as const,
});

/**
 * Wall-clock duration of a single projection attempt. Used to detect
 * pathological lock contention or N+1 lookups creeping into the
 * helper. Buckets are the canonical Tellus set.
 */
export const funnelProjectionSeconds = getOrCreateHistogram({
  name: "tellus_funnel_projection_seconds",
  help: "Wall-clock duration of a projection attempt (seconds).",
  labelNames: ["status", "outcome"] as const,
  buckets: [...CANONICAL_BUCKETS],
});
