// ---------------------------------------------------------------------------
// Global Error Handler Middleware
//
// Catches unhandled errors and returns formatted error responses. Must be
// registered LAST in the middleware chain (after all routes).
//
// Translation order:
//   1. OntologyError subclasses (from queryErrors.ts)
//   2. Application errors with a `code` matching ERROR_CODES
//   3. OpenSearch client errors (err.meta)
//   4. PostgreSQL errors (code is a string of digits)
//   5. All other errors -> INTERNAL_ERROR
// ---------------------------------------------------------------------------

import { Request, Response, NextFunction } from "express";
import { ERROR_CODES, sendError } from "../utils/responseFormatter";
import { AppError } from "../utils/appError";
import { OntologyError, ObjectDatabaseUnavailableError } from "../utils/queryErrors";

// ---------------------------------------------------------------------------
// PostgreSQL error detection — pg errors have a numeric `code` string
// ---------------------------------------------------------------------------

function isPostgresError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as Record<string, unknown>).code;
  return typeof code === "string" && /^\d{5}$/.test(code);
}

// ---------------------------------------------------------------------------
// OpenSearch error detection
// ---------------------------------------------------------------------------

function isOpenSearchError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as any).meta !== undefined && (err as any).meta.statusCode !== undefined;
}

// ---------------------------------------------------------------------------
// asyncHandler — wraps async route handlers so rejected promises are
// forwarded to next() for the error middleware to handle.
// ---------------------------------------------------------------------------

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ---------------------------------------------------------------------------
// Middleware (4-parameter signature required by Express for error handlers)
// ---------------------------------------------------------------------------

export default function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Don't send a response if headers are already sent
  if (res.headersSent) {
    return;
  }

  // -----------------------------------------------------------------
  // 1. OntologyError subclasses (Task 15 error hierarchy)
  // -----------------------------------------------------------------
  if (err instanceof OntologyError) {
    return void res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details || {},
      },
    });
  }

  // -----------------------------------------------------------------
  // 2. Application error with a code matching ERROR_CODES
  // -----------------------------------------------------------------
  if (err.code && ERROR_CODES[err.code] !== undefined) {
    sendError(res, err.code, err.message, err.details);
    return;
  }

  // -----------------------------------------------------------------
  // 3. OpenSearch client errors (detected by err.meta)
  // -----------------------------------------------------------------
  if (isOpenSearchError(err)) {
    const meta = (err as any).meta;
    const osStatus = meta.statusCode;
    const osBody = meta.body;

    // Index not found
    if (
      osStatus === 404 &&
      osBody?.error?.type === "index_not_found_exception"
    ) {
      sendError(
        res,
        "OBJECT_TYPE_NOT_FOUND",
        "Object type has not been indexed yet."
      );
      return;
    }

    // Document not found
    if (osStatus === 404) {
      sendError(res, "OBJECT_NOT_FOUND", "Object not found.");
      return;
    }

    // Bad query
    if (osStatus === 400) {
      console.error("OpenSearch 400 error:", JSON.stringify(osBody?.error));
      sendError(
        res,
        "QUERY_VALIDATION_ERROR",
        osBody?.error?.reason || "Invalid OpenSearch query."
      );
      return;
    }

    // Connection refused / timeout
    if (
      err.name === "ConnectionError" ||
      err.name === "TimeoutError" ||
      osStatus === 503
    ) {
      sendError(
        res,
        "OBJECT_DATABASE_UNAVAILABLE",
        "OpenSearch is currently unavailable. Please try again."
      );
      return;
    }

    // All other OpenSearch errors
    sendError(
      res,
      "OBJECT_DATABASE_UNAVAILABLE",
      `OpenSearch error (status ${osStatus}).`
    );
    return;
  }

  // -----------------------------------------------------------------
  // 4. PostgreSQL error (code is a 5-digit string)
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
  // 5. All other errors — never expose internals to the client
  // -----------------------------------------------------------------
  console.error("[UNHANDLED ERROR]", {
    message: err.message,
    stack: err.stack,
  });

  sendError(
    res,
    "INTERNAL_ERROR",
    "An unexpected error occurred. Please try again or contact support."
  );
}
