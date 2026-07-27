// ---------------------------------------------------------------------------
// Canonical Action Rule shape validators (pure, DB-free, async-safe)
//
// Stateless, pure functions that validate the canonical rule-body shape
// declared in `actionRules.types.ts`. Used by:
//   - the BE route layer (`routes/actionTypes.ts`) at POST/PATCH time
//     before the controllers dispatch into the DB-coupled object-type
//     lookup,
//   - unit tests that need to assert a rule body is structurally valid
//     without standing up Postgres,
//   - (planned) the FE rule-shape validator on save so the user sees
//     the same errors the BE will surface — without a round-trip.
//
// Each validator returns an array of human-readable error strings; an
// empty array means the rule body is structurally OK. The validators
// deliberately do NOT cross-reference the ontology (link type existence,
// parameter declaration existence) — they only check the rule's shape.
// The route layer that owns ontology lookup composes these pure helpers
// with its DB-side existence checks.
// ---------------------------------------------------------------------------

import type {
  ActionRule,
  AddLinkRule,
  RemoveLinkRule,
  CreateInterfaceLinkRule,
  DeleteInterfaceLinkRule,
} from "./actionRules.types";

/** Allowed ValueSource `source` values (mirrors the runtime's `ValueSource` union). The route layer's `validateValueSource` uses a duplicate Set; this is the canonical source of truth for the type-only consumers. */
export const CANONICAL_VALUE_SOURCE_KINDS = new Set([
  "parameter",
  "static",
  "currentTimestamp",
  "currentUser",
  "writebackResponse",
]);

/**
 * Validate the canonical concrete-link rule shape
 * (`addLink` / `removeLink`). Returns an array of error strings; empty
 * when structurally OK. The function does NOT consult the ontology —
 * the route layer composes the canonical shape check with its own
 * link-type existence check.
 *
 *   {
 *     type: 'addLink' | 'removeLink',
 *     linkType: <apiName>,                          // canonical field
 *     sourceObject: ValueSource,                      // { source: 'parameter', param, objectType? }
 *     targetObject: ValueSource
 *   }
 *
 * Legacy alias: `linkTypeApiName` is accepted on input only (no longer
 * emitted by new code) to keep the 24 seeded addLink actions valid.
 */
export function validateConcreteLinkRuleShape(rule: unknown): string[] {
  const errors: string[] = [];
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    return ["addLink/removeLink rule must be an object."];
  }
  const r = rule as Record<string, unknown>;

  // type
  if (r.type !== "addLink" && r.type !== "removeLink") {
    errors.push("type must be 'addLink' or 'removeLink'.");
    return errors; // shape unknown beyond the type
  }

  // linkType (canonical) - legacy linkTypeApiName accepted as alias
  const linkTypeRaw = r.linkType ?? r.linkTypeApiName;
  if (typeof linkTypeRaw !== "string" || linkTypeRaw.length === 0) {
    errors.push("linkType is required (canonical field used by the runtime). The legacy alias 'linkTypeApiName' is accepted on input only.");
  }

  // sourceObject and targetObject — both required ValueSource objects.
  for (const sideKey of ["sourceObject", "targetObject"] as const) {
    const side = r[sideKey];
    if (!side || typeof side !== "object" || Array.isArray(side)) {
      errors.push(`${sideKey} is required and must be a ValueSource object.`);
      continue;
    }
    errors.push(...validateValueSourceShape(side, sideKey));
  }

  return errors;
}

/**
 * Validate the interface-link rule shape (`createInterfaceLink` /
 * `deleteInterfaceLink`). Returns an array of error strings; empty when
 * structurally OK.
 *
 *   {
 *     type: 'createInterfaceLink' | 'deleteInterfaceLink',
 *     interfaceLinkConstraint: <apiName>,
 *     interfaceId: <apiName>,
 *     source: ValueSource,
 *     target:  ValueSource
 *   }
 *
 * Phase 1 calls these to round-trip type-check the FE body; the route
 * layer additionally rejects persistence until Phase 2 routes wire up
 * the runtime resolver.
 */
export function validateInterfaceLinkRuleShape(rule: unknown): string[] {
  const errors: string[] = [];
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    return ["createInterfaceLink/deleteInterfaceLink rule must be an object."];
  }
  const r = rule as Record<string, unknown>;

  if (r.type !== "createInterfaceLink" && r.type !== "deleteInterfaceLink") {
    errors.push("type must be 'createInterfaceLink' or 'deleteInterfaceLink'.");
    return errors;
  }

  if (typeof r.interfaceLinkConstraint !== "string" || r.interfaceLinkConstraint.length === 0) {
    errors.push("interfaceLinkConstraint is required.");
  }
  if (typeof r.interfaceId !== "string" || r.interfaceId.length === 0) {
    errors.push("interfaceId is required.");
  }

  for (const sideKey of ["source", "target"] as const) {
    const side = r[sideKey];
    if (!side || typeof side !== "object" || Array.isArray(side)) {
      errors.push(`${sideKey} is required and must be a ValueSource object.`);
      continue;
    }
    errors.push(...validateValueSourceShape(side, sideKey));
  }

  return errors;
}

/**
 * Pure structural validator for a single ValueSource object.
 */
export function validateValueSourceShape(
  valueSource: unknown,
  path: string,
): string[] {
  if (!valueSource || typeof valueSource !== "object" || Array.isArray(valueSource)) {
    return [`${path} must be a value source object.`];
  }
  const v = valueSource as Record<string, unknown>;
  if (typeof v.source !== "string" || !CANONICAL_VALUE_SOURCE_KINDS.has(v.source)) {
    return [`${path}.source must be one of: ${Array.from(CANONICAL_VALUE_SOURCE_KINDS).join(", ")}`];
  }
  if (v.source === "parameter") {
    if (typeof v.param !== "string" || v.param.length === 0) {
      return [`${path}: source 'parameter' requires a non-empty 'param' field.`];
    }
  }
  // writebackResponse requires outputId + optionally path (validated against the
  // webhook outputSchema at save time by the route layer; not here).
  if (v.source === "writebackResponse") {
    if (typeof v.outputId !== "string" || v.outputId.length === 0) {
      return [`${path}: source 'writebackResponse' requires an 'outputId' field.`];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Type guards: runtime narrows so callers can switch on rule.type
// ---------------------------------------------------------------------------

export function isConcreteLinkRule(rule: unknown): rule is AddLinkRule | RemoveLinkRule {
  return (
    !!rule && typeof rule === "object" && !Array.isArray(rule) &&
    ((rule as Record<string, unknown>).type === "addLink" ||
     (rule as Record<string, unknown>).type === "removeLink")
  );
}

export function isInterfaceLinkRule(
  rule: unknown,
): rule is CreateInterfaceLinkRule | DeleteInterfaceLinkRule {
  return (
    !!rule && typeof rule === "object" && !Array.isArray(rule) &&
    ((rule as Record<string, unknown>).type === "createInterfaceLink" ||
     (rule as Record<string, unknown>).type === "deleteInterfaceLink")
  );
}

export function isCanonicalActionRule(rule: unknown): rule is ActionRule {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return false;
  const t = (rule as Record<string, unknown>).type;
  return typeof t === "string" && [
    "createObject", "modifyObject", "modifyOrCreateObject", "deleteObject",
    "addLink", "removeLink",
    "createInterfaceLink", "deleteInterfaceLink",
  ].includes(t);
}
