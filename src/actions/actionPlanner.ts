// ---------------------------------------------------------------------------
// Action Planner — Deterministic Plan Construction (§4)
//
// Introduces a planning stage between parameter validation and transaction
// application. The planner does NOT validate each rule only against DB
// state independently — it accounts for persisted state, earlier in-invocation
// edits, FK changes, deletions, creates, rule ordering, and produces a
// single normalized, ordered final-state plan.
//
// The planner is pure logic over its inputs (prior-state + planned deltas);
// it does not touch the database. Reload/lock acquisition happens at the
// executor boundary (§6 sequence). This makes the planner + the
// final-state validator deterministically unit-testable without a DB.
// ---------------------------------------------------------------------------

import {
  type ActionSemanticsVersion,
} from "./actionSemantics";
import {
  sameInvocationReferenceForbiddenError,
  duplicatePrimaryKeyError,
  unsupportedSemanticsVersionError,
  type ActionError,
} from "./actionErrors";
import {
  canonicalPrimaryKey,
  type LockIdentity,
} from "./actionLockManager";
import { validateFinalState, type FinalStateValidationError } from "./finalStateValidator";
import type { PrimaryKeyValue } from "./objectReferenceResolver";

// ---------------------------------------------------------------------------
// Plan input types
// ---------------------------------------------------------------------------

export type ObjectOp = "create" | "update" | "delete";
export type RelationshipOp = "add" | "remove";

export interface ObjectIdentity {
  ontologyId: string;
  branchId: string;
  objectType: string;
  primaryKey: PrimaryKeyValue;
}

/** A planned object mutation, produced by the rule compiler. */
export interface PlannedObjectDelta {
  identity: ObjectIdentity;
  op: ObjectOp;
  propertyValues?: Record<string, unknown> | null;
  /** Index of the rule that produced this delta (for path/error reporting). */
  ruleIndex: number;
}

/**
 * A planned M2M relationship mutation. FK-backed relationships are modelled
 * as object property updates (a pending FK clear sets the FK property to
 * null), but the planner also accepts FK relationship deltas explicitly so
 * the final-state validator can treat a FK clear as relationship removal
 * and a FK-set-to-deleted-object as a violation.
 */
export interface PlannedRelationshipDelta {
  linkTypeApiName: string;
  source: ObjectIdentity;
  target: ObjectIdentity;
  op: RelationshipOp;
  ruleIndex: number;
}

/**
 * A pending FK-property change on an object that participates in a
 * FK-backed relationship. `newValueIdentity` is null when the FK is being
 * cleared (relationship removal); otherwise it's the object the FK now
 * references. Used by the validator to detect FK-set-to-deleted-object.
 */
export interface PlannedFkDelta {
  fkPropertyApiName: string;
  owningObject: ObjectIdentity;
  linkTypeApiName: string;
  newValueIdentity: ObjectIdentity | null;
  ruleIndex: number;
}

export interface PlannedSteps {
  objectDeltas: PlannedObjectDelta[];
  relationshipDeltas: PlannedRelationshipDelta[];
  fkDeltas: PlannedFkDelta[];
  /** Object identities that exist in persisted state before the plan. */
  persistedExistingObjects: Set<string>;
  /** Persisted active M2M edges (canonical edge keys) before the plan. */
  persistedActiveEdges: Set<string>;
}

export interface ActionPlan {
  executionId: string;
  correlationId: string;
  semanticsVersion: ActionSemanticsVersion;
  objectDeltas: PlannedObjectDelta[];
  relationshipDeltas: PlannedRelationshipDelta[];
  fkDeltas: PlannedFkDelta[];
  /** Final object state (active) — identities still present after the plan. */
  finalObjectState: Set<string>;
  /** Final active M2M edges (canonical keys) after applying the plan. */
  finalActiveEdges: Set<string>;
  /** Final FK targets per (objectType, pk, fkProperty) → referenced identity key. */
  finalFkTargets: Map<string, string | null>;
  requiredLocks: LockIdentity[];
  valid: boolean;
  errors: ActionError[];
}

// ---------------------------------------------------------------------------
// Canonical keys (reuse the lock-manager canonical serialiser)
// ---------------------------------------------------------------------------

export function objectKey(id: ObjectIdentity): string {
  return canonicalPrimaryKey(id.primaryKey) === ""
    ? `${id.objectType}|${canonicalPrimaryKey(id.primaryKey)}`
    : `${id.objectType}|${canonicalPrimaryKey(id.primaryKey)}`;
}

/** Canonical identity-as-LockIdentity coercion for the lock manager. */
function asLockId(id: ObjectIdentity): LockIdentity {
  return {
    ontologyId: id.ontologyId,
    branchId: id.branchId,
    objectType: id.objectType,
    primaryKey: id.primaryKey,
  };
}

// ---------------------------------------------------------------------------
// Same-invocation restriction (version 2)
// ---------------------------------------------------------------------------

interface SameInvocationCheck {
  ok: boolean;
  error?: ActionError;
}

/**
 * Version-2 forbids create→modify, create→delete, create→modify-or-create of
 * the same identity within a single invocation, EVEN when the final state
 * could otherwise be valid. Version 1 keeps its existing permissive
 * behaviour (create then modify/delete is supported there).
 */
function checkSameInvocationRestriction(
  objectDeltas: PlannedObjectDelta[],
  version: ActionSemanticsVersion,
): SameInvocationCheck {
  if (version !== 2) return { ok: true };

  // Track create targets; a later modify/delete targeting one is forbidden.
  const createdKeys = new Set<string>();
  const createIndexByKey = new Map<string, number>();
  for (const d of objectDeltas) {
    const key = objectKey(d.identity);
    if (d.op === "create") {
      if (createdKeys.has(key)) {
        return {
          ok: false,
          error: duplicatePrimaryKeyError(
            `rules[${d.ruleIndex}]`,
            d.identity.objectType,
            String(d.identity.primaryKey),
          ),
        };
      }
      createdKeys.add(key);
      createIndexByKey.set(key, d.ruleIndex);
      continue;
    }
    if ((d.op === "update" || d.op === "delete") && createdKeys.has(key)) {
      const createIdx = createIndexByKey.get(key)!;
      const err = sameInvocationReferenceForbiddenError(
        `rules[${d.ruleIndex}]`,
        {
          objectType: d.identity.objectType,
          primaryKey: String(d.identity.primaryKey),
        },
      );
      return {
        ok: false,
        error: {
          ...err,
          meta: {
            ...(err.meta ?? {}),
            originatingCreateRuleIndex: createIdx,
          },
        },
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Final object state computation
// ---------------------------------------------------------------------------

/**
 * Compute the final object state (active identities) by applying the plan's
 * object deltas to the persisted-existing set. Creates add, deletes remove,
 * updates keep (identity unchanged). A modify-or-create missing-object case
 * manifests as a `create` here (rule compiler emits a create for the missing
 * branch), so `may_exist` correctness is preserved.
 */
export function computeFinalObjectState(
  persisted: Set<string>,
  objectDeltas: PlannedObjectDelta[],
): Set<string> {
  const out = new Set(persisted);
  for (const d of objectDeltas) {
    const key = objectKey(d.identity);
    if (d.op === "delete") {
      out.delete(key);
    } else {
      // create or update — identity present in final state
      out.add(key);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main planner
// ---------------------------------------------------------------------------

export interface PlanResult {
  plan: ActionPlan | null;
  errors: ActionError[];
}

export function buildActionPlan(
  semanticsVersion: ActionSemanticsVersion,
  steps: PlannedSteps,
  context: { executionId: string; correlationId: string },
): PlanResult {
  const errors: ActionError[] = [];

  // Unknown versions fail closed — never silently run an unknown version.
  if (semanticsVersion !== 1 && semanticsVersion !== 2) {
    return {
      plan: null,
      errors: [unsupportedSemanticsVersionError(semanticsVersion)],
    };
  }

  // Version-2 same-invocation restriction.
  const sameCheck = checkSameInvocationRestriction(
    steps.objectDeltas,
    semanticsVersion,
  );
  if (!sameCheck.ok && sameCheck.error) {
    errors.push(sameCheck.error);
  }

  // Duplicate-create detection (applies to both versions; v2 caught above too).
  const createKeys = new Set<string>();
  for (const d of steps.objectDeltas) {
    if (d.op === "create") {
      const k = objectKey(d.identity);
      if (createKeys.has(k)) {
        errors.push(
          duplicatePrimaryKeyError(
            `rules[${d.ruleIndex}]`,
            d.identity.objectType,
            String(d.identity.primaryKey),
          ),
        );
      } else {
        createKeys.add(k);
      }
    }
  }

  // Compute final object state + final active M2M edges + final FK targets.
  const finalObjectState = computeFinalObjectState(
    steps.persistedExistingObjects,
    steps.objectDeltas,
  );

  // Merge persisted active edges with planned add/remove deltas.
  const finalActiveEdges = new Set(steps.persistedActiveEdges);
  for (const rel of steps.relationshipDeltas) {
    const edgeKeyStr = `${rel.linkTypeApiName}|${objectKey(rel.source)}|${objectKey(rel.target)}`;
    if (rel.op === "add") finalActiveEdges.add(edgeKeyStr);
    else finalActiveEdges.delete(edgeKeyStr);
  }

  // Final FK targets (objectKey|fkProperty → referenced objectKey or null).
  // Initialise from persisted (not modelled explicitly here); the validator
  // treats FK clears as relationship removals and FK-set-to-deleted as
  // violations. We only need planned FK deltas for the validation.
  const finalFkTargets = new Map<string, string | null>();
  for (const fk of steps.fkDeltas) {
    const ownerKey = objectKey(fk.owningObject);
    const mapKey = `${ownerKey}|${fk.fkPropertyApiName}`;
    finalFkTargets.set(
      mapKey,
      fk.newValueIdentity ? objectKey(fk.newValueIdentity) : null,
    );
  }

  // Final-state validation (delegated).
  const fsErrors = validateFinalState({
    semanticsVersion,
    objectDeltas: steps.objectDeltas,
    relationshipDeltas: steps.relationshipDeltas,
    fkDeltas: steps.fkDeltas,
    finalObjectState,
    finalActiveEdges,
    finalFkTargets,
  });
  errors.push(...fsErrors.map(toActionError));

  // Required locks: every object identity mutated or referenced.
  const lockIdentities: LockIdentity[] = [];
  for (const d of steps.objectDeltas) lockIdentities.push(asLockId(d.identity));
  for (const r of steps.relationshipDeltas) {
    lockIdentities.push(asLockId(r.source));
    lockIdentities.push(asLockId(r.target));
  }
  for (const f of steps.fkDeltas) {
    lockIdentities.push(asLockId(f.owningObject));
    if (f.newValueIdentity) lockIdentities.push(asLockId(f.newValueIdentity));
  }

  const plan: ActionPlan = {
    executionId: context.executionId,
    correlationId: context.correlationId,
    semanticsVersion,
    objectDeltas: steps.objectDeltas,
    relationshipDeltas: steps.relationshipDeltas,
    fkDeltas: steps.fkDeltas,
    finalObjectState,
    finalActiveEdges,
    finalFkTargets,
    requiredLocks: lockIdentities,
    valid: errors.length === 0,
    errors,
  };

  return { plan, errors };
}

function toActionError(e: FinalStateValidationError): ActionError {
  return e.error;
}
