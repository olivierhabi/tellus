// ---------------------------------------------------------------------------
// Dataset Routes — Express Router
//
// Routes for dataset management: uploading, listing, details, and deletion.
// Mounted at /api/v1/datasets
//
// Provides endpoints:
//   POST   /upload                   — Upload a new dataset (multipart form)
//   GET    /                         — List datasets with pagination & search
//   GET    /:datasetId               — Get full dataset details with transactions
//   DELETE /:datasetId               — Delete a dataset with safety check
//   POST   /:datasetId/transactions  — Append/Snapshot a new file to a dataset
//   GET    /:datasetId/transactions  — List transactions for a dataset
//
// Uses multer for multipart file upload handling.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { query, getClient } from "../db";
import { appError } from "../utils/appError";
import {
  sendSuccess,
  sendCreated,
  sendNoContent,
  sendError,
  snakeToCamel,
  encodePageToken,
  decodePageToken,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../utils/responseFormatter";
import {
  configureMulter,
  detectFileFormat,
  extractCsvMetadata,
  extractJsonMetadata,
  moveToFinalLocation,
} from "../services/uploadService";
import { scanFile } from "../services/fileScannerService";
import { checkAndTriggerAutoIndex, AutoIndexResult } from "../services/autoIndexService";

const router = Router();

// ---------------------------------------------------------------------------
// Multer instances
// ---------------------------------------------------------------------------

const upload = configureMulter();

// Legacy multer config for the /:datasetId/transactions route
const DATA_DIR = process.env.DATA_DIR || "./data";
const TMP_DIR = path.join(DATA_DIR, "tmp");
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

import multer from "multer";
const legacyUpload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ---------------------------------------------------------------------------
// Known error codes handled in catch blocks
// ---------------------------------------------------------------------------

const KNOWN_CODES = new Set([
  "DATASET_NOT_FOUND",
  "DATASET_IN_USE",
  "FORMAT_MISMATCH",
  "SCHEMA_MISMATCH",
  "INVALID_TRANSACTION_TYPE",
  "VALIDATION_FAILED",
  "INVALID_PARAMETER",
]);

// ---------------------------------------------------------------------------
// UUID format validation regex
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Helper: detect file format from extension (for legacy route)
// ---------------------------------------------------------------------------

function detectFormat(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".csv") return "csv";
  if (ext === ".json") return "json";
  if (ext === ".jsonl") return "jsonl";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Helper: extract schema columns from file (for legacy route)
// ---------------------------------------------------------------------------

async function extractSchemaColumns(
  filePath: string,
  format: string
): Promise<string[]> {
  if (format === "csv") {
    const scanResult = await scanFile(filePath, "csv");
    return scanResult.columnNames;
  }
  if (format === "json" || format === "jsonl") {
    const scanResult = await scanFile(filePath, "json");
    return scanResult.columnNames;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Helper: count rows in a file (for legacy route)
// ---------------------------------------------------------------------------

async function countRows(
  filePath: string,
  format: string
): Promise<number> {
  const scanResult = await scanFile(
    filePath,
    format === "jsonl" ? "json" : format
  );
  return scanResult.rowCount;
}

// ---------------------------------------------------------------------------
// Helper: cleanup temp file
// ---------------------------------------------------------------------------

function cleanupTempFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Route 1: POST /upload — Upload a new dataset file
//
// Accepts multipart/form-data with:
//   - file: the dataset file (CSV, JSON, or JSONL)
//   - name: dataset name (required)
//   - description: dataset description (optional)
//   - transactionType: 'SNAPSHOT' or 'APPEND' (default: 'SNAPSHOT')
//   - datasetId: existing dataset ID for APPEND (optional)
//
// On success: creates dataset + committed transaction in a PG transaction.
// Moves file from staging to final location.
// ---------------------------------------------------------------------------

router.post(
  "/upload",
  upload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    const stagedPath = req.file?.path;
    try {
      // 1. Validate file was uploaded
      if (!req.file) {
        throw appError(
          "VALIDATION_FAILED",
          "No file uploaded. Include a 'file' field in the multipart form."
        );
      }

      const { name, description, transactionType, datasetId } = req.body;
      const txType = transactionType || "SNAPSHOT";

      // 2. Validate transaction type
      if (!["SNAPSHOT", "APPEND"].includes(txType)) {
        throw appError(
          "INVALID_PARAMETER",
          "transactionType must be 'SNAPSHOT' or 'APPEND'."
        );
      }

      // 3. Detect file format
      const fileFormat = detectFileFormat(req.file);

      // 4. Validate allowed format
      if (!["csv", "json", "jsonl"].includes(fileFormat)) {
        throw appError(
          "VALIDATION_FAILED",
          `Unsupported file format: ${fileFormat}. Supported: csv, json, jsonl.`
        );
      }

      // 5. Extract metadata based on format
      let metadata;
      if (fileFormat === "csv") {
        metadata = await extractCsvMetadata(req.file.path);
      } else {
        metadata = await extractJsonMetadata(
          req.file.path,
          fileFormat as "json" | "jsonl"
        );
      }

      // 6. Begin PG transaction
      const client = await getClient();
      try {
        await client.query("BEGIN");

        let targetDatasetId: string;
        let isNewDataset = false;

        if (datasetId && txType === "APPEND") {
          // APPEND to existing dataset: verify dataset exists
          if (!UUID_RE.test(datasetId)) {
            throw appError(
              "INVALID_PARAMETER",
              "datasetId must be a valid UUID."
            );
          }

          const dsResult = await client.query(
            "SELECT dataset_id FROM dataset WHERE dataset_id = $1",
            [datasetId]
          );
          if (dsResult.rows.length === 0) {
            throw appError(
              "DATASET_NOT_FOUND",
              `Dataset '${datasetId}' not found.`
            );
          }
          targetDatasetId = datasetId;
        } else {
          // New dataset: validate name
          if (!name || typeof name !== "string" || name.trim().length === 0) {
            throw appError(
              "VALIDATION_FAILED",
              "Dataset name is required for new uploads."
            );
          }

          // Create the dataset record
          const dsInsert = await client.query(
            `INSERT INTO dataset (name, description, file_format, schema_definition, total_rows, total_size_bytes)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [
              name.trim(),
              description || null,
              fileFormat,
              JSON.stringify({
                columns: metadata.columnNames,
                inferredTypes: metadata.inferredTypes,
              }),
              metadata.rowCount,
              metadata.fileSizeBytes,
            ]
          );
          targetDatasetId = dsInsert.rows[0].dataset_id;
          isNewDataset = true;
        }

        // 7. Move file to final location
        const finalPath = moveToFinalLocation(
          req.file.path,
          targetDatasetId,
          req.file.originalname
        );

        // 8. Update dataset storage_path if new
        if (isNewDataset) {
          await client.query(
            "UPDATE dataset SET storage_path = $1 WHERE dataset_id = $2",
            [finalPath, targetDatasetId]
          );
        }

        // 9. Create the transaction record (committed immediately)
        const txInsert = await client.query(
          `INSERT INTO dataset_transaction
             (dataset_id, transaction_type, status, file_path, file_name,
              file_size_bytes, row_count, schema_definition, metadata, committed_at)
           VALUES ($1, $2, 'committed', $3, $4, $5, $6, $7, $8, NOW())
           RETURNING *`,
          [
            targetDatasetId,
            txType,
            finalPath,
            req.file.originalname,
            metadata.fileSizeBytes,
            metadata.rowCount,
            JSON.stringify({
              columns: metadata.columnNames,
              inferredTypes: metadata.inferredTypes,
            }),
            JSON.stringify({
              schemaHash: metadata.schemaHash,
              sampleRowCount: metadata.sampleRows.length,
            }),
          ]
        );

        // 10. For APPEND: update dataset totals
        if (txType === "APPEND" && !isNewDataset) {
          await client.query(
            `UPDATE dataset
             SET total_rows = total_rows + $1,
                 total_size_bytes = total_size_bytes + $2,
                 updated_at = NOW()
             WHERE dataset_id = $3`,
            [metadata.rowCount, metadata.fileSizeBytes, targetDatasetId]
          );
        }

        await client.query("COMMIT");

        // 11. Fetch the final dataset state
        const finalDs = await query(
          "SELECT * FROM dataset WHERE dataset_id = $1",
          [targetDatasetId]
        );

        // 12. Handle autoIndex query parameter
        const autoIndex =
          req.query.autoIndex === "true" || req.query.autoIndex === "1";

        let indexing: AutoIndexResult;
        if (autoIndex) {
          indexing = await checkAndTriggerAutoIndex(targetDatasetId);
          if (!indexing.triggered && !indexing.reason) {
            indexing.reason = "dataset_not_backing_any_object_type";
          }
        } else {
          indexing = {
            triggered: false,
            reason:
              "autoIndex parameter not set. Call POST /reindex to index this data.",
          };
        }

        const responseData: Record<string, unknown> = {
          dataset: snakeToCamel(finalDs.rows[0]),
          transaction: snakeToCamel(txInsert.rows[0]),
          fileMetadata: {
            columnNames: metadata.columnNames,
            rowCount: metadata.rowCount,
            inferredTypes: metadata.inferredTypes,
            schemaHash: metadata.schemaHash,
            fileSizeBytes: metadata.fileSizeBytes,
          },
          indexing,
        };

        sendCreated(res, responseData);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (err: any) {
      // Clean up staged file on error (if it wasn't already moved)
      if (stagedPath && fs.existsSync(stagedPath)) {
        cleanupTempFile(stagedPath);
      }

      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }

      // Handle multer errors
      if (err.code === "LIMIT_FILE_SIZE") {
        return sendError(
          res,
          "VALIDATION_FAILED",
          "File exceeds the maximum upload size of 500 MB."
        );
      }

      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 2: GET / — List datasets with pagination and search
//
// Query parameters:
//   - pageSize: number of results per page (default 100, max 1000)
//   - pageToken: pagination token from previous response
//   - search: filter datasets by name (case-insensitive LIKE)
//   - fileFormat: filter by file format ('csv', 'json', 'jsonl')
//   - orderBy: sort field ('name', 'created_at', 'total_rows'; default 'created_at')
//   - order: sort direction ('asc', 'desc'; default 'desc')
// ---------------------------------------------------------------------------

router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Parse pagination params
      const rawPageSize = req.query.pageSize;
      const pageSize = rawPageSize
        ? Math.min(
            Math.max(
              parseInt(rawPageSize as string, 10) || DEFAULT_PAGE_SIZE,
              1
            ),
            MAX_PAGE_SIZE
          )
        : DEFAULT_PAGE_SIZE;

      let offset: number;
      try {
        offset = decodePageToken(
          (req.query.pageToken as string) || null
        );
      } catch (err: any) {
        return sendError(res, "INVALID_PARAMETER", err.message);
      }

      // Parse filters
      const search = (req.query.search as string) || null;
      const fileFormat = (req.query.fileFormat as string) || null;

      // Parse ordering
      const allowedOrderBy = [
        "name",
        "created_at",
        "total_rows",
        "total_size_bytes",
      ];
      const orderBy = allowedOrderBy.includes(req.query.orderBy as string)
        ? (req.query.orderBy as string)
        : "created_at";
      const order =
        (req.query.order as string)?.toLowerCase() === "asc" ? "ASC" : "DESC";

      // Build WHERE clause
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (search) {
        conditions.push(`name ILIKE $${paramIdx}`);
        params.push(`%${search}%`);
        paramIdx++;
      }

      if (fileFormat) {
        if (!["csv", "json", "jsonl"].includes(fileFormat)) {
          return sendError(
            res,
            "INVALID_PARAMETER",
            "fileFormat must be 'csv', 'json', or 'jsonl'."
          );
        }
        conditions.push(`file_format = $${paramIdx}`);
        params.push(fileFormat);
        paramIdx++;
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // Count total
      const countResult = await query(
        `SELECT COUNT(*) AS total FROM dataset ${whereClause}`,
        params
      );
      const totalCount = parseInt(countResult.rows[0].total, 10);

      // Fetch page
      const dataParams = [...params, pageSize, offset];
      const dataResult = await query(
        `SELECT d.*,
                (SELECT COUNT(*) FROM dataset_transaction dt WHERE dt.dataset_id = d.dataset_id) AS transaction_count
         FROM dataset d
         ${whereClause}
         ORDER BY ${orderBy} ${order}
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        dataParams
      );

      // Build next page token
      const nextOffset = offset + pageSize;
      const nextPageToken =
        nextOffset < totalCount ? encodePageToken(nextOffset) : null;

      const data = dataResult.rows.map((row) => ({
        datasetId: row.dataset_id,
        name: row.name,
        description: row.description,
        fileFormat: row.file_format,
        totalRows: row.total_rows,
        totalSizeBytes: parseInt(String(row.total_size_bytes), 10),
        transactionCount: parseInt(row.transaction_count, 10),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

      sendSuccess(res, {
        data,
        totalCount,
        pageSize,
        nextPageToken,
      });
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 3: GET /:datasetId — Get full dataset details with transactions
// ---------------------------------------------------------------------------

router.get(
  "/:datasetId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { datasetId } = req.params;

      if (!UUID_RE.test(datasetId)) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          "datasetId must be a valid UUID."
        );
      }

      // Fetch dataset from the ontology `dataset` table first.
      const dsResult = await query(
        "SELECT * FROM dataset WHERE dataset_id = $1",
        [datasetId]
      );
      if (dsResult.rows.length === 0) {
        // Not in the ontology dataset table — fall through to the
        // foundry dataset router which checks `foundry_datasets`.
        return next();
      }

      const ds = dsResult.rows[0];

      // Fetch transactions (most recent first)
      const txnResult = await query(
        `SELECT * FROM dataset_transaction
         WHERE dataset_id = $1
         ORDER BY created_at DESC`,
        [datasetId]
      );

      // Check if dataset is linked to any backing_datasource
      const linkedResult = await query(
        `SELECT bd.mapping_id, ot.api_name AS object_type_api_name, ot.display_name AS object_type_display_name
         FROM backing_datasource bd
         JOIN object_type ot ON ot.object_type_id = bd.object_type_id
         WHERE bd.dataset_id = $1`,
        [datasetId]
      );

      sendSuccess(res, {
        dataset: {
          datasetId: ds.dataset_id,
          name: ds.name,
          description: ds.description,
          fileFormat: ds.file_format,
          schemaDefinition: ds.schema_definition,
          storagePath: ds.storage_path,
          totalRows: ds.total_rows,
          totalSizeBytes: parseInt(String(ds.total_size_bytes), 10),
          createdAt: ds.created_at,
          updatedAt: ds.updated_at,
        },
        transactions: txnResult.rows.map((t: any) => ({
          transactionId: t.transaction_id,
          transactionType: t.transaction_type,
          status: t.status,
          filePath: t.file_path,
          fileName: t.file_name,
          fileSizeBytes: parseInt(String(t.file_size_bytes), 10),
          rowCount: t.row_count,
          schemaDefinition: t.schema_definition,
          metadata: t.metadata,
          createdAt: t.created_at,
          committedAt: t.committed_at,
        })),
        backingObjectTypes: linkedResult.rows.map((row) => row.object_type_api_name),
      });
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 4: DELETE /:datasetId — Delete a dataset with safety check
//
// Safety: refuses to delete if the dataset is currently referenced by a
// backing_datasource. Use ?force=true to override.
// ---------------------------------------------------------------------------

router.delete(
  "/:datasetId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { datasetId } = req.params;
      const force = req.query.force === "true";

      if (!UUID_RE.test(datasetId)) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          "datasetId must be a valid UUID."
        );
      }

      // Check dataset exists in the ontology `dataset` table
      const dsResult = await query(
        "SELECT * FROM dataset WHERE dataset_id = $1",
        [datasetId]
      );
      if (dsResult.rows.length === 0) {
        // Not in the ontology dataset table — fall through to the
        // foundry dataset router which checks `foundry_datasets`.
        return next();
      }

      const dataset = dsResult.rows[0];

      // Safety check: is the dataset linked to a backing_datasource?
      if (!force) {
        const linkedResult = await query(
          `SELECT bd.mapping_id, ot.api_name AS object_type_api_name
           FROM backing_datasource bd
           JOIN object_type ot ON ot.object_type_id = bd.object_type_id
           WHERE bd.dataset_id = $1`,
          [datasetId]
        );

        if (linkedResult.rows.length > 0) {
          const objectTypes = linkedResult.rows
            .map((r) => r.object_type_api_name)
            .join(", ");
          return sendError(
            res,
            "DATASET_IN_USE",
            `Dataset is currently backing object type(s): ${objectTypes}. ` +
              "Unregister the datasource first or use ?force=true to override.",
            {
              linkedObjectTypes: linkedResult.rows.map(
                (r) => r.object_type_api_name
              ),
            }
          );
        }
      }

      // Begin PG transaction for delete
      const client = await getClient();
      try {
        await client.query("BEGIN");

        // If force-deleting and linked to backing_datasource, clear the reference
        if (force) {
          await client.query(
            "UPDATE backing_datasource SET dataset_id = NULL WHERE dataset_id = $1",
            [datasetId]
          );
        }

        // Delete transactions (CASCADE handles this, but be explicit)
        await client.query(
          "DELETE FROM dataset_transaction WHERE dataset_id = $1",
          [datasetId]
        );

        // Delete the dataset record
        await client.query("DELETE FROM dataset WHERE dataset_id = $1", [
          datasetId,
        ]);

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      // Clean up files on disk (best-effort, don't fail the response)
      if (dataset.storage_path) {
        try {
          const dir = path.dirname(dataset.storage_path);
          if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        } catch {
          console.warn(
            `Warning: Could not clean up dataset files at ${dataset.storage_path}`
          );
        }
      }

      sendNoContent(res);
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message, err.details);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 5: POST /:datasetId/transactions — Append/Snapshot a new file
//
// Uploads a new file to an existing dataset (APPEND or SNAPSHOT).
// Accepts multipart form-data with a 'file' field and optional 'type' field.
// ---------------------------------------------------------------------------

router.post(
  "/:datasetId/transactions",
  legacyUpload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    const { datasetId } = req.params;
    const uploadedFile = req.file;
    const transactionType = (req.body?.type || "APPEND").toUpperCase();

    try {
      // Pre-validation: file required
      if (!uploadedFile) {
        return sendError(
          res,
          "VALIDATION_FAILED",
          "A file must be uploaded in the 'file' field."
        );
      }

      // Validation 1: transaction type
      if (transactionType !== "SNAPSHOT" && transactionType !== "APPEND") {
        cleanupTempFile(uploadedFile.path);
        return sendError(
          res,
          "INVALID_TRANSACTION_TYPE",
          `Transaction type must be 'SNAPSHOT' or 'APPEND'. Received: '${req.body?.type}'`
        );
      }

      // Validation 2: dataset exists
      const dsResult = await query(
        "SELECT * FROM dataset WHERE dataset_id = $1",
        [datasetId]
      );
      if (dsResult.rows.length === 0) {
        cleanupTempFile(uploadedFile.path);
        return sendError(
          res,
          "DATASET_NOT_FOUND",
          `Dataset with ID '${datasetId}' was not found.`
        );
      }
      const dataset = dsResult.rows[0];

      // Validation 3: file format matches dataset format
      const uploadedFormat = detectFormat(uploadedFile.originalname);
      const datasetFormat = dataset.file_format;
      const normalizedUpload =
        uploadedFormat === "jsonl" ? "json" : uploadedFormat;
      const normalizedDataset =
        datasetFormat === "jsonl" ? "json" : datasetFormat;

      if (normalizedUpload !== normalizedDataset) {
        cleanupTempFile(uploadedFile.path);
        return sendError(
          res,
          "FORMAT_MISMATCH",
          `This dataset uses '${datasetFormat}' format but the uploaded file is '${uploadedFormat}'. The format must match.`
        );
      }

      // Validation 4: schema compatibility
      const existingSchema = dataset.schema_definition;
      let existingColumns: string[] = [];

      if (existingSchema) {
        if (Array.isArray(existingSchema)) {
          // Schema stored as array of column defs or strings
          existingColumns = existingSchema.map((col: any) =>
            typeof col === "string" ? col : col.name || col.columnName || col
          );
        } else if (
          existingSchema.columns &&
          Array.isArray(existingSchema.columns)
        ) {
          // Schema stored as { columns: [...], inferredTypes: {...} }
          existingColumns = existingSchema.columns.map((col: any) =>
            typeof col === "string" ? col : col.name || col.columnName || col
          );
        }
      }

      if (existingColumns.length > 0) {

        let uploadedColumns: string[];
        try {
          uploadedColumns = await extractSchemaColumns(
            uploadedFile.path,
            datasetFormat === "jsonl" ? "json" : datasetFormat
          );
        } catch (scanErr: any) {
          cleanupTempFile(uploadedFile.path);
          return sendError(
            res,
            "VALIDATION_FAILED",
            `Failed to scan uploaded file: ${scanErr.message}`
          );
        }

        const missingColumns = existingColumns.filter(
          (col) => !uploadedColumns.includes(col)
        );

        if (missingColumns.length > 0) {
          cleanupTempFile(uploadedFile.path);
          return sendError(
            res,
            "SCHEMA_MISMATCH",
            `The uploaded file is missing columns that exist in the dataset schema: [${missingColumns.map((c) => `'${c}'`).join(", ")}]. All existing columns must be present in appended data.`
          );
        }
      }

      // Extract metadata from uploaded file
      let fileRowCount: number;
      try {
        fileRowCount = await countRows(
          uploadedFile.path,
          datasetFormat === "jsonl" ? "json" : datasetFormat
        );
      } catch {
        fileRowCount = 0;
      }
      const fileSizeBytes = uploadedFile.size;

      // PostgreSQL transaction
      const client = await getClient();
      try {
        await client.query("BEGIN");

        const transactionId = crypto.randomUUID();

        // Determine permanent storage path
        const permanentDir = path.join(
          DATA_DIR,
          "datasets",
          datasetId,
          "transactions",
          transactionId
        );
        const permanentPath = path.join(
          permanentDir,
          uploadedFile.originalname
        );

        await client.query(
          `INSERT INTO dataset_transaction
             (transaction_id, dataset_id, transaction_type, status, file_path,
              file_name, row_count, file_size_bytes, metadata)
           VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8)`,
          [
            transactionId,
            datasetId,
            transactionType,
            permanentPath,
            uploadedFile.originalname,
            fileRowCount,
            fileSizeBytes,
            JSON.stringify({}),
          ]
        );

        // SNAPSHOT: mark previous committed transactions as superseded
        if (transactionType === "SNAPSHOT") {
          await client.query(
            `UPDATE dataset_transaction
             SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"superseded": true}'::jsonb
             WHERE dataset_id = $1 AND status = 'committed' AND transaction_id != $2`,
            [datasetId, transactionId]
          );
        }

        // Move file to permanent storage
        fs.mkdirSync(permanentDir, { recursive: true });
        fs.renameSync(uploadedFile.path, permanentPath);

        // Update dataset table
        if (transactionType === "SNAPSHOT") {
          await client.query(
            `UPDATE dataset SET
               total_rows = $1,
               total_size_bytes = $2,
               updated_at = now()
             WHERE dataset_id = $3`,
            [fileRowCount, fileSizeBytes, datasetId]
          );
        } else {
          await client.query(
            `UPDATE dataset SET
               total_rows = total_rows + $1,
               total_size_bytes = total_size_bytes + $2,
               updated_at = now()
             WHERE dataset_id = $3`,
            [fileRowCount, fileSizeBytes, datasetId]
          );
        }

        // Commit the transaction record
        await client.query(
          `UPDATE dataset_transaction
           SET status = 'committed', committed_at = now()
           WHERE transaction_id = $1`,
          [transactionId]
        );

        await client.query("COMMIT");

        // Fetch updated dataset for response
        const updatedDs = await query(
          "SELECT * FROM dataset WHERE dataset_id = $1",
          [datasetId]
        );
        const updatedDataset = updatedDs.rows[0];

        const txnCountResult = await query(
          "SELECT COUNT(*) as count FROM dataset_transaction WHERE dataset_id = $1 AND status = 'committed'",
          [datasetId]
        );
        const txnCount = parseInt(txnCountResult.rows[0].count, 10);

        // Handle autoIndex query parameter
        const autoIndex =
          req.query.autoIndex === "true" || req.query.autoIndex === "1";

        let indexing: AutoIndexResult;
        if (autoIndex) {
          indexing = await checkAndTriggerAutoIndex(datasetId);
          if (!indexing.triggered && !indexing.reason) {
            indexing.reason = "dataset_not_backing_any_object_type";
          }
        } else {
          indexing = {
            triggered: false,
            reason:
              "autoIndex parameter not set. Call POST /reindex to index this data.",
          };
        }

        sendCreated(res, {
          transaction: {
            transactionId,
            datasetId,
            type: transactionType,
            status: "committed",
            rowCount: fileRowCount,
            fileSizeBytes,
            committedAt: new Date().toISOString(),
          },
          dataset: {
            datasetId,
            totalRowCount: updatedDataset.total_rows,
            totalFileSizeBytes: parseInt(
              String(updatedDataset.total_size_bytes),
              10
            ),
            transactionCount: txnCount,
          },
          indexing,
        });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        cleanupTempFile(uploadedFile.path);
        throw err;
      } finally {
        client.release();
      }
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 6: GET /:datasetId/transactions — List transactions for a dataset
// ---------------------------------------------------------------------------

router.get(
  "/:datasetId/transactions",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { datasetId } = req.params;

      if (!UUID_RE.test(datasetId)) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          "datasetId must be a valid UUID."
        );
      }

      // Verify dataset exists in the ontology `dataset` table
      const dsResult = await query(
        "SELECT dataset_id FROM dataset WHERE dataset_id = $1",
        [datasetId]
      );
      if (dsResult.rows.length === 0) {
        // Not in the ontology dataset table — fall through
        return next();
      }

      const txnResult = await query(
        `SELECT transaction_id, transaction_type, status, file_path,
                file_name, row_count, file_size_bytes, committed_at,
                created_at, metadata
         FROM dataset_transaction
         WHERE dataset_id = $1
         ORDER BY created_at ASC`,
        [datasetId]
      );

      sendSuccess(res, {
        datasetId,
        transactions: txnResult.rows.map((t: any) => ({
          transactionId: t.transaction_id,
          type: t.transaction_type,
          status: t.status,
          filePath: t.file_path,
          fileName: t.file_name,
          rowCount: t.row_count,
          fileSizeBytes: parseInt(String(t.file_size_bytes), 10),
          committedAt: t.committed_at,
          createdAt: t.created_at,
          metadata: t.metadata,
        })),
      });
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

export default router;
