// ---------------------------------------------------------------------------
// B8 — Functions Registry error catalog.
//
// Spec §B8 enumerates 5 error names. Each maps to a precise HTTP status and
// errorCode per §1.3.
// ---------------------------------------------------------------------------

import {
  ERROR_CODES,
  buildEnvelope,
  type ErrorCode,
  type ErrorEnvelope,
} from "../codeRepos/contracts/errors";

/**
 * Functions Registry error names per spec §B8.
 *
 * - `Functions:VersionImmutable`        → 409 CONFLICT
 * - `Functions:VersionNotFound`         → 404 NOT_FOUND
 * - `Functions:VersionTargetUnsatisfied`→ 404 NOT_FOUND
 * - `Functions:RepositoryNotPublishable`→ 412 FAILED_PRECONDITION
 * - `Functions:ArtifactCorrupt`         → 400 INVALID_ARGUMENT
 */
export const FUNCTIONS_ERROR_NAMES = [
  "Functions:VersionImmutable",
  "Functions:VersionNotFound",
  "Functions:VersionTargetUnsatisfied",
  "Functions:RepositoryNotPublishable",
  "Functions:ArtifactCorrupt",
  "Functions:InvalidArgument",
  "Functions:Unauthenticated",
  "Functions:PermissionDenied",
  "Functions:Internal",
  "Functions:GrantConflict",
  "Functions:GrantNotFound",
] as const;

export type FunctionsErrorName = (typeof FUNCTIONS_ERROR_NAMES)[number];

interface FunctionsErrorSpec {
  readonly status: number;
  readonly errorCode: ErrorCode;
}

const FUNCTIONS_ERROR_TABLE: Record<FunctionsErrorName, FunctionsErrorSpec> = {
  "Functions:VersionImmutable":         { status: 409, errorCode: ERROR_CODES.CONFLICT },
  "Functions:VersionNotFound":          { status: 404, errorCode: ERROR_CODES.NOT_FOUND },
  "Functions:VersionTargetUnsatisfied": { status: 404, errorCode: ERROR_CODES.NOT_FOUND },
  "Functions:RepositoryNotPublishable": { status: 412, errorCode: ERROR_CODES.FAILED_PRECONDITION },
  "Functions:ArtifactCorrupt":          { status: 400, errorCode: ERROR_CODES.INVALID_ARGUMENT },
  "Functions:InvalidArgument":          { status: 400, errorCode: ERROR_CODES.INVALID_ARGUMENT },
  "Functions:Unauthenticated":          { status: 401, errorCode: ERROR_CODES.UNAUTHENTICATED },
  "Functions:PermissionDenied":      { status: 403, errorCode: ERROR_CODES.PERMISSION_DENIED },
  "Functions:Internal":              { status: 500, errorCode: ERROR_CODES.INTERNAL },
  "Functions:GrantConflict":         { status: 409, errorCode: ERROR_CODES.CONFLICT },
  "Functions:GrantNotFound":         { status: 404, errorCode: ERROR_CODES.NOT_FOUND },
};

export interface FunctionsError {
  readonly status: number;
  readonly envelope: ErrorEnvelope;
}

export function functionsError(
  name: FunctionsErrorName,
  parameters: Record<string, unknown> = {},
  errorInstanceId?: string,
): FunctionsError {
  const spec = FUNCTIONS_ERROR_TABLE[name];
  const envelope = buildEnvelope({
    errorCode: spec.errorCode,
    errorName: name,
    parameters,
    errorInstanceId,
  });
  return { status: spec.status, envelope };
}

export function isFunctionsErrorName(s: string): s is FunctionsErrorName {
  return (FUNCTIONS_ERROR_NAMES as readonly string[]).includes(s);
}
