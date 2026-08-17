// ---------------------------------------------------------------------------
// Action-type security settings (Ontology Manager "Security & Submission
// Criteria" page — the non-criteria cards).
//
// One resolver, used by every consumer, so the page, the executor's branch
// side-effect gate, the Automate consumer gate and the notification worker
// can never disagree about what a NULL or partial blob means.
//
// Persisted in action_type.security_settings (migration 173). NULL or any
// missing key resolves to the documented default below.
// ---------------------------------------------------------------------------

/** How a failure to reach a notified user is handled. */
export type ActionFailurePolicy = "all" | "any";

export interface ActionSecuritySettings {
  /**
   * Fire side-effect webhooks when this action runs on a non-main branch.
   * Default false: a branch is a rehearsal, and calling a real external
   * endpoint from a rehearsal is exactly what this switch guards against.
   */
  allowWebhooksOnBranches: boolean;
  /**
   * Run functions that make external calls when this action runs on a
   * non-main branch. Default false, same reasoning.
   */
  allowExternalCallFunctionsOnBranches: boolean;
  /**
   * Send notifications when this action runs on a non-main branch.
   * Default false — rehearsals must not email real users.
   */
  allowNotificationsOnBranches: boolean;
  /**
   * Allow Automate to submit this action. Default TRUE, which both matches
   * Foundry and keeps every automation that existed before migration 173
   * working unchanged.
   */
  allowAutomateSubmission: boolean;
  /**
   * "all" (default) — if ANY notified user cannot see an object the action
   * edited, the action fails and nobody is notified.
   * "any"           — the action succeeds as long as at least one notified
   *                   user can see the object; only they are notified.
   */
  actionFailurePolicy: ActionFailurePolicy;
  /**
   * Let everyone in the organization see unredacted notifications, despite
   * Control Panel redaction settings. Default false (redaction on).
   */
  disableNotificationRedaction: boolean;
}

export const DEFAULT_ACTION_SECURITY_SETTINGS: Readonly<ActionSecuritySettings> =
  Object.freeze({
    allowWebhooksOnBranches: false,
    allowExternalCallFunctionsOnBranches: false,
    allowNotificationsOnBranches: false,
    allowAutomateSubmission: true,
    actionFailurePolicy: "all",
    disableNotificationRedaction: false,
  });

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/**
 * Resolve a persisted `security_settings` blob into a fully-populated
 * settings object. Never throws: an unparseable blob resolves to the
 * defaults, which are the SAFE reading in every case (branch side effects
 * off, redaction on). The one non-restrictive default —
 * `allowAutomateSubmission: true` — is deliberate: silently blocking every
 * pre-existing automation on a malformed blob would be a worse failure than
 * honouring the pre-migration behaviour.
 */
export function resolveActionSecuritySettings(
  raw: unknown,
): ActionSecuritySettings {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_ACTION_SECURITY_SETTINGS };
  }
  const blob = raw as Record<string, unknown>;
  const policy = blob.actionFailurePolicy;
  return {
    allowWebhooksOnBranches: bool(
      blob.allowWebhooksOnBranches,
      DEFAULT_ACTION_SECURITY_SETTINGS.allowWebhooksOnBranches,
    ),
    allowExternalCallFunctionsOnBranches: bool(
      blob.allowExternalCallFunctionsOnBranches,
      DEFAULT_ACTION_SECURITY_SETTINGS.allowExternalCallFunctionsOnBranches,
    ),
    allowNotificationsOnBranches: bool(
      blob.allowNotificationsOnBranches,
      DEFAULT_ACTION_SECURITY_SETTINGS.allowNotificationsOnBranches,
    ),
    allowAutomateSubmission: bool(
      blob.allowAutomateSubmission,
      DEFAULT_ACTION_SECURITY_SETTINGS.allowAutomateSubmission,
    ),
    actionFailurePolicy:
      policy === "any" || policy === "all"
        ? policy
        : DEFAULT_ACTION_SECURITY_SETTINGS.actionFailurePolicy,
    disableNotificationRedaction: bool(
      blob.disableNotificationRedaction,
      DEFAULT_ACTION_SECURITY_SETTINGS.disableNotificationRedaction,
    ),
  };
}

/**
 * Normalize a caller-supplied settings body for persistence. Returns `null`
 * when every field equals its default, so an untouched page stores NULL
 * rather than a blob of defaults (keeps the column meaningfully sparse and
 * keeps `IS DISTINCT FROM` comparisons honest).
 *
 * Unknown keys are dropped rather than passed through — the CHECK constraint
 * in migration 173 only validates known keys, so accepting extras would let
 * arbitrary JSON accumulate in a security-relevant column.
 */
export function normalizeActionSecuritySettings(
  raw: unknown,
): ActionSecuritySettings | null {
  const resolved = resolveActionSecuritySettings(raw);
  const isDefault = (
    Object.keys(DEFAULT_ACTION_SECURITY_SETTINGS) as Array<
      keyof ActionSecuritySettings
    >
  ).every((key) => resolved[key] === DEFAULT_ACTION_SECURITY_SETTINGS[key]);
  return isDefault ? null : resolved;
}

/**
 * Is this execution running on a real (non-main) branch?
 *
 * Both arguments are branch UUIDs as resolved by `resolveBranchIdOrMain` /
 * `resolveMainBranchId` — NOT names. A caller who threaded no branch has
 * already been defaulted to main by the resolver, so equality with the main
 * id is the only "not on a branch" case.
 *
 * Fail-safe direction: when the main branch id cannot be resolved (a
 * transitional deployment with no `ontology_branch` row) we report `false`,
 * i.e. treat the execution as main. The alternative would silently suppress
 * every side effect of every action on such a deployment — a much larger,
 * much quieter behaviour change than letting them fire as they did before
 * these switches existed.
 */
export function isNonMainBranch(
  resolvedBranchId: string | null | undefined,
  mainBranchId: string | null | undefined,
): boolean {
  if (!resolvedBranchId || !mainBranchId) return false;
  return String(resolvedBranchId) !== String(mainBranchId);
}

/**
 * Apply the "Testing on branches" switches to a persisted `side_effects`
 * blob, returning the blob the dispatcher should actually see.
 *
 * Pure and shared deliberately: the executor has TWO dispatch paths — the
 * durable outbox (`extractSideEffectJobs` inside `preCommitHook`) and the
 * legacy fire-and-forget Stage 5/7 (`ACTION_SIDE_EFFECT_WORKER_ENABLED=0`).
 * Gating them through one function is the only way the switch cannot mean
 * two different things depending on an env var.
 *
 * Suppression is by emptying the relevant array rather than by skipping the
 * dispatch call, so an action with webhooks suppressed but notifications
 * allowed still gets its notifications. On main (`onBranch === false`) the
 * blob is returned untouched — identity, not a copy, so the no-branch path
 * is byte-for-byte what it was before migration 173.
 */
export function filterSideEffectsForBranch(
  sideEffects: unknown,
  settings: ActionSecuritySettings,
  onBranch: boolean,
): unknown {
  if (!onBranch) return sideEffects;
  if (!sideEffects || typeof sideEffects !== "object" || Array.isArray(sideEffects)) {
    return sideEffects;
  }
  const suppressWebhooks = !settings.allowWebhooksOnBranches;
  const suppressNotifications = !settings.allowNotificationsOnBranches;
  if (!suppressWebhooks && !suppressNotifications) return sideEffects;
  return {
    ...(sideEffects as Record<string, unknown>),
    ...(suppressWebhooks ? { webhooks: [] } : {}),
    ...(suppressNotifications ? { notifications: [] } : {}),
  };
}
