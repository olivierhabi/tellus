// ---------------------------------------------------------------------------
// executionPolicy.ts — operator controls for Function execution.
//
// Two production controls live here so routes, executors, and tests share a
// single source of truth:
//
// 1) PUBLISH AUTHORIZATION (execution security boundary, Phase: trust mode)
//    The current executor (worker_threads + `vm`, see functionExecutor.ts)
//    is NOT a security boundary for untrusted code. Until container/microVM
//    isolation lands (follow-up spec: docs/operations/), executable
//    Functions may only be published by explicitly authorized authors.
//
//    TODO(TELLUS-XXXX): this authorization layer is a STOPGAP. Once the
//    executor gains real isolation (Firecracker/gVisor/locked-down
//    containers) the publish gate should be replaced by ordinary RBAC on
//    repository writes, and untrusted-but-sandboxed publication re-opened.
//
//    authorizePublish() admits a publication through, in order:
//
//      a. KEYCLOAK ROLE — the caller's token carries the publish role
//         (FUNCTION_PUBLISH_ROLE, default "function:publish"). Roles grant
//         GLOBAL publish rights; per-repository scoping lives in DB grants.
//      b. DB GRANT — an active (non-revoked, non-expired) row in
//         function_publish_grants matching the caller's local users.id or
//         Keycloak sub, scoped `global` or to the target repository RID.
//         Managed via /api/v1/functions/admin/function-publish-grants.
//      c. LEGACY ENV ALLOWLIST — FUNCTION_TRUSTED_AUTHOR_IDS still works as
//         a migration fallback. DEPRECATED: a once-per-process warning is
//         logged and every admission is audited with decision_source
//         "env_allowlist". Migrate with scripts/import-function-trusted-authors.ts
//         and then unset the variable. An empty allowlist admits NOBODY.
//      d. OPEN-DEVELOPMENT — FUNCTION_EXECUTION_TRUST_MODE=open-development
//         opts out entirely for development stacks ONLY. Refused in
//         production (NODE_ENV=production falls back to
//         trusted-authors-only and logs) so a misconfigured prod deploy can
//         never silently open publication.
//
//      Anything else: DENY. Fail closed on every ambiguous path, including
//      database unavailability.
//
//    EVERY decision (allow AND deny) is persisted to
//    function_publish_audit_log. Publication is security-sensitive: if the
//    audit write for an ALLOW fails, the decision is flipped to deny —
//    an unaudited publication is not permitted.
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

import type { QueryResult, QueryResultRow } from "pg";

export type FunctionExecutionTrustMode =
  | "trusted-authors-only"
  | "open-development";

export interface ExecutionPolicy {
  readonly trustMode: FunctionExecutionTrustMode;
  /** Parsed legacy author allowlist; empty set = never admits by itself. */
  readonly trustedAuthorIds: ReadonlySet<string>;
  /** Realm/client role that grants global Function publish rights. */
  readonly publishRole: string;
  /** Fail-closed kill switch for legacy-contract executions. */
  readonly legacyContractDisabled: boolean;
  /** Informational operator sunset date (ISO YYYY-MM-DD) or null. */
  readonly legacyDeprecationDate: string | null;
}

/** The default Keycloak role granting global Function publish rights. */
export const DEFAULT_FUNCTION_PUBLISH_ROLE = "function:publish";

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
  const rawPublishRole = (process.env.FUNCTION_PUBLISH_ROLE ?? "").trim();
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
    publishRole:
      rawPublishRole.length > 0 ? rawPublishRole : DEFAULT_FUNCTION_PUBLISH_ROLE,
    legacyContractDisabled:
      (process.env.FUNCTION_LEGACY_CONTRACT_DISABLED ?? "")
        .trim()
        .toLowerCase() === "true",
    legacyDeprecationDate,
  };
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

// ---------------------------------------------------------------------------
// Publish authorization (1)
// ---------------------------------------------------------------------------

/**
 * Minimal query interface — satisfied by pg.Pool, pg.PoolClient, and the
 * schema-isolated test pools — so the authorizer stays unit-testable with a
 * fake without pulling the pg driver into the unit lane.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>;
}

export type PublishDecisionSource =
  | "keycloak_role"
  | "db_grant"
  | "env_allowlist"
  | "open_development"
  | "denied";

export type PublishAuditEventType =
  | "publish_allowed"
  | "publish_denied"
  | "grant_created"
  | "grant_revoked"
  | "grant_expired_denial";

export interface PublishDecision {
  readonly allowed: boolean;
  readonly source: PublishDecisionSource;
  /** The DB grant that admitted the caller (source "db_grant" only). */
  readonly grantId?: string;
  /** Operator-facing explanation; safe to surface in an error envelope. */
  readonly reason: string;
  /**
   * True when the underlying decision was ALLOW but persisting the audit
   * record failed, so the decision was flipped to deny. Publication is
   * security-sensitive — an unaudited allow is never honored.
   */
  readonly auditFailed?: boolean;
}

export interface PublishPrincipal {
  readonly localUserId?: string | null;
  readonly keycloakSub?: string | null;
  readonly roles?: readonly string[];
}

export interface AuthorizePublishInput extends PublishPrincipal {
  /** Repository being published from (required for repo-scoped grants). */
  readonly repositoryRid?: string | null;
  /** The release tag being published, for the audit record. */
  readonly releaseTag?: string | null;
}

interface GrantRow extends QueryResultRow {
  readonly id: string;
  readonly subject_type: "local_user" | "keycloak_sub";
  readonly scope_type: "global" | "repository";
  readonly scope_rid: string | null;
  readonly is_active: boolean;
}

/** Log the legacy-env-allowlist deprecation warning at most once per process. */
let envAllowlistDeprecationWarned = false;

/**
 * Persist one audit event. Exported so the grant-admin routes can record
 * grant_created / grant_revoked with the same writer as publish decisions.
 * THROWS on failure — callers decide the failure policy for their path.
 */
export async function recordFunctionPublishAuditEvent(
  db: Queryable,
  event: {
    readonly eventType: PublishAuditEventType;
    readonly subjectType?: "local_user" | "keycloak_sub" | null;
    readonly subjectId?: string | null;
    readonly keycloakSub?: string | null;
    readonly localUserId?: string | null;
    readonly repositoryRid?: string | null;
    readonly releaseTag?: string | null;
    readonly decisionSource?: PublishDecisionSource | null;
    readonly grantId?: string | null;
    readonly actorId?: string | null;
    readonly detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO function_publish_audit_log
       (event_type, subject_type, subject_id, keycloak_sub, local_user_id,
        repository_rid, release_tag, decision_source, grant_id, actor_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [
      event.eventType,
      event.subjectType ?? null,
      event.subjectId ?? null,
      event.keycloakSub ?? null,
      event.localUserId ?? null,
      event.repositoryRid ?? null,
      event.releaseTag ?? null,
      event.decisionSource ?? null,
      event.grantId ?? null,
      event.actorId ?? null,
      JSON.stringify(event.detail ?? {}),
    ],
  );
}

const DENY_REASON_UNTRUSTED =
  "function-author-not-authorized: publication of executable Functions requires " +
  "the publish role or an active function_publish_grants entry " +
  "(the executor is not yet an untrusted-code sandbox). Ask a platform " +
  "administrator to grant access via /api/v1/functions/admin/function-publish-grants.";

/**
 * Admit or deny a Function publication. Reads policy + grants fresh on every
 * call — no caching beyond a single request. Fails closed on every ambiguous
 * path. Every outcome is audit-logged; an allow whose audit write fails is
 * flipped to deny.
 */
export async function authorizePublish(
  db: Queryable,
  input: AuthorizePublishInput,
): Promise<PublishDecision> {
  const policy = executionPolicy();
  const localUserId = input.localUserId ?? null;
  const keycloakSub = input.keycloakSub ?? null;
  const repositoryRid = input.repositoryRid ?? null;
  const releaseTag = input.releaseTag ?? null;
  const roles = input.roles ?? [];

  const auditBase = {
    // Prefer the IdP identity as the audit subject; both raw identifiers are
    // always recorded in their dedicated columns alongside.
    subjectType: (keycloakSub ? "keycloak_sub" : localUserId ? "local_user" : null) as
      | "keycloak_sub"
      | "local_user"
      | null,
    subjectId: keycloakSub ?? localUserId,
    keycloakSub,
    localUserId,
    repositoryRid,
    releaseTag,
  };

  const finalize = async (
    decision: Omit<PublishDecision, "auditFailed">,
    eventType: PublishAuditEventType,
    detail: Record<string, unknown>,
  ): Promise<PublishDecision> => {
    try {
      await recordFunctionPublishAuditEvent(db, {
        eventType,
        ...auditBase,
        decisionSource: decision.source,
        grantId: decision.grantId ?? null,
        detail,
      });
      return decision;
    } catch (err) {
      console.error(
        JSON.stringify({
          type: "functions.publish.audit_write_failed",
          eventType,
          repositoryRid,
          releaseTag,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      if (!decision.allowed) {
        // Already denying; losing the audit row changes nothing for the
        // caller. Logged loudly above.
        return decision;
      }
      // Fail closed: an unaudited publication must not proceed.
      return {
        allowed: false,
        source: "denied",
        reason: "publish-audit-unavailable",
        auditFailed: true,
      };
    }
  };

  // (a) Keycloak publish role — global rights from the IdP itself.
  if (policy.publishRole.length > 0 && roles.includes(policy.publishRole)) {
    return finalize(
      {
        allowed: true,
        source: "keycloak_role",
        reason: "authorized via Keycloak publish role",
      },
      "publish_allowed",
      { publishRole: policy.publishRole },
    );
  }

  // (b) DB grant — global or repository-scoped, active only.
  type DbOutcome =
    | { readonly kind: "ok"; readonly rows: readonly GrantRow[] }
    | { readonly kind: "unavailable"; readonly error: string };
  const dbOutcome: DbOutcome = await db
    .query<GrantRow>(
      `SELECT id, subject_type, scope_type, scope_rid,
              (expires_at IS NULL OR expires_at > now()) AS is_active
         FROM function_publish_grants
        WHERE revoked_at IS NULL
          AND (
            (subject_type = 'local_user' AND subject_id = $1)
            OR (subject_type = 'keycloak_sub' AND subject_id = $2)
          )
          AND (
            scope_type = 'global'
            OR (scope_type = 'repository' AND scope_rid = $3)
          )`,
      [localUserId, keycloakSub, repositoryRid],
    )
    .then((res): DbOutcome => ({ kind: "ok", rows: res.rows }))
    .catch((err: unknown): DbOutcome => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({
          type: "functions.publish.grant_lookup_failed",
          repositoryRid,
          releaseTag,
          error: message,
        }),
      );
      return { kind: "unavailable", error: message };
    });

  if (dbOutcome.kind === "unavailable") {
    // Fail closed: authorization state is unknown when the grants table
    // cannot be read.
    return finalize(
      {
        allowed: false,
        source: "denied",
        reason: "publish-authorization-unavailable",
      },
      "publish_denied",
      { error: dbOutcome.error },
    );
  }

  const activeGrant = dbOutcome.rows.find((row) => row.is_active);
  if (activeGrant) {
    return finalize(
      {
        allowed: true,
        source: "db_grant",
        grantId: activeGrant.id,
        reason: "authorized via function publish grant",
      },
      "publish_allowed",
      {
        grantSubjectType: activeGrant.subject_type,
        grantScopeType: activeGrant.scope_type,
        grantScopeRid: activeGrant.scope_rid,
      },
    );
  }
  const expiredGrant = dbOutcome.rows.find((row) => !row.is_active);
  if (expiredGrant) {
    return finalize(
      {
        allowed: false,
        source: "denied",
        grantId: expiredGrant.id,
        reason: "function-publish-grant-expired",
      },
      "grant_expired_denial",
      {
        grantSubjectType: expiredGrant.subject_type,
        grantScopeType: expiredGrant.scope_type,
        grantScopeRid: expiredGrant.scope_rid,
      },
    );
  }

  // (c) Legacy env allowlist — DEPRECATED migration fallback.
  if (policy.trustedAuthorIds.size > 0) {
    const candidates = [localUserId, keycloakSub];
    const matched = candidates.find(
      (id): id is string =>
        typeof id === "string" &&
        id.length > 0 &&
        policy.trustedAuthorIds.has(id),
    );
    if (matched) {
      if (!envAllowlistDeprecationWarned) {
        envAllowlistDeprecationWarned = true;
        console.warn(
          JSON.stringify({
            type: "functions.publish.env_allowlist_deprecated",
            reason:
              "FUNCTION_TRUSTED_AUTHOR_IDS is a deprecated migration fallback. " +
              "Import entries into function_publish_grants with " +
              "scripts/import-function-trusted-authors.ts, then unset the variable.",
          }),
        );
      }
      return finalize(
        {
          allowed: true,
          source: "env_allowlist",
          reason: "authorized via legacy FUNCTION_TRUSTED_AUTHOR_IDS (deprecated)",
        },
        "publish_allowed",
        { matchedSubjectId: matched },
      );
    }
  }

  // (d) open-development — dev stacks only, refused in production by
  // executionPolicy() above.
  if (policy.trustMode === "open-development") {
    return finalize(
      {
        allowed: true,
        source: "open_development",
        reason: "authorized via FUNCTION_EXECUTION_TRUST_MODE=open-development",
      },
      "publish_allowed",
      {},
    );
  }

  // (e) Deny. Empty everything = deny, exactly as the env-only gate did.
  return finalize(
    { allowed: false, source: "denied", reason: DENY_REASON_UNTRUSTED },
    "publish_denied",
    {},
  );
}

/**
 * Startup summary of the active publish policy, so operators can see in the
 * boot log whether publication is gated and by how many paths. Best-effort:
 * never throws, never blocks server start.
 */
export async function logFunctionPublishPolicySummary(
  db: Queryable,
): Promise<void> {
  const policy = executionPolicy();
  let activeGrants: number | null = null;
  try {
    const res = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM function_publish_grants
        WHERE revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())`,
    );
    activeGrants = Number(res.rows[0]?.count ?? 0);
  } catch (err) {
    console.error(
      JSON.stringify({
        type: "functions.publish.policy_summary_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  console.log(
    JSON.stringify({
      type: "functions.publish.policy_summary",
      trustMode: policy.trustMode,
      publishRole: policy.publishRole,
      activeDbGrants: activeGrants,
      legacyEnvAllowlistEntries: policy.trustedAuthorIds.size,
      legacyEnvAllowlistDeprecated: policy.trustedAuthorIds.size > 0,
    }),
  );
}
