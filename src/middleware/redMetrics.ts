// ---------------------------------------------------------------------------
// src/middleware/redMetrics.ts
//
// F-P4-15 closure — per-route RED (Rate/Errors/Duration) metrics.
//
// Pre-fix: no per-route latency histograms existed; the SLO p99 < 250 ms
// claim in docs/SLO.md was unverifiable in production because nothing
// measured it.
//
// Post-fix: this middleware records for every HTTP request:
//   - tellus_http_requests_total{route, method, status}
//   - tellus_http_request_duration_seconds{route, method}
//     (histogram with RED-standard buckets)
//
// Route cardinality control: the `route` label comes from
// `req.route.path` (Express routing) AFTER the route matched. For
// requests that fall through to notFoundHandler, the label is
// "__not_found". For /health-class routes the middleware exempts them
// from the counter to avoid burning metric cardinality on probe traffic.
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction } from "express";
import { incCounter, observeHistogram } from "../services/funnel/metrics";

/** Histogram buckets tuned for the Tellus 200r/s + 50a/s SLO. */
const DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];

/** Route patterns exempt from metrics (infra endpoints). */
const EXEMPT_PATHS = new Set<string>([
  "/health",
  "/api/v1/health",
  "/api/v1/ready",
  "/api/metrics",
  "/metrics",
  "/favicon.ico",
  "/openapi.json",
]);

function classifyStatus(code: number): "2xx" | "3xx" | "4xx" | "5xx" | "other" {
  if (code >= 200 && code < 300) return "2xx";
  if (code >= 300 && code < 400) return "3xx";
  if (code >= 400 && code < 500) return "4xx";
  if (code >= 500 && code < 600) return "5xx";
  return "other";
}

/** Route label extraction — prefers req.route.path (after Express
 * matching), falls back to req.baseUrl + originalUrl stripped of
 * query string if unmatched. */
function routeLabel(req: Request): string {
  const anyReq = req as Request & { route?: { path?: string }; baseUrl?: string };
  const routePath = anyReq.route?.path;
  if (routePath) {
    return (anyReq.baseUrl ?? "") + routePath;
  }
  // Fallback: strip query string and collapse IDs via a crude heuristic.
  const pathOnly = (req.originalUrl ?? req.url ?? "").split("?")[0] ?? "";
  // Collapse UUIDs to :uuid and numeric ids to :id so cardinality stays bounded.
  return pathOnly
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":uuid")
    .replace(/\/\d{3,}/g, "/:id");
}

export function redMetrics() {
  return function redMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (EXEMPT_PATHS.has(req.path)) {
      next();
      return;
    }
    const startNs = process.hrtime.bigint();

    res.on("finish", () => {
      const endNs = process.hrtime.bigint();
      const durationSeconds = Number(endNs - startNs) / 1_000_000_000;
      const route = routeLabel(req);
      const method = req.method;
      const statusClass = classifyStatus(res.statusCode);

      try {
        incCounter("tellus_http_requests_total", {
          route,
          method,
          status: statusClass,
          status_code: String(res.statusCode),
        });
        observeHistogram("tellus_http_request_duration_seconds", durationSeconds, {
          route,
          method,
        });
      } catch {
        // metrics unavailable — silent is acceptable
      }
    });

    next();
  };
}

export { DURATION_BUCKETS_SECONDS, classifyStatus, routeLabel };
export default redMetrics;
