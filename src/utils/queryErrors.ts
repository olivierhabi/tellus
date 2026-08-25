// ---------------------------------------------------------------------------
// Query Error Classes (Task 15) + Standardized Error Module (Task 20)
//
// Error hierarchy for the Ontology Engine. Each error class sets its own
// HTTP status code and machine-readable error code.
//
// Task 20 enhancements:
//   - ERROR_CODES registry mapping errorCode -> { status, name }
//   - OntologyError now includes errorInstanceId, errorName, parameters
//   - toResponse() produces the Palantir-compatible standardized format
// ---------------------------------------------------------------------------

import crypto from "crypto";

// ---------------------------------------------------------------------------
// ERROR_CODES Registry (Task 20)
//
// Maps each machine-readable error code to its HTTP status and human-
// readable error class name. The OSDK relies on predictable error shapes,
// so this registry is the single source of truth.
// ---------------------------------------------------------------------------

export const STANDARD_ERROR_CODES: Record<string, { status: number; name: string }> = {
  // Action-specific errors (from Palantir's documented failure types)
  INVALID_PARAMETER:          { status: 400, name: "InvalidParameterError" },
  SCALE_LIMIT_EXCEEDED:       { status: 400, name: "ScaleLimitExceededError" },
  AUTHENTICATION_FAILURE:     { status: 403, name: "AuthenticationError" },
  OBJECT_NOT_FOUND:           { status: 404, name: "ObjectNotFoundError" },
  DUPLICATE_PRIMARY_KEY:      { status: 409, name: "DuplicatePrimaryKeyError" },
  REQUIRED_PROPERTY_MISSING:  { status: 400, name: "RequiredPropertyMissingError" },
  TYPE_MISMATCH:              { status: 400, name: "TypeMismatchError" },
  SIDE_EFFECT_FAILURE:        { status: 502, name: "SideEffectFailureError" },
  FUNCTION_FAILURE:           { status: 500, name: "FunctionFailureError" },
  CONCURRENCY_CONFLICT:       { status: 409, name: "ConcurrencyConflictError" },
  INVALID_OBJECT_REFERENCE:   { status: 400, name: "InvalidObjectReferenceError" },
  INVALID_PRIMARY_KEY:        { status: 400, name: "InvalidPrimaryKeyError" },
  OBJECT_TYPE_MISMATCH:       { status: 400, name: "ObjectTypeMismatchError" },
  OBJECT_ALREADY_EXISTS:      { status: 400, name: "ObjectAlreadyExistsError" },
  SAME_INVOCATION_REFERENCE_FORBIDDEN: {
    status: 422,
    name: "SameInvocationReferenceForbiddenError",
  },
  DELETE_BLOCKED_BY_RELATIONSHIPS: {
    status: 422,
    name: "DeleteBlockedByRelationshipsError",
  },
  DANGLING_RELATIONSHIP:      { status: 422, name: "DanglingRelationshipError" },
  FINAL_STATE_INVALID:        { status: 422, name: "FinalStateInvalidError" },
  INVALID_RULE_PARAMETER_TYPE: {
    status: 400,
    name: "InvalidRuleParameterTypeError",
  },
  UNSUPPORTED_SEMANTICS_VERSION: {
    status: 422,
    name: "UnsupportedActionSemanticsVersionError",
  },
  INCOMPATIBLE_ACTION_SEMANTICS: {
    status: 422,
    name: "IncompatibleActionSemanticsError",
  },
  INVALID_EXECUTION_MODE:     { status: 422, name: "InvalidExecutionModeError" },
  INVALID_DELETE_POLICY:      { status: 422, name: "InvalidDeletePolicyError" },
  // B1 (cross-functionality engagement) — submission criteria rejection is a
  // client-input failure (422), NOT a server error. Without this entry the
  // OntologyError defaults to 500, mis-classifying the criterion rejection
  // (the executor correctly throws SUBMISSION_CRITERIA_NOT_MET; the route's
  // error middleware maps the code → status via this registry).
  SUBMISSION_CRITERIA_NOT_MET: { status: 422, name: "SubmissionCriteriaNotMetError" },
  DEADLOCK_RETRY_EXHAUSTED:   { status: 500, name: "DeadlockRetryExhaustedError" },

  // General API errors
  NOT_FOUND:                  { status: 404, name: "NotFoundError" },
  CONFLICT:                   { status: 409, name: "ConflictError" },
  VALIDATION_ERROR:           { status: 400, name: "ValidationError" },
  INTERNAL_ERROR:             { status: 500, name: "InternalError" },
  ACTION_DISABLED:            { status: 400, name: "ActionDisabledError" },
  ACTION_TYPE_NOT_FOUND:      { status: 404, name: "ActionTypeNotFoundError" },
  OBJECT_TYPE_NOT_FOUND:      { status: 404, name: "ObjectTypeNotFoundError" },
  LINK_TYPE_NOT_FOUND:        { status: 404, name: "LinkTypeNotFoundError" },
  PROPERTY_NOT_FOUND:         { status: 404, name: "PropertyNotFoundError" },
  INDEX_ERROR:                { status: 500, name: "IndexError" },

  // Existing codes from the codebase that need backwards compatibility
  VALIDATION_FAILED:          { status: 400, name: "ValidationError" },
  ALREADY_EXISTS:             { status: 409, name: "ConflictError" },
  ONTOLOGY_NOT_FOUND:         { status: 404, name: "NotFoundError" },
  ONTOLOGY_ALREADY_EXISTS:    { status: 409, name: "ConflictError" },
  OBJECT_TYPE_ALREADY_EXISTS: { status: 409, name: "ConflictError" },
  PROPERTY_ALREADY_EXISTS:    { status: 409, name: "ConflictError" },
  ACTION_TYPE_ALREADY_EXISTS: { status: 409, name: "ConflictError" },
  // Phase 2 — interface link constraints.
  INTERFACE_LINK_CONSTRAINT_NOT_FOUND:    { status: 404, name: "NotFoundError" },
  INTERFACE_LINK_CONSTRAINT_ALREADY_EXISTS: { status: 409, name: "ConflictError" },
  // Phase 3 — governed webhook registry.
  WEBHOOK_NOT_FOUND:           { status: 404, name: "NotFoundError" },
  WEBHOOK_ALREADY_EXISTS:      { status: 409, name: "ConflictError" },
  WEBHOOK_VERSION_DISABLED:    { status: 409, name: "ConflictError" },
  DATASOURCE_NOT_FOUND:       { status: 404, name: "NotFoundError" },
  DATASOURCE_ALREADY_REGISTERED: { status: 409, name: "ConflictError" },
  INVALID_API_NAME:           { status: 400, name: "ValidationError" },
  INVALID_BASE_TYPE:          { status: 400, name: "ValidationError" },
  PRIMARY_KEY_NOT_SET:        { status: 400, name: "ValidationError" },
  DATASOURCE_FILE_NOT_FOUND:  { status: 400, name: "ValidationError" },
  COLUMN_MAPPING_INVALID:     { status: 400, name: "ValidationError" },
  REQUIRED_FIELD_MISSING:     { status: 400, name: "RequiredPropertyMissingError" },
  NO_BACKING_DATASOURCE:      { status: 400, name: "ValidationError" },
  // 413: the request is well-formed and authorized, but the object type is
  // too large for the in-heap datasource reindex path (see
  // REINDEX_MAX_MERGED_OBJECTS in reindexService). Not a 500 — the caller can
  // act on it by using the Object Storage V2 funnel instead.
  REINDEX_TOO_LARGE:          { status: 413, name: "PayloadTooLargeError" },
  INDEXING_IN_PROGRESS:       { status: 409, name: "ConflictError" },
  DATA_VALIDATION_ERROR:      { status: 400, name: "ValidationError" },
  EDIT_NOT_FOUND:             { status: 404, name: "NotFoundError" },
  AUDIT_ENTRY_NOT_FOUND:      { status: 404, name: "NotFoundError" },
  QUERY_VALIDATION_ERROR:     { status: 400, name: "ValidationError" },
  INCOMPATIBLE_FILTER:        { status: 400, name: "ValidationError" },
  INVALID_PAGE_TOKEN:         { status: 400, name: "ValidationError" },
  INVALID_AGGREGATION:        { status: 400, name: "ValidationError" },
  INVALID_QUERY:              { status: 400, name: "ValidationError" },
  OBJECT_DATABASE_UNAVAILABLE: { status: 503, name: "ServiceUnavailableError" },
  METADATA_STORE_UNAVAILABLE: { status: 503, name: "ServiceUnavailableError" },
  OPENSEARCH_CONNECTION_ERROR: { status: 503, name: "ServiceUnavailableError" },
  OPENSEARCH_ERROR:           { status: 503, name: "ServiceUnavailableError" },

  // Files & Projects B1 (tasks/files-projects/files-projects-tasks.md:125)
  INVALID_RID_FORMAT:         { status: 400, name: "InvalidRidFormatError" },
  RESOURCE_NOT_FOUND:         { status: 404, name: "ResourceNotFoundError" },
  BATCH_TOO_LARGE:            { status: 400, name: "BatchTooLargeError" },

  // Files & Projects B2 (tasks/files-projects/files-projects-tasks.md:185)
  SPACE_NOT_FOUND:                  { status: 404, name: "SpaceNotFoundError" },
  MOVE_BETWEEN_SPACES_FORBIDDEN:    { status: 409, name: "MoveBetweenSpacesForbiddenError" },
  ROOT_SPACE_IMMUTABLE:             { status: 409, name: "RootSpaceImmutableError" },

  // Files & Projects B3 — Filesystem v2 Public API (Conjure-faithful codes).
  // Contracts: tasks/files-projects/contracts.md (B3-C-50, B3-C-51).
  PRECONDITION_FAILED:              { status: 412, name: "PreconditionFailedError" },
  PRECONDITION_REQUIRED:            { status: 428, name: "PreconditionRequiredError" },
  INVALID_ARGUMENT:                 { status: 400, name: "InvalidArgumentError" },
  RESOURCE_NAME_CONFLICT:           { status: 409, name: "ResourceNameConflictError" },
  IDEMPOTENCY_KEY_CONFLICT:         { status: 409, name: "IdempotencyKeyConflictError" },
  PERMISSION_DENIED:                { status: 403, name: "PermissionDeniedError" },
};

// ---------------------------------------------------------------------------
// Levenshtein distance (for "did you mean?" suggestions)
// ---------------------------------------------------------------------------

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ---------------------------------------------------------------------------
// Base class (Task 15 + Task 20 enhancements)
// ---------------------------------------------------------------------------

export class OntologyError extends Error {
  /** Machine-readable error code (e.g., "INVALID_PARAMETER"). */
  code: string;
  /** HTTP status code for this error. */
  statusCode: number;
  /** Backward-compatible details object (Task 15 format). */
  details: Record<string, unknown>;
  /** Human-readable error class name (e.g., "InvalidParameterError"). */
  errorName: string;
  /** Unique ID for this specific error instance — for log correlation. */
  errorInstanceId: string;
  /** Structured parameters providing context about the error. */
  parameters: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    statusCode?: number,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "OntologyError";
    this.code = code;
    // If statusCode is explicitly provided, use it; otherwise look up from registry
    this.statusCode = statusCode ?? (STANDARD_ERROR_CODES[code]?.status || 500);
    this.details = details;
    this.errorName = STANDARD_ERROR_CODES[code]?.name || "UnknownError";
    this.errorInstanceId = crypto.randomUUID();
    this.parameters = details; // alias — details and parameters are the same
  }

  /**
   * Produce the Ontology Platform spec §2.1 error envelope. The legacy
   * `errorInstanceId` field is retained for backward compatibility with
   * older clients, but the canonical contract is:
   *   {errorCode, errorName, message, statusCode, requestId, parameters}
   */
  toResponse(): {
    errorCode: string;
    errorName: string;
    message: string;
    statusCode: number;
    requestId: string;
    parameters: Record<string, unknown>;
    errorInstanceId: string;
  } {
    return {
      errorCode: this.code,
      errorName: this.errorName,
      message: this.message,
      statusCode: this.statusCode,
      requestId: this.errorInstanceId,
      parameters: this.parameters,
      errorInstanceId: this.errorInstanceId,
    };
  }
}

// ---------------------------------------------------------------------------
// Specific error classes
// ---------------------------------------------------------------------------

export class ObjectTypeNotFoundError extends OntologyError {
  constructor(objectType: string, availableTypes: string[] = []) {
    const msg = `Object type '${objectType}' not found. Available types: ${availableTypes.join(", ") || "(none)"}.`;
    super(msg, "OBJECT_TYPE_NOT_FOUND", 404, { objectType, availableTypes });
    this.name = "ObjectTypeNotFoundError";
  }
}

export class ObjectNotFoundError extends OntologyError {
  constructor(objectType: string, primaryKey: string) {
    super(
      `Object '${primaryKey}' not found in object type '${objectType}'.`,
      "OBJECT_NOT_FOUND", 404, { objectType, primaryKey }
    );
    this.name = "ObjectNotFoundError";
  }
}

export class PropertyNotFoundError extends OntologyError {
  constructor(property: string, objectType: string, validProperties: string[] = []) {
    const suggestions = validProperties
      .map((p) => ({ name: p, dist: levenshteinDistance(property.toLowerCase(), p.toLowerCase()) }))
      .filter((s) => s.dist <= 2)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3)
      .map((s) => s.name);

    const msg = suggestions.length > 0
      ? `Property '${property}' not found on object type '${objectType}'. Did you mean: ${suggestions.join(", ")}?`
      : `Property '${property}' not found on object type '${objectType}'. Valid properties: ${validProperties.join(", ")}.`;

    super(msg, "PROPERTY_NOT_FOUND", 400, { property, objectType, validProperties, suggestions });
    this.name = "PropertyNotFoundError";
  }
}

export class QueryValidationError extends OntologyError {
  constructor(message: string, field: string | null = null) {
    super(message, "INVALID_QUERY", 400, { field });
    this.name = "QueryValidationError";
  }
}

export class IncompatibleFilterError extends OntologyError {
  constructor(filterType: string, property: string, propertyType: string) {
    super(
      `Filter '${filterType}' is not compatible with property '${property}' of type '${propertyType}'.`,
      "INCOMPATIBLE_FILTER", 400, { filterType, property, propertyType }
    );
    this.name = "IncompatibleFilterError";
  }
}

export class PageTokenError extends OntologyError {
  constructor(reason: string) {
    super(`Invalid page token: ${reason}.`, "INVALID_PAGE_TOKEN", 400, { reason });
    this.name = "PageTokenError";
  }
}

export class ObjectDatabaseUnavailableError extends OntologyError {
  constructor(message = "OpenSearch is currently unavailable. Please try again.") {
    super(message, "OBJECT_DATABASE_UNAVAILABLE", 503, {});
    this.name = "ObjectDatabaseUnavailableError";
  }
}

export class MetadataStoreUnavailableError extends OntologyError {
  constructor(message = "PostgreSQL is currently unavailable. Please try again.") {
    super(message, "METADATA_STORE_UNAVAILABLE", 503, {});
    this.name = "MetadataStoreUnavailableError";
  }
}

export class AggregationError extends OntologyError {
  constructor(message: string) {
    super(message, "INVALID_AGGREGATION", 400, {});
    this.name = "AggregationError";
  }
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

export function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string) {
    if (condition) { passed++; console.log(`  PASS  ${label}`); }
    else { failed++; console.log(`  FAIL  ${label}`); }
  }

  console.log("=== QueryErrors self-test ===");

  const propErr = new PropertyNotFoundError("deparment", "Employee", ["department", "employeeId", "salary"]);
  assert(propErr.message.includes("Did you mean: department"), "PropertyNotFound suggests 'department'");
  assert(propErr.statusCode === 400, "PropertyNotFound is 400");
  assert(propErr.code === "PROPERTY_NOT_FOUND", "PropertyNotFound code correct");

  const propErr2 = new PropertyNotFoundError("xyz", "Employee", ["department", "employeeId"]);
  assert(!propErr2.message.includes("Did you mean"), "No suggestion for 'xyz' (distance > 2)");
  assert(propErr2.message.includes("Valid properties"), "Falls back to listing valid properties");

  const otErr = new ObjectTypeNotFoundError("Employe", ["Employee", "Company"]);
  assert(otErr.statusCode === 404, "ObjectTypeNotFound is 404");
  assert(otErr.message.includes("Employee, Company"), "Lists available types");

  const qErr = new QueryValidationError("bad query", "$pageSize");
  assert(qErr.statusCode === 400, "QueryValidation is 400");
  assert(qErr.code === "INVALID_QUERY", "QueryValidation code correct");

  const dbErr = new ObjectDatabaseUnavailableError();
  assert(dbErr.statusCode === 503, "DatabaseUnavailable is 503");

  assert(new OntologyError("test", "TEST", 500) instanceof Error, "OntologyError extends Error");

  // Task 20: Test new standardized fields
  const stdErr = new OntologyError("test error", "INVALID_PARAMETER", undefined, { param: "salary" });
  assert(stdErr.statusCode === 400, "OntologyError looks up status from STANDARD_ERROR_CODES");
  assert(stdErr.errorName === "InvalidParameterError", "OntologyError gets errorName from registry");
  assert(typeof stdErr.errorInstanceId === "string" && stdErr.errorInstanceId.length > 0, "OntologyError has errorInstanceId");
  assert(stdErr.parameters.param === "salary", "OntologyError has parameters");

  const resp = stdErr.toResponse();
  assert(resp.errorCode === "INVALID_PARAMETER", "toResponse() has errorCode");
  assert(resp.errorName === "InvalidParameterError", "toResponse() has errorName");
  assert(resp.errorInstanceId === stdErr.errorInstanceId, "toResponse() has errorInstanceId");
  assert(resp.message === "test error", "toResponse() has message");
  assert((resp.parameters as any).param === "salary", "toResponse() has parameters");

  // Test unknown code fallback
  const unkErr = new OntologyError("unknown", "UNKNOWN_CODE");
  assert(unkErr.statusCode === 500, "Unknown code defaults to 500");
  assert(unkErr.errorName === "UnknownError", "Unknown code defaults to UnknownError");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
