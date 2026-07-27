// ---------------------------------------------------------------------------
// Object Reference Resolver
//
// Splits canonicalization (normalize an external object reference into a
// complete, typed internal identity) from existence checks (decide whether
// the canonicalized identity exists according to the rule-specific policy).
//
// Canonicalization:
//   * Validate the referenced object type exists in the same ontology/branch.
//   * Resolve the primary-key property definition.
//   * Coerce the supplied value according to that property's declared base type.
//   * Reject lossy or ambiguous coercions.
//   * Preserve the canonical typed value for compiled edits and audit metadata.
//
// Version-2 invariants (enforced by callers, not here):
//   * A version-2 reference must never be stored as only a raw string.
//   * Modifying/creating/deleting requires a typed `object_reference` parameter.
//
// Primary-key value types are derived from the ontology property base types
// actually supported by the repository (property.base_type CHECK constraint).
// Composite primary keys and stable RIDs are explicit future work (non-goal).
// ---------------------------------------------------------------------------

import objectTypeService from "../services/objectTypeService";
import {
  invalidObjectReferenceError,
  invalidPrimaryKeyError,
  objectTypeMismatchError,
  objectNotFoundError,
  objectAlreadyExistsError,
  type ActionError,
} from "./actionErrors";
import type { ActionSemanticsVersion } from "./actionSemantics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Primary-key value types supported by the repository. Derived from the
 * scalar `property.base_type` members that can function as a primary key and
 * coerce cleanly across JSON wire formats:
 *   string, boolean, integer, long, byte, short, decimal, double, float
 * (date/timestamp serialize as strings). Array/object/geo/struct/marking
 * types are deliberately excluded — a primary key must be a scalar.
 */
export type PrimaryKeyValue = string | number | boolean;

/**
 * Canonical internal identity. OntologyId/branchId are provided by the
 * route/action context; objectType + primaryKey come from the rule or
 * parameter. This is the shape carried through compiled edits and audit
 * metadata.
 */
export interface ObjectIdentity {
  ontologyId: string;
  branchId: string;
  objectType: string;
  primaryKey: PrimaryKeyValue;
}

/**
 * An external (wire) object reference. The primary-key value here is the
 * raw, unnormalized value supplied by the caller; canonicalizeObjectReference
 * coerces it to PrimaryKeyValue.
 */
export interface ObjectReference {
  objectType: string;
  primaryKey: unknown;
}

/** Ambient context providing ontology/branch scoping, derived from the route. */
export interface ActionContext {
  ontologyId: string;
  branchId: string;
}

/** A parameter definition (mirrors parameterValidator.ParameterDefinition). */
export interface ActionTypeParameter {
  apiName: string;
  type: string;
  objectType?: string;
}

/**
 * The subset of a property row the resolver needs: the primary-key
 * property's api_name and its declared base_type. Resolved via the schema
 * lookup, so tests can inject a pure mock without DB I/O.
 */
export interface PrimaryKeyPropertyDef {
  propertyId: string;
  apiName: string;
  baseType: string;
}

/**
 * The schema lookup a caller can inject to override the default DB-backed
 * resolver. Returns the PK property definition for an object type in an
 * ontology, or null if the object type or its PK property is missing.
 */
export type ObjectTypeSchemaLookup = (
  ontologyId: string,
  objectTypeApiName: string,
) => Promise<PrimaryKeyPropertyDef | null>;

/**
 * Default schema lookup — uses objectTypeService to resolve the PK property
 * definition straight from the `object_type`/`property` tables.
 */
export const defaultSchemaLookup: ObjectTypeSchemaLookup = async (
  ontologyId,
  objectTypeApiName,
) => {
  try {
    const result = await objectTypeService.getByApiName(
      ontologyId,
      objectTypeApiName,
    );
    const ot = result.objectType as { primary_key_property_id?: string | null };
    const pkId = ot.primary_key_property_id;
    if (!pkId) return null;
    const pkProp = (result.properties as Array<{ property_id: string; api_name: string; base_type: string }>)
      .find((p) => p.property_id === pkId);
    if (!pkProp) return null;
    return {
      propertyId: pkProp.property_id,
      apiName: pkProp.api_name,
      baseType: pkProp.base_type,
    };
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Existence policy & checks (separated from canonicalization)
// ---------------------------------------------------------------------------

export type ExistencePolicy = "must_exist" | "may_exist" | "must_not_exist";

/** Reader interface for checking whether a canonical identity persists. */
export interface ObjectStateReader {
  exists(identity: ObjectIdentity): Promise<boolean>;
}

export interface ObjectExistenceResult {
  policy: ExistencePolicy;
  exists: boolean;
  /** Satisfied when the result matches the policy's expectation. */
  ok: boolean;
  error?: ActionError;
}

/**
 * Validate object existence against a rule-specific policy. This does NOT
 * canonicalize — it assumes the identity is already canonical and only
 * queries the reader. The rule existence matrix:
 *   createObject         → must_not_exist
 *   modifyObject         → must_exist
 *   modifyOrCreateObject → may_exist (does not fail on missing)
 *   deleteObject         → must_exist
 *   addLink endpoints    → must exist in planned final state (caller)
 *   removeLink           → relationship must exist in current/planned state
 */
export async function validateObjectExistence(
  identity: ObjectIdentity,
  policy: ExistencePolicy,
  reader: ObjectStateReader,
): Promise<ObjectExistenceResult> {
  const exists = await reader.exists(identity);
  switch (policy) {
    case "must_exist":
      return exists
        ? { policy, exists: true, ok: true }
        : {
            policy,
            exists: false,
            ok: false,
            error: objectNotFoundError(
              "",
              identity.objectType,
              String(identity.primaryKey),
            ),
          };
    case "must_not_exist":
      return exists
        ? {
            policy,
            exists: true,
            ok: false,
            error: objectAlreadyExistsError(
              "",
              identity.objectType,
              String(identity.primaryKey),
            ),
          }
        : { policy, exists: false, ok: true };
    case "may_exist":
      // modify-or-create must not fail merely because the target does not exist.
      return { policy, exists, ok: true };
  }
}

// ---------------------------------------------------------------------------
// Primary-key coercion
// ---------------------------------------------------------------------------

const STRING_BASE_TYPES = new Set([
  "string",
  "date",
  "timestamp",
]);
const INT_BASE_TYPES = new Set([
  "integer",
  "byte",
  "short",
]);
const LONG_BASE_TYPE = "long";
const FLOAT_BASE_TYPES = new Set([
  "double",
  "float",
  "decimal",
]);
const BOOLEAN_BASE_TYPE = "boolean";

/** All base types that may serve as a primary key (the PropertyKeyValue union). */
export const PK_CAPABLE_BASE_TYPES = new Set<string>([
  ...STRING_BASE_TYPES,
  ...INT_BASE_TYPES,
  LONG_BASE_TYPE,
  ...FLOAT_BASE_TYPES,
  BOOLEAN_BASE_TYPE,
]);

export type CoercionResult =
  | { ok: true; value: PrimaryKeyValue }
  | { ok: false; reason: string };

/** Coerce a raw value into the canonical PrimaryKeyValue for a base type. */
export function coercePrimaryKey(
  baseType: string,
  rawValue: unknown,
): CoercionResult {
  if (rawValue === undefined || rawValue === null) {
    return { ok: false, reason: "value is null or undefined" };
  }

  if (STRING_BASE_TYPES.has(baseType)) {
    if (typeof rawValue === "string") return { ok: true, value: rawValue };
    // Numbers/booleans → string is a non-lossy printable coercion for keys,
    // but objects/arrays are not acceptable scalar key material.
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      return { ok: true, value: String(rawValue) };
    }
    if (typeof rawValue === "boolean") {
      return { ok: true, value: rawValue ? "true" : "false" };
    }
    return { ok: false, reason: `cannot coerce ${typeof rawValue} to ${baseType} primary key` };
  }

  if (INT_BASE_TYPES.has(baseType)) {
    let n: number;
    if (typeof rawValue === "number") n = rawValue;
    else if (typeof rawValue === "string") {
      // Reject ambiguous strings like "12.5" or "12x".
      if (!/^-?\d+$/.test(rawValue.trim())) {
        return { ok: false, reason: `'${rawValue}' is not an integer` };
      }
      n = Number(rawValue.trim());
    } else {
      return { ok: false, reason: `cannot coerce ${typeof rawValue} to ${baseType}` };
    }
    if (!Number.isSafeInteger(n)) {
      return { ok: false, reason: `${n} is not a safe ${baseType} integer` };
    }
    return { ok: true, value: n };
  }

  if (baseType === LONG_BASE_TYPE) {
    let s: string;
    if (typeof rawValue === "number") {
      if (!Number.isInteger(rawValue)) {
        return { ok: false, reason: "long must be an integer" };
      }
      s = String(rawValue);
    } else if (typeof rawValue === "string") {
      if (!/^-?\d+$/.test(rawValue.trim())) {
        return { ok: false, reason: `'${rawValue}' is not a long integer` };
      }
      s = rawValue.trim();
    } else {
      return { ok: false, reason: `cannot coerce ${typeof rawValue} to long` };
    }
    let big: bigint;
    try {
      big = BigInt(s);
    } catch {
      return { ok: false, reason: `'${rawValue}' is not a long integer` };
    }
    if (big < BigInt("-9223372036854775808") || big > BigInt("9223372036854775807")) {
      return { ok: false, reason: `${s} exceeds 64-bit long range` };
    }
    // Preserve precision through the wire as a number only when safe.
    if (Number.isSafeInteger(Number(big))) {
      return { ok: true, value: Number(big) };
    }
    // Above MAX_SAFE_INTEGER: keep as a string to avoid precision loss.
    return { ok: true, value: s };
  }

  if (FLOAT_BASE_TYPES.has(baseType)) {
    let n: number;
    if (typeof rawValue === "number") n = rawValue;
    else if (typeof rawValue === "string") n = Number(rawValue.trim());
    else return { ok: false, reason: `cannot coerce ${typeof rawValue} to ${baseType}` };
    if (!Number.isFinite(n)) {
      return { ok: false, reason: `${String(rawValue)} is not a finite ${baseType}` };
    }
    return { ok: true, value: n };
  }

  if (baseType === BOOLEAN_BASE_TYPE) {
    if (typeof rawValue === "boolean") return { ok: true, value: rawValue };
    if (rawValue === "true") return { ok: true, value: true };
    if (rawValue === "false") return { ok: true, value: false };
    if (rawValue === 1) return { ok: true, value: true };
    if (rawValue === 0) return { ok: true, value: false };
    return { ok: false, reason: `cannot coerce ${String(rawValue)} to boolean` };
  }

  return { ok: false, reason: `base type '${baseType}' is not primary-key capable` };
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

export type CanonicalizeResult =
  | { ok: true; identity: ObjectIdentity }
  | { ok: false; error: ActionError };

/**
 * Canonicalize an external object reference into a complete internal identity.
 *
 * Responsibilities:
 *   1. Validate the referenced object type exists in the same ontology+branch.
 *   2. Resolve the primary-key property definition (via the schema lookup).
 *   3. Coerce the supplied raw value to the PK's declared base type.
 *   4. Reject lossy or ambiguous coercions.
 *   5. Return the canonical typed identity (preserved in edits + audit).
 *
 * This function does NOT check object existence — that is
 * `validateObjectExistence`'s job. The caller selects the existence policy
 * for the rule and invokes `validateObjectExistence` separately so reference
 * canonicalization is reusable across create/modify/delete/etc.
 */
export async function canonicalizeObjectReference(
  definition: ActionTypeParameter,
  rawValue: unknown,
  context: ActionContext,
  options?: { schemaLookup?: ObjectTypeSchemaLookup; semanticVersion?: ActionSemanticsVersion },
): Promise<CanonicalizeResult> {
  const lookup = options?.schemaLookup ?? defaultSchemaLookup;

  // An object_reference parameter must declare an objectType.
  const declaredObjectType = definition.objectType;
  if (!declaredObjectType) {
    return {
      ok: false,
      error: invalidObjectReferenceError(
        `parameters.${definition.apiName}`,
        `Parameter '${definition.apiName}' is an object_reference but has no objectType configured.`,
      ),
    };
  }

  // Resolve the primary-key property definition for the declared object type.
  const pkDef = await lookup(context.ontologyId, declaredObjectType);
  if (!pkDef) {
    return {
      ok: false,
      error: invalidObjectReferenceError(
        `parameters.${definition.apiName}`,
        `Object type '${declaredObjectType}' does not exist in ontology '${context.ontologyId}' or has no primary key property.`,
        { declaredObjectType },
      ),
    };
  }

  // The PK property's base type must be primary-key capable.
  if (!PK_CAPABLE_BASE_TYPES.has(pkDef.baseType)) {
    return {
      ok: false,
      error: invalidObjectReferenceError(
        `parameters.${definition.apiName}`,
        `Primary key property '${pkDef.apiName}' of object type '${declaredObjectType}' has unsupported base type '${pkDef.baseType}'.`,
      ),
    };
  }

  // Coerce the raw value per the declared base type.
  const coerced = coercePrimaryKey(pkDef.baseType, rawValue);
  if (!coerced.ok) {
    return {
      ok: false,
      error: invalidPrimaryKeyError(
        `parameters.${definition.apiName}`,
        rawValue,
        pkDef.baseType,
        coerced.reason,
      ),
    };
  }

  return {
    ok: true,
    identity: {
      ontologyId: context.ontologyId,
      branchId: context.branchId,
      objectType: declaredObjectType,
      primaryKey: coerced.value,
    },
  };
}

/**
 * Validate that a resolved identity's objectType matches the rule's expected
 * object type. Used by compilers that resolve object references from a
 * parameter but the rule declares its own objectType.
 */
export function assertObjectTypeMatch(
  identity: { objectType: string },
  expectedObjectType: string,
  path: string,
): ActionError | null {
  if (identity.objectType === expectedObjectType) return null;
  return objectTypeMismatchError(path, expectedObjectType, identity.objectType);
}
