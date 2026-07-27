// ---------------------------------------------------------------------------
// Action V2 Plan Builder
//
// Constructs the planner's `PlannedSteps` directly from the action type's
// rules + resolved parameters (NOT from the merged compiled edits), so the
// version-2 same-invocation restriction and the final-state validator see
// faithful rule ordering and unmerged per-rule deltas.
//
// Object identities are resolved via `canonicalizeObjectReference` for
// typed `object_reference` parameters, and via the primary-key property
// mapping for `createObject` rules. String parameters used as references
// are rejected for v2 (per the semantics matrix).
// ---------------------------------------------------------------------------

import {
  canonicalizeObjectReference,
  type ObjectTypeSchemaLookup,
  type ObjectIdentity,
  type PrimaryKeyValue,
} from "./objectReferenceResolver";
import {
  type PlannedObjectDelta,
  type PlannedRelationshipDelta,
  type PlannedFkDelta,
  type PlannedSteps,
  objectKey,
} from "./actionPlanner";
import { invalidObjectReferenceError, type ActionError } from "./actionErrors";
import { behaviourMatrix, type ActionSemanticsVersion } from "./actionSemantics";

interface ValueSource {
  source: "parameter" | "static" | "currentTimestamp" | "currentUser";
  param?: string;
  value?: unknown;
}

interface RuleLike {
  type: string;
  objectType?: string;
  linkType?: string;
  objectReference?: ValueSource;
  sourceObject?: ValueSource;
  targetObject?: ValueSource;
  properties?: Record<string, ValueSource>;
}

interface ParamLike {
  apiName: string;
  type: string;
  objectType?: string;
}

export interface PlanBuildContext {
  ontologyId: string;
  branchId: string;
  semanticsVersion: ActionSemanticsVersion;
  schemaLookup: ObjectTypeSchemaLookup;
}

export interface PlanBuildResult {
  ok: boolean;
  steps?: PlannedSteps;
  errors: ActionError[];
}

/** Resolve a ValueSource to a raw value using resolved parameters + context. */
function resolveSourceValue(
  source: ValueSource | undefined,
  resolvedParameters: Record<string, unknown>,
  executedBy: string,
): unknown {
  if (!source || typeof source !== "object") return undefined;
  switch (source.source) {
    case "parameter":
      return resolvedParameters[source.param!];
    case "static":
      return source.value;
    case "currentTimestamp":
      return new Date().toISOString();
    case "currentUser":
      return executedBy;
    default:
      return undefined;
  }
}

/**
 * Build PlannedSteps from rules. For version 2, modify/delete/modify-or-create
 * rules require a typed `object_reference` parameter; a primitive string
 * parameter used as the reference is rejected with INVALID_OBJECT_REFERENCE.
 */
export async function buildPlannedStepsFromRules(
  rules: RuleLike[],
  parameters: ParamLike[],
  resolvedParameters: Record<string, unknown>,
  persisted: { existingObjects: Set<string>; activeEdges: Set<string> },
  ctx: PlanBuildContext,
  executedBy: string,
): Promise<PlanBuildResult> {
  const errors: ActionError[] = [];
  const paramByApi = new Map<string, ParamLike>();
  for (const p of parameters) paramByApi.set(p.apiName, p);

  const objectDeltas: PlannedObjectDelta[] = [];
  const relationshipDeltas: PlannedRelationshipDelta[] = [];
  const fkDeltas: PlannedFkDelta[] = [];

  // Track resolved identities per rule for FK-pk derivation of createObject.
  const pkPropByObjectType = new Map<string, string>();

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const ruleIdx = i;

    if (
      rule.type === "createObject" ||
      rule.type === "modifyObject" ||
      rule.type === "modifyOrCreateObject" ||
      rule.type === "deleteObject"
    ) {
      if (!rule.objectType) {
        errors.push(invalidObjectReferenceError(`rules[${i}]`, `Rule ${rule.type} has no objectType.`));
        continue;
      }
      // Resolve the target identity.
      let identity: ObjectIdentity | null = null;

      if (rule.type === "createObject") {
        // PK comes from the property mapping (the PK property's source).
        // Look up the PK property name for this object type.
        const pkDef = await ctx.schemaLookup(ctx.ontologyId, rule.objectType);
        if (!pkDef) {
          errors.push(invalidObjectReferenceError(`rules[${i}]`, `Object type '${rule.objectType}' not found or has no primary key.`));
          continue;
        }
        pkPropByObjectType.set(rule.objectType, pkDef.apiName);
        const pkSource = rule.properties?.[pkDef.apiName];
        const rawPk = resolveSourceValue(pkSource, resolvedParameters, executedBy);
        if (rawPk === undefined || rawPk === null) {
          errors.push(invalidObjectReferenceError(`rules[${i}]`, `createObject rule does not supply a primary key value for '${pkDef.apiName}'.`));
          continue;
        }
        identity = {
          ontologyId: ctx.ontologyId,
          branchId: ctx.branchId,
          objectType: rule.objectType,
          primaryKey: rawPk as PrimaryKeyValue,
        };
      } else {
        // modify / modify-or-create / delete → require object_reference param.
        const ref = rule.objectReference;
        if (!ref || ref.source !== "parameter" || !ref.param) {
          errors.push(invalidObjectReferenceError(`rules[${i}]`, `${rule.type} rule requires a parameter objectReference.`));
          continue;
        }
        const param = paramByApi.get(ref.param);
        if (!param) {
          errors.push(invalidObjectReferenceError(`rules[${i}]`, `objectReference references unknown parameter '${ref.param}'.`));
          continue;
        }
        // v2 rejects primitive string parameters used as object references.
        if (ctx.semanticsVersion === 2 && param.type !== "object_reference") {
          errors.push(invalidObjectReferenceError(
            `rules[${i}].objectReference`,
            `Version-2 ${rule.type} requires a typed 'object_reference' parameter; '${ref.param}' is type '${param.type}'.`,
            { parameterType: param.type },
          ));
          continue;
        }
        // v1 allows primitive string parameters (legacy). Resolve as a
        // best-effort identity using the declared objectType if present.
        const canResult = await canonicalizeObjectReference(
          param,
          resolvedParameters[ref.param],
          { ontologyId: ctx.ontologyId, branchId: ctx.branchId },
          { schemaLookup: ctx.schemaLookup, semanticVersion: ctx.semanticsVersion },
        );
        if (!canResult.ok) {
          errors.push(canResult.error);
          continue;
        }
        identity = canResult.identity;
      }

      const op =
        rule.type === "createObject"
          ? "create"
          : rule.type === "deleteObject"
            ? "delete"
            : "update";
      // modify-or-create: the rule compiler decides create vs update at
      // compile time; for planning we mark it "update" tentatively (may_exist).
      // The planner's same-invocation check only cares about create vs non-create;
      // a modify-or-create that ends up creating is modelled as 'create' below
      // when the persisted object is absent.
      const persistedHasKey = persisted.existingObjects.has(objectKey(identity));
      const effectiveOp =
        rule.type === "modifyOrCreateObject"
          ? persistedHasKey
            ? "update"
            : "create"
          : op;
      objectDeltas.push({ identity, op: effectiveOp, ruleIndex: ruleIdx });
      continue;
    }

    if (rule.type === "addLink" || rule.type === "removeLink") {
      if (!rule.objectType && !rule.linkType) {
        errors.push(invalidObjectReferenceError(`rules[${i}]`, `${rule.type} requires a linkType/objectType.`));
        continue;
      }
      const srcRaw = resolveSourceValue(rule.sourceObject, resolvedParameters, executedBy);
      const tgtRaw = resolveSourceValue(rule.targetObject, resolvedParameters, executedBy);
      if (srcRaw === undefined || tgtRaw === undefined) {
        errors.push(invalidObjectReferenceError(`rules[${i}]`, `${rule.type} could not resolve source/target object reference.`));
        continue;
      }
      // Build minimal identities (objectType is resolved by the compiler at
      // apply time from the link type; for planning we use the raw PK + a
      // placeholder objectType derived from the linkType string if present).
      const linkApiName = rule.linkType ?? rule.objectType ?? "";
      relationshipDeltas.push({
        linkTypeApiName: linkApiName,
        source: { ontologyId: ctx.ontologyId, branchId: ctx.branchId, objectType: "", primaryKey: srcRaw as PrimaryKeyValue },
        target: { ontologyId: ctx.ontologyId, branchId: ctx.branchId, objectType: "", primaryKey: tgtRaw as PrimaryKeyValue },
        op: rule.type === "addLink" ? "add" : "remove",
        ruleIndex: ruleIdx,
      });
      continue;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    steps: {
      objectDeltas,
      relationshipDeltas,
      fkDeltas,
      persistedExistingObjects: persisted.existingObjects,
      persistedActiveEdges: persisted.activeEdges,
    },
    errors,
  };
}

/** Re-export the v2 primitive-string-reference gate for compiler reuse. */
export function v2RejectsStringReference(version: ActionSemanticsVersion): boolean {
  return behaviourMatrix.stringAsObjectReference(version) === false;
}
