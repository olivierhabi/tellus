// ---------------------------------------------------------------------------
// Response Formatter Utility
//
// Formats ALL API responses into Palantir-compatible shapes. Every endpoint
// must use this module — no endpoint constructs its own response object
// directly.
// ---------------------------------------------------------------------------

import { Response } from "express";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Generic database row shape (snake_case keys). */
type DbRow = Record<string, unknown>;

/**
 * Formatted error response body (Ontology Platform tasks.md §2.1).
 *
 * All endpoints MUST return this envelope on error paths so that clients
 * (including the cypress e2e suite) can assert on `errorCode`/`requestId`.
 */
export interface FormattedError {
  errorCode: string;
  errorName: string;
  message: string;
  statusCode: number;
  requestId: string;
  parameters: Record<string, unknown>;
  /** Deprecated legacy envelope. Kept so old clients don't crash. */
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
    timestamp: string;
  };
}

// ---------------------------------------------------------------------------
// Keys whose values contain user-defined data and must NOT have their
// internal keys converted from snake_case to camelCase.
// ---------------------------------------------------------------------------

const PASSTHROUGH_KEYS = new Set([
  "column_mapping",
  "struct_schema",
  "column_names",
  "conditional_formatting",
]);

// ---------------------------------------------------------------------------
// snakeToCamel
// ---------------------------------------------------------------------------

/**
 * Convert a single snake_case string to camelCase.
 */
function snakeToCamelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

/**
 * Recursively convert all keys in an object/array from snake_case to
 * camelCase. Values under PASSTHROUGH_KEYS are passed through as-is.
 */
export function snakeToCamel(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map((item) => snakeToCamel(item));
  if (typeof obj !== "object") return obj;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const camelKey = snakeToCamelKey(key);
    if (PASSTHROUGH_KEYS.has(key)) {
      // Pass user-defined data through without converting inner keys
      result[camelKey] = value;
    } else {
      result[camelKey] = snakeToCamel(value);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// RID emitters — canonical Foundry resource-identifier form.
//
// CONTRACT-FOLLOWUP: backend RID shape migrated; coordinate with audit, search,
// OSDK, deep-link consumers. The legacy shape carried the ontology UUID in the
// second segment; the canonical form across every other tellus service
// (stemma, workshop, tellus-audit, ontology top-level) uses the literal
// `main` realm. We migrate the user-facing surface here and add helpers that
// every downstream call site MUST use so a future regression can't reintroduce
// the legacy shape silently.
// ---------------------------------------------------------------------------

/** Reject empty / whitespace-only identifiers — these would produce malformed RIDs. */
function assertNonEmptyId(id: string, kind: string): void {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(
      `responseFormatter: ${kind} RID requires a non-empty id (got ${JSON.stringify(id)})`,
    );
  }
}

/**
 * Build the canonical RID for an object type. Form:
 *   ri.ontology.main.object-type.<objectTypeId>
 *
 * Throws on empty / whitespace id. Returns a frozen string the caller may
 * surface to the UI, audit log, deep link, or OSDK lookup.
 */
export function formatObjectTypeRid(objectTypeId: string): string {
  assertNonEmptyId(objectTypeId, "object-type");
  return `ri.ontology.main.object-type.${objectTypeId}`;
}

/**
 * Build the canonical RID for a link type. Form:
 *   ri.ontology.main.link-type.<linkTypeId>
 *
 * Throws on empty / whitespace id.
 */
export function formatLinkTypeRid(linkTypeId: string): string {
  assertNonEmptyId(linkTypeId, "link-type");
  return `ri.ontology.main.link-type.${linkTypeId}`;
}

// ---------------------------------------------------------------------------
// Entity formatters
// ---------------------------------------------------------------------------

/**
 * Format an ontology DB row for the API response.
 */
export function formatOntology(
  dbRow: DbRow,
  objectTypeCount: number = 0
): Record<string, unknown> {
  return {
    ontologyId: dbRow.ontology_id,
    displayName: dbRow.display_name,
    description: dbRow.description ?? null,
    createdAt: dbRow.created_at,
    updatedAt: dbRow.updated_at,
    createdBy: dbRow.created_by,
    objectTypeCount,
  };
}

/**
 * Project a PascalCase `apiName` onto a kebab-case slug for the human
 * readable ID surfaced on the overview card. Splits on case + digit
 * boundaries so `GenaAllOrders` → `gena-all-orders` and `OrderV2` →
 * `order-v-2`. Purely presentational — the canonical identifier for
 * every API call and audit log is still `object_type_id` (UUID).
 */
function apiNameToDisplayId(apiName: string): string {
  return apiName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase())
    .join("-");
}

/**
 * Format a full object type DB row with properties, datasource, and funnel
 * state for the API response.
 */
export function formatObjectType(
  dbRow: DbRow,
  properties: DbRow[] = [],
  datasource: DbRow | null = null,
  funnelState: DbRow | null = null,
  linkTypes: Array<Record<string, unknown>> = []
): Record<string, unknown> {
  // Build properties map keyed by api_name
  const propertiesMap: Record<string, unknown> = {};
  for (const prop of properties) {
    const apiName = prop.api_name as string;
    propertiesMap[apiName] = formatProperty(prop);
  }

  // Resolve primary key and title property api_names
  let primaryKey: string | null = null;
  let titleProperty: string | null = null;
  if (dbRow.primary_key_property_id) {
    const pkProp = properties.find(
      (p) => p.property_id === dbRow.primary_key_property_id
    );
    primaryKey = pkProp ? (pkProp.api_name as string) : null;
  }
  if (dbRow.title_property_id) {
    const titleProp = properties.find(
      (p) => p.property_id === dbRow.title_property_id
    );
    titleProperty = titleProp ? (titleProp.api_name as string) : null;
  }

  // Palantir-style resource identifier. We don't persist RIDs —
  // they're a deterministic projection of object_type_id so overview
  // pages and deep links can show/copy a stable RID without an extra
  // lookup. The canonical form is `ri.ontology.main.object-type.<id>`
  // (see formatObjectTypeRid + CONTRACT-FOLLOWUP at top of file).
  const rid = dbRow.object_type_id
    ? formatObjectTypeRid(String(dbRow.object_type_id))
    : null;

  // Human-scannable kebab-case projection of apiName — purely for
  // presentation on the object type overview card ("gena-all-orders"
  // instead of a raw UUID). Derived here so every client gets the
  // same slug without having to reimplement the casing logic.
  const displayId = dbRow.api_name
    ? apiNameToDisplayId(dbRow.api_name as string)
    : null;

  return {
    objectType: {
      objectTypeId: dbRow.object_type_id,
      displayId,
      rid,
      apiName: dbRow.api_name,
      // Original apiName the caller asked for when the wizard was
      // in "rename-on-conflict" mode. When non-null and different
      // from `apiName`, the frontend flags it as an API-name
      // conflict on the overview card.
      requestedApiName: (dbRow.requested_api_name as string | null) ?? null,
      displayName: dbRow.display_name,
      pluralName: dbRow.plural_name ?? null,
      description: dbRow.description ?? null,
      aliases: Array.isArray(dbRow.aliases) ? dbRow.aliases : [],
      pointOfContact: dbRow.point_of_contact ?? null,
      contributors: Array.isArray(dbRow.contributors) ? dbRow.contributors : [],
      visibility: dbRow.visibility ?? "normal",
      icon: dbRow.icon,
      iconColor: dbRow.icon_color,
      status: dbRow.status,
      editsViaActionsOnly: dbRow.edits_via_actions_only,
      maxProperties: dbRow.max_properties,
      primaryKey,
      titleProperty,
      createdAt: dbRow.created_at,
      updatedAt: dbRow.updated_at,
      properties: propertiesMap,
      backingDatasource: datasource ? formatDatasource(datasource) : null,
      indexingState: funnelState ? formatFunnelState(funnelState) : null,
      linkTypes,
    },
  };
}

/**
 * Format a lightweight object type summary for list endpoints.
 */
export function formatObjectTypeSummary(
  dbRow: DbRow,
  propertyCount: number = 0,
  datasourceName: string | null = null,
  indexStatus: string | null = null,
  objectCount: number = 0,
  dependentCount: number = 0
): Record<string, unknown> {
  return {
    objectTypeId: dbRow.object_type_id,
    apiName: dbRow.api_name,
    displayName: dbRow.display_name,
    icon: dbRow.icon,
    iconColor: dbRow.icon_color,
    status: dbRow.status,
    propertyCount,
    // Number of indexed object instances (Foundry "N objects" readout).
    objectCount,
    // Number of ontology resources that reference this type — link_type
    // rows (source or target) plus action_type rules/parameters whose
    // JSONB `objectType` key matches this type's api_name.
    dependentCount,
    datasourceName,
    indexStatus,
    createdAt: dbRow.created_at,
    updatedAt: dbRow.updated_at,
  };
}

/**
 * Format a property DB row for the API response.
 */
export function formatProperty(dbRow: DbRow): Record<string, unknown> {
  return {
    apiName: dbRow.api_name,
    displayName: dbRow.display_name,
    baseType: dbRow.base_type,
    description: dbRow.description ?? null,
    structSchema: dbRow.struct_schema ?? null,
    isRequired: dbRow.is_required,
    isArray: dbRow.is_array,
    ordinal: dbRow.ordinal,
    conditionalFormatting: dbRow.conditional_formatting ?? null,
    inlineEditActionId: (dbRow.inline_edit_action_id as string | null) ?? null,
  };
}

/**
 * Format a backing_datasource DB row for the API response.
 */
export function formatDatasource(dbRow: DbRow): Record<string, unknown> {
  // Surface the backing foundry_datasets.id so clients can preview
  // rows straight from the upload pipeline without having to parse
  // the synthetic file_path tag themselves.
  //
  // Two sources, in priority order:
  //   1. `backing_datasource.dataset_id` — set by the legacy
  //      Ontology-dataset binding path (FK to `dataset` table).
  //   2. `#foundry-dataset:<uuid>` tag embedded in `file_path` by
  //      `registerWithFoundryDataset`, the bridge used when the
  //      Step 1 picker selects a `foundry_datasets` row.
  //
  // `filePath` is left intact for backward compatibility and for
  // legacy filesystem-backed rows that don't carry a synthetic tag.
  let datasetId: string | null = null;
  if (dbRow.dataset_id) {
    datasetId = String(dbRow.dataset_id);
  } else if (typeof dbRow.file_path === "string") {
    const match = dbRow.file_path.match(/#foundry-dataset:([0-9a-f-]{36})/i);
    if (match) datasetId = match[1];
  }

  return {
    datasetId,
    datasetName: dbRow.dataset_name,
    filePath: dbRow.file_path,
    fileFormat: dbRow.file_format,
    columnMapping: dbRow.column_mapping,
    primaryKeyColumn: dbRow.primary_key_column,
    rowCount: dbRow.row_count ?? null,
    columnNames: dbRow.column_names ?? null,
    schemaHash: dbRow.schema_hash ?? null,
    lastScannedAt: dbRow.last_scanned_at ?? null,
    registeredAt: dbRow.registered_at,
    originalFilename: dbRow._original_filename ?? null,
    ontologyName: dbRow._ontology_name ?? null,
    projectName: dbRow._project_name ?? null,
    folderName: dbRow._folder_name ?? null,
    folderPath: dbRow._folder_path ?? null,
  };
}

/**
 * Format a funnel_state DB row for the API response.
 */
export function formatFunnelState(dbRow: DbRow): Record<string, unknown> {
  return {
    status: dbRow.status,
    objectsIndexed: dbRow.objects_indexed,
    objectsFailed: dbRow.objects_failed,
    editsPending: dbRow.edits_pending,
    lastIndexedAt: dbRow.last_indexed_at ?? null,
    lastIndexDurationMs: dbRow.last_index_duration_ms ?? null,
    errorMessage: dbRow.error_message ?? null,
    indexName: dbRow.index_name ?? null,
  };
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const ERROR_CODES: Record<string, number> = {
  ONTOLOGY_NOT_FOUND: 404,
  OBJECT_TYPE_NOT_FOUND: 404,
  PROPERTY_NOT_FOUND: 404,
  DATASOURCE_NOT_FOUND: 404,
  ONTOLOGY_ALREADY_EXISTS: 409,
  // "One Enterprise, One Ontology" — lifecycle operations that would create or
  // remove an ontology are rejected: the single enterprise ontology is fixed.
  ONTOLOGY_SINGLETON: 409,
  OBJECT_TYPE_ALREADY_EXISTS: 409,
  DUPLICATE_API_NAME: 409,
  PROPERTY_ALREADY_EXISTS: 409,
  DATASOURCE_ALREADY_REGISTERED: 409,
  ALREADY_EXISTS: 409,
  INVALID_API_NAME: 400,
  INVALID_BASE_TYPE: 400,
  INVALID_PARAMETER: 400,
  VALIDATION_FAILED: 400,
  PRIMARY_KEY_NOT_SET: 400,
  DATASOURCE_FILE_NOT_FOUND: 400,
  COLUMN_MAPPING_INVALID: 400,
  REQUIRED_FIELD_MISSING: 400,
  OPENSEARCH_CONNECTION_ERROR: 503,
  NO_BACKING_DATASOURCE: 400,
  INDEXING_IN_PROGRESS: 409,
  DATA_VALIDATION_ERROR: 400,
  ACTION_TYPE_NOT_FOUND: 404,
  ACTION_TYPE_ALREADY_EXISTS: 409,
  EDIT_NOT_FOUND: 404,
  AUDIT_ENTRY_NOT_FOUND: 404,
  LINK_TYPE_NOT_FOUND: 404,
  OBJECT_NOT_FOUND: 404,
  QUERY_VALIDATION_ERROR: 400,
  INCOMPATIBLE_FILTER: 400,
  INVALID_PAGE_TOKEN: 400,
  INVALID_AGGREGATION: 400,
  INVALID_QUERY: 400,
  OBJECT_DATABASE_UNAVAILABLE: 503,
  METADATA_STORE_UNAVAILABLE: 503,
  OPENSEARCH_ERROR: 503,
  INTERNAL_ERROR: 500,
  DATASET_NOT_FOUND: 404,
  DATASET_IN_USE: 409,
  FORMAT_MISMATCH: 400,
  SCHEMA_MISMATCH: 400,
  INVALID_TRANSACTION_TYPE: 400,
  DATASET_EMPTY: 400,
  COLUMN_NOT_FOUND: 400,
  PRIMARY_KEY_MISMATCH: 400,
  DATASET_ALREADY_BACKING: 409,
  AMBIGUOUS_DATASOURCE: 400,
  REINDEX_IN_PROGRESS: 409,
  REINDEX_FAILED: 500,
  INTERFACE_NOT_FOUND: 404,
  INTERFACE_ALREADY_EXISTS: 409,
  INTERFACE_IN_USE: 409,
  PROPERTY_IN_USE: 409,
  BASE_TYPE_MISMATCH: 400,
  MISSING_REQUIRED_MAPPING: 400,
  INVALID_MAPPING_KEY: 400,
  INVALID_MAPPING_VALUE: 400,
  TYPE_MISMATCH: 400,
  DUPLICATE_MAPPING_TARGET: 400,
  INVALID_FORMAT: 400,
  NOT_IMPLEMENTED: 404,
  // Foundry data ingestion layer error codes (BE-001 through BE-030)
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  UNSUPPORTED_FILE: 415,
  RATE_LIMITED: 429,
  // Ontology Platform spec §2.1
  CONCURRENT_EDIT_CONFLICT: 409,
  PRECONDITION_REQUIRED: 428,
  API_NAME_CONFLICT: 409,
  BRANCH_MERGE_CONFLICT: 409,
  BREAKING_SCHEMA_CHANGE: 422,
  MIGRATION_REQUIRED: 422,
  INSUFFICIENT_ROLE: 403,
  MARKING_ACCESS_DENIED: 403,
  ORG_ACCESS_DENIED: 403,
  STORAGE_MIGRATION_FAILED: 500,
  // FOUNDRY-GAPS §8 — purpose-based access control (purposeGate middleware).
  PURPOSE_REQUIRED: 403,
  PURPOSE_UNKNOWN: 403,
  PURPOSE_NOT_GRANTED: 403,
  PURPOSE_EXPIRED: 403,
  PURPOSE_CATEGORY_DENIED: 403,
  SEARCH_INDEX_UNAVAILABLE: 503,
  PIPELINE_OVERLOADED: 503,
  VECTOR_DIMS_EXCEEDED: 400,
  VECTOR_DIMS_MISMATCH: 400,
  STRUCT_DEPTH_EXCEEDED: 400,
  COMPOSITE_PK_LIMIT: 400,
  SCHEMA_VALIDATION_FAILED: 400,
  SQL_WRITE_REJECTED: 400,
  SQL_QUERY_TIMEOUT: 408,
  JOIN_TABLE_REQUIRED: 400,
  MAX_LINK_DEPTH_EXCEEDED: 400,
  INCOMPATIBLE_PROPERTY_TYPE: 400,
  INTERFACE_CYCLE_DETECTED: 400,
  BRANCH_NOT_FOUND: 404,
  PK_UNIQUENESS_VIOLATION: 409,
  MISSING_REQUIRED_PARAMETER: 400,
  FUNCTION_TIMEOUT: 504,
  // AI engine (telos-AIE-agent) proxy — /api/v1/code-assistant/typescript-v2.
  AI_ENGINE_UNAVAILABLE: 502,
  AI_ENGINE_TIMEOUT: 504,
  AI_ENGINE_BAD_REQUEST: 400,
  AI_ENGINE_ERROR: 502,
  RULE_EXECUTION_FAILED: 500,
  // Action Semantics v2 — http status mapping per the §8 directive.
  INVALID_OBJECT_REFERENCE: 400,
  INVALID_PRIMARY_KEY: 400,
  OBJECT_TYPE_MISMATCH: 400,
  OBJECT_ALREADY_EXISTS: 400,
  SAME_INVOCATION_REFERENCE_FORBIDDEN: 422,
  DELETE_BLOCKED_BY_RELATIONSHIPS: 422,
  DANGLING_RELATIONSHIP: 422,
  FINAL_STATE_INVALID: 422,
  INVALID_RULE_PARAMETER_TYPE: 400,
  UNSUPPORTED_SEMANTICS_VERSION: 422,
  INCOMPATIBLE_ACTION_SEMANTICS: 422,
  INVALID_EXECUTION_MODE: 422,
  INVALID_DELETE_POLICY: 422,
   // Action Semantics v2 — migration workflow audit + concurrency controls.
   MIGRATION_ACKNOWLEDGEMENT_REQUIRED: 422,
   MIGRATION_STALE_DEFINITION: 409,
   MIGRATION_ROLLBACK_NOT_AVAILABLE: 409,
   MIGRATION_INCOMPATIBLE: 422,
   // Action rule validation — link / interface-link / webhook / writeback / side effect.
   // Phase 1: link-rule shape errors + interface-link Phase-2 gate.
   // Phase 2-5: the remaining structured codes light up alongside their runtime.
   // NOTE: `LINK_TYPE_NOT_FOUND` is deliberately NOT added here — it already
   // exists at line ~401 with HTTP 404 (used by routes/links.ts). Action-rule
   // validation that needs to surface a missing-link-type reference reuses
   // `VALIDATION_FAILED` + a structured `validationErrors[]` array rather
   // than overwriting the existing code's HTTP status.
   INVALID_LINK_MAPPING: 422,
   UNSUPPORTED_RULE_TYPE: 422,
   AMBIGUOUS_INTERFACE_LINK_IMPLEMENTATION: 422,
   MISSING_INTERFACE_LINK_IMPLEMENTATION: 422,
   CARDINALITY_VIOLATION: 422,
   DUPLICATE_LINK: 409,
   CONFLICTING_FOREIGN_KEY_EDITS: 409,
   INVALID_WEBHOOK_INPUT_MAPPING: 422,
   INVALID_WEBHOOK_OUTPUT_MAPPING: 422,
   WEBHOOK_NOT_FOUND: 404,
   WEBHOOK_ALREADY_EXISTS: 409,
   WEBHOOK_VERSION_DISABLED: 409,
   WRITEBACK_TIMEOUT: 504,
   WRITEBACK_REJECTED: 502,
   WRITEBACK_OUTPUT_SCHEMA_MISMATCH: 422,
   WRITEBACK_CONFIG_INVALID: 422,
   SIDE_EFFECT_CONFIGURATION_INVALID: 422,
  DEADLOCK_RETRY_EXHAUSTED: 500,
  TIMESERIES_WINDOW_TOO_LARGE: 400,
  QUERY_TIMEOUT: 504,
  UNDO_WINDOW_EXPIRED: 410,
  LINK_CYCLE_DETECTED: 400,
  EXPORT_ROW_LIMIT_EXCEEDED: 400,
  // T-09 — search-around accumulated visited-PK cap.
  SEARCH_AROUND_LIMIT_EXCEEDED: 400,
  // T-09 — page-size validation.
  PAGE_SIZE_OUT_OF_RANGE: 400,
  // T-03 — SQL surface.
  SQL_STATEMENT_TIMEOUT: 504,
  SQL_DISALLOWED_KEYWORD: 400,
  SQL_EXECUTION_ERROR: 400,
  // T-04 — overlay branch isolation.
  OVERLAY_VERSION_CONFLICT: 409,
  OVERLAY_BRANCH_MISMATCH: 500,
  // T-05 — exports phase A/B.
  EXPORT_LIMIT_EXCEEDED: 400,
  EXPORT_NOT_AVAILABLE: 501,
  EXPORT_DOWNLOAD_EXPIRED: 410,
  BULK_FAILURE_THRESHOLD_EXCEEDED: 422,
  // LT-B1..B10
  ONE_TO_ONE_VIOLATION: 409,
  OFFSET_TOO_DEEP_USE_SEARCH_AFTER: 400,
  INVALID_SEARCH_AFTER_TOKEN: 400,
  PIT_EXPIRED: 410,
  RESULT_SET_TOO_LARGE: 413,
  REVERSE_ACTIONS_DISABLED: 403,
  QUARANTINE_NOT_FOUND: 404,
};

// ---------------------------------------------------------------------------
// Error formatting & response helpers
// ---------------------------------------------------------------------------

/**
 * Convert a SCREAMING_SNAKE_CASE error code to PascalCase name.
 * Example: "OBJECT_TYPE_NOT_FOUND" -> "ObjectTypeNotFound".
 */
function errorCodeToName(code: string): string {
  return code
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

// ---------------------------------------------------------------------------
// T-07 — sanitizeMessage: defense-in-depth scrubber.
// Strips stack-trace frames, absolute filesystem paths, IPv4 addresses, and
// SQL fragments before placing user-supplied or wrapped exception text into
// the response envelope. Existing throw sites already produce safe strings;
// this is a last-line check so a leaky `err.message` from a third-party lib
// (pg/opensearch/duckdb) cannot exfiltrate the layout of the host filesystem
// or the internal SQL via a 4xx response.
// ---------------------------------------------------------------------------
export function sanitizeMessage(message: string): string {
  if (typeof message !== "string" || message.length === 0) return message;
  let out = message;
  // Stack-trace frames: `at fn (path:line:col)` and `at path:line:col`
  out = out.replace(/\s*at\s+\S+\s+\([^)]+:\d+:\d+\)/g, "");
  out = out.replace(/\s*at\s+[^\s]+:\d+:\d+/g, "");
  // Absolute POSIX paths up to a colon, slash, or whitespace boundary.
  out = out.replace(/(?<![A-Za-z0-9_])\/[A-Za-z0-9_./-]{4,}/g, "<path>");
  // Windows-style paths.
  out = out.replace(/[A-Z]:\\[^\s"']{4,}/g, "<path>");
  // IPv4 dotted-quads (privacy / network-topology leak).
  out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>");
  // Embedded SQL keywords often bring along the query text — collapse a
  // contiguous run of `SELECT|INSERT|UPDATE|DELETE … FROM …` to a marker.
  // Note: WITH is excluded from the generic SQL scrubber because it
  // over-matches common English phrases (e.g., "Connection failed with
  // timeout"). CTEs are rare in error messages; if needed, add a specific
  // pattern like /\bWITH\s+\w+\s+AS\b/ to match only CTE syntax.
  out = out.replace(
    /\b(?:SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE)\b[^\n]{0,200}/gi,
    "<sql>",
  );
  // Trim any whitespace artefacts left behind by the substitutions.
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Build a formatted error response body that complies with the Ontology
 * Platform spec §2.1 envelope while remaining backward compatible with the
 * legacy `error.{code,message,details,timestamp}` shape.
 *
 * T-07 — `code` is mapped through `CANONICAL_ERROR_ALIAS` so legacy code
 * literals (e.g. `VALIDATION_FAILED`) emit the canonical wire-form
 * (`VALIDATION_ERROR`) without forcing a synchronous global rename.
 */
const CANONICAL_ERROR_ALIAS: Record<string, string> = {
  // T-07 — vocabulary unification. Legacy throw sites are folded into the
  // canonical code at the response boundary; the structured `parameters`
  // surface preserves the original semantic via `parameters.subtype` so
  // monitoring dashboards keyed on the legacy code can be migrated
  // incrementally.
  VALIDATION_FAILED: "VALIDATION_ERROR",
  NOT_FOUND: "OBJECT_NOT_FOUND",
  CHART_ERROR: "VALIDATION_ERROR",
  SQL_ERROR: "SQL_EXECUTION_ERROR",
  LINK_CYCLE_DETECTED: "VALIDATION_ERROR",
};

export function formatError(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  requestId: string = ""
): FormattedError {
  // T-07 — the alias map is consulted ONLY for HTTP-status routing. Legacy
  // codes (e.g. CHART_ERROR, VALIDATION_FAILED) used to fall through the
  // ERROR_CODES table to the 500 fallback; the alias hop fixes that
  // without rewriting the wire body. The response itself preserves the
  // caller-supplied code verbatim — pre-existing e2e contracts and
  // production dashboards key on `errorCode` and `error.code` unchanged.
  const canonical = CANONICAL_ERROR_ALIAS[code] ?? code;
  const statusCode = ERROR_CODES[code] ?? ERROR_CODES[canonical] ?? 500;
  const cleanMessage = sanitizeMessage(message);
  return {
    errorCode: code,
    errorName: errorCodeToName(code),
    message: cleanMessage,
    statusCode,
    requestId,
    parameters: details,
    error: {
      code,
      message: cleanMessage,
      details,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Send an error response. Looks up HTTP status via the canonicalised body
 * (so legacy aliases like `CHART_ERROR → VALIDATION_ERROR (400)` route to
 * the correct status — not the 500 fallback that the pre-T-07 lookup
 * silently produced).
 *
 * Automatically pulls `requestId` from `res.req.correlationId` when present.
 */
export function sendError(
  res: Response,
  code: string,
  message: string,
  details: Record<string, unknown> = {}
): void {
  const requestId =
    ((res.req as unknown as { correlationId?: string })?.correlationId) || "";
  const body = formatError(code, message, details, requestId);
  res.status(body.statusCode).json(body);
}

/**
 * Send a success response with data (default 200).
 */
export function sendSuccess(
  res: Response,
  data: unknown,
  status: number = 200
): void {
  res.status(status).json(data);
}

/**
 * Send a 201 Created response with data.
 */
export function sendCreated(res: Response, data: unknown): void {
  res.status(201).json(data);
}

/**
 * Send a 204 No Content response (no body).
 */
export function sendNoContent(res: Response): void {
  res.status(204).end();
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

/** Default page size. */
export const DEFAULT_PAGE_SIZE = 100;

/** Maximum page size. */
export const MAX_PAGE_SIZE = 1000;

/**
 * Encode an offset into a base64 page token.
 */
export function encodePageToken(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString("base64");
}

/**
 * Decode a page token back to an offset. Returns 0 if token is
 * null/undefined. Throws INVALID_PARAMETER if decoding fails.
 */
export function decodePageToken(token: string | null | undefined): number {
  if (token === null || token === undefined || token === "") return 0;
  try {
    const decoded = JSON.parse(Buffer.from(token, "base64").toString());
    if (typeof decoded.offset !== "number" || decoded.offset < 0) {
      throw new Error("bad offset");
    }
    return decoded.offset;
  } catch {
    throw Object.assign(new Error("Invalid page token."), {
      code: "INVALID_PARAMETER",
    });
  }
}

// ---------------------------------------------------------------------------
// Inline self-tests (run when executed directly: tsx src/utils/responseFormatter.ts)
// ---------------------------------------------------------------------------

export function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
    } else {
      /* v8 ignore next 2 */
      failed++;
      console.error(`  FAIL: ${label}`);
    }
  }

  console.log("Running response formatter self-tests...\n");

  // 1. snakeToCamel basic conversion
  const r1 = snakeToCamel({
    object_type_id: "123",
    display_name: "Foo",
  }) as Record<string, unknown>;
  assert(
    r1.objectTypeId === "123" && r1.displayName === "Foo",
    "snakeToCamel converts object_type_id and display_name"
  );

  // 2. snakeToCamel preserves inner keys of passthrough fields
  const r2 = snakeToCamel({
    column_mapping: { custom_key: "val" },
  }) as Record<string, unknown>;
  const cm = r2.columnMapping as Record<string, unknown>;
  assert(
    cm.custom_key === "val" && cm.customKey === undefined,
    "snakeToCamel preserves inner keys of column_mapping"
  );

  // 3. encodePageToken / decodePageToken roundtrip
  const token = encodePageToken(20);
  const offset = decodePageToken(token);
  assert(offset === 20, "encodePageToken(20) decoded back to 20");

  // 4. formatError produces spec §2.1 envelope + legacy fields
  const err = formatError("ONTOLOGY_NOT_FOUND", "test", { apiName: "x" }, "req-abc");
  assert(
    err.errorCode === "ONTOLOGY_NOT_FOUND" &&
      err.errorName === "OntologyNotFound" &&
      err.message === "test" &&
      err.statusCode === 404 &&
      err.requestId === "req-abc" &&
      (err.parameters as Record<string, unknown>).apiName === "x",
    "formatError produces spec envelope"
  );
  assert(
    err.error.code === "ONTOLOGY_NOT_FOUND" &&
      err.error.message === "test" &&
      typeof err.error.details === "object" &&
      typeof err.error.timestamp === "string",
    "formatError retains legacy envelope"
  );

  // Additional: ERROR_CODES has at least 23 entries (incl. AI_ENGINE_* etc.)
  const errorCodeCount = Object.keys(ERROR_CODES).length;
  assert(
    errorCodeCount >= 23,
    `ERROR_CODES has ${errorCodeCount} entries (expected >= 23)`
  );

  // Additional: snakeToCamel handles null, arrays, nested objects
  assert(snakeToCamel(null) === null, "snakeToCamel(null) === null");
  assert(snakeToCamel(undefined) === undefined, "snakeToCamel(undefined) === undefined");
  assert(snakeToCamel(42) === 42, "snakeToCamel(42) === 42");

  const r3 = snakeToCamel([
    { some_key: 1 },
    { another_key: 2 },
  ]) as Record<string, unknown>[];
  assert(
    r3[0].someKey === 1 && r3[1].anotherKey === 2,
    "snakeToCamel handles arrays of objects"
  );

  const r4 = snakeToCamel({
    outer_key: { inner_key: "deep" },
  }) as Record<string, unknown>;
  assert(
    (r4.outerKey as Record<string, unknown>).innerKey === "deep",
    "snakeToCamel handles nested objects"
  );

  // Additional: struct_schema passthrough
  const r5 = snakeToCamel({
    struct_schema: [{ fieldName: "abc", field_type: "string" }],
  }) as Record<string, unknown>;
  const ss = r5.structSchema as Record<string, unknown>[];
  assert(
    ss[0].field_type === "string",
    "snakeToCamel preserves inner keys of struct_schema"
  );

  // Additional: decodePageToken(null) returns 0
  assert(
    decodePageToken(null) === 0,
    "decodePageToken(null) === 0"
  );
  assert(
    decodePageToken(undefined) === 0,
    "decodePageToken(undefined) === 0"
  );

  // Additional: decodePageToken with invalid token throws
  let threwOnBadToken = false;
  try {
    decodePageToken("not-valid-base64!!!");
  } catch {
    threwOnBadToken = true;
  }
  assert(threwOnBadToken, "decodePageToken throws on invalid token");

  // Additional: formatOntology
  const ont = formatOntology(
    {
      ontology_id: "uuid-1",
      display_name: "Test",
      description: null,
      created_at: "ts1",
      updated_at: "ts2",
      created_by: "system",
    },
    3
  );
  assert(
    ont.ontologyId === "uuid-1" && ont.objectTypeCount === 3,
    "formatOntology produces correct shape"
  );

  // Additional: formatProperty
  const prop = formatProperty({
    api_name: "employeeId",
    display_name: "Employee ID",
    base_type: "string",
    description: null,
    struct_schema: null,
    is_required: true,
    is_array: false,
    ordinal: 0,
  });
  assert(
    prop.apiName === "employeeId" && prop.isRequired === true,
    "formatProperty produces correct shape"
  );

  // Additional: formatFunnelState
  const fs = formatFunnelState({
    status: "not_indexed",
    objects_indexed: 0,
    objects_failed: 0,
    edits_pending: 0,
    last_indexed_at: null,
    last_index_duration_ms: null,
    error_message: null,
    index_name: null,
  });
  assert(
    fs.status === "not_indexed" && fs.objectsIndexed === 0,
    "formatFunnelState produces correct shape"
  );

  // Additional: formatDatasource
  const ds = formatDatasource({
    dataset_name: "Emp DS",
    file_path: "/data/emp.csv",
    file_format: "csv",
    column_mapping: { empId: "emp_id" },
    primary_key_column: "emp_id",
    row_count: 100,
    column_names: ["emp_id", "name"],
    schema_hash: "abc",
    last_scanned_at: "ts",
    registered_at: "ts2",
  });
  assert(
    ds.datasetName === "Emp DS" && ds.rowCount === 100,
    "formatDatasource produces correct shape"
  );

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll formatter tests passed");
  } else {
    /* v8 ignore next */
    process.exit(1);
  }
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
