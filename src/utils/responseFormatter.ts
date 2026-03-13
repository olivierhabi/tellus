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

/** Formatted error response body. */
export interface FormattedError {
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

  return {
    objectType: {
      apiName: dbRow.api_name,
      displayName: dbRow.display_name,
      description: dbRow.description ?? null,
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
  indexStatus: string | null = null
): Record<string, unknown> {
  return {
    apiName: dbRow.api_name,
    displayName: dbRow.display_name,
    status: dbRow.status,
    propertyCount,
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
  return {
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
};

// ---------------------------------------------------------------------------
// Error formatting & response helpers
// ---------------------------------------------------------------------------

/**
 * Build a formatted error response body.
 */
export function formatError(
  code: string,
  message: string,
  details: Record<string, unknown> = {}
): FormattedError {
  return {
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
 */
export function sendError(
  res: Response,
  code: string,
  message: string,
  details: Record<string, unknown> = {}
): void {
  const httpStatus = ERROR_CODES[code] || 500;
  res.status(httpStatus).json(formatError(code, message, details));
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

function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
    } else {
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

  // 4. formatError has all 4 fields
  const err = formatError("ONTOLOGY_NOT_FOUND", "test");
  assert(
    err.error.code === "ONTOLOGY_NOT_FOUND" &&
      err.error.message === "test" &&
      typeof err.error.details === "object" &&
      typeof err.error.timestamp === "string",
    "formatError has code, message, details, timestamp"
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
    process.exit(1);
  }
}

if (require.main === module) {
  runSelfTests();
}
