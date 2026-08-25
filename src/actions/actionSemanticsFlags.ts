// ---------------------------------------------------------------------------
// Feature Flags — Version-2 Semantics Rollout Controls
//
// All version-2 execution and creation are DISABLED by default. The flags
// must be enabled explicitly (env, per-request header, or operator kill
// switch) ONLY after database verification (locking, concurrency, query
// plans, E2E) has passed. Compilation + unit tests are NOT sufficient to
// flip these flags.
//
// `ACTION_SEMANTICS_V2_ENABLED`           — gate v2 EXECUTION behaviour.
// `ACTION_SEMANTICS_V2_CREATION_ENABLED`  — gate v2 action-type CREATION.
//
// Even when both are enabled, unknown semantics versions fail closed and
// the compiler/executor never silently downgrade v2.
// ---------------------------------------------------------------------------

function readBool(name: string, def = false): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "on";
}

interface SemanticsV2Flags {
  /** v2 EXECUTION behaviour (restrict delete, same-invocation rejection). */
  executionEnabled: boolean;
  /** v2 action-type CREATION through the UI/API. */
  creationEnabled: boolean;
  /** Hard kill switch — overrides both above to off when true. */
  disabled: boolean;
}

export interface ActionSemanticsExecutionAvailability {
  available: boolean;
  code?: "UNSUPPORTED_SEMANTICS_VERSION";
  message?: string;
  details?: {
    semanticsVersion: number;
    executionEnabled: boolean;
    projectionReady: boolean;
    killSwitchEnabled: boolean;
    reason:
      | "unsupported_version"
      | "kill_switch_enabled"
      | "execution_disabled"
      | "projection_not_ready";
  };
}

export function semanticsV2Flags(): SemanticsV2Flags {
  const killSwitch = readBool("ACTION_SEMANTICS_V2_KILL_SWITCH", false);
  const execution = readBool("ACTION_SEMANTICS_V2_ENABLED", false);
  const creation = readBool("ACTION_SEMANTICS_V2_CREATION_ENABLED", false);
  return {
    executionEnabled: !killSwitch && execution,
    creationEnabled: !killSwitch && creation,
    disabled: killSwitch,
  };
}

/**
 * Effective gate for v2 execution — the compiler/executor branch on this.
 * Returns true only when v2 execution is enabled. When false, a v2 action
 * type is rejected at execution time (fail closed) so we never silently run
 * a v2 action as v1.
 */
export function isV2ExecutionEnabled(): boolean {
  return semanticsV2Flags().executionEnabled;
}

/**
 * Effective gate for v2 creation — the create route branches on this. When
 * false, an explicit `semanticsVersion: 2` on the create endpoint is
 * rejected (fail closed) so we never persist a v2 action type whose
 * behaviour isn't enforced yet.
 */
export function isV2CreationEnabled(): boolean {
  return semanticsV2Flags().creationEnabled;
}

/**
 * Whether the link_instances projection has been bootstrapped + reconciled
 * against the ledger (zero mismatches). v2 restrict-delete FAILS CLOSED
 * while this is false, because the EXISTS/aggregate checks would read an
 * empty/stale projection. The operator sets this only after running the
 * bootstrap + reconciliation runbook and confirming mismatch count == 0.
 */
export function isV2ProjectionReady(): boolean {
  return readBool("ACTION_SEMANTICS_V2_PROJECTION_READY", false);
}

/**
 * Single source of truth for whether a persisted action semantics version can
 * execute in this process. Both validate and apply MUST use this decision so
 * a dry run can never advertise an action as executable when apply will
 * reject it.
 */
export function getActionSemanticsExecutionAvailability(
  version: number,
): ActionSemanticsExecutionAvailability {
  if (version === 1) {
    return { available: true };
  }

  const flags = semanticsV2Flags();
  const projectionReady = isV2ProjectionReady();

  if (version !== 2) {
    return {
      available: false,
      code: "UNSUPPORTED_SEMANTICS_VERSION",
      message: `Unsupported action semantics version '${version}'.`,
      details: {
        semanticsVersion: version,
        executionEnabled: flags.executionEnabled,
        projectionReady,
        killSwitchEnabled: flags.disabled,
        reason: "unsupported_version",
      },
    };
  }

  if (flags.disabled) {
    return {
      available: false,
      code: "UNSUPPORTED_SEMANTICS_VERSION",
      message:
        "Version-2 action execution is temporarily unavailable because the operator kill switch is enabled.",
      details: {
        semanticsVersion: version,
        executionEnabled: false,
        projectionReady,
        killSwitchEnabled: true,
        reason: "kill_switch_enabled",
      },
    };
  }

  if (!flags.executionEnabled) {
    return {
      available: false,
      code: "UNSUPPORTED_SEMANTICS_VERSION",
      message:
        "Version-2 action execution is not enabled for this deployment.",
      details: {
        semanticsVersion: version,
        executionEnabled: false,
        projectionReady,
        killSwitchEnabled: false,
        reason: "execution_disabled",
      },
    };
  }

  if (!projectionReady) {
    return {
      available: false,
      code: "UNSUPPORTED_SEMANTICS_VERSION",
      message:
        "Version-2 action execution is enabled, but the relationship projection has not been verified. Run the projection bootstrap and reconciliation before enabling version-2 execution.",
      details: {
        semanticsVersion: version,
        executionEnabled: true,
        projectionReady: false,
        killSwitchEnabled: false,
        reason: "projection_not_ready",
      },
    };
  }

  return { available: true };
}

/**
 * Whether a semantic-version execution should be enforced. v1 always runs
 * (unchanged legacy behaviour). v2 runs only when execution is enabled AND
 * the projection is ready; otherwise the executor rejects the invocation
 * with UNSUPPORTED_SEMANTICS_VERSION (fail closed — never silently run a
 * v2 action as v1, and never run v2 restrict-delete against an unverified
 * projection).
 */
export function shouldEnforceSemantics(version: number): boolean {
  return getActionSemanticsExecutionAvailability(version).available;
}
