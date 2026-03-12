// ---------------------------------------------------------------------------
// Request Logger Middleware
//
// Logs every request/response as structured JSON with a unique requestId,
// timing information, and an attached helper for application-level logging.
//
// Task 19 enhancements:
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
      _bodySnapshot?: string;
      log?: (message: string, data?: Record<string, unknown>) => void;
    }
  }
}

// ---------------------------------------------------------------------------
// Sensitive path patterns whose request bodies must NOT be logged
// ---------------------------------------------------------------------------

const SENSITIVE_PATH_PATTERNS = [/\/auth\//, /\/password\//];

// Slow request threshold in milliseconds
const SLOW_REQUEST_THRESHOLD_MS = 1000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export default function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // 1. Attach request ID and start time (nanosecond precision)
  req.requestId = crypto.randomUUID();
  req._startHrTime = process.hrtime.bigint();

  // Expose request ID to clients for correlation / debugging
  res.setHeader("X-Request-Id", req.requestId);

  // 2. Capture request body snapshot for slow-request logging (POST/PUT/PATCH only)
  const isSensitive = SENSITIVE_PATH_PATTERNS.some((p) => p.test(req.path));
  if (
    !isSensitive &&
    ["POST", "PUT", "PATCH"].includes(req.method) &&
    req.body &&
    Object.keys(req.body).length > 0
  ) {
    req._bodySnapshot = JSON.stringify(req.body).substring(0, 2000);
  }

  // 3. Log request start
  const startLog: Record<string, unknown> = {
    level: "info",
    type: "request_start",
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    timestamp: new Date().toISOString(),
  };

  if (req._bodySnapshot) {
    startLog.body = req._bodySnapshot;
  }

  console.log(JSON.stringify(startLog));

  // 4. Log request completion on response finish
  res.on("finish", () => {
    const durationMs =
      Number(process.hrtime.bigint() - (req._startHrTime || 0n)) / 1_000_000;
    const level = res.statusCode >= 400 ? "error" : "info";

    const completeLog: Record<string, unknown> = {
      level,
      type: "request_complete",
      requestId: req.requestId,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100, // sub-millisecond precision
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
        durationMs: Math.round(durationMs * 100) / 100,
        timestamp: new Date().toISOString(),
      };
      if (req._bodySnapshot) {
        slowLog.body = req._bodySnapshot;
      }
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
