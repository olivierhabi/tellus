// ---------------------------------------------------------------------------
// Interface-Link Rule Handler — runtime resolver for createInterfaceLink /
// deleteInterfaceLink rules.
//
// Per the public behavioural spec:
//   * Creation: resolve to a SINGLE concrete link_type that satisfies the
//     interface_link_constraint against the resolved source/target object
//     types. Fail BEFORE applying any edits when more than one concrete
//     link_type ambiguously satisfies the constraint (so no ontology edit
//     is ever applied to a non-deterministically-resolved create) OR when
//     zero satisfy it.
//   * Deletion: emit a removeLink edit for EVERY concrete link_type that
//     satisfies the constraint. The deletion plan is deterministic (sorted
//     by link_type.api_name) and auditable.
//
// Concrete link_type(s) considered "matching" the constraint must:
//   1. Share the constraint's cardinality.
//   2. Have their source_object_type implement the constraint's owning
//      interface_id (via object_type_interface).
//   3. Have their target_object_type match the constraint's target side:
//      - if target_interface_id is non-NULL: the link_type's target_object_type
//        MUST implement that interface.
//      - if target_object_type_id is non-NULL: the link_type's target_object_type
//        MUST BE that object_type_id.
//   4. The runtime source object's resolved concrete object_type MUST
//      match the candidate link_type's source_object_type AND the runtime
//      target object's resolved concrete object_type MUST match the
//      candidate link_type's target_object_type.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import { getInterfaceLinkConstraintByApiName } from "../../models/interfaceLinkConstraint";
import {
  resolveObjectTypeApiName,
  getByApiName as getLinkTypeByApiName,
} from "../../models/linkType";
import type { LinkTypeRow } from "../../models/linkType";

// ---------------------------------------------------------------------------
// Types (mirror the canonical domain types declared in actionRules.types.ts)
// ---------------------------------------------------------------------------

export type InterfaceLinkOperation = "createInterfaceLink" | "deleteInterfaceLink";

export interface InterfaceLinkRuleRuntime {
  type: InterfaceLinkOperation;
  /** apiName of the interface_link_constraint. */
  interfaceLinkConstraint: string;
  /** apiName of the interface that OWNS the constraint (declared on the rule body for sanity-check). */
  interfaceId: string;
  /** ValueSource pointing at a parameter (object_reference). */
  source: { source: "parameter"; param: string; objectType?: string };
  /** ValueSource pointing at a parameter (object_reference). */
  target: { source: "parameter"; param: string; objectType?: string };
}

// ---------------------------------------------------------------------------
// Concrete Link Type candidate
// ---------------------------------------------------------------------------

interface CandidateLink {
  linkType: LinkTypeRow;
}

// ---------------------------------------------------------------------------
// Resolve — given a constraint + runtime source/target object types, find
// the concrete link_type(s) that satisfy the contract.
// ---------------------------------------------------------------------------

/**
 * Resolve the concrete link_type(s) that satisfy the interface-link
 * constraint against the resolved source/target concrete object types.
 *
 * Returns the candidate list (possibly empty). Throws on structural issues
 * (constraint not found, runtime source/target not typed, object types
 * not implementing the required interfaces).
 *
 * The resolver never mutates state. It is the caller's responsibility
 * (ruleCompiler) to assemble the edit list from the returned candidate(s)
 * — emitting a single addLink when exactly one candidate matches (create)
 * OR multiple removeLinks ordered by link_type.api_name for delete.
 */
export async function resolveInterfaceLinkRule(
  ontologyId: string,
  rule: InterfaceLinkRuleRuntime,
): Promise<
  | { kind: "ok"; candidates: LinkTypeRow[] }
  | { kind: "missing"; constraintApiName: string }
  | { kind: "ambiguous"; candidates: LinkTypeRow[] }
  | { kind: "no_match"; constraintApiName: string }
  | { kind: "invalid"; errors: string[] }
> {
  const errors: string[] = [];

  // 1. Load the interface link constraint.
  const constraint = await getInterfaceLinkConstraintByApiName(ontologyId, rule.interfaceLinkConstraint);
  if (!constraint) {
    return { kind: "missing", constraintApiName: rule.interfaceLinkConstraint };
  }

  // Deactivated constraints refuse to be resolved for new action types.
  // Phase 2 activates the constraint via status='active' when authoring
  // an action type that references it; this resolver enforces it at runtime.
  if (constraint.status === "deprecated") {
    errors.push(`interface_link_constraint '${rule.interfaceLinkConstraint}' is deprecated; cannot be used in new action types.`);
  }

  // 2. Sanity check the rule's declared owning interface matches the constraint's.
  // The constraint's interface_id is the owning interface UUID; the rule
  // declares the owning interface's apiName. Resolve the interface_id →
  // apiName and compare.
  const ifaceRes = await query("SELECT api_name FROM interface WHERE interface_id = $1", [constraint.interface_id]);
  if (ifaceRes.rows.length === 0) {
    errors.push(`interface_link_constraint '${rule.interfaceLinkConstraint}' references a non-existent owning interface.`);
  } else if (rule.interfaceId && ifaceRes.rows[0].api_name !== rule.interfaceId) {
    errors.push(`interfaceId '${rule.interfaceId}' on the rule does not match the constraint's owning interface '${ifaceRes.rows[0].api_name}'.`);
  }

  // 3. The source ValueSource must declare an objectType (object_reference
  // parameter's objectType). Resolve the runtime source/target object types
  // — Phase 2 supports only `parameter` value sources (no `ruleRef` to
  // objects created earlier in the action yet).
  if (!rule.source?.objectType) {
    errors.push("createInterfaceLink/deleteInterfaceLink rule: source.objectType is required (Phase 2 supports only typed parameter value sources).");
  }
  if (!rule.target?.objectType) {
    errors.push("createInterfaceLink/deleteInterfaceLink rule: target.objectType is required (Phase 2 supports only typed parameter value sources).");
  }
  if (errors.length > 0) {
    return { kind: "invalid", errors };
  }

  const sourceApiName = rule.source.objectType!;
  const targetApiName = rule.target.objectType!;

  // 4. Resolve the runtime source/target object_type UUIDs.
  let sourceObjectTypeId: string | null = null;
  let targetObjectTypeId: string | null = null;
  try {
    const r1 = await query(
      "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
      [ontologyId, sourceApiName],
    );
    if (r1.rows.length === 0) {
      errors.push(`src object type '${sourceApiName}' not found.`);
    } else {
      sourceObjectTypeId = r1.rows[0].object_type_id;
    }
  } catch {
    errors.push(`could not resolve source object type '${sourceApiName}'.`);
  }
  try {
    const r2 = await query(
      "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
      [ontologyId, targetApiName],
    );
    if (r2.rows.length === 0) {
      errors.push(`target object type '${targetApiName}' not found.`);
    } else {
      targetObjectTypeId = r2.rows[0].object_type_id;
    }
  } catch {
    errors.push(`could not resolve target object type '${targetApiName}'.`);
  }
  if (errors.length > 0) {
    return { kind: "invalid", errors };
  }

  // 5. Verify the runtime source object type implements the constraint's
  // owning interface. The constraint requires this: source side of every
  // interface-link rule is polymorphic over the owning interface.
  const sourceImplRes = await query(
    "SELECT 1 FROM object_type_interface WHERE object_type_id = $1 AND interface_id = $2",
    [sourceObjectTypeId, constraint.interface_id],
  );
  if (sourceImplRes.rows.length === 0) {
    errors.push(
      `source object type '${sourceApiName}' does not implement interface '` +
      `${ifaceRes.rows[0]?.api_name ?? "?"}' (interface_id=${constraint.interface_id}).`,
    );
  }

  // 6. Verify the runtime target matches the constraint's target side:
  //    - if target_interface_id is set: target must implement that interface.
  //    - if target_object_type_id is set: target must be that object_type.
  if (constraint.target_interface_id) {
    const targetImplRes = await query(
      "SELECT 1 FROM object_type_interface WHERE object_type_id = $1 AND interface_id = $2",
      [targetObjectTypeId, constraint.target_interface_id],
    );
    if (targetImplRes.rows.length === 0) {
      errors.push(
        `target object type '${targetApiName}' does not implement the constraint's target interface.`,
      );
    }
  } else if (constraint.target_object_type_id) {
    if (targetObjectTypeId !== constraint.target_object_type_id) {
      errors.push(
        `target object type '${targetApiName}' does not match the constraint's target object type.`,
      );
    }
  }

  if (errors.length > 0) {
    return { kind: "invalid", errors };
  }

  // 7. Find all concrete link_type(s) in the ontology whose source/target
  //    object types match the runtime {sourceObjectTypeId, targetObjectTypeId}
  //    and whose cardinality matches the constraint. These are the
  //    concrete implementations of the constraint for this runtime
  //    resolution.
  //
  //    The Phase 2 resolver is intentionally strict: candidates must
  //    match the runtime's source AND target object type uuids and the
  //    constraint's cardinality. This keeps ambiguity detection tractable
  //    (the operator's intent is "this specific pair of runtime object
  //    types implements this interface contract; the link_type that
  //    binds them implements the contract").
  const candidateResults = await query(
    `SELECT * FROM link_type
      WHERE ontology_id = $1
        AND source_object_type = $2
        AND target_object_type = $3
        AND cardinality = $4`,
    [ontologyId, sourceObjectTypeId, targetObjectTypeId, constraint.cardinality],
  );
  const candidates: LinkTypeRow[] = [];
  for (const row of candidateResults.rows) {
    // Re-fetch via getByApiName to get the well-formed LinkTypeRow (the
    // raw SELECT * row types UUIDs differently across PG versions).
    const lt = await getLinkTypeByApiName(ontologyId, row.api_name);
    if (lt) candidates.push(lt);
  }

  if (candidates.length === 0) {
    return { kind: "no_match", constraintApiName: rule.interfaceLinkConstraint };
  }

  // 8. For createInterfaceLink, ambiguity is failure (more than one candidate).
  //    For deleteInterfaceLink, all-matching is the contract — every candidate
  //    becomes a removeLink.
  if (rule.type === "createInterfaceLink" && candidates.length > 1) {
    return { kind: "ambiguous", candidates };
  }

  return { kind: "ok", candidates };
}

/**
 * Build the concrete addLink/removeLink edit for each candidate link type.
 * The rule-compiler uses this to assemble the final edit list. Returned
 * edits are concrete addLink/removeLink-shaped records the existing
 * `ruleCompiler.compileLinkRule` understands.
 */
export function buildConcreteLinkEditsFromCandidates(
  rule: InterfaceLinkRuleRuntime,
  candidates: LinkTypeRow[],
): Array<
  | { type: "addLink"; linkType: string; sourceObject: unknown; targetObject: unknown }
  | { type: "removeLink"; linkType: string; sourceObject: unknown; targetObject: unknown }
> {
  // Sort by apiName for deterministic deletion plans.
  const sorted = [...candidates].sort((a, b) => a.api_name.localeCompare(b.api_name));

  return sorted.map((lt) => ({
    type: rule.type === "createInterfaceLink" ? "addLink" : "removeLink",
    linkType: lt.api_name,
    sourceObject: {
      source: rule.source.source,
      param: rule.source.param,
      ...(rule.source.objectType ? { objectType: rule.source.objectType } : {}),
    },
    targetObject: {
      source: rule.target.source,
      param: rule.target.param,
      ...(rule.target.objectType ? { objectType: rule.target.objectType } : {}),
    },
  }));
}
