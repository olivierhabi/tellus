// ---------------------------------------------------------------------------
// Request Logger Middleware
//
// Logs every request/response as structured JSON with a unique requestId,
// timing information, and an attached helper for application-level logging.
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
      _startTime?: number;
      log?: (message: string, data?: Record<string, unknown>) => void;
    }
  }
}

// ---------------------------------------------------------------------------
// Sensitive path patterns whose request bodies must NOT be logged
// ---------------------------------------------------------------------------

const SENSITIVE_PATH_PATTERNS = [/\/auth\//, /\/password\//];

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export default function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // 1. Attach request ID and start time
  req.requestId = crypto.randomUUID();
  req._startTime = Date.now();

  // Expose request ID to clients for correlation / debugging
  res.setHeader("X-Request-Id", req.requestId);

  // 2. Log request start
  const isSensitive = SENSITIVE_PATH_PATTERNS.some((p) => p.test(req.path));

  const startLog: Record<string, unknown> = {
    level: "info",
    type: "request_start",
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    timestamp: new Date().toISOString(),
  };

  if (!isSensitive && req.body && Object.keys(req.body).length > 0) {
    const bodyStr = JSON.stringify(req.body);
    startLog.body =
      bodyStr.length > 2000 ? bodyStr.substring(0, 2000) + "..." : bodyStr;
  }

  console.log(JSON.stringify(startLog));

  // 3. Log request completion on response finish
  res.on("finish", () => {
    const durationMs = Date.now() - (req._startTime || 0);
    const level = res.statusCode >= 400 ? "error" : "info";

    const completeLog: Record<string, unknown> = {
      level,
      type: "request_complete",
      requestId: req.requestId,
      statusCode: res.statusCode,
      durationMs,
      timestamp: new Date().toISOString(),
    };

    console.log(JSON.stringify(completeLog));
  });

  // 4. Attach req.log helper for application-level structured logging
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

  // 5. Continue
  next();
}
