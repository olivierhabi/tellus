// ---------------------------------------------------------------------------
// Action Migration Analysis (§12)
//
// Classifies version-1 action types for a potential v1→v2 migration. Static
// analysis only — it does NOT claim certainty when runtime parameter values
// determine the outcome, and it performs NO automatic version upgrade.
//
// Classifications:
//   compatible             — safe to migrate; all v2 invariants hold statically
//   requires_review        — migration is technically possible but a real
//                            behavioral change requires explicit acknowledgement
//                            (e.g. delete policy changes from legacy_unchecked
//                            to restrict, a compatibility adapter is required,
//                            or a parameter rename is proposed)
//   potentially_incompatible — could violate at runtime (depends on inputs)
//   incompatible            — statically violates a v2 invariant
//   unable_to_determine     — missing metadata needed for a verdict
//
// This module also produces a *proposed* v2 definition when the migration is
// mechanically derivable: primitive parameters used exclusively as object
// references are converted to typed `object_reference` parameters. The
// proposed definition is validated against the object/primary-key schema via
// an injected `ObjectTypeSchemaLookup` before being returned. The analyzer
// never persists anything; it is a pure function of its inputs.
// ---------------------------------------------------------------------------

import {
  PK_CAPABLE_BASE_TYPES,
  type ObjectTypeSchemaLookup,
  type PrimaryKeyPropertyDef,
} from "./objectReferenceResolver";

export type MigrationClassification =
  | "compatible"
  | "requires_review"
  | "potentially_incompatible"
  | "incompatible"
  | "unable_to_determine";

/** Stable, machine-readable finding codes. Consumed by the migration
 *  endpoint to require explicit acknowledgements before persisting. */
export type MigrationFindingCode =
  // The parameter conversion is deterministic and safe.
  | "PARAMETER_CONVERSION"
  // The delete policy changes from legacy_unchecked to restrict.
  | "DELETE_POLICY_CHANGED_TO_RESTRICT"
  // A scalar value as object reference is still accepted; needs an adapter
  // boundary only if the wire shape diverges from the v2 contract.
  | "ADAPTER_REQUIRED"
  // A parameter rename is proposed because of a conflicting scalar use.
  | "PARAMETER_RENAMED"
  // Parameter is used both as objectReference.param AND as a scalar property.
  | "MIXED_PARAMETER_USAGE"
  // The v2 same-invocation rule rejects create→modify/delete of same object
  // type when the same primary key is supplied at runtime.
  | "SAME_INVOCATION_COLLISION_RISK";

export interface MigrationFinding {
  code: MigrationFindingCode;
  severity: "info" | "warning" | "blocker";
  path: string;
  message: string;
  /** Optional structured metadata — never contains sensitive payloads. */
  metadata?: Record<string, unknown>;
  /** Legacy array-style index preserved for backward compatibility. */
  ruleIndex?: number;
}

export interface ParameterMigration {
  parameterApiName: string;
  fromType: string;
  toType: "object_reference";
  objectType: string;
  primaryKeyProperty: string;
  primaryKeyBaseType: string;
  wireCompatibility: "compatible" | "adapter_required" | "breaking" | "unknown";
  /** When a rename is proposed, the new apiName; otherwise unchanged. */
  proposedApiName?: string;
}

export interface MigrationReport {
  classification: MigrationClassification;
  findings: MigrationFinding[];
  /**
   * The proposed v2 action definition — `parameters` with primitive→typed
   * conversions applied, identical shape otherwise. Only set when at least
   * one parameter migration is mechanically derivable AND every blocking
   * precondition for a safe conversion is met. Persisted only by the
   * `/migrate` endpoint after explicit acknowledgement.
   */
  proposedDefinition?: {
    parameters: ParamLike[];
    rules: RuleLike[];
  };
  parameterMigrations: ParameterMigration[];
  /** The delete-policy change implied by a v1→v2 migration, if any. */
  deletePolicyChange?: "legacy_unchecked_to_restrict";
  /** True when every object-reference target object type was verifiable. */
  schemaVerified: boolean;
}

interface RuleLike {
  type: string;
  objectType?: string;
  objectReference?: { source?: string; param?: string };
  properties?: Record<string, unknown>;
}

interface ParamLike {
  apiName: string;
  type: string;
  objectType?: string;
  required?: boolean;
  displayName?: string;
}

export interface ActionTypeDefForMigration {
  rules: RuleLike[];
  parameters: ParamLike[];
}

/** Rules that reference an object via an `objectReference.param`. */
const OBJECT_REF_RULE_TYPES = new Set([
  "modifyObject",
  "modifyOrCreateObject",
  "deleteObject",
]);

/** Rules that may also consume a parameter as a scalar property value. */
const SCALAR_RULE_TYPES = new Set([
  "createObject",
  "modifyObject",
  "modifyOrCreateObject",
]);

/**
 * Wire-compatibility heuristic between a v1 parameter type and the target
 * primary-key base type. Decided deterministically from the coercion rules
 * implemented in `objectReferenceResolver.coercePrimaryKey`: a v2
 * `object_reference` parameter accepts a *scalar* primary-key value at
 * runtime and canonicalizes it via the same coercion that v1 used.
 */
function wireCompatibilityBetween(
  fromType: string,
  pkBaseType: string,
): ParameterMigration["wireCompatibility"] {
  // Identical string-shaped keys: v1 string → v2 string PK — trivially
  // compatible, every value the v1 caller could have sent is accepted.
  if (fromType === pkBaseType) return "compatible";
  // Old primitive → new object_reference: the v1 caller sent a scalar of
  // `fromType`. v2 canonicalization will coerce it. Determine feasibility.
  const numericFrom = new Set([
    "integer",
    "long",
    "byte",
    "short",
    "double",
    "float",
    "decimal",
  ]);
  const intPk = new Set(["integer", "byte", "short"]);
  const floatPk = new Set(["double", "float", "decimal"]);
  if (numericFrom.has(fromType)) {
    if (intPk.has(pkBaseType) || pkBaseType === "long") return "compatible";
    if (floatPk.has(pkBaseType)) return "compatible";
  }
  if (fromType === "string") {
    // A v1 string caller could have sent any string; v2 string-shaped PKs
    // accept whatever the caller sent. Numeric PKs coerce on a best-effort
    // basis — a non-numeric string is a runtime error, but it was a
    // runtime error in v1 too (the rule used it as a PK).
    if (
      pkBaseType === "string" ||
      pkBaseType === "date" ||
      pkBaseType === "timestamp"
    ) {
      return "compatible";
    }
    if (intPk.has(pkBaseType) || pkBaseType === "long" || floatPk.has(pkBaseType)) {
      // Safe in the average case (numeric strings); a non-numeric string
      // was already invalid in v1 since the rule dereferenced it as a PK.
      return "compatible";
    }
    if (pkBaseType === "boolean") return "adapter_required";
  }
  if (fromType === "boolean" && pkBaseType === "boolean") return "compatible";
  // Anything else (e.g. struct → string, attachment → long, …) is not safe
  // to claim compatibility for without caller-specific evidence.
  return "unknown";
}

/**
 * Classify a v1 action type for a v1→v2 migration and, when mechanically
 * derivable, build a proposed v2 definition with typed object_reference
 * parameters. The optional `schemaLookup` validates the target object
 * type and resolves the primary-key base type (required to populate
 * `ParameterMigration.primaryKeyBaseType` and to mark `schemaVerified`).
 *
 * Static analysis only — never persists, never upgrades.
 */
export async function analyzeActionTypeMigration(
  actionType: ActionTypeDefForMigration,
  options?: { schemaLookup?: ObjectTypeSchemaLookup; ontologyId?: string },
): Promise<MigrationReport> {
  const findings: MigrationFinding[] = [];
  const parameterMigrations: ParameterMigration[] = [];
  let hasBlocker = false;
  let hasPotential = false;
  let requiresReview = false;
  let schemaVerified = true;
  let deletePolicyChange: MigrationReport["deletePolicyChange"];

  const paramByApi = new Map<string, ParamLike>();
  for (const p of actionType.parameters) paramByApi.set(p.apiName, p);

  // Index every place a parameter is consumed. Used to detect mixed usage
  // (objectReference AND scalar property) — auto-mutation of such a shared
  // parameter would silently change unrelated rule behaviour.
  const objectRefUses = new Map<string, number[]>(); // paramApiName -> rule indices
  const scalarUses = new Map<string, Set<number>>(); // paramApiName -> rule indices using it as a property value source

  for (let i = 0; i < actionType.rules.length; i++) {
    const rule = actionType.rules[i];

    if (OBJECT_REF_RULE_TYPES.has(rule.type)) {
      const ref = rule.objectReference;
      if (!ref || ref.source !== "parameter" || !ref.param) {
        findings.push({
          code: "MIXED_PARAMETER_USAGE",
          severity: "blocker",
          path: `rules[${i}].objectReference`,
          message: `${rule.type} rule has no parameter objectReference; v2 requires a typed object_reference parameter.`,
          ruleIndex: i,
        });
        hasBlocker = true;
        continue;
      }
      const arr = objectRefUses.get(ref.param) ?? [];
      arr.push(i);
      objectRefUses.set(ref.param, arr);

      const param = paramByApi.get(ref.param);
      if (!param) {
        findings.push({
          code: "MIXED_PARAMETER_USAGE",
          severity: "blocker",
          path: `rules[${i}].objectReference.param`,
          message: `${rule.type} rule objectReference references unknown parameter '${ref.param}'.`,
          ruleIndex: i,
        });
        hasBlocker = true;
        continue;
      }
      if (param.type !== "object_reference") {
        findings.push({
          code: "PARAMETER_CONVERSION",
          severity: "blocker",
          path: `rules[${i}].objectReference.param`,
          message: `${rule.type} rule uses parameter '${ref.param}' of type '${param.type}' as object reference; v2 requires type 'object_reference'.`,
          ruleIndex: i,
          metadata: { parameterApiName: ref.param, fromType: param.type },
        });
        // Don't set hasBlocker yet — a deterministic conversion may unblock
        // this. The proposedDefinition pass below will clear the blocker
        // marker only if every such param can be safely converted.
      }
      if (param.type === "object_reference" && !param.objectType) {
        findings.push({
          code: "PARAMETER_CONVERSION",
          severity: "blocker",
          path: `parameters['${ref.param}'].objectType`,
          message: `object_reference parameter '${ref.param}' has no objectType; v2 requires it.`,
          ruleIndex: i,
        });
        hasBlocker = true;
      }
    }

    // Track scalar uses (property mappings sourced from a parameter).
    if (rule.properties && typeof rule.properties === "object") {
      for (const v of Object.values(rule.properties)) {
        if (
          v &&
          typeof v === "object" &&
          (v as { source?: string }).source === "parameter" &&
          typeof (v as { param?: string }).param === "string"
        ) {
          const pn = (v as { param: string }).param;
          const set = scalarUses.get(pn) ?? new Set<number>();
          set.add(i);
          scalarUses.set(pn, set);
        }
      }
    }
  }

  // Same-invocation create→modify/delete possibility.
  const createObjectTypes = new Set<string>();
  for (const r of actionType.rules) {
    if (r.type === "createObject" && r.objectType) createObjectTypes.add(r.objectType);
  }
  for (let i = 0; i < actionType.rules.length; i++) {
    const r = actionType.rules[i];
    if (
      OBJECT_REF_RULE_TYPES.has(r.type) &&
      r.objectType &&
      createObjectTypes.has(r.objectType)
    ) {
      findings.push({
        code: "SAME_INVOCATION_COLLISION_RISK",
        severity: "warning",
        path: `rules[${i}]`,
        message: `createObject earlier in the rules touches the same object type as ${r.type}; if the same primary key is supplied at runtime, v2 rejects it as SAME_INVOCATION_REFERENCE_FORBIDDEN.`,
        ruleIndex: i,
      });
      hasPotential = true;
    }
  }

  // Delete actions become restricted under v2.
  let hasDeleteRule = false;
  for (let i = 0; i < actionType.rules.length; i++) {
    const r = actionType.rules[i];
    if (r.type === "deleteObject") {
      hasDeleteRule = true;
      findings.push({
        code: "DELETE_POLICY_CHANGED_TO_RESTRICT",
        severity: "info",
        path: `rules[${i}]`,
        message: `deleteObject rule will use the v2 restrict policy; migration will fail any execution that has active relationships to the deleted object.`,
        ruleIndex: i,
      });
    }
  }
  if (hasDeleteRule) {
    deletePolicyChange = "legacy_unchecked_to_restrict";
    requiresReview = true;
  }

  // Missing object-type metadata.
  for (let i = 0; i < actionType.rules.length; i++) {
    const r = actionType.rules[i];
    if (
      (r.type === "createObject" ||
        OBJECT_REF_RULE_TYPES.has(r.type)) &&
      !r.objectType
    ) {
      findings.push({
        code: "MIXED_PARAMETER_USAGE",
        severity: "blocker",
        path: `rules[${i}].objectType`,
        message: `${r.type} rule has no objectType; cannot validate references.`,
        ruleIndex: i,
      });
      hasBlocker = true;
    }
  }

  // -----------------------------------------------------------------------
  // Proposed-definition pass: convert eligible primitive parameters to
  // typed object_reference parameters, validate the target object type
  // and primary-key schema, and decide wire compatibility. Pure: does not
  // touch the input. Only produces a proposal when every blocker flagged
  // above can be cleared by a deterministic conversion.
  // -----------------------------------------------------------------------
  const schemaLookup = options?.schemaLookup;
  const ontologyId = options?.ontologyId;

  // Collect the param→objectType binding required for each conversion. The
  // target object type is the rule's objectType (we do not trust the
  // parameter's own objectType — it may be unset on a primitive param).
  const conversionTargets = new Map<
    string,
    { objectType: string; ruleIndices: number[] }
  >();
  for (const [paramApi, ruleIndices] of objectRefUses) {
    const param = paramByApi.get(paramApi);
    if (!param || param.type === "object_reference") {
      // Already typed or missing; skip.
      continue;
    }
    // Determine the target object type from every rule that uses this
    // parameter. If two rules disagree on the object type, the conversion
    // is ambiguous → blocker.
    const objectTypes = new Set<string>();
    for (const ri of ruleIndices) {
      const ot = actionType.rules[ri].objectType;
      if (ot) objectTypes.add(ot);
    }
    if (objectTypes.size === 0) {
      // The rule had no objectType — already flagged as a blocker above.
      continue;
    }
    if (objectTypes.size > 1) {
      findings.push({
        code: "PARAMETER_CONVERSION",
        severity: "blocker",
        path: `parameters['${paramApi}']`,
        message: `Parameter '${paramApi}' is used as an object reference by rules targeting different object types (${Array.from(objectTypes).join(", ")}); v2 requires a single object_reference target type.`,
        metadata: { parameterApiName: paramApi, objectTypes: Array.from(objectTypes) },
      });
      hasBlocker = true;
      continue;
    }
    conversionTargets.set(paramApi, {
      objectType: objectTypes.values().next().value as string,
      ruleIndices,
    });
  }

  // Mixed usage: a parameter used as both an objectReference AND a scalar
  // property mapping. We do NOT auto-mutate the shared parameter; we propose
  // a NEW parameter carrying the object_reference while preserving the scalar
  // one. The frontend surfaces this as a review-required rename.
  const proposedParameters: ParamLike[] = [];
  const renameByOldApi = new Map<string, string>();
  for (const p of actionType.parameters) proposedParameters.push({ ...p });

  for (const [paramApi, target] of conversionTargets) {
    const param = paramByApi.get(paramApi)!;
    const scalarRuleIndices = scalarUses.get(paramApi);
    const mixed = !!scalarRuleIndices && scalarRuleIndices.size > 0;

    let proposedApiName = paramApi;
    if (mixed) {
      // Propose a new parameter apiName keyed off the object type's role.
      proposedApiName = paramApi.endsWith("Id")
        ? paramApi.slice(0, -2)
        : `${paramApi}Ref`;
      // Ensure uniqueness against existing params.
      let candidate = proposedApiName;
      let n = 2;
      while (paramByApi.has(candidate)) {
        candidate = `${proposedApiName}${n++}`;
      }
      proposedApiName = candidate;
      renameByOldApi.set(paramApi, proposedApiName);
      findings.push({
        code: "MIXED_PARAMETER_USAGE",
        severity: "warning",
        path: `parameters['${paramApi}']`,
        message: `Parameter '${paramApi}' is used both as an objectReference and as a scalar property mapping. A new typed object_reference parameter '${proposedApiName}' is proposed; the scalar '${paramApi}' is preserved.`,
        metadata: { parameterApiName: paramApi, proposedApiName, scalarRuleIndices: Array.from(scalarRuleIndices!) },
      });
      findings.push({
        code: "PARAMETER_RENAMED",
        severity: "warning",
        path: `parameters['${paramApi}']`,
        message: `Migration proposes a new parameter '${proposedApiName}' bound to object type '${target.objectType}'. Existing callers must be updated if they relied on the shared parameter.`,
        metadata: { parameterApiName: paramApi, proposedApiName },
      });
      requiresReview = true;
    }

    // Validate the target object type + primary-key schema.
    let pkDef: PrimaryKeyPropertyDef | null = null;
    if (schemaLookup && ontologyId) {
      try {
        pkDef = await schemaLookup(ontologyId, target.objectType);
      } catch {
        pkDef = null;
      }
    }
    if (!pkDef) {
      findings.push({
        code: "PARAMETER_CONVERSION",
        severity: "blocker",
        path: `parameters['${paramApi}'].objectType`,
        message: mixed
          ? `Cannot resolve target object type '${target.objectType}' or its primary-key property for parameter '${paramApi}'.`
          : `Cannot resolve target object type '${target.objectType}' or its primary-key property for parameter '${paramApi}'.`,
        metadata: { parameterApiName: paramApi, objectType: target.objectType },
      });
      hasBlocker = true;
      schemaVerified = false;
      continue;
    }
    if (!PK_CAPABLE_BASE_TYPES.has(pkDef.baseType)) {
      findings.push({
        code: "PARAMETER_CONVERSION",
        severity: "blocker",
        path: `parameters['${paramApi}'].objectType`,
        message: `Primary-key property '${pkDef.apiName}' of object type '${target.objectType}' has unsupported base type '${pkDef.baseType}'; v2 object_reference canonicalization cannot accept it.`,
        metadata: {
          parameterApiName: paramApi,
          objectType: target.objectType,
          primaryKeyProperty: pkDef.apiName,
          primaryKeyBaseType: pkDef.baseType,
        },
      });
      hasBlocker = true;
      continue;
    }

    const wire = wireCompatibilityBetween(param.type, pkDef.baseType);
    if (wire === "breaking" || wire === "unknown") {
      // Treat as review-required rather than blocker; the operator must
      // confirm an explicit compatibility adapter or accept the break.
      findings.push({
        code: "ADAPTER_REQUIRED",
        severity: "warning",
        path: `parameters['${paramApi}']`,
        message: `Wire compatibility between '${param.type}' and primary-key base type '${pkDef.baseType}' is '${wire}'; a compatibility adapter is required or callers must be updated.`,
        metadata: {
          parameterApiName: paramApi,
          fromType: param.type,
          primaryKeyBaseType: pkDef.baseType,
          wireCompatibility: wire,
        },
      });
      requiresReview = true;
    } else if (wire === "adapter_required") {
      findings.push({
        code: "ADAPTER_REQUIRED",
        severity: "warning",
        path: `parameters['${paramApi}']`,
        message: `Wire values of type '${param.type}' require an explicit compatibility adapter to coerce to primary-key base type '${pkDef.baseType}'.`,
        metadata: {
          parameterApiName: paramApi,
          fromType: param.type,
          primaryKeyBaseType: pkDef.baseType,
        },
      });
      requiresReview = true;
    }

    // Record the migration.
    parameterMigrations.push({
      parameterApiName: paramApi,
      fromType: param.type,
      toType: "object_reference",
      objectType: target.objectType,
      primaryKeyProperty: pkDef.apiName,
      primaryKeyBaseType: pkDef.baseType,
      wireCompatibility: wire,
      proposedApiName: mixed ? proposedApiName : undefined,
    });

    // Apply the conversion to the proposed parameters list. When mixed,
    // add a NEW parameter and keep the scalar one untouched.
    if (mixed) {
      proposedParameters.push({
        apiName: proposedApiName,
        type: "object_reference",
        objectType: target.objectType,
        required: param.required ?? true,
        displayName: param.displayName ?? proposedApiName,
      });
    } else {
      const idx = proposedParameters.findIndex((p) => p.apiName === paramApi);
      if (idx >= 0) {
        proposedParameters[idx] = {
          ...proposedParameters[idx],
          type: "object_reference",
          objectType: target.objectType,
        };
      }
    }
  }

  // If a parameter rename was proposed, the rules' objectReference.param must
  // be repointed to the new typed parameter in the proposed definition. The
  // scalar usages keep referencing the original parameter.
  const proposedRules: RuleLike[] = actionType.rules.map((r) => ({ ...r }));
  for (let i = 0; i < proposedRules.length; i++) {
    const r = proposedRules[i];
    if (
      OBJECT_REF_RULE_TYPES.has(r.type) &&
      r.objectReference?.source === "parameter" &&
      r.objectReference?.param &&
      renameByOldApi.has(r.objectReference.param)
    ) {
      proposedRules[i] = {
        ...r,
        objectReference: {
          ...r.objectReference,
          param: renameByOldApi.get(r.objectReference.param),
        },
      };
    }
  }

  // Build the proposed definition only when at least one conversion was
  // produced and no remaining blocker stands.
  const proposedDefinition =
    parameterMigrations.length > 0 && !hasBlocker
      ? { parameters: proposedParameters, rules: proposedRules }
      : undefined;

  // Re-evaluate the blocker flag: a primitive-as-object-reference finding
  // recorded earlier as a 'blocker' is cleared iff a deterministic
  // conversion was produced for that parameter. If no conversion was
  // produced (e.g. ambiguous object types), the blocker stands and is
  // already on `hasBlocker` via the ambiguity path.
  if (proposedDefinition) {
    // Any PARAMETER_CONVERSION blocker findings must have a matching
    // parameterMigration entry (i.e. were successfully converted). Demote
    // those findings from "blocker" to "info".
    for (const f of findings) {
      if (
        f.code === "PARAMETER_CONVERSION" &&
        f.severity === "blocker" &&
        f.metadata?.parameterApiName &&
        parameterMigrations.some(
          (m) =>
            m.parameterApiName === f.metadata!.parameterApiName &&
            !m.proposedApiName,
        )
      ) {
        f.severity = "info";
        f.message = `Parameter '${f.metadata!.parameterApiName}' will be converted from '${f.metadata!.fromType}' to a typed object_reference parameter bound to object type ${
          parameterMigrations.find(
            (m) => m.parameterApiName === f.metadata!.parameterApiName,
          )!.objectType
        }.`;
      }
    }
  } else if (parameterMigrations.length === 0) {
    // No conversion was derived at all — the primitive-as-object-reference
    // blocker findings stand.
    for (const f of findings) {
      if (f.code === "PARAMETER_CONVERSION" && f.severity === "blocker") {
        hasBlocker = true;
      }
    }
  }

  let classification: MigrationClassification;
  if (hasBlocker) classification = "incompatible";
  else if (hasPotential) classification = "potentially_incompatible";
  else if (requiresReview) classification = "requires_review";
  else if (findings.length === 0) classification = "compatible";
  else classification = "compatible";

  return {
    classification,
    findings,
    proposedDefinition,
    parameterMigrations,
    deletePolicyChange,
    schemaVerified,
  };
}

/**
 * Backward-compatible synchronous projection onto the original 4-value
 * classification. Existing callers continue to use this; the route layer
 * and the new migration workflow use {@link analyzeActionTypeMigration}.
 *
 * NOTE: `requires_review` is reported here as `requires_review` (the union
 * has been extended to carry it). Callers that only understand the original
 * 4 values should treat `requires_review` as `potentially_incompatible`.
 */
export function classifyActionTypeForMigration(
  actionType: ActionTypeDefForMigration,
): Pick<MigrationReport, "classification" | "findings"> {
  // Synchronous fallback analyser — the schema-aware pass is skipped (no
  // schemaLookup), so the proposed definition / PK base type / wire
  // compatibility are not produced. Intentionally produces the same
  // classification verdicts the route relied on before this extension.
  const findings: MigrationFinding[] = [];
  let hasBlocker = false;
  let hasPotential = false;
  let requiresReview = false;

  const paramByApi = new Map<string, ParamLike>();
  for (const p of actionType.parameters) paramByApi.set(p.apiName, p);

  for (let i = 0; i < actionType.rules.length; i++) {
    const rule = actionType.rules[i];
    const ruleIdx = { ruleIndex: i };

    if (OBJECT_REF_RULE_TYPES.has(rule.type)) {
      const ref = rule.objectReference;
      if (!ref || ref.source !== "parameter" || !ref.param) {
        findings.push({ code: "MIXED_PARAMETER_USAGE", severity: "blocker", path: `rules[${i}]`, ...ruleIdx, message: `${rule.type} rule has no parameter objectReference; v2 requires a typed object_reference parameter.` });
        hasBlocker = true;
        continue;
      }
      const param = paramByApi.get(ref.param);
      if (!param) {
        findings.push({ code: "MIXED_PARAMETER_USAGE", severity: "blocker", path: `rules[${i}]`, ...ruleIdx, message: `${rule.type} rule objectReference references unknown parameter '${ref.param}'.` });
        hasBlocker = true;
        continue;
      }
      if (param.type !== "object_reference") {
        findings.push({ code: "PARAMETER_CONVERSION", severity: "blocker", path: `rules[${i}]`, ...ruleIdx, message: `${rule.type} rule uses parameter '${ref.param}' of type '${param.type}' as object reference; v2 requires type 'object_reference'.` });
        hasBlocker = true;
      }
      if (param.type === "object_reference" && !param.objectType) {
        findings.push({ code: "PARAMETER_CONVERSION", severity: "blocker", path: `rules[${i}]`, ...ruleIdx, message: `object_reference parameter '${ref.param}' has no objectType; v2 requires it.` });
        hasBlocker = true;
      }
    }
  }

  const createObjectTypes = new Set<string>();
  for (const r of actionType.rules) {
    if (r.type === "createObject" && r.objectType) createObjectTypes.add(r.objectType);
  }
  for (let i = 0; i < actionType.rules.length; i++) {
    const r = actionType.rules[i];
    if (
      OBJECT_REF_RULE_TYPES.has(r.type) &&
      r.objectType &&
      createObjectTypes.has(r.objectType)
    ) {
      findings.push({ code: "SAME_INVOCATION_COLLISION_RISK", severity: "warning", path: `rules[${i}]`, ruleIndex: i, message: `createObject earlier in the rules touches the same object type as ${r.type}; if the same primary key is supplied at runtime, v2 rejects it as SAME_INVOCATION_REFERENCE_FORBIDDEN.` });
      hasPotential = true;
    }
  }

  let hasDeleteRule = false;
  for (let i = 0; i < actionType.rules.length; i++) {
    if (actionType.rules[i].type === "deleteObject") {
      hasDeleteRule = true;
      findings.push({ code: "DELETE_POLICY_CHANGED_TO_RESTRICT", severity: "info", path: `rules[${i}]`, ruleIndex: i, message: `deleteObject rule will use the v2 restrict policy; migration will fail any execution that has active relationships to the deleted object.` });
    }
  }
  if (hasDeleteRule) requiresReview = true;

  for (let i = 0; i < actionType.rules.length; i++) {
    const r = actionType.rules[i];
    if ((r.type === "createObject" || OBJECT_REF_RULE_TYPES.has(r.type)) && !r.objectType) {
      findings.push({ code: "MIXED_PARAMETER_USAGE", severity: "blocker", path: `rules[${i}]`, ruleIndex: i, message: `${r.type} rule has no objectType; cannot validate references.` });
      hasBlocker = true;
    }
  }

  let classification: MigrationClassification;
  if (hasBlocker) classification = "incompatible";
  else if (hasPotential) classification = "potentially_incompatible";
  else if (requiresReview) classification = "requires_review";
  else classification = "compatible";

  return { classification, findings };
}

/**
 * Set of finding codes whose acknowledgement is REQUIRED before the
 * `/migrate` endpoint persists a `requires_review` migration. The frontend
 * surfaces these as explicit checkboxes.
 */
export const ACKNOWLEDGEMENT_REQUIRED_FINDING_CODES: ReadonlySet<MigrationFindingCode> =
  new Set<MigrationFindingCode>([
    "DELETE_POLICY_CHANGED_TO_RESTRICT",
    "ADAPTER_REQUIRED",
    "PARAMETER_RENAMED",
    "MIXED_PARAMETER_USAGE",
  ]);
