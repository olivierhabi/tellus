// ---------------------------------------------------------------------------
// Data Preview Routes
//
// REST API endpoint for previewing raw dataset data with column statistics.
//
// Mounted at: /api/v1/datasets
//
// Endpoint:
//   GET /:datasetId/preview — Preview dataset rows with column statistics
//
// Query parameters:
//   rows           — Number of preview rows to return (default 50, max 500)
//   transactionId  — Optional: preview data from a specific transaction
//
// Returns raw string values (no type conversion). Column statistics are
// computed over the returned preview SAMPLE (nullCount, uniqueCount capped
// at 1000, sampleValues, min/max/avg for numeric/date types) — scanning all
// rows for stats would re-introduce the multi-million-row 504 the streaming
// read was built to avoid. `totalRows` is the authoritative DB row_count
// when available (else the parsed/capped count).
//
// Merged view uses the same logic as the reindex engine but WITHOUT the
// edit overlay — datasource data only.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendSuccess, sendError } from "../utils/responseFormatter";
import { readCSV } from "../services/indexing/csvReader";
import { getObjectStream } from "../services/storageService";
import { parseCsvReadable } from "../services/indexing/streamingCsv";

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ROWS = 50;
const MAX_ROWS = 500;
const MAX_UNIQUE_COUNT = 1000;
const SAMPLE_VALUES_COUNT = 5;

// ---------------------------------------------------------------------------
// Helper: detect if a string is numeric
// ---------------------------------------------------------------------------

function isNumeric(val: string): boolean {
  if (val === "") return false;
  return !isNaN(Number(val)) && isFinite(Number(val));
}

// ---------------------------------------------------------------------------
// Helper: detect if a string looks like a date/timestamp
// ---------------------------------------------------------------------------

const DATE_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}$/,                          // 2025-01-15
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,        // ISO 8601
  /^\d{4}\/\d{2}\/\d{2}$/,                         // 2025/01/15
  /^\d{2}\/\d{2}\/\d{4}$/,                         // 01/15/2025
  /^\d{2}-\d{2}-\d{4}$/,                           // 15-01-2025
];

function isDateLike(val: string): boolean {
  if (val === "") return false;
  return DATE_PATTERNS.some((p) => p.test(val));
}

// ---------------------------------------------------------------------------
// Helper: compute column statistics from all rows
// ---------------------------------------------------------------------------

interface ColumnStats {
  column: string;
  totalRows: number;
  nullCount: number;
  emptyCount: number;
  uniqueCount: number;
  uniqueCountCapped: boolean;
  sampleValues: string[];
  detectedType: "numeric" | "date" | "boolean" | "string";
  numericStats: {
    min: number | null;
    max: number | null;
    avg: number | null;
  } | null;
  dateStats: {
    min: string | null;
    max: string | null;
  } | null;
}

function computeColumnStats(
  rows: Array<Record<string, string>>,
  column: string
): ColumnStats {
  const totalRows = rows.length;
  let nullCount = 0;
  let emptyCount = 0;
  const uniqueSet = new Set<string>();
  let uniqueCountCapped = false;
  const sampleValues: string[] = [];

  // Type detection counters
  let numericCount = 0;
  let dateCount = 0;
  let booleanCount = 0;
  let nonEmptyCount = 0;

  // Numeric accumulators
  let numMin = Infinity;
  let numMax = -Infinity;
  let numSum = 0;
  let numericValues = 0;

  // Date accumulators
  let dateMin: string | null = null;
  let dateMax: string | null = null;

  for (const row of rows) {
    const val = row[column];

    if (val === undefined || val === null) {
      nullCount++;
      continue;
    }

    const trimmed = val.trim();

    if (trimmed === "") {
      emptyCount++;
      continue;
    }

    nonEmptyCount++;

    // Track unique values (capped at MAX_UNIQUE_COUNT)
    if (uniqueSet.size < MAX_UNIQUE_COUNT) {
      uniqueSet.add(trimmed);
    } else {
      uniqueCountCapped = true;
    }

    // Collect sample values
    if (sampleValues.length < SAMPLE_VALUES_COUNT) {
      if (!sampleValues.includes(trimmed)) {
        sampleValues.push(trimmed);
      }
    }

    // Type detection
    if (isNumeric(trimmed)) {
      numericCount++;
      const num = Number(trimmed);
      if (num < numMin) numMin = num;
      if (num > numMax) numMax = num;
      numSum += num;
      numericValues++;
    } else if (isDateLike(trimmed)) {
      dateCount++;
      if (dateMin === null || trimmed < dateMin) dateMin = trimmed;
      if (dateMax === null || trimmed > dateMax) dateMax = trimmed;
    } else if (
      trimmed.toLowerCase() === "true" ||
      trimmed.toLowerCase() === "false"
    ) {
      booleanCount++;
    }
  }

  // Determine detected type (majority wins)
  let detectedType: "numeric" | "date" | "boolean" | "string" = "string";
  if (nonEmptyCount > 0) {
    const numericRatio = numericCount / nonEmptyCount;
    const dateRatio = dateCount / nonEmptyCount;
    const boolRatio = booleanCount / nonEmptyCount;

    if (numericRatio > 0.8) {
      detectedType = "numeric";
    } else if (dateRatio > 0.8) {
      detectedType = "date";
    } else if (boolRatio > 0.8) {
      detectedType = "boolean";
    }
  }

  // Build numeric stats
  let numericStats: ColumnStats["numericStats"] = null;
  if (detectedType === "numeric" && numericValues > 0) {
    numericStats = {
      min: numMin === Infinity ? null : numMin,
      max: numMax === -Infinity ? null : numMax,
      avg: numericValues > 0 ? Math.round((numSum / numericValues) * 100) / 100 : null,
    };
  }

  // Build date stats
  let dateStats: ColumnStats["dateStats"] = null;
  if (detectedType === "date" && (dateMin || dateMax)) {
    dateStats = {
      min: dateMin,
      max: dateMax,
    };
  }

  return {
    column,
    totalRows,
    nullCount,
    emptyCount,
    uniqueCount: uniqueSet.size,
    uniqueCountCapped,
    sampleValues,
    detectedType,
    numericStats,
    dateStats,
  };
}

// ---------------------------------------------------------------------------
// GET /:datasetId/preview — Preview dataset data
// ---------------------------------------------------------------------------

router.get(
  "/:datasetId/preview",
  async (req: Request, res: Response, next: NextFunction) => {
    const { datasetId } = req.params;

    try {
      // -----------------------------------------------------------------
      // Parse query parameters
      // -----------------------------------------------------------------
      let rowLimit = parseInt(req.query.rows as string, 10);
      if (isNaN(rowLimit) || rowLimit < 1) rowLimit = DEFAULT_ROWS;
      if (rowLimit > MAX_ROWS) rowLimit = MAX_ROWS;

      const transactionId = req.query.transactionId as string | undefined;

      // -----------------------------------------------------------------
      // Validate dataset exists (check both dataset and foundry_datasets)
      // -----------------------------------------------------------------
      const dsResult = await query(
        `SELECT dataset_id, name, file_format, storage_path,
                total_rows, total_size_bytes, schema_definition
         FROM dataset
         WHERE dataset_id = $1`,
        [datasetId]
      );

      let dataset: Record<string, unknown>;
      let isFoundryDataset = false;

      if (dsResult.rows.length > 0) {
        dataset = dsResult.rows[0];
      } else {
        // Fallback: check foundry_datasets table
        const foundryResult = await query(
          `SELECT id AS dataset_id, name, file_path AS storage_path,
                  row_count AS total_rows, file_size_bytes AS total_size_bytes,
                  schema_info AS schema_definition
           FROM foundry_datasets
           WHERE id = $1`,
          [datasetId]
        );

        if (foundryResult.rows.length === 0) {
          return sendError(
            res,
            "DATASOURCE_NOT_FOUND",
            `Dataset '${datasetId}' not found.`
          );
        }

        dataset = foundryResult.rows[0];
        isFoundryDataset = true;
      }

      // -----------------------------------------------------------------
      // Determine which file to read
      // -----------------------------------------------------------------
      let filePath: string;

      if (isFoundryDataset) {
        // Foundry datasets store the file path directly
        if (dataset.storage_path) {
          filePath = dataset.storage_path as string;
        } else {
          return sendError(
            res,
            "DATASOURCE_NOT_FOUND",
            `Dataset '${datasetId}' has no file path.`
          );
        }
      } else if (transactionId) {
        // Validate transaction exists and belongs to this dataset
        const txnResult = await query(
          `SELECT transaction_id, file_path, status, row_count
           FROM dataset_transaction
           WHERE transaction_id = $1 AND dataset_id = $2`,
          [transactionId, datasetId]
        );

        if (txnResult.rows.length === 0) {
          return sendError(
            res,
            "DATASOURCE_NOT_FOUND",
            `Transaction '${transactionId}' not found for dataset '${datasetId}'.`
          );
        }

        const txn = txnResult.rows[0];

        if (txn.status !== "committed") {
          return sendError(
            res,
            "INVALID_PARAMETER",
            `Transaction '${transactionId}' has status '${txn.status}'. Only committed transactions can be previewed.`
          );
        }

        filePath = txn.file_path;
      } else {
        // Use the most recent committed transaction's file, or
        // fall back to the dataset's storage_path
        const latestTxnResult = await query(
          `SELECT file_path
           FROM dataset_transaction
           WHERE dataset_id = $1 AND status = 'committed'
           ORDER BY committed_at DESC
           LIMIT 1`,
          [datasetId]
        );

        if (latestTxnResult.rows.length > 0) {
          filePath = latestTxnResult.rows[0].file_path;
        } else if (dataset.storage_path) {
          filePath = dataset.storage_path as string;
        } else {
          return sendError(
            res,
            "DATASOURCE_NOT_FOUND",
            `Dataset '${datasetId}' has no committed transactions and no storage path.`
          );
        }
      }

      // -----------------------------------------------------------------
      // Read rows. Both paths are bounded by `rowLimit` so a preview of an
      // 854 MB / 5.6 M-row backing file streams only the rows it returns.
      // The old path downloaded the whole S3 object into a Buffer, wrote it
      // to a temp file, then `readCSV`-collected EVERY row just to slice 50
      // — which blew the global 5 s request budget and 504'd the preview.
      // -----------------------------------------------------------------
      let columns: string[] = [];
      let previewRows: Array<Record<string, string>> = [];
      let totalRows: number | null = null;

      if (isFoundryDataset) {
        // Stream the S3 object straight through csv-parse, stopping after
        // `rowLimit` data rows (parseCsvReadable tears down the GET on
        // early stop, so we don't pull the whole 854 MB for a 50-row peek).
        try {
          const stream = await getObjectStream(filePath);
          const { rows } = await parseCsvReadable(stream, {
            source: filePath,
            maxRows: rowLimit,
            normalizeNulls: false,
          });
          for await (const row of rows) {
            if (columns.length === 0) columns = Object.keys(row);
            previewRows.push(row as Record<string, string>);
          }
        } catch (s3Err: unknown) {
          const s3Msg = s3Err instanceof Error ? s3Err.message : String(s3Err);
          return sendError(
            res,
            "DATASOURCE_FILE_NOT_FOUND",
            `Failed to read dataset file from storage: ${s3Msg}`
          );
        }
        // `foundry_datasets.row_count` (aliased to total_rows) is the
        // authoritative count set at scan time — use it instead of scanning
        // the whole file just to count rows. It's NULL for datasets that
        // haven't finished parsing (status 'pending'/'error'); fall back to
        // the streamed sample size so the FE never gets null (which would
        // crash its `totalRows.toLocaleString()`). `!= null` + Number()
        // also coerces a future BIGINT-string (row_count_exact) safely.
        totalRows =
          dataset.total_rows != null
            ? Number(dataset.total_rows)
            : previewRows.length;
      } else {
        // Local disk path (committed dataset_transaction or storage_path).
        // `readCSV`'s maxRows stops after `rowLimit` rows so a large disk
        // file can't hang the preview either.
        const csvResult = await readCSV(filePath, { maxRows: rowLimit });
        if (!csvResult.success) {
          return sendError(
            res,
            "DATASOURCE_FILE_NOT_FOUND",
            `Failed to read dataset file: ${csvResult.error.message}`
          );
        }
        columns = csvResult.columns;
        previewRows = csvResult.rows as Array<Record<string, string>>;
        // Prefer the dataset table's authoritative total_rows when the DB
        // has it; fall back to csvResult.rowCount, which is the true count
        // for files that fit in the preview window and capped at rowLimit
        // for larger ones (readCSV's maxRows stops early). Same null/BigInt
        // coercion as the foundry branch.
        totalRows =
          dataset.total_rows != null
            ? Number(dataset.total_rows)
            : csvResult.rowCount;
      }

      // -----------------------------------------------------------------
      // Compute column statistics over the returned preview sample. The
      // legacy path scanned ALL rows for stats; for a multi-million-row
      // foundry file that is exactly the 504 trigger. Sample-stats are a
      // deliberate trade — accurate enough for a preview, and the ontology
      // manager's backing-preview consumer reads only `rows`.
      // -----------------------------------------------------------------
      const columnStats = columns.map((col) =>
        computeColumnStats(previewRows, col)
      );

      // -----------------------------------------------------------------
      // Build response — all values remain as raw strings
      // -----------------------------------------------------------------
      return sendSuccess(res, {
        datasetId,
        datasetName: dataset.name,
        fileFormat: dataset.file_format || filePath.split('.').pop() || 'csv',
        filePath,
        transactionId: transactionId || null,
        totalRows,
        previewRowCount: previewRows.length,
        requestedRows: rowLimit,
        columns,
        rows: previewRows,
        columnStats,
        schemaDefinition: dataset.schema_definition || null,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return sendError(
        res,
        "INTERNAL_ERROR",
        `Failed to preview dataset: ${message}`
      );
    }
  }
);

export default router;
