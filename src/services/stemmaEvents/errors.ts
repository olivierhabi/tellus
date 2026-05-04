// ---------------------------------------------------------------------------
// B10 — BranchProtection error names + envelope helpers.
//
// Spec contracts:
//   B10-C-16  BranchProtection:DeleteProtected (403)
//   B10-C-17  BranchProtection:ForcePushProtected (403)
//   B10-C-18  BranchProtection:RequiresPullRequest (403)
//   B10-C-19  BranchProtection:InsufficientApprovals (403)
//   B10-C-20  BranchProtection:RegexViolation (400)
//   plus     BranchProtection:TagImmutable (403) for B10-C-09 — the spec
//            mandates the rejection but doesn't pre-name it; we mint
//            following the family naming convention (D-2026-05-01-004).
//
// Each name is bound to its HTTP status here so the route layer cannot
// accidentally emit a wrong status. Pinned by unit tests.
// ---------------------------------------------------------------------------

import {
  buildEnvelope,
  ERROR_CODES,
  type ErrorEnvelope,
} from "../codeRepos/contracts/errors";

export type BranchProtectionErrorName =
  | "BranchProtection:DeleteProtected"
  | "BranchProtection:ForcePushProtected"
  | "BranchProtection:RequiresPullRequest"
  | "BranchProtection:InsufficientApprovals"
  | "BranchProtection:RegexViolation"
  | "BranchProtection:TagImmutable";

/**
 * Static mapping. Every BranchProtection name is exhaustively listed
 * with its HTTP status and the matching errorCode from §1.3 (incl. the
 * D-2026-05-01-002 UNAUTHENTICATED extension — though no BranchProtection
 * error maps to 401, we include it for reference completeness).
 */
export const BRANCH_PROTECTION_STATUS: Readonly<
  Record<BranchProtectionErrorName, { httpStatus: 400 | 403; errorCode: string }>
> = Object.freeze({
  "BranchProtection:DeleteProtected": {
    httpStatus: 403,
    errorCode: ERROR_CODES.PERMISSION_DENIED,
  },
  "BranchProtection:ForcePushProtected": {
    httpStatus: 403,
    errorCode: ERROR_CODES.PERMISSION_DENIED,
  },
  "BranchProtection:RequiresPullRequest": {
    httpStatus: 403,
    errorCode: ERROR_CODES.PERMISSION_DENIED,
  },
  "BranchProtection:InsufficientApprovals": {
    httpStatus: 403,
    errorCode: ERROR_CODES.PERMISSION_DENIED,
  },
  "BranchProtection:RegexViolation": {
    httpStatus: 400,
    errorCode: ERROR_CODES.INVALID_ARGUMENT,
  },
  "BranchProtection:TagImmutable": {
    httpStatus: 403,
    errorCode: ERROR_CODES.PERMISSION_DENIED,
  },
});

export interface BranchProtectionEnvelope {
  readonly envelope: ErrorEnvelope;
  readonly httpStatus: 400 | 403;
}

/**
 * Build the envelope + HTTP status for a BranchProtection error. The
 * caller writes `res.status(out.httpStatus).json(out.envelope)`. Codes
 * are looked up from the table; an unknown name throws (the table is
 * exhaustive by construction so this is a programming error).
 */
export function branchProtectionError(
  name: BranchProtectionErrorName,
  parameters: Record<string, unknown>,
): BranchProtectionEnvelope {
  const meta = BRANCH_PROTECTION_STATUS[name];
  if (!meta) {
    throw new Error(`Unknown BranchProtection error name: ${name}`);
  }
  return {
    envelope: buildEnvelope({
      errorCode: meta.errorCode as ErrorEnvelope["errorCode"],
      errorName: name,
      parameters,
    }),
    httpStatus: meta.httpStatus,
  };
}
