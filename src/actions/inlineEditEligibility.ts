// ---------------------------------------------------------------------------
// Inline-edit action-type eligibility validator.
//
// Palantir Foundry requires inline-edit action types to meet strict backend
// constraints (see FOUNDRY_SPEC_EXTRACT.md, Pillar 2). Not all action types
// can serve as inline-edit bindings. This pure function checks every
// constraint and returns a list of specific violations so the Ontology
// Manager UI + the property PUT endpoint can show/reject ineligible
// bindings with precise reasons (defense in depth — never rely on UI
// filtering alone).
//
// Rules (from https://palantir.com/docs/foundry/action-types/inline-edits/
//   #action-type-requirements-for-inline-edits):
//   1. May only modify a single object of a single object type.
//   2. Default values must be enabled; must come from the object reference
//      parameter (reject static, CurrentUser, CurrentTime).
//   3. Side-effect webhooks or side-effect notifications cannot be enabled.
//   4. Submission criteria referencing shared or linked objects are
//      incompatible (reject).
//   5. Visibility overrides are allowed but ignored (NOT a violation).
//
// Pure + total — never throws on adversarial input. Unit-tested.
// ---------------------------------------------------------------------------

import type { ActionRule } from "./actionRules.types";

export interface InlineEditEligibilityInput {
  readonly apiName: string;
  readonly isEnabled: boolean;
  readonly rules: ReadonlyArray<unknown>;
  readonly parameters: ReadonlyArray<{
    readonly apiName: string;
    readonly type: string;
    readonly objectType?: string;
    readonly defaultValue?: unknown;
  }>;
  readonly sideEffects?: ReadonlyArray<unknown> | null;
  readonly writebackConfig?: unknown | null;
  readonly submissionCriteria?: unknown | null;
}

export interface InlineEditViolation {
  readonly code: string;
  readonly message: string;
}

export interface InlineEditEligibilityResult {
  readonly eligible: boolean;
  readonly violations: InlineEditViolation[];
}

// Rule types that modify an object (allowed for inline edit).
const MODIFY_RULE_TYPES = new Set([
  "modifyObject",
  "modifyOrCreateObject",
]);

// Rule types that are NOT modifications (forbidden for inline edit).
const FORBIDDEN_RULE_TYPES = new Set([
  "createObject",
  "deleteObject",
  "createInterfaceObject",
  "modifyInterfaceObject",
  "deleteInterfaceObject",
  "addLink",
  "removeLink",
  "createInterfaceLink",
  "deleteInterfaceLink",
]);

// Value sources that are NOT "from the object reference parameter".
const FORBIDDEN_DEFAULT_SOURCES = new Set([
  "static",
  "currentUser",
  "currentTimestamp",
  "writebackResponse",
]);

/**
 * Validate whether an action type is eligible to be bound as an inline-edit
 * action. Returns `{ eligible: true, violations: [] }` when every constraint
 * passes; otherwise returns the specific violations so callers can surface
 * them to the user or reject the binding server-side.
 */
export function validateInlineEditEligibility(
  action: InlineEditEligibilityInput,
): InlineEditEligibilityResult {
  const violations: InlineEditViolation[] = [];

  // Foundry parity: `is_enabled` is cosmetic metadata (deletion/API-name
  // semantics), never an execution or binding gate — no "disabled" constraint.

  // Constraint 1 — may only modify a single object of a single object type.
  // Exactly one modify rule, no create/delete/link rules, single object type.
  const rules = Array.isArray(action.rules) ? (action.rules as ReadonlyArray<ActionRule>) : [];
  const modifyRules = rules.filter(
    (r) => r && typeof r === "object" && MODIFY_RULE_TYPES.has((r as ActionRule).type),
  );
  const forbiddenRules = rules.filter(
    (r) => r && typeof r === "object" && FORBIDDEN_RULE_TYPES.has((r as ActionRule).type),
  );

  if (modifyRules.length === 0) {
    violations.push({
      code: "INLINE_EDIT_NO_MODIFY_RULE",
      message:
        "Inline edit actions must include a modifyObject or modifyOrCreateObject rule.",
    });
  }
  if (modifyRules.length > 1) {
    violations.push({
      code: "INLINE_EDIT_MULTIPLE_MODIFY_RULES",
      message: `Inline edit actions may only modify a single object of a single type (found ${modifyRules.length} modify rules).`,
    });
  }
  if (forbiddenRules.length > 0) {
    violations.push({
      code: "INLINE_EDIT_FORBIDDEN_RULES",
      message: `Inline edit actions must not include create, delete, or link rules (found ${forbiddenRules.map((r) => r.type).join(", ")}).`,
    });
  }

  // Check single object type across all modify rules.
  const objectTypes = new Set(
    modifyRules.map((r) => (r as { objectType?: string }).objectType).filter(Boolean),
  );
  if (objectTypes.size > 1) {
    violations.push({
      code: "INLINE_EDIT_MULTIPLE_OBJECT_TYPES",
      message: `Inline edit actions may only modify a single object type (found ${[...objectTypes].join(", ")}).`,
    });
  }

  // No multi-object reference parameters (a single object_reference param is
  // the object being edited; additional object_reference params would let the
  // action touch other objects).
  const params = Array.isArray(action.parameters) ? action.parameters : [];
  const objectRefParams = params.filter(
    (p) => p && typeof p === "object" && p.type === "object_reference",
  );
  if (objectRefParams.length > 1) {
    violations.push({
      code: "INLINE_EDIT_MULTIPLE_OBJECT_REFERENCE_PARAMS",
      message: `Inline edit actions may only have one object reference parameter (found ${objectRefParams.length}).`,
    });
  }

  // Constraint 2 — default values must be enabled and sourced from the object
  // reference parameter. Reject static / CurrentUser / CurrentTime defaults
  // on the edited-property parameters (the object_reference param itself
  // carries the object being edited; non-PK property params must default to
  // the existing object value via the object reference).
  const objectRefParam = objectRefParams[0];
  for (const param of params) {
    if (param.apiName === objectRefParam?.apiName) continue; // the PK param
    // Check default value source. The default can be:
    //   - undefined/absent (no default — allowed, the caller provides the value)
    //   - { source: "parameter", param: <objectRefParam> } (from object ref — OK)
    //   - { source: "objectProperty", param: <objectRefParam>, path: "..." } (OK)
    //   - anything else — violation.
    const dv = param.defaultValue as { source?: string; param?: string } | undefined;
    if (dv == null) continue; // no default configured — allowed
    if (dv.source === "parameter" && dv.param === objectRefParam?.apiName) continue;
    if (dv.source === "objectProperty" && dv.param === objectRefParam?.apiName) continue;
    if (FORBIDDEN_DEFAULT_SOURCES.has(dv.source ?? "")) {
      violations.push({
        code: "INLINE_EDIT_FORBIDDEN_DEFAULT",
        message: `Parameter "${param.apiName}" has a default value from "${dv.source}" which is not allowed for inline edit (must come from the object reference parameter).`,
      });
    } else {
      violations.push({
        code: "INLINE_EDIT_INVALID_DEFAULT_SOURCE",
        message: `Parameter "${param.apiName}" has a default value not sourced from the object reference parameter.`,
      });
    }
  }

  // Constraint 3 — no side-effect webhooks or notifications.
  const sideEffectsRaw = action.sideEffects;
  const sideEffects = Array.isArray(sideEffectsRaw) ? sideEffectsRaw : [];
  if (sideEffects.length > 0) {
    violations.push({
      code: "INLINE_EDIT_SIDE_EFFECTS_PRESENT",
      message: `Inline edit actions cannot have side-effect webhooks or notifications (found ${sideEffects.length} side effect(s)).`,
    });
  }

  // Writeback config is a pre-edit webhook — also forbidden for inline edits.
  if (action.writebackConfig != null) {
    violations.push({
      code: "INLINE_EDIT_WRITEBACK_CONFIG_PRESENT",
      message: "Inline edit actions cannot have a pre-edit writeback webhook.",
    });
  }

  // Constraint 4 — submission criteria referencing shared or linked objects are
  // incompatible. We check for criteria that reference object_reference
  // parameters OTHER than the object being edited, or that reference linked
  // objects. The submission criteria shape (from submissionCriteria.ts) is:
  //   { match: "all"|"any", conditions: [{ parameter: "...", ... }] }
  // or a bare array. A condition referencing a parameter that is NOT the
  // single object_reference param is referencing a "shared or linked object".
  if (action.submissionCriteria != null) {
    const criteriaViolations = checkSubmissionCriteriaForObjectRefs(
      action.submissionCriteria,
      params,
      objectRefParam?.apiName,
    );
    violations.push(...criteriaViolations);
  }

  return {
    eligible: violations.length === 0,
    violations,
  };
}

/**
 * Inspect submission criteria for references to parameters other than the
 * object_reference param (which represents the object being edited). Any such
 * reference implies a shared or linked object — incompatible with inline edits
 * per Foundry's spec.
 */
function checkSubmissionCriteriaForObjectRefs(
  criteria: unknown,
  params: ReadonlyArray<{ readonly apiName: string; readonly type: string }>,
  objectRefParamApiName: string | undefined,
): InlineEditViolation[] {
  const violations: InlineEditViolation[] = [];
  const referencedParams = new Set<string>();

  const collectConditions = (node: unknown): void => {
    if (node == null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    // Array of conditions.
    if (Array.isArray(obj.conditions)) {
      for (const c of obj.conditions) collectConditions(c);
      return;
    }
    // Single condition with a `parameter` field.
    if (typeof obj.parameter === "string") {
      referencedParams.add(obj.parameter);
    }
    // Nested logical operators.
    if (Array.isArray(obj.all)) for (const c of obj.all) collectConditions(c);
    if (Array.isArray(obj.any)) for (const c of obj.any) collectConditions(c);
    if (obj.condition) collectConditions(obj.condition);
  };

  // Handle bare array or { conditions: [...] } or { match, conditions }
  if (Array.isArray(criteria)) {
    for (const c of criteria) collectConditions(c);
  } else {
    collectConditions(criteria);
  }

  // Any referenced parameter that is NOT the object_reference param and IS an
  // object_reference param itself implies a shared/linked object reference.
  for (const paramName of referencedParams) {
    if (paramName === objectRefParamApiName) continue;
    const param = params.find((p) => p.apiName === paramName);
    if (param && param.type === "object_reference") {
      violations.push({
        code: "INLINE_EDIT_CRITERIA_LINKED_OBJECT",
        message: `Submission criteria references parameter "${paramName}" which is a linked/shared object — incompatible with inline edits.`,
      });
    }
  }

  return violations;
}
