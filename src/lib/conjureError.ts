// ---------------------------------------------------------------------------
// Conjure error envelope — Foundry-faithful error shape for /api/v2 endpoints.
// ---------------------------------------------------------------------------
// Contracts: tasks/files-projects/contracts.md (B3-C-50, B3-C-51).
//
// Shape:
//   {
//     "errorCode":      "<UPPER_SNAKE_CASE>",
//     "errorName":      "<PascalCaseError>",
//     "errorInstanceId":"<uuidv4>",
//     "parameters":     { ... }   // optional, machine-actionable details
//   }
//
// `errorInstanceId` is logged with the request span so that operators can
// correlate a client-visible error code back to an exact request id and
// stack trace.
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { OntologyError, STANDARD_ERROR_CODES } from "../utils/queryErrors";

export interface ConjureErrorBody {
  errorCode: string;
  errorName: string;
  errorInstanceId: string;
  parameters?: Record<string, unknown>;
}

/** Build a Conjure error body from an OntologyError or generic message. */
export function buildConjureError(
  errorCode: string,
  message: string,
  parameters?: Record<string, unknown>,
): ConjureErrorBody {
  const reg = STANDARD_ERROR_CODES[errorCode] ?? { status: 500, name: "InternalError" };
  return {
    errorCode,
    errorName: reg.name,
    errorInstanceId: randomUUID(),
    // Conjure shape carries `message` inside `parameters._message` because the
    // top-level Conjure body is not allowed a `message` field. Foundry's
    // OSDK Python client surfaces it via `error.parameters._message`.
    parameters: { _message: message, ...(parameters ?? {}) },
  };
}

/**
 * Express error-handler that converts OntologyError instances into Conjure
 * envelopes. Mounted by the v2 router stack, runs *before* the global
 * application error handler so v2 endpoints get the public Foundry shape
 * while v1 endpoints keep their existing error shape.
 */
export function conjureErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof OntologyError) {
    const body = buildConjureError(err.code, err.message, err.parameters);
    body.errorInstanceId = err.errorInstanceId;
    res.status(err.statusCode).json(body);
    return;
  }
  // Unknown — wrap as INTERNAL.
  const body = buildConjureError(
    "INTERNAL",
    err instanceof Error ? err.message : String(err),
    {},
  );
  res.status(500).json(body);
}
