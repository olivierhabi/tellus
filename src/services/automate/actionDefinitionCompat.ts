// ---------------------------------------------------------------------------
// Action-Type Definition Compatibility Classifier
//
// SINGLE SOURCE OF TRUTH for action-definition evolution decisions. Three
// consumers MUST share this implementation (no re-derivation at call
// sites):
//
//   1. Automate activation validation  (services/automate/validation.ts)
//   2. Bulk re-pin API                 (services/automate/repin.ts)
//   3. Edit-time blast radius          (routes/actionTypes.ts)
//
// EVOLUTION RULES (Avro/Protobuf-style table):
//
//   ╔══════════════════════════════════════════╦════════════╗
//   ║ Change                                   ║ Verdict    ║
//   ╠══════════════════════════════════════════╬════════════╣
//   ║ no semantic change (same canonical hash) ║ identical  ║
//   ║ added OPTIONAL parameter                 ║ compatible ║
//   ║ added REQUIRED parameter WITH default    ║ compatible ║
//   ║ parameter relaxed required→optional      ║ compatible ║
//   ║ parameter defaultValue changed/added     ║ compatible ║
//   ║ rule added                               ║ compatible ║
//   ║ rule edited, same signature              ║ compatible ║
//   ║ submissionCriteria changed               ║ compatible ║
//   ║ sideEffects changed                      ║ compatible ║
//   ║ writebackConfig changed                  ║ compatible ║
//   ╠══════════════════════════════════════════╬════════════╣
//   ║ removed parameter                        ║ breaking   ║
//   ║ renamed parameter (apiName)              ║ breaking   ║
//   ║ dataType change                          ║ breaking   ║
//   ║ newly-REQUIRED parameter WITHOUT default ║ breaking   ║
//   ║ removed rule                             ║ breaking   ║
//   ║ rule signature change                    ║ breaking   ║
//   ║ semantics triple change                  ║ breaking   ║
//   ║ functionConfig changed                   ║ breaking   ║
//   ╚══════════════════════════════════════════╩════════════╝
//
// Rationale edge cases:
//   * A REMOVED parameter breaks pins because effect bindings reference it.
//   * A RENAME manifests as removed+added: the removal is reported as
//     breaking; the addition is reported for context.
//   * functionConfig binds an immutable published function — changing it
//     swaps the executed code; pins must review it.
//   * semantics triple + functionConfig breaking is conservative by design
//     (hard constraint: never auto-upgrade across a breaking change). If
//     product analysis loosens a row, loosen THIS table — the three
//     consumers follow automatically.
// ---------------------------------------------------------------------------

import {
  canonicalizeActionDefinition,
  canonicalJsonString,
  type ActionDefinitionInput,
  type CanonicalActionParameter,
} from "../../actions/actionDefinitionCanonical";
import { hashActionDefinition } from "../../actions/actionDefinitionHash";

export type ChangeSeverity = "compatible" | "breaking";

export interface ActionDefinitionChangeDetail {
  /** Machine-stable change code (e.g. PARAMETER_TYPE_CHANGED). */
  code: string;
  severity: ChangeSeverity;
  /** Human-readable summary, e.g. "parameter `orderid` type changed string→integer". */
  message: string;
}

export type ActionDefinitionChangeKind =
  | "identical"
  | "compatible"
  | "breaking";

export interface ActionDefinitionClassification {
  kind: ActionDefinitionChangeKind;
  changes: ActionDefinitionChangeDetail[];
}

function change(
  code: string,
  severity: ChangeSeverity,
  message: string,
): ActionDefinitionChangeDetail {
  return { code, severity, message };
}

function classifyParameters(
  pinned: CanonicalActionParameter[],
  current: CanonicalActionParameter[],
  changes: ActionDefinitionChangeDetail[],
): void {
  const pinnedByName = new Map(pinned.map((p) => [p.apiName, p]));
  const currentByName = new Map(current.map((p) => [p.apiName, p]));
  for (const [apiName, pinnedParam] of pinnedByName) {
    const currentParam = currentByName.get(apiName);
    if (!currentParam) {
      changes.push(
        change(
          "PARAMETER_REMOVED",
          "breaking",
          `parameter \`${apiName}\` removed`,
        ),
      );
      continue;
    }
    if (pinnedParam.dataType !== currentParam.dataType) {
      changes.push(
        change(
          "PARAMETER_TYPE_CHANGED",
          "breaking",
          `parameter \`${apiName}\` type changed ${pinnedParam.dataType}→${currentParam.dataType}`,
        ),
      );
    }
    if (!pinnedParam.required && currentParam.required) {
      const hasDefault = currentParam.defaultValue != null;
      changes.push(
        hasDefault
          ? change(
              "PARAMETER_NEWLY_REQUIRED_WITH_DEFAULT",
              "compatible",
              `parameter \`${apiName}\` became required (default provided)`,
            )
          : change(
              "PARAMETER_NEWLY_REQUIRED",
              "breaking",
              `parameter \`${apiName}\` became required without a default`,
            ),
      );
    }
    if (pinnedParam.required && !currentParam.required) {
      changes.push(
        change(
          "PARAMETER_RELAXED",
          "compatible",
          `parameter \`${apiName}\` relaxed from required to optional`,
        ),
      );
    }
    if (
      canonicalJsonString(pinnedParam.defaultValue) !==
      canonicalJsonString(currentParam.defaultValue)
    ) {
      changes.push(
        change(
          "PARAMETER_DEFAULT_CHANGED",
          "compatible",
          `parameter \`${apiName}\` default changed ${canonicalJsonString(pinnedParam.defaultValue)}→${canonicalJsonString(currentParam.defaultValue)}`,
        ),
      );
    }
  }
  for (const [apiName, currentParam] of currentByName) {
    if (pinnedByName.has(apiName)) continue;
    if (currentParam.required && currentParam.defaultValue == null) {
      changes.push(
        change(
          "PARAMETER_ADDED_REQUIRED_NO_DEFAULT",
          "breaking",
          `parameter \`${apiName}\` added as required without a default`,
        ),
      );
    } else {
      changes.push(
        change(
          "PARAMETER_ADDED",
          "compatible",
          `parameter \`${apiName}\` added (${currentParam.required ? "required with default" : "optional"})`,
        ),
      );
    }
  }
}

function ruleKey(signature: Record<string, unknown>): string {
  return (
    (typeof signature.ruleId === "string" && signature.ruleId) ||
    `${String(signature.type ?? "unknown")}::${canonicalJsonString(signature)}`
  );
}

function classifyRules(
  pinned: Record<string, unknown>[],
  current: Record<string, unknown>[],
  changes: ActionDefinitionChangeDetail[],
): void {
  const pinnedByKey = new Map(pinned.map((sig) => [ruleKey(sig), sig]));
  const currentByKey = new Map(current.map((sig) => [ruleKey(sig), sig]));
  for (const [key, pinnedSig] of pinnedByKey) {
    const currentSig = currentByKey.get(key);
    if (!currentSig) {
      changes.push(
        change(
          "RULE_REMOVED",
          "breaking",
          `rule \`${shortKey(key)}\` removed`,
        ),
      );
      continue;
    }
    const pinnedBody = canonicalJsonString(pinnedSig);
    const currentBody = canonicalJsonString(currentSig);
    if (pinnedBody !== currentBody) {
      changes.push(
        change(
          "RULE_SIGNATURE_CHANGED",
          "breaking",
          `rule \`${shortKey(key)}\` signature changed`,
        ),
      );
    }
  }
  for (const key of currentByKey.keys()) {
    if (!pinnedByKey.has(key)) {
      changes.push(
        change("RULE_ADDED", "compatible", `rule \`${shortKey(key)}\` added`),
      );
    }
  }
}

function shortKey(key: string): string {
  return key.length > 48 ? `${key.slice(0, 45)}…` : key;
}

/**
 * Classify the drift between a PINNED definition and the CURRENT one.
 * Both inputs accept ActionDefinitionInput (TS shapes) — canonicalization
 * inside keeps the comparison immune to JSONB/object key order.
 */
export function classifyActionDefinitionChange(
  pinnedDef: unknown,
  currentDef: unknown,
): ActionDefinitionClassification {
  const pinned = canonicalizeActionDefinition(
    (pinnedDef ?? {}) as ActionDefinitionInput,
  );
  const current = canonicalizeActionDefinition(
    (currentDef ?? {}) as ActionDefinitionInput,
  );
  if (hashActionDefinition(pinned) === hashActionDefinition(current)) {
    return { kind: "identical", changes: [] };
  }
  const changes: ActionDefinitionChangeDetail[] = [];
  classifyParameters(pinned.parameters, current.parameters, changes);
  classifyRules(
    pinned.ruleSignatures as Record<string, unknown>[],
    current.ruleSignatures as Record<string, unknown>[],
    changes,
  );
  // Rule CONTENT drift with preserved signatures (e.g. a property binding
  // rewired to another parameter): compatible by rule, but recorded.
  if (
    canonicalJsonString(pinned.rules) !== canonicalJsonString(current.rules) &&
    !changes.some(
      (entry) =>
        entry.code === "RULE_REMOVED" ||
        entry.code === "RULE_ADDED" ||
        entry.code === "RULE_SIGNATURE_CHANGED",
    )
  ) {
    changes.push(
      change(
        "RULE_CONTENT_CHANGED",
        "compatible",
        "a rule's payload changed (signature preserved)",
      ),
    );
  }
  if (
    canonicalJsonString(pinned.submissionCriteria) !==
    canonicalJsonString(current.submissionCriteria)
  ) {
    changes.push(
      change(
        "SUBMISSION_CRITERIA_CHANGED",
        "compatible",
        "submission criteria changed",
      ),
    );
  }
  if (
    canonicalJsonString(pinned.sideEffects) !==
    canonicalJsonString(current.sideEffects)
  ) {
    changes.push(
      change("SIDE_EFFECTS_CHANGED", "compatible", "side effects changed"),
    );
  }
  if (
    canonicalJsonString(pinned.writebackConfig) !==
    canonicalJsonString(current.writebackConfig)
  ) {
    changes.push(
      change("WRITEBACK_CONFIG_CHANGED", "compatible", "writeback config changed"),
    );
  }
  if (
    canonicalJsonString(pinned.functionConfig) !==
    canonicalJsonString(current.functionConfig)
  ) {
    changes.push(
      change("FUNCTION_CONFIG_CHANGED", "breaking", "function binding changed"),
    );
  }
  if (pinned.semanticsVersion !== current.semanticsVersion) {
    changes.push(
      change(
        "SEMANTICS_VERSION_CHANGED",
        "breaking",
        `semantics version changed ${pinned.semanticsVersion ?? "null"}→${current.semanticsVersion ?? "null"}`,
      ),
    );
  }
  if (pinned.executionMode !== current.executionMode) {
    changes.push(
      change(
        "EXECUTION_MODE_CHANGED",
        "breaking",
        `execution mode changed ${pinned.executionMode ?? "null"}→${current.executionMode ?? "null"}`,
      ),
    );
  }
  if (pinned.deletePolicy !== current.deletePolicy) {
    changes.push(
      change(
        "DELETE_POLICY_CHANGED",
        "breaking",
        `delete policy changed ${pinned.deletePolicy ?? "null"}→${current.deletePolicy ?? "null"}`,
      ),
    );
  }
  const kind: ActionDefinitionChangeKind =
    changes.length === 0
      ? "identical"
      : changes.some((entry) => entry.severity === "breaking")
        ? "breaking"
        : "compatible";
  return { kind, changes };
}

/** One-line summary for validation messages and audit details. */
export function summarizeChanges(
  changes: ActionDefinitionChangeDetail[],
  max = 3,
): string {
  if (changes.length === 0) return "no changes";
  const head = changes.slice(0, max).map((entry) => entry.message);
  const rest = changes.length - head.length;
  return rest > 0 ? `${head.join("; ")} (+${rest} more)` : head.join("; ");
}
