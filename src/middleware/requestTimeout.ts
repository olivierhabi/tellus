// ---------------------------------------------------------------------------
// src/middleware/requestTimeout.ts
//
// Block F item 4 — 5s request-level timeout via AbortController.
//
// Every data-plane request gets a 5-second budget. On expiry, returns
// 504 Gateway Timeout with `retry_hint: "narrower_filter"` and emits
// tellus_request_timeout_total{route}. The AbortSignal is attached to
// req so downstream fetch()/OS/PG callers can cancel work in flight
// (the callers that already accept AbortSignal per F-P4-08 benefit
// immediately; others fall back to the wall-clock limit).
//
// Does not apply to /health, /ready, /metrics, streaming endpoints.
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction } from "express";
import { incCounter } from "../services/funnel/metrics";

const DEFAULT_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 5_000);
const DEFAULT_EXACT_AGGREGATION_TIMEOUT_MS = Number(
  process.env.OBJECTSET_EXACT_AGGREGATION_TIMEOUT_MS ?? 30_000,
);

const EXEMPT_PATHS = [
  "/health",
  "/api/v1/health",
  "/api/v1/ready",
  "/api/metrics",
  "/openapi.json",
  // Admin/test endpoint that synchronously drains pending funnel signals
  // by starting one workflow per pending signal. Latency is proportional
  // to the queue depth and routinely exceeds the 5s data-plane budget.
  // It is not user-facing and never on the hot path.
  "/api/v1/funnel/drain",
  // Workspace pods can take 30+ seconds to provision (K8s API calls, pod readiness polling).
  // The workspace broker handles its own timeout logic with waitForPodReadiness.
  "/api/v1/workspaces",
];

export interface RequestTimeoutOptions {
  timeoutMs?: number;
  exemptPaths?: string[];
  /**
   * Predicate identifying requests that need a longer wall-clock budget than
   * the default data-plane limit — e.g. multipart file uploads, whose duration
   * scales with file size and network throughput rather than handler work.
   * Matched requests get `extendedTimeoutMs` instead of `timeoutMs`; everything
   * else stays on the tight data-plane budget.
   */
  extendedBudgetFor?: (req: Request) => boolean;
  extendedTimeoutMs?: number;
  /**
   * Exact composite ObjectSet aggregations may page through more than
   * 100,000 groups. They retain the normal per-OpenSearch-call timeout and
   * complexity budget, but need a larger end-to-end envelope.
   */
  exactAggregationTimeoutMs?: number;
  /**
   * Full per-request budget override (evaluated BEFORE the
   * aggregate/upload predicate chain): when it returns a number, that
   * number IS the wall-clock budget. Used by routes whose own internal
   * deadline legitimately outlasts the data-plane budget and whose
   * terminal outcome must reach the wire (e.g. the /apply link-index
   * ack barrier: its 202 COMMITTED_INDEX_PENDING is the honest answer —
   * a 504 on a committed mutation invites retries of already-applied
   * edits; see actions/linkIndexAckHttp.ts).
   */
  budgetFor?: (req: Request) => number | undefined;
}

/** Attach `req.timeoutSignal: AbortSignal` and arm a 504 on expiry. */
export function requestTimeoutMiddleware(opts: RequestTimeoutOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const extendedTimeoutMs = opts.extendedTimeoutMs ?? timeoutMs;
  const exactAggregationTimeoutMs =
    opts.exactAggregationTimeoutMs ??
    DEFAULT_EXACT_AGGREGATION_TIMEOUT_MS;
  const exemptSet = new Set([...EXEMPT_PATHS, ...(opts.exemptPaths ?? [])]);

  return function requestTimeoutMw(req: Request, res: Response, next: NextFunction) {
    // Check exact match first
    if (exemptSet.has(req.path)) {
      return next();
    }
    // Check prefix match for dynamic paths (e.g., /api/v1/workspaces/:rid/:branch)
    for (const exemptPath of exemptSet) {
      if (req.path.startsWith(exemptPath + "/") || req.path === exemptPath) {
        return next();
      }
    }

    // Multipart uploads (POST .../upload and the .../transactions append
    // route) move bytes — their wall-clock duration is dominated by file size
    // and client throughput, not handler work, so the 5s data-plane budget
    // would 504 a legitimate large upload mid-stream. Give those requests the
    // extended budget; reads and other writes stay on the tight limit.
    const isObjectSetAggregate =
      req.method === "POST" &&
      /^\/api\/v2\/ontologies\/[^/]+\/objectSets\/aggregate$/.test(req.path);
    const customBudget = opts.budgetFor?.(req);
    const budget =
      customBudget ??
      (isObjectSetAggregate
        ? exactAggregationTimeoutMs
        : opts.extendedBudgetFor?.(req)
          ? extendedTimeoutMs
          : timeoutMs);

    // Expose the wire deadline so routes can pre-defer work whose own
    // internal waits would OVERRUN it (the applyBatch link-ack barrier:
    // a committed item MUST be answered 202, never left to the 504
    // fallback below). Read-only for handlers; not part of the response.
    // Express always provides res.locals; the ||= defends against test
    // harnesses that build a bare EventEmitter as res.
    res.locals ||= {};
    (res.locals as Record<string, unknown>).requestBudgetDeadlineAt =
      Date.now() + budget;

    const controller = new AbortController();
    (req as unknown as { timeoutSignal: AbortSignal }).timeoutSignal = controller.signal;

    const timer = setTimeout(() => {
      if (res.headersSent || res.writableEnded) return;
      controller.abort();
      incCounter("tellus_request_timeout_total", {
        route: req.route?.path ?? "__not_found",
        method: req.method,
      });
      res.status(504).json({
        errorCode: "REQUEST_TIMEOUT",
        errorName: "RequestTimeout",
        message: `Request exceeded ${budget}ms budget`,
        statusCode: 504,
        retryHint: "narrower_filter",
        requestId: (req as any).requestId,
      });
    }, budget);

    const clear = () => {
      clearTimeout(timer);
    };
    res.on("finish", clear);
    res.on("close", clear);

    next();
  };
}

export default requestTimeoutMiddleware;
