// ---------------------------------------------------------------------------
// Global Error Handler Middleware
//
// Catches unhandled errors and returns formatted error responses. Must be
// registered LAST in the middleware chain (after all routes).
//
// Translation order:
//   1. OntologyError subclasses (from queryErrors.ts) → standardized format
//   2. Application errors with a `code` matching ERROR_CODES → standardized format
//   3. OpenSearch client errors (err.meta)
//   4. PostgreSQL errors (code is a string of digits)
//   5. All other errors -> INTERNAL_ERROR
//
// Task 20: All error responses now follow the Palantir-compatible format:
//   { errorCode, errorName, errorInstanceId, parameters, message }
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { ERROR_CODES, sendError } from "../utils/responseFormatter";
import { AppError } from "../utils/appError";
import { OntologyError, ObjectDatabaseUnavailableError, STANDARD_ERROR_CODES } from "../utils/queryErrors";

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
  // 1. OntologyError subclasses (Task 15 error hierarchy + Task 20 format)
  // -----------------------------------------------------------------
  if (err instanceof OntologyError) {
    console.error(`[${err.code}] ${err.message} (${err.errorInstanceId})`);
    return void res.status(err.statusCode).json(err.toResponse());
  }

  // -----------------------------------------------------------------
  // 2. Application error with a code matching ERROR_CODES
  //    Convert to standardized format (Task 20)
  // -----------------------------------------------------------------
  if (err.code && ERROR_CODES[err.code] !== undefined) {
    const instanceId = crypto.randomUUID();
    const entry = STANDARD_ERROR_CODES[err.code];
    const httpStatus = entry?.status || ERROR_CODES[err.code] || 500;
    const errorName = entry?.name || "UnknownError";
    console.error(`[${err.code}] ${err.message} (${instanceId})`);
    return void res.status(httpStatus).json({
      errorCode: err.code,
      errorName,
      errorInstanceId: instanceId,
      parameters: err.details || {},
      message: err.message,
    });
  }

  // -----------------------------------------------------------------
  // 3. OpenSearch client errors (detected by err.meta)
  //    Converted to standardized format (Task 20)
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
      return void res.status(404).json(
        new OntologyError(
          "Object type has not been indexed yet.",
          "OBJECT_TYPE_NOT_FOUND"
        ).toResponse()
      );
    }

    // Document not found
    if (osStatus === 404) {
      return void res.status(404).json(
        new OntologyError("Object not found.", "OBJECT_NOT_FOUND").toResponse()
      );
    }

    // Bad query
    if (osStatus === 400) {
      console.error("OpenSearch 400 error:", JSON.stringify(osBody?.error));
      return void res.status(400).json(
        new OntologyError(
          osBody?.error?.reason || "Invalid OpenSearch query.",
          "QUERY_VALIDATION_ERROR"
        ).toResponse()
      );
    }

    // Connection refused / timeout
    if (
      err.name === "ConnectionError" ||
      err.name === "TimeoutError" ||
      osStatus === 503
    ) {
      return void res.status(503).json(
        new OntologyError(
          "OpenSearch is currently unavailable. Please try again.",
          "OBJECT_DATABASE_UNAVAILABLE"
        ).toResponse()
      );
    }

    // All other OpenSearch errors
    return void res.status(503).json(
      new OntologyError(
        `OpenSearch error (status ${osStatus}).`,
        "OBJECT_DATABASE_UNAVAILABLE"
      ).toResponse()
    );
  }

  // -----------------------------------------------------------------
  // 4. PostgreSQL error (code is a 5-digit string)
  //    Converted to standardized format (Task 20)
  // -----------------------------------------------------------------
  if (isPostgresError(err)) {
    const pgCode = err.code as string;

    switch (pgCode) {
      case "23505": // unique_violation
        return void res.status(409).json(
          new OntologyError(
            "A resource with that identifier already exists.",
            "ALREADY_EXISTS"
          ).toResponse()
        );

      case "23503": // foreign_key_violation
        return void res.status(400).json(
          new OntologyError(
            "Referenced resource does not exist.",
            "VALIDATION_FAILED"
          ).toResponse()
        );

      case "23502": // not_null_violation
        return void res.status(400).json(
          new OntologyError(
            "A required field was not provided.",
            "REQUIRED_FIELD_MISSING"
          ).toResponse()
        );

      default:
        console.error("Unhandled PostgreSQL error:", {
          code: pgCode,
          message: err.message,
          stack: err.stack,
        });
        return void res.status(500).json(
          new OntologyError(
            "An unexpected database error occurred.",
            "INTERNAL_ERROR"
          ).toResponse()
        );
    }
  }

  // -----------------------------------------------------------------
  // 5. All other errors — never expose internals to the client
  // -----------------------------------------------------------------
  const instanceId = crypto.randomUUID();
  console.error(`[INTERNAL_ERROR] Unhandled: ${err.message} (${instanceId})`, err.stack);

  return void res.status(500).json({
    errorCode: "INTERNAL_ERROR",
    errorName: "InternalError",
    errorInstanceId: instanceId,
    parameters: {},
    message: "An internal error occurred. Reference ID: " + instanceId,
  });
}
