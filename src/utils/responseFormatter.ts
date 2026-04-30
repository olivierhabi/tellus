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
  // they're a deterministic projection of the ontology id + object
  // type id so overview pages and deep links can show/copy a stable
  // RID without an extra lookup.
  const rid =
    dbRow.ontology_id && dbRow.object_type_id
      ? `ri.ontology.${dbRow.ontology_id}.object-type.${dbRow.object_type_id}`
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
  RULE_EXECUTION_FAILED: 500,
  TIMESERIES_WINDOW_TOO_LARGE: 400,
  QUERY_TIMEOUT: 504,
  UNDO_WINDOW_EXPIRED: 410,
  LINK_CYCLE_DETECTED: 400,
  EXPORT_ROW_LIMIT_EXCEEDED: 400,
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

/**
 * Build a formatted error response body that complies with the Ontology
 * Platform spec §2.1 envelope while remaining backward compatible with the
 * legacy `error.{code,message,details,timestamp}` shape.
 */
export function formatError(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  requestId: string = ""
): FormattedError {
  const statusCode = ERROR_CODES[code] || 500;
  return {
    errorCode: code,
    errorName: errorCodeToName(code),
    message,
    statusCode,
    requestId,
    parameters: details,
    error: {
      code,
      message,
      details,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Send an error response. Looks up HTTP status from ERROR_CODES (default 500).
 * Automatically pulls `requestId` from `res.req.correlationId` when present.
 */
export function sendError(
  res: Response,
  code: string,
  message: string,
  details: Record<string, unknown> = {}
): void {
  const httpStatus = ERROR_CODES[code] || 500;
  const requestId =
    ((res.req as unknown as { correlationId?: string })?.correlationId) || "";
  res
    .status(httpStatus)
    .json(formatError(code, message, details, requestId));
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

  // Additional: ERROR_CODES has exactly 19 entries
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
