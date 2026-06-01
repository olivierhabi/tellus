// ---------------------------------------------------------------------------
// Conjure-style error envelope.
// Spec §19: every 4xx/5xx returns { errorCode, errorName, errorInstanceId, parameters }.
// errorName matches Tellus:<Service>:<PascalCase>.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { ErrorDefinition } from "./registry";

export interface ErrorEnvelope {
  /** HTTP-equivalent code expressed as Conjure's coarse category. */
  errorCode: string;
  /** Stable Tellus identifier (Tellus:Service:Name). */
  errorName: string;
  /** Server-generated UUID for log-correlation. */
  errorInstanceId: string;
  /** Operator-visible structured fields (NEVER include credentials). */
  parameters: Record<string, unknown>;
}

/** Convert an ErrorDefinition + parameters into the wire envelope. */
export function buildEnvelope(
  def: ErrorDefinition,
  parameters: Record<string, unknown> = {},
  errorInstanceId: string = randomUUID(),
): ErrorEnvelope {
  return {
    errorCode: def.errorCode,
    errorName: def.errorName,
    errorInstanceId,
    parameters: sanitizeParameters(parameters),
  };
}

/** Send the envelope on an Express response with the registered HTTP status. */
export function sendEnvelope(
  res: Response,
  def: ErrorDefinition,
  parameters: Record<string, unknown> = {},
): void {
  const envelope = buildEnvelope(def, parameters);
  res.status(def.httpStatus).json(envelope);
}

/**
 * Strip values that look like credentials before emitting.
 * Defense-in-depth — handlers must not pass them in the first place,
 * but this catches mistakes (cf. B2 in-session criterion 1).
 */
const SECRET_KEY_PATTERN = /(password|passphrase|secret|token|api[_-]?key|kek|dek|ciphertext)/i;

function sanitizeParameters(p: Record<string, unknown>): Record<string, unknown> {
  return sanitizeForLog(p) as Record<string, unknown>;
}

/**
 * Recursive credential-shaped key redaction. Exported for use by logging
 * call sites (test.handler.ts etc.) that emit structured records derived
 * from request bodies. Returns a new object; the input is unmodified.
 */
export function sanitizeForLog(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeForLog(v));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = sanitizeForLog(v);
      }
    }
    return out;
  }
  return value;
}

/** Typed error subclass with attached definition and parameters. */
export class TellusError extends Error {
  readonly definition: ErrorDefinition;
  readonly parameters: Record<string, unknown>;
  readonly errorInstanceId: string;

  constructor(
    definition: ErrorDefinition,
    parameters: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(`${definition.errorName}: ${definition.description}`);
    this.name = "TellusError";
    this.definition = definition;
    this.parameters = parameters;
    this.errorInstanceId = randomUUID();
    if (cause !== undefined) {
      (this as unknown as { cause: unknown }).cause = cause;
    }
  }

  toEnvelope(): ErrorEnvelope {
    return buildEnvelope(this.definition, this.parameters, this.errorInstanceId);
  }

  send(res: Response): void {
    res.status(this.definition.httpStatus).json(this.toEnvelope());
  }
}
