// B7 — JobSpec error catalog (spec lines 628-632).

import type { ErrorEnvelope } from "../codeRepos/contracts/errors.js";
import { buildEnvelope, ERROR_CODES } from "../codeRepos/contracts/errors.js";

export const JOBSPEC_ERROR_NAMES = [
  // Spec-mandated.
  "JobSpec:OutputAlreadyOwned",
  "JobSpec:CircularDependency",
  "JobSpec:InvalidEntryPoint",
  "JobSpec:DatasetNotFound",
  // Cross-cutting (per §1.3).
  "JobSpec:Unauthenticated",
  "JobSpec:PermissionDenied",
  "JobSpec:InvalidArgument",
  "JobSpec:Internal",
  "JobSpec:ConflictingMutation",
] as const;
export type JobSpecErrorName = (typeof JOBSPEC_ERROR_NAMES)[number];

export const JOBSPEC_ERROR_STATUS: Readonly<
  Record<JobSpecErrorName, { status: number; errorCode: keyof typeof ERROR_CODES }>
> = Object.freeze({
  "JobSpec:OutputAlreadyOwned": { status: 409, errorCode: "CONFLICT" },
  "JobSpec:CircularDependency": { status: 400, errorCode: "INVALID_ARGUMENT" },
  "JobSpec:InvalidEntryPoint": { status: 400, errorCode: "INVALID_ARGUMENT" },
  "JobSpec:DatasetNotFound": { status: 404, errorCode: "NOT_FOUND" },
  "JobSpec:Unauthenticated": { status: 401, errorCode: "UNAUTHENTICATED" },
  "JobSpec:PermissionDenied": { status: 403, errorCode: "PERMISSION_DENIED" },
  "JobSpec:InvalidArgument": { status: 400, errorCode: "INVALID_ARGUMENT" },
  "JobSpec:Internal": { status: 500, errorCode: "INTERNAL" },
  "JobSpec:ConflictingMutation": { status: 409, errorCode: "CONFLICT" },
});

export interface JobSpecError {
  readonly status: number;
  readonly envelope: ErrorEnvelope;
}

export function jobSpecError(
  name: JobSpecErrorName,
  parameters: Record<string, unknown> = {},
  errorInstanceId?: string,
): JobSpecError {
  const spec = JOBSPEC_ERROR_STATUS[name];
  const envelope = buildEnvelope({
    errorCode: spec.errorCode,
    errorName: name,
    parameters,
    errorInstanceId,
  });
  return { status: spec.status, envelope };
}

export function isJobSpecErrorName(value: string): value is JobSpecErrorName {
  return (JOBSPEC_ERROR_NAMES as readonly string[]).includes(value);
}
