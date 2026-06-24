// ---------------------------------------------------------------------------
// B1 — Stemma error names + factory functions
//
// Spec: tasks/code-repository/code-repository-tasks.md:201-209.
// Contract IDs: B1-C-26..34.
//
// Each factory returns a typed ErrorEnvelope; route layer maps via
// envelopeStatusCode() to HTTP status. The `errorName` namespace `Stemma:`
// is part of the contract — renaming any symbol below is a breaking change.
// ---------------------------------------------------------------------------

import {
  buildEnvelope,
  ERROR_CODES,
  type ErrorEnvelope,
  type ErrorCode,
} from "../codeRepos/contracts/errors";

export const STEMMA_ERROR_NAMES = Object.freeze({
  RepositoryNotFound: "Stemma:RepositoryNotFound",
  RefNotFound: "Stemma:RefNotFound",
  RefUpdateRejected: "Stemma:RefUpdateRejected",
  ProtectedBranchViolation: "Stemma:ProtectedBranchViolation",
  RepositorySizeExceeded: "Stemma:RepositorySizeExceeded",
  PushBodyTooLarge: "Stemma:PushBodyTooLarge",
  InvalidPackfile: "Stemma:InvalidPackfile",
  GcInProgress: "Stemma:GcInProgress",
  HookTimeout: "Stemma:HookTimeout",
  StaleEtag: "Stemma:StaleEtag",
  IdempotencyConflict: "Stemma:IdempotencyConflict",
} as const);

/** Mapping from each Stemma errorName to (errorCode, status) per spec §1.3. */
export const STEMMA_ERROR_CODE_MAP: Readonly<
  Record<string, { errorCode: ErrorCode; status: number }>
> = Object.freeze({
  [STEMMA_ERROR_NAMES.RepositoryNotFound]: { errorCode: ERROR_CODES.NOT_FOUND, status: 404 },
  [STEMMA_ERROR_NAMES.RefNotFound]: { errorCode: ERROR_CODES.NOT_FOUND, status: 404 },
  [STEMMA_ERROR_NAMES.RefUpdateRejected]: { errorCode: ERROR_CODES.CONFLICT, status: 409 },
  [STEMMA_ERROR_NAMES.ProtectedBranchViolation]: {
    errorCode: ERROR_CODES.PERMISSION_DENIED,
    status: 403,
  },
  [STEMMA_ERROR_NAMES.RepositorySizeExceeded]: {
    // 413 is "Payload Too Large" — closest Conjure code is INVALID_ARGUMENT.
    // Spec line 206 explicitly states 413; we honour the HTTP status here
    // and emit the codest INVALID_ARGUMENT envelope. This matches existing
    // Foundry conventions where 413 is delivered as INVALID_ARGUMENT.
    errorCode: ERROR_CODES.INVALID_ARGUMENT,
    status: 413,
  },
  [STEMMA_ERROR_NAMES.PushBodyTooLarge]: {
    errorCode: ERROR_CODES.INVALID_ARGUMENT,
    status: 413,
  },
  [STEMMA_ERROR_NAMES.InvalidPackfile]: { errorCode: ERROR_CODES.INVALID_ARGUMENT, status: 400 },
  [STEMMA_ERROR_NAMES.GcInProgress]: { errorCode: ERROR_CODES.UNAVAILABLE, status: 503 },
  [STEMMA_ERROR_NAMES.HookTimeout]: { errorCode: ERROR_CODES.DEADLINE_EXCEEDED, status: 504 },
  [STEMMA_ERROR_NAMES.StaleEtag]: { errorCode: ERROR_CODES.FAILED_PRECONDITION, status: 412 },
  [STEMMA_ERROR_NAMES.IdempotencyConflict]: { errorCode: ERROR_CODES.CONFLICT, status: 409 },
});

/** Build a Stemma-namespaced error envelope by errorName + parameters. */
export function stemmaError(
  name: keyof typeof STEMMA_ERROR_NAMES,
  parameters?: Record<string, unknown>
): { envelope: ErrorEnvelope; status: number } {
  const errorName = STEMMA_ERROR_NAMES[name];
  const mapping = STEMMA_ERROR_CODE_MAP[errorName];
  if (!mapping) {
    throw new Error(`stemmaError: unmapped errorName ${errorName}`);
  }
  return {
    envelope: buildEnvelope({
      errorCode: mapping.errorCode,
      errorName,
      parameters,
    }),
    status: mapping.status,
  };
}
