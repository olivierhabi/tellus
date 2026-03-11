// ---------------------------------------------------------------------------
// Global Error Handler Middleware
//
// Catches unhandled errors and returns formatted error responses. Must be
// registered LAST in the middleware chain (after all routes).
//
// Translation order:
//   1. Application errors with a `code` matching ERROR_CODES
//   2. PostgreSQL errors (code is a string of digits)
//   3. All other errors -> INTERNAL_ERROR
// ---------------------------------------------------------------------------

import { Request, Response, NextFunction } from "express";
import { ERROR_CODES, sendError } from "../utils/responseFormatter";
import { AppError } from "../utils/appError";

// ---------------------------------------------------------------------------
// PostgreSQL error detection — pg errors have a numeric `code` string
// ---------------------------------------------------------------------------

function isPostgresError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as Record<string, unknown>).code;
  return typeof code === "string" && /^\d{5}$/.test(code);
}

// ---------------------------------------------------------------------------
// Middleware (4-parameter signature required by Express for error handlers)
// ---------------------------------------------------------------------------

export default function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Don't send a response if headers are already sent
  if (res.headersSent) {
    return;
  }

  // -----------------------------------------------------------------
  // 1. Application error with a code matching ERROR_CODES
  // -----------------------------------------------------------------
  if (err.code && ERROR_CODES[err.code] !== undefined) {
    sendError(res, err.code, err.message, err.details);
    return;
  }

  // -----------------------------------------------------------------
  // 2. PostgreSQL error (code is a 5-digit string)
  // -----------------------------------------------------------------
  if (isPostgresError(err)) {
    const pgCode = err.code as string;

    switch (pgCode) {
      case "23505": // unique_violation
        sendError(
          res,
          "ALREADY_EXISTS",
          "A resource with that identifier already exists."
        );
        return;

      case "23503": // foreign_key_violation
        sendError(
          res,
          "VALIDATION_FAILED",
          "Referenced resource does not exist."
        );
        return;

      case "23502": // not_null_violation
        sendError(
          res,
          "REQUIRED_FIELD_MISSING",
          "A required field was not provided."
        );
        return;

      default:
        console.error("Unhandled PostgreSQL error:", {
          code: pgCode,
          message: err.message,
          stack: err.stack,
        });
        sendError(
          res,
          "INTERNAL_ERROR",
          "An unexpected database error occurred."
        );
        return;
    }
  }

  // -----------------------------------------------------------------
  // 3. All other errors — never expose internals to the client
  // -----------------------------------------------------------------
  console.error("Unhandled error:", {
    message: err.message,
    stack: err.stack,
  });

  sendError(res, "INTERNAL_ERROR", "An internal server error occurred.");
}
