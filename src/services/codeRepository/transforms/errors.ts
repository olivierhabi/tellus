// ===========================================================================
// Transform build error catalog — §1.3 envelope, mirrors jobSpec/errors.ts.
// ===========================================================================
import type { ErrorEnvelope } from "../../codeRepos/contracts/errors.js";
import { buildEnvelope, ERROR_CODES } from "../../codeRepos/contracts/errors.js";

export const TRANSFORM_ERROR_NAMES = [
  "Transform:NoTransformsToBuild",
  "Transform:InvalidTransform",
  "Transform:CircularDependency",
  "Transform:InputDatasetNotFound",
  "Transform:RepositoryNotFound",
  "Transform:BranchNotFound",
  "Transform:BuildNotFound",
  "Transform:DatasetNotFound",
  "Transform:BuildFailed",
  "Transform:Unauthenticated",
  "Transform:PermissionDenied",
  "Transform:InvalidArgument",
  "Transform:Internal",
] as const;
export type TransformErrorName = (typeof TRANSFORM_ERROR_NAMES)[number];

const STATUS: Readonly<
  Record<TransformErrorName, keyof typeof ERROR_CODES>
> = Object.freeze({
  "Transform:NoTransformsToBuild": "INVALID_ARGUMENT",
  "Transform:InvalidTransform": "INVALID_ARGUMENT",
  "Transform:CircularDependency": "INVALID_ARGUMENT",
  "Transform:InputDatasetNotFound": "NOT_FOUND",
  "Transform:RepositoryNotFound": "NOT_FOUND",
  "Transform:BranchNotFound": "NOT_FOUND",
  "Transform:BuildNotFound": "NOT_FOUND",
  "Transform:DatasetNotFound": "NOT_FOUND",
  "Transform:BuildFailed": "INTERNAL",
  "Transform:Unauthenticated": "UNAUTHENTICATED",
  "Transform:PermissionDenied": "PERMISSION_DENIED",
  "Transform:InvalidArgument": "INVALID_ARGUMENT",
  "Transform:Internal": "INTERNAL",
});

const HTTP: Readonly<Record<keyof typeof ERROR_CODES, number>> = Object.freeze({
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

export interface TransformError {
  readonly status: number;
  readonly envelope: ErrorEnvelope;
}

export function transformError(
  name: TransformErrorName,
  parameters: Record<string, unknown> = {},
  errorInstanceId?: string,
): TransformError {
  const codeKey = STATUS[name];
  return {
    status: HTTP[codeKey],
    envelope: buildEnvelope({
      errorCode: ERROR_CODES[codeKey],
      errorName: name,
      parameters,
      errorInstanceId,
    }),
  };
}
