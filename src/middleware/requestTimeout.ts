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
}

/** Attach `req.timeoutSignal: AbortSignal` and arm a 504 on expiry. */
export function requestTimeoutMiddleware(opts: RequestTimeoutOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const extendedTimeoutMs = opts.extendedTimeoutMs ?? timeoutMs;
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
    const budget = opts.extendedBudgetFor?.(req) ? extendedTimeoutMs : timeoutMs;

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
