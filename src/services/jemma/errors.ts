// ---------------------------------------------------------------------------
// B6 — Jemma error catalog.
//
// Spec §B6 enumerates 5 error names. Each maps to a precise HTTP status and
// errorCode per §1.3. Envelopes built via the shared CodeRepos buildEnvelope
// for consistency across services.
// ---------------------------------------------------------------------------

import {
  ERROR_CODES,
  buildEnvelope,
  type ErrorCode,
  type ErrorEnvelope,
} from "../codeRepos/contracts/errors";

/**
 * Jemma error names per spec §B6.
 *
 * - `Jemma:RunNotFound`            → 404 NOT_FOUND
 * - `Jemma:RunAlreadyTerminal`     → 409 CONFLICT
 * - `Jemma:CapacityExceeded`       → 429 RATE_LIMIT_EXCEEDED
 * - `Jemma:WorkerImageUnavailable` → 503 UNAVAILABLE
 * - `Jemma:StageFailed`            → 500 INTERNAL  (returned in run.state=FAILED;
 *                                                   the HTTP status is irrelevant
 *                                                   for that case but exposed here
 *                                                   for synchronous callers.)
 */
export const JEMMA_ERROR_NAMES = [
  "Jemma:RunNotFound",
  "Jemma:RunAlreadyTerminal",
  "Jemma:CapacityExceeded",
  "Jemma:WorkerImageUnavailable",
  "Jemma:StageFailed",
] as const;

export type JemmaErrorName = (typeof JEMMA_ERROR_NAMES)[number];

interface JemmaErrorSpec {
  readonly status: number;
  readonly errorCode: ErrorCode;
}

const JEMMA_ERROR_TABLE: Record<JemmaErrorName, JemmaErrorSpec> = {
  "Jemma:RunNotFound":           { status: 404, errorCode: ERROR_CODES.NOT_FOUND },
  "Jemma:RunAlreadyTerminal":    { status: 409, errorCode: ERROR_CODES.CONFLICT },
  "Jemma:CapacityExceeded":      { status: 429, errorCode: ERROR_CODES.RESOURCE_EXHAUSTED },
  "Jemma:WorkerImageUnavailable":{ status: 503, errorCode: ERROR_CODES.UNAVAILABLE },
  "Jemma:StageFailed":           { status: 500, errorCode: ERROR_CODES.INTERNAL },
};

/**
 * Build a Jemma error envelope.
 *
 * @returns `{ status, envelope }` where `envelope` conforms to §1.3 (exactly
 * 4 keys: errorCode, errorName, errorInstanceId, parameters).
 */
export function jemmaError(
  name: JemmaErrorName,
  parameters: Record<string, unknown> = {},
  errorInstanceId?: string,
): { status: number; envelope: ErrorEnvelope } {
  const spec = JEMMA_ERROR_TABLE[name];
  const envelope = buildEnvelope({
    errorCode: spec.errorCode,
    errorName: name,
    parameters,
    errorInstanceId,
  });
  return { status: spec.status, envelope };
}

export function isJemmaErrorName(s: string): s is JemmaErrorName {
  return (JEMMA_ERROR_NAMES as readonly string[]).includes(s);
}
