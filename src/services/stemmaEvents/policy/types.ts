// ---------------------------------------------------------------------------
// B10 — Stemma Events / Branch Protection — pre-receive types.
//
// Spec contracts: B10-C-02 payload shape, B10-C-04..10 ordered checks.
//
// These types are the input/output of the pure-logic preReceiveDecision
// function. The HTTP boundary lives elsewhere; this module is library
// code with no I/O so it can be exhaustively unit-tested without DB.
// ---------------------------------------------------------------------------

/** B10-C-02 — exact ref-update record from Stemma's pre-receive payload. */
export interface RefUpdate {
  readonly ref: string;
  readonly oldSha: string;
  readonly newSha: string;
  readonly isCreate: boolean;
  readonly isDelete: boolean;
  readonly isForce: boolean;
}

/** Subset of repository settings needed for pre-receive enforcement.
 *  Mirrors the schema in B2 but only the fields B10 actually reads. */
export interface RepoSettingsSnapshot {
  /** Regex (string form) that branch names must match. From B2.repoSettings.json. */
  readonly branchNameValidation: string;
  /** Regex (string form) that tag names must match. */
  readonly tagNameValidation: string;
  /** Branch globs that are protected (e.g. ["main", "release/*"]). */
  readonly protectedBranches: readonly string[];
  /** When true, direct push (no PR) to a protected branch is denied. */
  readonly requirePullRequest: boolean;
}

/** Subset of principal info the policy needs. Roles drive the OWNER
 *  override that lets tag mutations land. */
export interface PrincipalSnapshot {
  readonly userId: string;
  readonly roles: readonly string[];
}

/** B10-C-04..10 — discriminated decision union. ALLOW means the ref-update
 *  passes; DENY carries the namespaced errorName Stemma must surface. */
export type Decision =
  | { readonly kind: "allow"; readonly ref: string }
  | {
      readonly kind: "deny";
      readonly ref: string;
      readonly errorName: BranchProtectionErrorName | "Compass:PermissionDenied";
      readonly httpStatus: 400 | 403;
      readonly parameters: Readonly<Record<string, unknown>>;
    };

export type BranchProtectionErrorName =
  | "BranchProtection:RegexViolation"
  | "BranchProtection:DeleteProtected"
  | "BranchProtection:ForcePushProtected"
  | "BranchProtection:RequiresPullRequest"
  | "BranchProtection:InsufficientApprovals"
  | "BranchProtection:TagImmutable";

/** Push context — additional knobs Stemma passes alongside the per-ref updates. */
export interface PushContext {
  readonly repositoryRid: string;
  readonly principal: PrincipalSnapshot;
  readonly settings: RepoSettingsSnapshot;
  /** B10-C-08 — true when this push originates from a PR merge. Direct
   *  pushes (false) are subject to the requirePullRequest guard. */
  readonly viaPullRequest: boolean;
  /** Optional Compass policy hook. When omitted, the policy treats
   *  Compass as ALLOW (the real implementation always supplies one). */
  readonly canActAsEditor?: () => boolean | Promise<boolean>;
}
