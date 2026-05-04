// B3 — Templates error catalog (spec lines 370-373).
//
// 3 spec-mandated names + 4 cross-cutting (auth, idempotency, ETag, internal).

import type { ErrorEnvelope } from "../codeRepos/contracts/errors.js";
import { buildEnvelope, ERROR_CODES } from "../codeRepos/contracts/errors.js";

export const TEMPLATES_ERROR_NAMES = [
  // Spec-mandated.
  "Templates:NotFound",
  "Templates:VersionDeprecated",
  "Templates:ParameterValidationFailed",
  // Cross-cutting (per §1.3).
  "Templates:Unauthenticated",
  "Templates:PermissionDenied",
  "Templates:InvalidArgument",
  "Templates:Internal",
] as const;
export type TemplatesErrorName = (typeof TEMPLATES_ERROR_NAMES)[number];

export const TEMPLATES_ERROR_STATUS: Readonly<
  Record<TemplatesErrorName, { status: number; errorCode: keyof typeof ERROR_CODES }>
> = Object.freeze({
  "Templates:NotFound": { status: 404, errorCode: "NOT_FOUND" },
  "Templates:VersionDeprecated": { status: 410, errorCode: "FAILED_PRECONDITION" },
  "Templates:ParameterValidationFailed": { status: 400, errorCode: "INVALID_ARGUMENT" },
  "Templates:Unauthenticated": { status: 401, errorCode: "UNAUTHENTICATED" },
  "Templates:PermissionDenied": { status: 403, errorCode: "PERMISSION_DENIED" },
  "Templates:InvalidArgument": { status: 400, errorCode: "INVALID_ARGUMENT" },
  "Templates:Internal": { status: 500, errorCode: "INTERNAL" },
});

export interface TemplatesError {
  readonly status: number;
  readonly envelope: ErrorEnvelope;
}

export function templatesError(
  name: TemplatesErrorName,
  parameters: Record<string, unknown> = {},
  errorInstanceId?: string,
): TemplatesError {
  const spec = TEMPLATES_ERROR_STATUS[name];
  const envelope = buildEnvelope({
    errorCode: spec.errorCode,
    errorName: name,
    parameters,
    errorInstanceId,
  });
  return { status: spec.status, envelope };
}

export function isTemplatesErrorName(value: string): value is TemplatesErrorName {
  return (TEMPLATES_ERROR_NAMES as readonly string[]).includes(value);
}
