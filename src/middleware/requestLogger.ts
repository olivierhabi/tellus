// ---------------------------------------------------------------------------
// Enhanced Request Logger Middleware (Task 16)
//
// Logs every request/response as structured JSON with a unique requestId,
// timing information, and an attached helper for application-level logging.
//
// Task 16 enhancements:
//   - Request timing (duration in ms) with nanosecond precision
//   - Structured JSON log format for all entries
//   - Log request body size
//   - Log response status code
//   - Skip logging for health check endpoints (configurable)
//   - Configurable log levels per status code range
//
// Task 19 enhancements (preserved):
//   - Nanosecond-precision timing via process.hrtime.bigint()
//   - X-Request-Id response header for client correlation
//   - Slow-request detection (>1000ms) with request body logging
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { Request, Response, NextFunction } from "express";

// ---------------------------------------------------------------------------
// Extend Express Request to carry our custom fields
// ---------------------------------------------------------------------------

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      _startHrTime?: bigint;
      log?: (message: string, data?: Record<string, unknown>) => void;
    }
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Paths that should NOT be logged (health checks, readiness probes, etc.). */
const SKIP_PATHS: Set<string> = new Set(
  (process.env.LOG_SKIP_PATHS || "/health,/healthz,/ready,/readiness,/liveness")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
);

/** Slow request threshold in milliseconds (configurable via env). */
const SLOW_REQUEST_THRESHOLD_MS = parseInt(
  process.env.SLOW_REQUEST_THRESHOLD_MS || "1000",
  10
);

// ---------------------------------------------------------------------------
// Helper: compute request body size in bytes
// ---------------------------------------------------------------------------

function getBodySizeBytes(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  try {
    return Buffer.byteLength(JSON.stringify(body), "utf-8");
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Helper: determine log level from status code
// ---------------------------------------------------------------------------

function getLogLevel(statusCode: number): string {
  if (statusCode >= 500) return "error";
  if (statusCode >= 400) return "warn";
  return "info";
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export default function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // 1. Attach request ID (always — even for skipped paths like /health)
  req.requestId = crypto.randomUUID();
  res.setHeader("X-Request-Id", req.requestId);

  // Skip logging for configured health check endpoints
  if (SKIP_PATHS.has(req.path)) {
    next();
    return;
  }

  // 2. Record start time (nanosecond precision) for logged requests
  req._startHrTime = process.hrtime.bigint();

  // 2. Compute body size (for logging metadata only — NEVER log the body itself)
  const bodySizeBytes = getBodySizeBytes(req.body);

  // 3. Log request start with structured JSON
  const startLog: Record<string, unknown> = {
    level: "info",
    type: "request_start",
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    query: Object.keys(req.query).length > 0 ? req.query : undefined,
    userAgent: req.get("user-agent") || undefined,
    ip: req.ip,
    contentType: req.get("content-type") || undefined,
    bodySizeBytes: bodySizeBytes > 0 ? bodySizeBytes : undefined,
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(startLog));

  // 4. Log request completion on response finish
  res.on("finish", () => {
    const durationMs =
      Number(process.hrtime.bigint() - (req._startHrTime || 0n)) / 1_000_000;
    const level = getLogLevel(res.statusCode);

    const completeLog: Record<string, unknown> = {
      level,
      type: "request_complete",
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100, // sub-millisecond precision
      contentLength: res.get("content-length")
        ? parseInt(res.get("content-length")!, 10)
        : undefined,
      timestamp: new Date().toISOString(),
    };

    console.log(JSON.stringify(completeLog));

    // 5. Slow-request detection
    if (durationMs > SLOW_REQUEST_THRESHOLD_MS) {
      const slowLog: Record<string, unknown> = {
        level: "warn",
        type: "slow_request",
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        bodySizeBytes: bodySizeBytes > 0 ? bodySizeBytes : undefined,
        timestamp: new Date().toISOString(),
      };
      console.log(JSON.stringify(slowLog));
    }
  });

  // 6. Attach req.log helper for application-level structured logging
  req.log = (message: string, data?: Record<string, unknown>): void => {
    const appLog: Record<string, unknown> = {
      level: "info",
      type: "app_log",
      requestId: req.requestId,
      message,
      data: data || {},
      timestamp: new Date().toISOString(),
    };
    console.log(JSON.stringify(appLog));
  };

  // 7. Continue
  next();
}
