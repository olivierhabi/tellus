// ---------------------------------------------------------------------------
// T-10 — Route observability helpers.
//
// Two narrowly-scoped helpers that EVERY object-explorer route is required
// to call:
//
//   * `routeMetric(req, route, branchId)` — emits the canonical
//     `tellus_read_branch_filtered_total` counter with `(route, scoped)`
//     labels at the top of the handler. The label cardinality is bounded
//     to (≤22 routes) × (2 scoped values) = 44 series.
//
//   * `routeLog(req, route, status, durationMs, extras?)` — emits the
//     canonical structured JSON log line at handler completion AND
//     observes the `tellus_route_duration_seconds` histogram with
//     `(route, status_class)` labels.
//
// The companion AST contract guard (tests/contract/routeContractGuard.test.ts)
// asserts that every read handler in the explorer surface calls
// `buildSecurityFilter`, `readBranchHeader`, AND `routeMetric` — so a
// missing call breaks CI at PR time, not in a post-incident review.
//
// Decisions:
//   * `RouteName` is a closed union — adding a route requires editing this
//     file, which is the single point where SOC reviewers track counter
//     cardinality. The compiler refuses unknown routes.
//   * `console.log(JSON.stringify(...))` is intentional: the project's
//     log shipper is line-based, and structured logs flow through the
//     same pipeline as the rest of the codebase. We do NOT pull in a
//     logger here to avoid a per-handler logger-initialization cost.
//   * `extras` is a `Record<string, unknown>` constrained to non-PII
//     fields by convention (route counts, query types, error codes —
//     never user input or row contents).
// ---------------------------------------------------------------------------

import type { Request } from "express";
import { incCounter, observeHistogram } from "../services/funnel/metrics";

/**
 * The closed set of routes whose observability is mandatory under the
 * T-10 AST contract guard. Adding a new route requires:
 *   1. adding the literal here,
 *   2. wiring `routeMetric` + `routeLog` in the handler,
 *   3. either calling `buildSecurityFilter` + `readBranchHeader` OR
 *      adding the file::handler key to EXEMPT_LIST in the guard test.
 */
export type RouteName =
  | "objects.list"
  | "objects.search"
  | "objects.searchFullText"
  | "objects.searchAround"
  | "objects.aggregate"
  | "objects.get"
  | "objects.linked"
  | "objects.linkedCount"
  | "objects.editHistory"
  | "objects.validateForeignKeys"
  | "objectViews.single"
  | "objectViews.batch"
  | "objectViews.linked"
  | "objectViews.byType.single"
  | "objectViews.byType.linked"
  | "charts.batch"
  | "comparisons.aggregate"
  | "summary.single"
  | "summary.bundle"
  | "explorations.list"
  | "explorations.get"
  | "explorations.create"
  | "explorations.update"
  | "exports.create"
  | "exports.list"
  | "exports.get"
  | "exports.download"
  | "favorites.list"
  | "favorites.toggle"
  | "favorites.recent.list"
  | "favorites.recent.record"
  | "pipelines.activity"
  | "sql.execute"
  | "sql.invalidate";

/**
 * Read a request-scoped string property without importing express
 * augmentation. Used for `requestId`, `correlationId`, `traceId`, and
 * `user.id` — all of which the existing middleware attaches via the
 * loose `(req as any)` pattern.
 */
function readReqString(req: Request, key: string): string | null {
  const v = (req as unknown as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

function readUserId(req: Request): string | null {
  const u = (req as unknown as { user?: { id?: unknown } }).user;
  if (u && typeof u.id === "string") return u.id;
  return null;
}

/**
 * Emit the top-of-handler "branch-scoped or not" counter. MUST be called
 * exactly once per handler, AFTER `readBranchHeader(req)` has resolved
 * the active branch. The `scoped` label is "true" iff the request
 * carries a non-null branch id; the `route` label is the canonical name
 * from the closed union.
 */
export function routeMetric(
  _req: Request,
  route: RouteName,
  branchId: string | null,
): void {
  incCounter("tellus_read_branch_filtered_total", {
    route,
    scoped: branchId !== null ? "true" : "false",
  });
}

/**
 * Emit the end-of-handler structured log line + observe the route
 * duration histogram. Status class is derived from the response status
 * (`2xx`, `4xx`, etc.) so the histogram cardinality stays bounded.
 *
 * `extras` is included as additional structured fields and SHOULD NOT
 * include user input or row contents; the recommended fields are:
 *   - hits/totalCount/rowCount (numbers)
 *   - errorCode (string from the canonical error envelope)
 *   - format (for /exports)
 *   - cacheHit (boolean)
 */
export function routeLog(
  req: Request,
  route: RouteName,
  status: number,
  durationMs: number,
  extras: Record<string, unknown> = {},
): void {
  // The log line is one JSON object on stdout. Test harnesses capture
  // this via `vi.spyOn(console, "log")`; production captures via the
  // standard log shipper. (Direct console use is the project-wide
  // structured-log convention — see middleware/correlationId.ts.)
  console.log(
    JSON.stringify({
      level: "info",
      type: "route_call",
      route,
      status,
      durationMs,
      requestId: readReqString(req, "requestId"),
      correlationId: readReqString(req, "correlationId"),
      traceId: readReqString(req, "traceId"),
      user: readUserId(req),
      ...extras,
    }),
  );
  observeHistogram("tellus_route_duration_seconds", durationMs / 1000, {
    route,
    status_class: `${Math.floor(status / 100)}xx`,
  });
}

/**
 * Convenience wrapper: capture `Date.now()` on entry, return a closure
 * that logs at exit. Call sites that prefer to pass an explicit
 * duration use `routeLog` directly.
 */
export function startRouteTimer(
  req: Request,
  route: RouteName,
): (status: number, extras?: Record<string, unknown>) => void {
  const started = Date.now();
  return (status, extras) => routeLog(req, route, status, Date.now() - started, extras);
}
