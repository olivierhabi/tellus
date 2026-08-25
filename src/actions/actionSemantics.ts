// ---------------------------------------------------------------------------
// Action Semantics — Versioning & Behaviour Matrix
//
// Introduces explicit, immutable, numeric semantics versions so the action
// framework can evolve safely without rewriting the existing executor,
// rule compiler, edit applicator, audit pipeline, or post-commit side
// effects. New behaviour is introduced behind `semanticsVersion: 2`; all
// existing stored action types remain `semanticsVersion: 1` and keep their
// current (legacy) behaviour.
//
// The persisted identifiers are numeric and stable:
//   * `semanticsVersion` ∈ { 1, 2 }            — never "legacy"/"strict"
//   * `executionMode`    ∈ { "declarative", "function" }
//   * `deletePolicy`     ∈ { "legacy_unchecked", "restrict" }
//
// `function` executes an immutable published Function Registry binding.
// Future `detach`/`cascade` delete policies are intentionally NOT persisted
// yet — they land via a later schema migration when their behaviour exists.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Version & mode types
// ---------------------------------------------------------------------------

/**
 * Numeric, immutable semantics version. Persisted as an integer column.
 * Never use "legacy"/"strict" as persisted identifiers.
 */
export type ActionSemanticsVersion = 1 | 2;

/**
 * How a rule executes. `function` resolves a pinned published Function.
 */
export type ActionExecutionMode = "declarative" | "function";

/**
 * Referential-integrity policy for delete operations.
 *   * `legacy_unchecked` — version-1 behaviour: dangling links are warned
 *     about (deleteObjectRule) but never block the delete.
 *   * `restrict`         — version-2 behaviour: the action fails when the
 *     final planned state contains any active relationship connected to the
 *     deleted object.
 * `detach`/`cascade` are deliberately NOT persisted yet (non-goal §18).
 */
export type DeletePolicy = "legacy_unchecked" | "restrict";

// ---------------------------------------------------------------------------
// Valid combination matrix
// ---------------------------------------------------------------------------

/**
 * The full per-action-type semantics triple, persisted on `action_type`.
 */
export interface ActionSemantics {
  semanticsVersion: ActionSemanticsVersion;
  executionMode: ActionExecutionMode;
  deletePolicy: DeletePolicy;
}

/**
 * The set of combinations the framework will persist and execute. Anything
 * outside this set is rejected at definition, invocation, and execution
 * time (fail closed).
 *
 * Version 1:
 *   { semanticsVersion: 1, executionMode: "declarative", deletePolicy: "legacy_unchecked" }
 * Version 2:
 *   { semanticsVersion: 2, executionMode: "declarative", deletePolicy: "restrict" }
 *
 * `executionMode: "function"` requires a validated immutable functionConfig.
 * Unknown future versions fail closed.
 */
export const VALID_SEMANTICS_COMBINATIONS: ReadonlyArray<ActionSemantics> = [
  { semanticsVersion: 1, executionMode: "declarative", deletePolicy: "legacy_unchecked" },
  { semanticsVersion: 1, executionMode: "function", deletePolicy: "legacy_unchecked" },
  { semanticsVersion: 2, executionMode: "declarative", deletePolicy: "restrict" },
  { semanticsVersion: 2, executionMode: "function", deletePolicy: "restrict" },
];

/** The currently-supported known semantics versions. */
export const SUPPORTED_SEMANTICS_VERSIONS: ReadonlySet<ActionSemanticsVersion> =
  new Set<ActionSemanticsVersion>([1, 2]);

// ---------------------------------------------------------------------------
// Version defaults / fallback
// ---------------------------------------------------------------------------

/**
 * The canonical version-1 semantics triple. Used as the read-time fallback
 * when a stored row has NULL semantics columns (Stage B of the additive
 * migration) and as the implicit default when a v1 create request omits the
 * semantics fields entirely.
 */
export const V1_DEFAULT_SEMANTICS: ActionSemantics = {
  semanticsVersion: 1,
  executionMode: "declarative",
  deletePolicy: "legacy_unchecked",
};

/**
 * The canonical version-2 semantics triple. Used by the version-2 API route
 * to fill in executionMode/deletePolicy server-side when the caller omits
 * them. The caller MUST still send `semanticsVersion: 2` explicitly — this
 * constant does NOT change the omission-means-v1 contract for the legacy
 * route.
 */
export const V2_DEFAULT_SEMANTICS: ActionSemantics = {
  semanticsVersion: 2,
  executionMode: "declarative",
  deletePolicy: "restrict",
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface SemanticsValidationResult {
  valid: boolean;
  error?: {
    code:
      | "UNSUPPORTED_SEMANTICS_VERSION"
      | "INCOMPATIBLE_ACTION_SEMANTICS"
      | "INVALID_EXECUTION_MODE"
      | "INVALID_DELETE_POLICY";
    message: string;
  };
}

/**
 * Validate a full semantics triple against the accept matrix.
 *
 * Known version + valid mode/policy but incompatible combination (e.g.
 * version 2 + `legacy_unchecked`) → `INCOMPATIBLE_ACTION_SEMANTICS`.
 * Unknown version (not in {1,2}) → `UNSUPPORTED_SEMANTICS_VERSION`.
 * Unknown mode/policy string   → `INVALID_EXECUTION_MODE` / `INVALID_DELETE_POLICY`.
 * `executionMode: "function"` is valid with the version's delete policy.
 */
export function validateActionSemantics(
  semantics: Partial<ActionSemantics>,
): SemanticsValidationResult {
  const { semanticsVersion, executionMode, deletePolicy } = semantics;

  // Unknown version → fail closed. Never silently run an unknown version as 1.
  if (
    semanticsVersion !== undefined &&
    !SUPPORTED_SEMANTICS_VERSIONS.has(semanticsVersion as ActionSemanticsVersion)
  ) {
    return {
      valid: false,
      error: {
        code: "UNSUPPORTED_SEMANTICS_VERSION",
        message: `Unsupported action semantics version '${semanticsVersion}'. Supported versions: ${Array.from(
          SUPPORTED_SEMANTICS_VERSIONS,
        ).join(", ")}.`,
      },
    };
  }

  if (
    executionMode !== undefined &&
    executionMode !== "declarative" &&
    executionMode !== "function"
  ) {
    return {
      valid: false,
      error: {
        code: "INVALID_EXECUTION_MODE",
        message: `Invalid execution mode '${executionMode}'. Must be 'declarative'.`,
      },
    };
  }

  // Future detach/cascade are not persisted yet.
  if (
    deletePolicy !== undefined &&
    deletePolicy !== "legacy_unchecked" &&
    deletePolicy !== "restrict"
  ) {
    return {
      valid: false,
      error: {
        code: "INVALID_DELETE_POLICY",
        message: `Invalid delete policy '${deletePolicy}'. Supported policies: legacy_unchecked, restrict.`,
      },
    };
  }

  // Fully specified combination must match the accept matrix exactly.
  if (
    semanticsVersion !== undefined &&
    executionMode !== undefined &&
    deletePolicy !== undefined
  ) {
    const match = VALID_SEMANTICS_COMBINATIONS.some(
      (c) =>
        c.semanticsVersion === semanticsVersion &&
        c.executionMode === executionMode &&
        c.deletePolicy === deletePolicy,
    );
    if (!match) {
      return {
        valid: false,
        error: {
          code: "INCOMPATIBLE_ACTION_SEMANTICS",
          message:
            `Incompatible action semantics: version ${semanticsVersion} requires ` +
            `executionMode 'declarative' and deletePolicy ` +
            `${semanticsVersion === 1 ? "'legacy_unchecked'" : "'restrict'"}.`,
        },
      };
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Read-time fallback (Stage B of the additive migration)
// ---------------------------------------------------------------------------

/**
 * Resolve persisted (possibly NULL) semantics columns to a full
 * `ActionSemantics` triple.
 *
 * Existing rows pre-migration have NULL semantics_version / execution_mode
 * / delete_policy. During Stage B (compatible deployment), those are
 * interpreted as version 1 / declarative / legacy_unchecked — the exact
 * behaviour they had before the columns existed. This fallback MUST remain
 * observable (emits a `action_legacy_default_used_total` metric) so ops
 * can track how many rows still rely on it.
 *
 * Unknown stored versions fail closed: callers receive V1_DEFAULT_SEMANTICS
 * only for NULL; a stored 3 or 99 is rejected upstream by
 * `validateActionSemantics`.
 */
export function resolveSemanticsFromRow(row: {
  semantics_version?: number | null;
  execution_mode?: string | null;
  delete_policy?: string | null;
}): ActionSemantics {
  const v = row.semantics_version;
  const m = row.execution_mode;
  const p = row.delete_policy;

  if (v === null || v === undefined) {
    // Stage B fallback — observable elsewhere via a metric counter.
    return { ...V1_DEFAULT_SEMANTICS };
  }

  // Mode/policy are defaulted per the stored version so a v2 row that lost
  // its delete_policy (shouldn't happen — create persists all three together)
  // still resolves to the safe v2 default (`restrict`), not the v1 policy.
  const defaults = v === 2 ? V2_DEFAULT_SEMANTICS : V1_DEFAULT_SEMANTICS;
  return {
    semanticsVersion: v as ActionSemanticsVersion,
    executionMode: (m ?? defaults.executionMode) as ActionExecutionMode,
    deletePolicy: (p ?? defaults.deletePolicy) as DeletePolicy,
  };
}

// ---------------------------------------------------------------------------
// Per-rule behaviour matrix
// ---------------------------------------------------------------------------

/**
 * Returns whether a given behaviour is supported for the supplied semantics
 * version. Centralises the semantics matrix from §1 of the directive so
 * individual compilers/executors do not duplicate these rules.
 */
export const behaviourMatrix = {
  /** New UI/API-created action types default to v2. Existing types stay v1. */
  newActionTypeDefaultVersion: 2 as ActionSemanticsVersion,

  /** String parameter used as an object reference: v1 supported, v2 rejected. */
  stringAsObjectReference(version: ActionSemanticsVersion): boolean {
    return version === 1;
  },

  /** Typed `object_reference` parameter: v1 supported, v2 required for modify/delete. */
  typedObjectReferenceRequired(
    version: ActionSemanticsVersion,
    ruleType: string,
  ): boolean {
    if (version !== 2) return false;
    return (
      ruleType === "modifyObject" ||
      ruleType === "modifyOrCreateObject" ||
      ruleType === "deleteObject"
    );
  },

  /** Create then modify the same identity in one invocation: v1 yes, v2 no. */
  createThenModify(version: ActionSemanticsVersion): boolean {
    return version === 1;
  },

  /** Create then delete the same identity in one invocation: v1 yes, v2 no. */
  createThenDelete(version: ActionSemanticsVersion): boolean {
    return version === 1;
  },

  /** modify-or-create against a missing object still creates, in both versions. */
  modifyOrCreateCreatesMissing(_version: ActionSemanticsVersion): boolean {
    return true;
  },

  /** Delete referential-integrity policy per version. */
  deleteRestrict(version: ActionSemanticsVersion): boolean {
    return version === 2;
  },

  /** Pending relationship edits must be considered during delete checks (v2 required). */
  pendingRelationshipEditsRequired(version: ActionSemanticsVersion): boolean {
    return version === 2;
  },

  /** Function execution is supported for immutable published bindings. */
  functionExecutionSupported(_version: ActionSemanticsVersion): boolean {
    return true;
  },
} as const;
