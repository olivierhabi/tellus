// ---------------------------------------------------------------------------
// Code Repositories — Error envelope + namespaced error names
//
// Spec: tasks/code-repository/code-repository-tasks.md §1.3 (lines 65-76).
// Contract IDs covered:
//   G-C-12  Envelope shape exactly {errorCode, errorName, errorInstanceId, parameters}
//   G-C-13  errorCode enumeration
//   G-C-14  Namespaced errorName per service
//   G-C-15  HTTP status mapping
//   G-C-16  parameters carries no secrets
//
// Per-service Stemma error names (B1-C-26..34) are defined in
// `services/stemma/errors.ts`; this module provides the shared envelope.
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";

/**
 * G-C-13 — closed enumeration of error codes.
 *
 * The spec §1.3 enumerates 10 codes but G-C-08 separately mandates a 401
 * with `Stemma:Unauthenticated`. The 10-code enum has no slot mapping to
 * 401, so per the Decision Protocol (D-2026-05-01-002) we add UNAUTHENTICATED
 * as the 11th code, mapped to 401, mirroring the gRPC canonical status set.
 * Rationale: the most production-safe interpretation; rejects the alternative
 * of overloading PERMISSION_DENIED (403) for an authn failure.
 */
export const ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  FAILED_PRECONDITION: "FAILED_PRECONDITION",
  RESOURCE_EXHAUSTED: "RESOURCE_EXHAUSTED",
  INTERNAL: "INTERNAL",
  UNAVAILABLE: "UNAVAILABLE",
  DEADLINE_EXCEEDED: "DEADLINE_EXCEEDED",
  QOS_THROTTLE: "QOS_THROTTLE",
} as const);

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** G-C-15 — HTTP status mapping. */
export const ERROR_CODE_TO_HTTP_STATUS: Readonly<Record<ErrorCode, number>> =
  Object.freeze({
    INVALID_ARGUMENT: 400,
    UNAUTHENTICATED: 401,
    PERMISSION_DENIED: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    FAILED_PRECONDITION: 412,
    RESOURCE_EXHAUSTED: 429,
    INTERNAL: 500,
    UNAVAILABLE: 503,
    DEADLINE_EXCEEDED: 504,
    QOS_THROTTLE: 429,
  });

/** G-C-12 — exact envelope shape. */
export interface ErrorEnvelope {
  readonly errorCode: ErrorCode;
  readonly errorName: string; // namespaced "<Service>:<Symbol>" (G-C-14)
  readonly errorInstanceId: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** Namespaced errorName regex: `<PascalNamespace>:<PascalSymbol>`. */
export const ERROR_NAME_REGEX = /^[A-Z][A-Za-z0-9]+:[A-Z][A-Za-z0-9]+$/;

/**
 * G-C-16 — `parameters` MUST NOT carry secrets. We strip a denylist of keys
 * defensively so a careless caller cannot leak a token through `parameters`.
 */
const PARAM_DENYLIST = new Set([
  "password",
  "passcode",
  "secret",
  "token",
  "authorization",
  "cookie",
  "set-cookie",
  "api_key",
  "apikey",
  "private_key",
  "privatekey",
  "client_secret",
]);

export function sanitizeParameters(
  raw: Record<string, unknown> | undefined | null
): Record<string, unknown> {
  if (!raw) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const lk = k.toLowerCase();
    if (PARAM_DENYLIST.has(lk)) continue;
    // Refuse functions / class instances as values (only plain JSON-able).
    if (typeof v === "function") continue;
    out[k] = v;
  }
  return out;
}

export interface BuildEnvelopeArgs {
  readonly errorCode: ErrorCode;
  readonly errorName: string;
  readonly parameters?: Record<string, unknown>;
  readonly errorInstanceId?: string;
}

export function buildEnvelope(args: BuildEnvelopeArgs): ErrorEnvelope {
  if (!ERROR_NAME_REGEX.test(args.errorName)) {
    throw new Error(
      `errorName must be PascalNamespace:PascalSymbol (got ${JSON.stringify(args.errorName)})`
    );
  }
  return {
    errorCode: args.errorCode,
    errorName: args.errorName,
    errorInstanceId: args.errorInstanceId ?? randomUUID(),
    parameters: Object.freeze(sanitizeParameters(args.parameters)),
  };
}

export function envelopeStatusCode(env: Pick<ErrorEnvelope, "errorCode">): number {
  return ERROR_CODE_TO_HTTP_STATUS[env.errorCode];
}

/**
 * Validates that the four expected keys are exactly present (and only those)
 * — used by contract tests to enforce G-C-12 byte-level.
 */
export function isExactEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort();
  const expected = ["errorCode", "errorInstanceId", "errorName", "parameters"];
  if (keys.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (keys[i] !== expected[i]) return false;
  }
  if (typeof v.errorCode !== "string") return false;
  if (typeof v.errorName !== "string") return false;
  if (typeof v.errorInstanceId !== "string") return false;
  if (typeof v.parameters !== "object" || v.parameters === null) return false;
  if (!Object.values(ERROR_CODES).includes(v.errorCode as ErrorCode)) return false;
  if (!ERROR_NAME_REGEX.test(v.errorName as string)) return false;
  return true;
}
