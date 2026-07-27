// ---------------------------------------------------------------------------
// Action Errors — Stable Structured Error Contract
//
// One stable error shape is used across definition validation, invocation
// validation, compilation, planning, and transaction execution. The
// `code` field is authoritative for programmatic clients; `message`
// remains human-readable for legacy clients that only render strings.
//
// Error metadata is BOUNDED and REDACTED: raw parameter values or
// primary-key values are never logged by default. Structured errors carry
// counts and a bounded sample only — never unbounded relationship listings.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * Authoritative, stable error codes. Frontend field mapping keys off `code`
 * and `path`; HTTP status keys off the stage.
 */
export type ActionErrorCode =
  | "INVALID_OBJECT_REFERENCE"
  | "INVALID_PRIMARY_KEY"
  | "OBJECT_TYPE_MISMATCH"
  | "OBJECT_NOT_FOUND"
  | "OBJECT_ALREADY_EXISTS"
  | "SAME_INVOCATION_REFERENCE_FORBIDDEN"
  | "DELETE_BLOCKED_BY_RELATIONSHIPS"
  | "DANGLING_RELATIONSHIP"
  | "DUPLICATE_PRIMARY_KEY"
  | "CONCURRENCY_CONFLICT"
  | "DEADLOCK_RETRY_EXHAUSTED"
  | "UNSUPPORTED_SEMANTICS_VERSION"
  | "INCOMPATIBLE_ACTION_SEMANTICS"
  | "INVALID_EXECUTION_MODE"
  | "INVALID_DELETE_POLICY"
  | "INVALID_RULE_PARAMETER_TYPE"
  | "FINAL_STATE_INVALID";

// The full set, exposed for whitelist checks (e.g. route-layer HTTP mapping).
export const ALL_ACTION_ERROR_CODES: ReadonlySet<ActionErrorCode> = new Set<
  ActionErrorCode
>([
  "INVALID_OBJECT_REFERENCE",
  "INVALID_PRIMARY_KEY",
  "OBJECT_TYPE_MISMATCH",
  "OBJECT_NOT_FOUND",
  "OBJECT_ALREADY_EXISTS",
  "SAME_INVOCATION_REFERENCE_FORBIDDEN",
  "DELETE_BLOCKED_BY_RELATIONSHIPS",
  "DANGLING_RELATIONSHIP",
  "DUPLICATE_PRIMARY_KEY",
  "CONCURRENCY_CONFLICT",
  "DEADLOCK_RETRY_EXHAUSTED",
  "UNSUPPORTED_SEMANTICS_VERSION",
  "INCOMPATIBLE_ACTION_SEMANTICS",
  "INVALID_EXECUTION_MODE",
  "INVALID_DELETE_POLICY",
  "INVALID_RULE_PARAMETER_TYPE",
  "FINAL_STATE_INVALID",
]);

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export type ActionErrorStage =
  | "definition"
  | "invocation"
  | "planning"
  | "compilation"
  | "transaction";

// ---------------------------------------------------------------------------
// Error shape
// ---------------------------------------------------------------------------

/**
 * The single stable error shape used across every action boundary.
 *
 * `path` uses stable, dotted values for frontend field mapping, e.g.
 *   parameters.customerRef
 *   rules[1].objectReference
 *   rules[2].propertyMappings.customerId
 *
 * `retryable` distinguishes concurrency/deadlock (retry) from domain
 * validation errors (never retry).
 *
 * `meta` carries counts and a BOUNDED sample only. Redact before logging.
 */
export interface ActionError {
  code: ActionErrorCode;
  message: string;
  stage: ActionErrorStage;
  path?: string;
  retryable: boolean;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// HTTP status mapping (§8 of the directive)
// ---------------------------------------------------------------------------

/**
 * Map an error stage + code to the HTTP status returned to the client.
 *
 *   Definition/invocation validation: 400
 *   Authorization:                    403  (handled by auth middleware)
 *   Missing visible resource:         404
 *   Concurrency conflict:             409
 *   Unsupported stored semantics:     422 (fail closed)
 *   Unexpected internal failure:      500
 */
export function httpStatusForActionError(
  stage: ActionErrorStage,
  code: ActionErrorCode,
): number {
  switch (code) {
    case "CONCURRENCY_CONFLICT":
      return 409;
    case "OBJECT_NOT_FOUND":
      return 404;
    case "UNSUPPORTED_SEMANTICS_VERSION":
    case "INCOMPATIBLE_ACTION_SEMANTICS":
      return 422;
    case "DEADLOCK_RETRY_EXHAUSTED":
      return 500; // retried internally; exhaustion is an internal failure
    case "DANGLING_RELATIONSHIP":
    case "FINAL_STATE_INVALID":
      return 422;
  }
  // Domain validation errors across definition/invocation/planning/compilation.
  if (
    stage === "definition" ||
    stage === "invocation" ||
    stage === "planning" ||
    stage === "compilation"
  ) {
    return 400;
  }
  // transaction-stage domain failures (e.g. DELETE_BLOCKED_BY_RELATIONSHIPS).
  return 422;
}

// ---------------------------------------------------------------------------
// Error factories
// ---------------------------------------------------------------------------

/** Concurrency conflict — retryable at the transport level. */
export function concurrencyConflictError(
  message: string,
  meta?: Record<string, unknown>,
): ActionError {
  return {
    code: "CONCURRENCY_CONFLICT",
    message,
    stage: "transaction",
    retryable: true,
    meta: redactMeta(meta),
  };
}

/** Same-invocation create→modify/delete forbidden (version 2). */
export function sameInvocationReferenceForbiddenError(
  path: string,
  identitySummary: { objectType: string; primaryKey: string },
): ActionError {
  return {
    code: "SAME_INVOCATION_REFERENCE_FORBIDDEN",
    message:
      `A version-2 action may not create and subsequently modify or delete the ` +
      `same object '${identitySummary.primaryKey}' of type '${identitySummary.objectType}' in one invocation.`,
    stage: "planning",
    path,
    retryable: false,
    meta: redactMeta({ objectType: identitySummary.objectType }),
  };
}

/** Delete blocked by active relationships (version-2 restrict). */
export function deleteBlockedByRelationshipsError(
  path: string,
  summary: {
    total: number;
    inboundCount: number;
    outboundCount: number;
    byLinkType: Array<{
      linkType: string;
      inbound: number;
      outbound: number;
    }>;
    sample: BlockingRelationship[];
    sampleTruncated: boolean;
  },
): ActionError {
  return {
    code: "DELETE_BLOCKED_BY_RELATIONSHIPS",
    message:
      `Cannot delete: ${summary.total} active relationship(s) would become dangling ` +
      `(${summary.inboundCount} inbound, ${summary.outboundCount} outbound).`,
    stage: "transaction",
    path,
    retryable: false,
    meta: redactMeta({
      total: summary.total,
      inboundCount: summary.inboundCount,
      outboundCount: summary.outboundCount,
      byLinkType: summary.byLinkType,
      sample: summary.sample,
      sampleTruncated: summary.sampleTruncated,
    }),
  };
}

/** Unsupported stored semantics version — fail closed. */
export function unsupportedSemanticsVersionError(
  version: unknown,
): ActionError {
  return {
    code: "UNSUPPORTED_SEMANTICS_VERSION",
    message: `Unsupported action semantics version '${version}'.`,
    stage: "definition",
    retryable: false,
    meta: redactMeta({ version }),
  };
}

/** Invalid primary key coercion. */
export function invalidPrimaryKeyError(
  path: string,
  rawValue: unknown,
  declaredType: string,
  reason: string,
): ActionError {
  return {
    code: "INVALID_PRIMARY_KEY",
    message:
      `Primary key value could not be coerced to declared type '${declaredType}': ${reason}.`,
    stage: "invocation",
    path,
    retryable: false,
    meta: redactMeta({ declaredType, reason }),
  };
}

/** Invalid / cross-ontology / cross-branch object reference. */
export function invalidObjectReferenceError(
  path: string,
  reason: string,
  meta?: Record<string, unknown>,
): ActionError {
  return {
    code: "INVALID_OBJECT_REFERENCE",
    message: reason,
    stage: "invocation",
    path,
    retryable: false,
    meta: redactMeta(meta),
  };
}

/** Object type mismatch between rule and resolved reference. */
export function objectTypeMismatchError(
  path: string,
  expectedObjectType: string,
  actualObjectType: string,
): ActionError {
  return {
    code: "OBJECT_TYPE_MISMATCH",
    message:
      `Object reference resolved to type '${actualObjectType}' but the rule requires '${expectedObjectType}'.`,
    stage: "compilation",
    path,
    retryable: false,
    meta: redactMeta({ expectedObjectType, actualObjectType }),
  };
}

/** Object not found (rule existence policy must_exist). */
export function objectNotFoundError(
  path: string,
  objectType: string,
  primaryKey: string,
): ActionError {
  return {
    code: "OBJECT_NOT_FOUND",
    message: `Object '${primaryKey}' of type '${objectType}' does not exist.`,
    stage: "compilation",
    path,
    retryable: false,
    meta: redactMeta({ objectType }),
  };
}

/** Object already exists (rule existence policy must_not_exist). */
export function objectAlreadyExistsError(
  path: string,
  objectType: string,
  primaryKey: string,
): ActionError {
  return {
    code: "OBJECT_ALREADY_EXISTS",
    message: `Object '${primaryKey}' of type '${objectType}' already exists.`,
    stage: "compilation",
    path,
    retryable: false,
    meta: redactMeta({ objectType }),
  };
}

/** Duplicate primary key across creates in the same invocation. */
export function duplicatePrimaryKeyError(
  path: string,
  objectType: string,
  primaryKey: string,
): ActionError {
  return {
    code: "DUPLICATE_PRIMARY_KEY",
    message: `Duplicate create for object '${primaryKey}' of type '${objectType}'.`,
    stage: "planning",
    path,
    retryable: false,
    meta: redactMeta({ objectType }),
  };
}

/** Final graph state would contain a dangling relationship. */
export function danglingRelationshipError(
  path: string,
  detail: { linkType: string; sourceObjectType: string; targetObjectType: string },
): ActionError {
  return {
    code: "DANGLING_RELATIONSHIP",
    message:
      `Final state would contain a dangling relationship of type '${detail.linkType}' ` +
      `(${detail.sourceObjectType} → ${detail.targetObjectType}).`,
    stage: "transaction",
    path,
    retryable: false,
    meta: redactMeta(detail),
  };
}

/** General final-state validation failure. */
export function finalStateInvalidError(message: string, path?: string): ActionError {
  return {
    code: "FINAL_STATE_INVALID",
    message,
    stage: "transaction",
    path,
    retryable: false,
  };
}

// ---------------------------------------------------------------------------
// Bounded blocking-relationship summary (§7)
// ---------------------------------------------------------------------------

/** A single blocking relationship (bounded sample entry). */
export interface BlockingRelationship {
  linkType: string;
  sourceObjectType: string;
  sourcePrimaryKey: string;
  targetObjectType: string;
  targetPrimaryKey: string;
  direction: "inbound" | "outbound";
}

/**
 * Aggregated, bounded summary of relationships blocking a delete. Used by
 * the preview contract and embedded (bounded) in the execution error.
 *
 * `sample` is capped at `maxBlockingSample` (default 50). Full details are
 * only available via a separate inspection endpoint — never unbounded in
 * an action-validation response.
 */
export interface BlockingRelationshipSummary {
  total: number;
  inboundCount: number;
  outboundCount: number;
  byLinkType: Array<{
    linkType: string;
    inbound: number;
    outbound: number;
  }>;
  sample: BlockingRelationship[];
  sampleTruncated: boolean;
}

/** Maximum number of sample relationships embedded in an error/preview response. */
export const MAX_BLOCKING_SAMPLE = 50;

/**
 * Truncate a raw list of blocking relationships down to the bounded summary
 * used in responses. Counts are always exact; `sample` is capped.
 */
export function buildBlockingSummary(
  raw: Array<Omit<BlockingRelationship, "direction"> & { direction: "inbound" | "outbound" }>,
): BlockingRelationshipSummary {
  const total = raw.length;
  let inboundCount = 0;
  let outboundCount = 0;
  const byLinkTypeMap = new Map<
    string,
    { inbound: number; outbound: number }
  >();

  for (const r of raw) {
    if (r.direction === "inbound") inboundCount++;
    else outboundCount++;
    const entry =
      byLinkTypeMap.get(r.linkType) ?? { inbound: 0, outbound: 0 };
    if (r.direction === "inbound") entry.inbound++;
    else entry.outbound++;
    byLinkTypeMap.set(r.linkType, entry);
  }

  const byLinkType = Array.from(byLinkTypeMap.entries()).map(
    ([linkType, counts]) => ({
      linkType,
      inbound: counts.inbound,
      outbound: counts.outbound,
    }),
  );

  const truncated = raw.slice(0, MAX_BLOCKING_SAMPLE) as BlockingRelationship[];
  return {
    total,
    inboundCount,
    outboundCount,
    byLinkType,
    sample: truncated,
    sampleTruncated: total > MAX_BLOCKING_SAMPLE,
  };
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Redact sensitive values from error metadata before it is logged or
 * returned. Primary-key and raw parameter values are never logged by
 * default. This is a defensive copy + scalar-only projection so structured
 * objects can't carry references to unbounded collections.
 */
export function redactMeta(
  meta?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    // Keep counts, booleans, enums, and bounded arrays/objects.
    // Drop raw PK/parameter value keys explicitly named for redaction.
    if (
      k === "primaryKey" ||
      k === "primary_key" ||
      k === "rawValue" ||
      k === "value" ||
      k === "parameters"
    ) {
      continue;
    }
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.length; // bound arrays to their length in metadata
    } else if (v && typeof v === "object") {
      out[k] = "[object]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conversion helpers (compat with the existing OntologyError path)
// ---------------------------------------------------------------------------

/**
 * Whether an error code represents a domain validation failure that must
 * NOT be retried (as opposed to concurrency/deadlock, which are retryable).
 */
export function isDomainValidationError(code: ActionErrorCode): boolean {
  return (
    code !== "CONCURRENCY_CONFLICT" &&
    code !== "DEADLOCK_RETRY_EXHAUSTED"
  );
}

/**
 * Whether an error code is a concurrency/transient failure that the
 * bounded-retry loop should attempt (serialization failure / deadlock).
 */
export function isConcurrencyFailure(code: ActionErrorCode): boolean {
  return code === "CONCURRENCY_CONFLICT";
}
