// ---------------------------------------------------------------------------
// Backing Datasource Service Layer
//
// Registers, scans, and manages backing datasources. Validates file
// existence, scans file headers, validates column mapping against properties,
// and enforces Palantir's one-datasource-per-object-type rule.
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { query } from "../db";
import { validateColumnMapping } from "../utils/columnMappingValidator";
import { scanFile } from "./fileScannerService";

// ---------------------------------------------------------------------------
// Path traversal protection
// ---------------------------------------------------------------------------

/**
 * Resolve and validate a file path against the allowed base directory.
 * Prevents path traversal attacks (e.g. "../../etc/passwd").
 * Throws if the resolved path escapes the DATA_DIR.
 */
function resolveAndValidatePath(filePath: string): string {
  const dataDir = path.resolve(process.env.DATA_DIR || "./data");
  const resolved = path.resolve(dataDir, filePath);

  if (!resolved.startsWith(dataDir + path.sep) && resolved !== dataDir) {
    throw appError(
      "VALIDATION_FAILED",
      "File path is outside the allowed data directory."
    );
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegisterInput {
  datasetName: string;
  filePath: string;
  fileFormat: string;
  columnMapping: Record<string, string>;
}

// AppError imported from shared module
import { appError } from "../utils/appError";

// ---------------------------------------------------------------------------
// Method 1: register
// ---------------------------------------------------------------------------

async function register(objectTypeId: string, data: RegisterInput) {
  const { datasetName, filePath, fileFormat, columnMapping } = data;

  // 1. Check object type exists
  const otResult = await query(
    "SELECT * FROM object_type WHERE object_type_id = $1",
    [objectTypeId]
  );
  if (otResult.rows.length === 0) {
    throw appError(
      "OBJECT_TYPE_NOT_FOUND",
      `Object type '${objectTypeId}' not found.`
    );
  }
  const objectType = otResult.rows[0];

  // 2. Check no datasource already registered for this object type
  const existingDs = await query(
    "SELECT mapping_id FROM backing_datasource WHERE object_type_id = $1",
    [objectTypeId]
  );
  if (existingDs.rows.length > 0) {
    throw appError(
      "DATASOURCE_ALREADY_REGISTERED",
      "This object type already has a registered datasource."
    );
  }

  // 3. Check no other object type uses this file
  const existingFile = await query(
    "SELECT object_type_id FROM backing_datasource WHERE file_path = $1",
    [filePath]
  );
  if (existingFile.rows.length > 0) {
    throw appError(
      "DATASOURCE_ALREADY_REGISTERED",
      `File '${filePath}' is already registered to another object type.`
    );
  }

  // 4. Validate file format before doing any filesystem work
  const SUPPORTED_FORMATS = new Set(["csv", "json", "jsonl", "tsv"]);
  if (!fileFormat || !SUPPORTED_FORMATS.has(fileFormat.toLowerCase())) {
    throw appError(
      "VALIDATION_FAILED",
      `Unsupported file format: '${fileFormat}'. Supported: csv, json, jsonl, tsv.`
    );
  }

  // 5. Validate and resolve the file path (path traversal protection)
  const resolvedPath = resolveAndValidatePath(filePath);

  // 6. Check file exists on filesystem
  if (!fs.existsSync(resolvedPath)) {
    throw appError(
      "DATASOURCE_FILE_NOT_FOUND",
      `File not found: ${filePath}`
    );
  }

  // 7. Scan the file (async — does not block the event loop for large files)
  const scanResult = await scanFile(resolvedPath, fileFormat);

  // 6. Fetch properties and resolve primary key
  const propsResult = await query(
    "SELECT * FROM property WHERE object_type_id = $1",
    [objectTypeId]
  );
  const properties = propsResult.rows;

  let primaryKeyPropertyApiName: string | null = null;
  if (objectType.primary_key_property_id) {
    const pkProp = properties.find(
      (p: any) => p.property_id === objectType.primary_key_property_id
    );
    primaryKeyPropertyApiName = pkProp ? pkProp.api_name : null;
  }

  // Validate column mapping (delegated to columnMappingValidator — Task 23)
  const mappingValidation = validateColumnMapping(
    columnMapping,
    properties,
    scanResult.columnNames,
    primaryKeyPropertyApiName,
    scanResult.sampleRows
  );
  if (!mappingValidation.valid) {
    throw appError(
      "COLUMN_MAPPING_INVALID",
      mappingValidation.errors.join(" ")
    );
  }

  // Log any warnings (non-blocking)
  for (const warning of mappingValidation.warnings) {
    console.warn(warning);
  }

  // 7. Determine primary_key_column
  const primaryKeyColumn = primaryKeyPropertyApiName
    ? columnMapping[primaryKeyPropertyApiName]
    : Object.values(columnMapping)[0] || "";

  // Insert
  const insertResult = await query(
    `INSERT INTO backing_datasource
       (object_type_id, dataset_name, file_path, file_format,
        column_mapping, primary_key_column, row_count, column_names, schema_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      objectTypeId,
      datasetName,
      resolvedPath,
      fileFormat,
      JSON.stringify(columnMapping),
      primaryKeyColumn,
      scanResult.rowCount,
      scanResult.columnNames,
      scanResult.schemaHash,
    ]
  );

  // Update funnel_state based on current status
  const fsResult = await query(
    "SELECT * FROM funnel_state WHERE object_type_id = $1",
    [objectTypeId]
  );
  if (fsResult.rows.length > 0) {
    const currentStatus = fsResult.rows[0].status;
    let newStatus = currentStatus;

    if (currentStatus === "not_indexed" || currentStatus === null) {
      newStatus = "not_indexed"; // keep as-is
    } else if (currentStatus === "indexed") {
      newStatus = "stale";
    } else if (currentStatus === "failed") {
      newStatus = "not_indexed";
    }
    // If 'indexing', don't change

    if (newStatus !== currentStatus) {
      await query(
        "UPDATE funnel_state SET status = $1, updated_at = NOW() WHERE object_type_id = $2",
        [newStatus, objectTypeId]
      );
    }
  }

  return insertResult.rows[0];
}

// ---------------------------------------------------------------------------
// Method 2: getByObjectType
// ---------------------------------------------------------------------------

async function getByObjectType(objectTypeId: string) {
  const result = await query(
    "SELECT * FROM backing_datasource WHERE object_type_id = $1",
    [objectTypeId]
  );
  return result.rows[0] || null;
}

// ---------------------------------------------------------------------------
// Method 3: scan
// ---------------------------------------------------------------------------

async function scan(objectTypeId: string) {
  // 1. Fetch datasource
  const dsResult = await query(
    "SELECT * FROM backing_datasource WHERE object_type_id = $1",
    [objectTypeId]
  );
  if (dsResult.rows.length === 0) {
    throw appError(
      "DATASOURCE_NOT_FOUND",
      "No datasource registered for this object type."
    );
  }
  const ds = dsResult.rows[0];

  // 2. Verify file exists (use stored path directly — it was validated on register)
  if (!fs.existsSync(ds.file_path)) {
    throw appError(
      "DATASOURCE_FILE_NOT_FOUND",
      `File not found: ${ds.file_path}`
    );
  }

  // 3. Scan the file (async — does not block the event loop)
  const scanResult = await scanFile(ds.file_path, ds.file_format);

  // 4. Check schema change
  const oldHash = ds.schema_hash;
  const schemaChanged = scanResult.schemaHash !== oldHash;

  // If schema changed, update funnel_state to stale
  if (schemaChanged) {
    await query(
      `UPDATE funnel_state
       SET status = 'stale', updated_at = NOW()
       WHERE object_type_id = $1 AND status IN ('indexed', 'not_indexed')`,
      [objectTypeId]
    );
  }

  // 5. Update datasource row
  const updateResult = await query(
    `UPDATE backing_datasource
     SET row_count = $1, column_names = $2, schema_hash = $3, last_scanned_at = NOW()
     WHERE mapping_id = $4
     RETURNING *`,
    [
      scanResult.rowCount,
      scanResult.columnNames,
      scanResult.schemaHash,
      ds.mapping_id,
    ]
  );

  return {
    datasource: updateResult.rows[0],
    schemaChanged,
  };
}

// ---------------------------------------------------------------------------
// Method 4: unregister
// ---------------------------------------------------------------------------

async function unregister(objectTypeId: string): Promise<void> {
  // 1. Check datasource exists
  const dsResult = await query(
    "SELECT mapping_id FROM backing_datasource WHERE object_type_id = $1",
    [objectTypeId]
  );
  if (dsResult.rows.length === 0) {
    throw appError(
      "DATASOURCE_NOT_FOUND",
      "No datasource registered for this object type."
    );
  }

  // 2. Delete
  await query("DELETE FROM backing_datasource WHERE object_type_id = $1", [
    objectTypeId,
  ]);

  // 3. Reset funnel_state
  await query(
    `UPDATE funnel_state
     SET status = 'not_indexed', objects_indexed = 0, updated_at = NOW()
     WHERE object_type_id = $1`,
    [objectTypeId]
  );

  console.log(`Unregistered datasource for object type ${objectTypeId}`);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const datasourceService = {
  register,
  getByObjectType,
  scan,
  unregister,
};
export default datasourceService;
