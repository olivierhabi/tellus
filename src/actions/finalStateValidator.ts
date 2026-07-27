// ---------------------------------------------------------------------------
// Final-State Validator — One Validator for the Final Planned Graph (§4)
//
// Validates the final planned graph state against the version-2 invariants
// from §4 of the directive. Centralising these rules here (rather than
// duplicating them across individual rule compilers) means the final
// contract is enforced in exactly one place and is deterministically
// unit-testable without a database.
//
// The validator is PURE: it operates on the planner-computed final state
// (active objects + active M2M edges + final FK targets) plus the planned
// deltas. The transaction-time executor runs the SAME validator after
// reloading from inside the advisory-locked transaction, so concurrent
// writers can't slip a violation between plan and commit.
// ---------------------------------------------------------------------------

import {
  danglingRelationshipError,
  finalStateInvalidError,
  type ActionError,
} from "./actionErrors";
import type { ActionSemanticsVersion } from "./actionSemantics";
import type {
  ObjectIdentity,
  PlannedFkDelta,
  PlannedObjectDelta,
  PlannedRelationshipDelta,
} from "./actionPlanner";

// Reuse helper from planner (avoids re-deriving the canonical key shape).
export function objectKey(id: ObjectIdentity): string {
  return `${id.objectType}|${canonicalPk(id.primaryKey)}`;
}
function canonicalPk(pk: import("./objectReferenceResolver").PrimaryKeyValue): string {
  if (typeof pk === "boolean") return pk ? "B1" : "B0";
  if (typeof pk === "number") return `N:${pk}`;
  return `S:${pk}`;
}

export interface FinalStateValidationInput {
  semanticsVersion: ActionSemanticsVersion;
  objectDeltas: PlannedObjectDelta[];
  relationshipDeltas: PlannedRelationshipDelta[];
  fkDeltas: PlannedFkDelta[];
  /** Final object state (active identity keys). */
  finalObjectState: Set<string>;
  /** Final active M2M edges (canonical keys: link|src|tgt). */
  finalActiveEdges: Set<string>;
  /** Final FK targets per ownerKey|fkProperty → referenced objectKey|null. */
  finalFkTargets: Map<string, string | null>;
}

export interface FinalStateValidationError {
  error: ActionError;
}

/**
 * Validate the final planned graph. Returns a list of structured errors.
 * Empty list ⇒ final state is valid. A single failing invariant fails the
 * whole plan (no partial application).
 *
 * Version 2 enforces all of the following; version 1 only enforces the
 * invariants that were already enforced by the existing merge step
 * (create+delete conflict) and skips the v2-restrict additions.
 */
export function validateFinalState(
  input: FinalStateValidationInput,
): FinalStateValidationError[] {
  const errors: FinalStateValidationError[] = [];
  const v2 = input.semanticsVersion === 2;

  // 1. No final relationship whose source or target does not exist.
  //    Edge-key format (from actionPlanner): `link|srcObjType|srcPk|tgtObjType|tgtPk`
  //    — canonicalPk never contains '|', so the 5-way split is unambiguous.
  for (const edgeKey of input.finalActiveEdges) {
    const parts = edgeKey.split("|");
    const link = parts[0];
    const srcKey = `${parts[1]}|${parts[2]}`;
    const tgtKey = `${parts[3]}|${parts[4]}`;
    const danglingOn = !input.finalObjectState.has(srcKey)
      ? "source"
      : !input.finalObjectState.has(tgtKey)
        ? "target"
        : null;
    if (danglingOn) {
      errors.push({
        error: danglingRelationshipError(edgePath(edgeKey), {
          linkType: link,
          sourceObjectType: parts[1],
          targetObjectType: parts[3],
        }),
      });
    }
  }

  if (!v2) {
    // Version 1: only the dangling-relationship invariant above applies;
    // existing create+delete merging is handled by the rule compiler merge
    // step, so there is nothing more to check here for v1.
    return errors;
  }

  // 2. addLink targeting a deleted object is rejected.
  // 3. addLink after deleteObject is rejected (delete then add link fails).
  //    Both reduce to: an add whose source or target is removed in the plan.
  const deletedKeys = new Set<string>();
  for (const d of input.objectDeltas) {
    if (d.op === "delete") deletedKeys.add(objectKey(d.identity));
  }
  for (const rel of input.relationshipDeltas) {
    if (rel.op !== "add") continue;
    const src = objectKey(rel.source);
    const tgt = objectKey(rel.target);
    if (deletedKeys.has(src) || deletedKeys.has(tgt)) {
      errors.push({
        error: finalStateInvalidError(
          `addLink (rule ${rel.ruleIndex}) targets an object that is deleted in the same invocation.`,
          `rules[${rel.ruleIndex}]`,
        ),
      });
    }
  }

  // 4. FK assignment to a deleted object is rejected.
  for (const fk of input.fkDeltas) {
    if (!fk.newValueIdentity) continue; // FK clear — allowed / treated as removal
    const refKey = objectKey(fk.newValueIdentity);
    if (deletedKeys.has(refKey)) {
      errors.push({
        error: finalStateInvalidError(
          `FK update (rule ${fk.ruleIndex}) references an object that is deleted in the same invocation.`,
          `rules[${fk.ruleIndex}]`,
        ),
      });
    }
  }

  // 5. FK clear before delete of the FK owner's referenced target is allowed
  //    (a planned null FK is a relationship removal; the target may then be
  //    deleted as long as no other active edge remains).

  return errors;
}

// ---------------------------------------------------------------------------
// Edge-key path helper
// ---------------------------------------------------------------------------

function edgePath(edgeKey: string): string {
  return `rules[*].relationship.${edgeKey}`;
}
