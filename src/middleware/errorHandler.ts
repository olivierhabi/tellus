// ---------------------------------------------------------------------------
// Global Error Handler Middleware (Task 15 Enhanced)
//
// Catches unhandled errors and returns formatted error responses. Must be
// registered LAST in the middleware chain (after all routes).
//
// Translation order:
//   1. OntologyError subclasses (from queryErrors.ts) -> standardized format
//   2. AppError hierarchy (ValidationError, NotFoundError, ConflictError,
//      AuthError, ServerError) -> structured JSON with requestId + timestamp
//   3. Application errors with a `code` matching ERROR_CODES -> standardized format
//   4. OpenSearch client errors (err.meta)
//   5. PostgreSQL errors (code is a string of digits)
//   6. All other errors -> INTERNAL_ERROR
//
// Task 15 enhancements:
//   - AppError hierarchy support (ValidationError, NotFoundError, etc.)
//   - asyncHandler wrapper that catches async errors
//   - Structured JSON error response with requestId, timestamp
//   - Stack traces suppressed in production
//
// Task 20: All error responses follow the Palantir-compatible format:
//   { errorCode, errorName, errorInstanceId, parameters, message }
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { ERROR_CODES, sendError } from "../utils/responseFormatter";
import { AppError } from "../utils/appError";
import { OntologyError, ObjectDatabaseUnavailableError, STANDARD_ERROR_CODES } from "../utils/queryErrors";

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

const IS_PRODUCTION = process.env.NODE_ENV === "production";

// ---------------------------------------------------------------------------
// AppError hierarchy classes (Task 15)
//
// These extend AppError with specific HTTP status codes and error names.
// They can be thrown anywhere in the codebase and will be caught here.
// ---------------------------------------------------------------------------

export class ValidationError extends Error implements AppError {
  code = "VALIDATION_FAILED";
  statusCode = 400;
  errorName = "ValidationError";
  details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ValidationError";
    if (details) this.details = details;
  }
}

export class NotFoundError extends Error implements AppError {
  code = "NOT_FOUND";
  statusCode = 404;
  errorName = "NotFoundError";
  details?: Record<string, unknown>;

  constructor(message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "NotFoundError";
    if (code) this.code = code;
    if (details) this.details = details;
  }
}

export class ConflictError extends Error implements AppError {
  code = "ALREADY_EXISTS";
  statusCode = 409;
  errorName = "ConflictError";
  details?: Record<string, unknown>;

  constructor(message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ConflictError";
    if (code) this.code = code;
    if (details) this.details = details;
  }
}

export class AuthError extends Error implements AppError {
  code = "AUTHENTICATION_FAILURE";
  statusCode = 403;
  errorName = "AuthenticationError";
  details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AuthError";
    if (details) this.details = details;
  }
}

export class ServerError extends Error implements AppError {
  code = "INTERNAL_ERROR";
  statusCode = 500;
  errorName = "InternalError";
  details?: Record<string, unknown>;

  constructor(message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ServerError";
    if (code) this.code = code;
    if (details) this.details = details;
  }
}

export class AlreadyExistsError extends Error implements AppError {
  code = "ALREADY_EXISTS";
  statusCode = 409;
  errorName = "AlreadyExistsError";
  details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AlreadyExistsError";
    if (details) this.details = details;
  }
}

export class InvalidParameterError extends Error implements AppError {
  code = "INVALID_PARAMETER";
  statusCode = 400;
  errorName = "InvalidParameterError";
  details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "InvalidParameterError";
    if (details) this.details = details;
  }
}

export class LimitExceededError extends Error implements AppError {
  code = "LIMIT_EXCEEDED";
  statusCode = 400;
  errorName = "LimitExceededError";
  details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "LimitExceededError";
    if (details) this.details = details;
  }
}

export class ServiceUnavailableError extends Error implements AppError {
  code = "SERVICE_UNAVAILABLE";
  statusCode = 503;
  errorName = "ServiceUnavailableError";
  details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ServiceUnavailableError";
    if (details) this.details = details;
  }
}

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
// Check for AppError hierarchy instances
// ---------------------------------------------------------------------------

function isAppErrorHierarchy(err: unknown): err is (
  ValidationError | NotFoundError | ConflictError | AuthError | ServerError |
  AlreadyExistsError | InvalidParameterError | LimitExceededError | ServiceUnavailableError
) {
  return (
    err instanceof ValidationError ||
    err instanceof NotFoundError ||
    err instanceof ConflictError ||
    err instanceof AuthError ||
    err instanceof ServerError ||
    err instanceof AlreadyExistsError ||
    err instanceof InvalidParameterError ||
    err instanceof LimitExceededError ||
    err instanceof ServiceUnavailableError
  );
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
// Build structured error response with requestId and timestamp
// ---------------------------------------------------------------------------

function buildErrorResponse(
  errorCode: string,
  errorName: string,
  message: string,
  instanceId: string,
  parameters: Record<string, unknown> = {},
  stack?: string
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    errorCode,
    errorName,
    errorInstanceId: instanceId,
    parameters,
    message,
    timestamp: new Date().toISOString(),
  };

  // Only include stack traces in non-production environments
  if (!IS_PRODUCTION && stack) {
    response.stack = stack;
  }

  return response;
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

  // Attach requestId from the request logger middleware if available
  const requestId = (req as any).requestId || crypto.randomUUID();

  // -----------------------------------------------------------------
  // 1. OntologyError subclasses (Task 15 error hierarchy + Task 20 format)
  // -----------------------------------------------------------------
  if (err instanceof OntologyError) {
    console.error(`[${err.code}] ${err.message} (${err.errorInstanceId}) [requestId=${requestId}]`);
    const response = err.toResponse();
    (response as any).requestId = requestId;
    (response as any).timestamp = new Date().toISOString();
    return void res.status(err.statusCode).json(response);
  }

  // -----------------------------------------------------------------
  // 2. AppError hierarchy classes (Task 15)
  // -----------------------------------------------------------------
  if (isAppErrorHierarchy(err)) {
    const instanceId = crypto.randomUUID();
    console.error(`[${err.code}] ${err.message} (${instanceId}) [requestId=${requestId}]`);
    return void res.status(err.statusCode).json(
      buildErrorResponse(
        err.code,
        err.errorName,
        err.message,
        instanceId,
        err.details || {},
        err.stack
      )
    );
  }

  // -----------------------------------------------------------------
  // 2b. Foundry data ingestion layer AppError (duck-type detection)
  //     These have statusCode (number), code (string), isOperational (boolean)
  //     Check error name to avoid catching third-party errors
  // -----------------------------------------------------------------
  if (
    typeof err === "object" && err !== null &&
    ((err as any).name === "AppError" || (err as any).constructor?.name === "AppError") &&
    typeof (err as any).statusCode === "number" &&
    typeof (err as any).code === "string" &&
    typeof (err as any).isOperational === "boolean"
  ) {
    const fErr = err as { statusCode: number; code: string; message: string; isOperational: boolean };
    const instanceId = crypto.randomUUID();
    console.error(`[${fErr.code}] ${fErr.message} (${instanceId}) [requestId=${requestId}]`);

    // Foundry endpoints return { success: false, error: { code, message } } format
    return void res.status(fErr.statusCode).json({
      success: false,
      error: {
        code: fErr.code,
        message: fErr.message,
        details: null,
      },
    });
  }

  // -----------------------------------------------------------------
  // 2c. JSON parse error (malformed request body from express.json())
  // -----------------------------------------------------------------
  if (
    err instanceof SyntaxError &&
    "type" in err &&
    (err as any).type === "entity.parse.failed"
  ) {
    return void res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Malformed JSON in request body.",
        details: null,
      },
    });
  }

  // -----------------------------------------------------------------
  // 3. Application error with a code matching ERROR_CODES
  //    Convert to standardized format (Task 20)
  // -----------------------------------------------------------------
  if (err.code && ERROR_CODES[err.code] !== undefined) {
    const instanceId = crypto.randomUUID();
    const entry = STANDARD_ERROR_CODES[err.code];
    const httpStatus = entry?.status || ERROR_CODES[err.code] || 500;
    const errorName = entry?.name || "UnknownError";
    console.error(`[${err.code}] ${err.message} (${instanceId}) [requestId=${requestId}]`);
    return void res.status(httpStatus).json(
      buildErrorResponse(
        err.code,
        errorName,
        err.message,
        instanceId,
        err.details || {},
        err.stack
      )
    );
  }

  // -----------------------------------------------------------------
  // 4. OpenSearch client errors (detected by err.meta)
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
      const osErr = new OntologyError(
        "Object type has not been indexed yet.",
        "OBJECT_TYPE_NOT_FOUND"
      );
      const response = osErr.toResponse();
      (response as any).requestId = requestId;
      (response as any).timestamp = new Date().toISOString();
      return void res.status(404).json(response);
    }

    // Document not found
    if (osStatus === 404) {
      const osErr = new OntologyError("Object not found.", "OBJECT_NOT_FOUND");
      const response = osErr.toResponse();
      (response as any).requestId = requestId;
      (response as any).timestamp = new Date().toISOString();
      return void res.status(404).json(response);
    }

    // Bad query
    if (osStatus === 400) {
      console.error("OpenSearch 400 error:", JSON.stringify(osBody?.error));
      const osErr = new OntologyError(
        osBody?.error?.reason || "Invalid OpenSearch query.",
        "QUERY_VALIDATION_ERROR"
      );
      const response = osErr.toResponse();
      (response as any).requestId = requestId;
      (response as any).timestamp = new Date().toISOString();
      return void res.status(400).json(response);
    }

    // Connection refused / timeout
    if (
      err.name === "ConnectionError" ||
      err.name === "TimeoutError" ||
      osStatus === 503
    ) {
      const osErr = new OntologyError(
        "OpenSearch is currently unavailable. Please try again.",
        "OBJECT_DATABASE_UNAVAILABLE"
      );
      const response = osErr.toResponse();
      (response as any).requestId = requestId;
      (response as any).timestamp = new Date().toISOString();
      return void res.status(503).json(response);
    }

    // All other OpenSearch errors
    const osErr = new OntologyError(
      `OpenSearch error (status ${osStatus}).`,
      "OBJECT_DATABASE_UNAVAILABLE"
    );
    const response = osErr.toResponse();
    (response as any).requestId = requestId;
    (response as any).timestamp = new Date().toISOString();
    return void res.status(503).json(response);
  }

  // -----------------------------------------------------------------
  // 5. PostgreSQL error (code is a 5-digit string)
  //    Converted to standardized format (Task 20)
  // -----------------------------------------------------------------
  if (isPostgresError(err)) {
    const pgCode = err.code as string;

    switch (pgCode) {
      case "23505": { // unique_violation
        const pgErr = new OntologyError(
          "A resource with that identifier already exists.",
          "ALREADY_EXISTS"
        );
        const response = pgErr.toResponse();
        (response as any).requestId = requestId;
        (response as any).timestamp = new Date().toISOString();
        return void res.status(409).json(response);
      }

      case "23503": { // foreign_key_violation
        const pgErr = new OntologyError(
          "Referenced resource does not exist.",
          "VALIDATION_FAILED"
        );
        const response = pgErr.toResponse();
        (response as any).requestId = requestId;
        (response as any).timestamp = new Date().toISOString();
        return void res.status(400).json(response);
      }

      case "23502": { // not_null_violation
        const pgErr = new OntologyError(
          "A required field was not provided.",
          "REQUIRED_FIELD_MISSING"
        );
        const response = pgErr.toResponse();
        (response as any).requestId = requestId;
        (response as any).timestamp = new Date().toISOString();
        return void res.status(400).json(response);
      }

      case "23514": { // check_violation
        const pgErr = new OntologyError(
          "A value failed a validation constraint.",
          "VALIDATION_FAILED"
        );
        const response = pgErr.toResponse();
        (response as any).requestId = requestId;
        (response as any).timestamp = new Date().toISOString();
        (response as any).details = { constraint: err.constraint };
        return void res.status(400).json(response);
      }

      case "57014": { // query_canceled (statement_timeout)
        const pgErr = new OntologyError(
          "The query timed out after 30 seconds. Try narrowing your search.",
          "QUERY_TIMEOUT"
        );
        const response = pgErr.toResponse();
        (response as any).requestId = requestId;
        (response as any).timestamp = new Date().toISOString();
        return void res.status(504).json(response);
      }

      case "42P01": { // undefined_table
        console.error("PostgreSQL undefined_table error:", {
          message: err.message,
          stack: IS_PRODUCTION ? undefined : err.stack,
          requestId,
        });
        const pgErr = new OntologyError(
          "Database schema error. Please contact support.",
          "INTERNAL_ERROR"
        );
        const response = pgErr.toResponse();
        (response as any).requestId = requestId;
        (response as any).timestamp = new Date().toISOString();
        return void res.status(500).json(response);
      }

      default: {
        console.error("Unhandled PostgreSQL error:", {
          code: pgCode,
          message: err.message,
          stack: IS_PRODUCTION ? undefined : err.stack,
          requestId,
        });
        const pgErr = new OntologyError(
          "An unexpected database error occurred.",
          "INTERNAL_ERROR"
        );
        const response = pgErr.toResponse();
        (response as any).requestId = requestId;
        (response as any).timestamp = new Date().toISOString();
        return void res.status(500).json(response);
      }
    }
  }

  // -----------------------------------------------------------------
  // 6. All other errors — never expose internals to the client
  // -----------------------------------------------------------------
  const instanceId = crypto.randomUUID();
  console.error(
    `[INTERNAL_ERROR] Unhandled: ${err.message} (${instanceId}) [requestId=${requestId}]`,
    IS_PRODUCTION ? "" : err.stack
  );

  return void res.status(500).json(
    buildErrorResponse(
      "INTERNAL_ERROR",
      "InternalError",
      IS_PRODUCTION
        ? "An internal error occurred. Reference ID: " + instanceId
        : err.message || "An internal error occurred.",
      instanceId,
      {},
      IS_PRODUCTION ? undefined : err.stack
    )
  );
}
