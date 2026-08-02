// ---------------------------------------------------------------------------
// executionPolicy.ts — operator controls for Function execution.
//
// Two production controls live here so routes, executors, and tests share a
// single source of truth:
//
// 1) PUBLISH TRUST GATE (execution security boundary, Phase: trust mode)
//    The current executor (worker_threads + `vm`, see functionExecutor.ts)
//    is NOT a security boundary for untrusted code. Until container/microVM
//    isolation lands (follow-up spec: docs/operations/), executable
//    Functions may only be published by explicitly trusted authors.
//
//      FUNCTION_EXECUTION_TRUST_MODE
//        "trusted-authors-only" (DEFAULT, also when unset)
//          Publishing executable Functions requires the caller's identity in
//          FUNCTION_TRUSTED_AUTHOR_IDS. An empty allowlist means NOBODY can
//          publish — fail closed, never open.
//        "open-development"
//          Explicit opt-out for development stacks ONLY. Refused in
//          production (NODE_ENV=production falls back to
//          trusted-authors-only and logs) so a misconfigured prod deploy can
//          never silently open publication.
//
//      FUNCTION_TRUSTED_AUTHOR_IDS
//        Comma/space-separated principal user ids (Keycloak subject or the
//        identity string bound to the request) permitted to publish.
//
// 2) LEGACY CONTRACT DEPRECATION (operational migration control)
//      FUNCTION_LEGACY_CONTRACT_DISABLED=true
//        Fail-closed switch: any execution resolved to the
//        legacy-object-envelope-v1 contract is rejected with the stable
//        error code FUNCTION_LEGACY_CONTRACT_DISABLED. Default false while
//        legacy artifacts still exist — flip only after the migration
//        status endpoint reports zero legacy executions of consequence.
//      FUNCTION_LEGACY_CONTRACT_DEPRECATION_DATE=YYYY-MM-DD
//        Operator-communicated sunset date, surfaced in the admin status
//        endpoint, activation warnings, and structured logs. Informational
//        only; enforcement is the disabled flag above.
//
// Neither setting ever changes WHICH artifact executes — only whether
// publication/execution is admitted.
// ---------------------------------------------------------------------------

export type FunctionExecutionTrustMode =
  | "trusted-authors-only"
  | "open-development";

export interface ExecutionPolicy {
  readonly trustMode: FunctionExecutionTrustMode;
  /** Parsed author allowlist; empty set = deny all new publishes. */
  readonly trustedAuthorIds: ReadonlySet<string>;
  /** Fail-closed kill switch for legacy-contract executions. */
  readonly legacyContractDisabled: boolean;
  /** Informational operator sunset date (ISO YYYY-MM-DD) or null. */
  readonly legacyDeprecationDate: string | null;
}

function parseAuthorAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

/**
 * Read the current execution policy from the environment. Read on every
 * call (not cached) so deploy-time env changes and tests apply without a
 * module reload — the same laziness convention as the worker pool.
 */
export function executionPolicy(): ExecutionPolicy {
  const rawMode = (process.env.FUNCTION_EXECUTION_TRUST_MODE ?? "")
    .trim()
    .toLowerCase();
  let trustMode: FunctionExecutionTrustMode;
  if (rawMode === "open-development") {
    // Never honor an open mode in production; fail back to the default and
    // make the refusal visible (this log is reachable from every caller's
    // first policy read after boot).
    if (process.env.NODE_ENV === "production") {
      console.warn(
        JSON.stringify({
          type: "functions.execution_policy.open_mode_refused",
          requested: rawMode,
          effective: "trusted-authors-only",
          reason:
            "FUNCTION_EXECUTION_TRUST_MODE=open-development is refused in production (NODE_ENV=production).",
        }),
      );
      trustMode = "trusted-authors-only";
    } else {
      trustMode = "open-development";
    }
  } else {
    trustMode = "trusted-authors-only";
  }
  const deprecationRaw = (
    process.env.FUNCTION_LEGACY_CONTRACT_DEPRECATION_DATE ?? ""
  ).trim();
  const legacyDeprecationDate = /^\d{4}-\d{2}-\d{2}$/.test(deprecationRaw)
    ? deprecationRaw
    : null;
  return {
    trustMode,
    trustedAuthorIds: parseAuthorAllowlist(
      process.env.FUNCTION_TRUSTED_AUTHOR_IDS,
    ),
    legacyContractDisabled:
      (process.env.FUNCTION_LEGACY_CONTRACT_DISABLED ?? "")
        .trim()
        .toLowerCase() === "true",
    legacyDeprecationDate,
  };
}

/**
 * Admit or deny a Function publication for `authorId` under the current
 * trust mode. Pure with respect to the policy argument for testability;
 * route/service callers pass executionPolicy().
 */
export function isPublishAuthorTrusted(
  authorId: string | null | undefined,
  policy: ExecutionPolicy = executionPolicy(),
): boolean {
  if (policy.trustMode === "open-development") return true;
  if (!authorId) return false;
  return policy.trustedAuthorIds.has(authorId);
}

/**
 * Whether a legacy-contract (legacy-object-envelope-v1) execution is
 * currently permitted. Positional v2 executions are NEVER affected.
 */
export function isLegacyContractExecutionAllowed(
  policy: ExecutionPolicy = executionPolicy(),
): boolean {
  return !policy.legacyContractDisabled;
}

export interface LegacyStatusSummary {
  readonly legacyContractDisabled: boolean;
  readonly legacyDeprecationDate: string | null;
  readonly trustMode: FunctionExecutionTrustMode;
}
