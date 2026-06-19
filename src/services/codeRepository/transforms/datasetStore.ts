// ===========================================================================
// Dataset materialization for transform builds.
//
// Bridges a transform's Output("ri...")/Input("ri...") RIDs to rows in the
// singular `dataset` table (the same table the upload route + dataset preview
// use). Output is written as a committed dataset_transaction (SNAPSHOT, or
// APPEND for incremental), so a materialized transform output is immediately
// viewable through the existing dataset preview UI by its UUID.
//
// Replicates the INSERT contract of src/routes/datasets.ts so the rows are
// indistinguishable from an uploaded dataset.
// ===========================================================================
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pool, getClient } from "../../../db.js";
import { scanFile } from "../../fileScannerService.js";

// Absolute so stored file_path values resolve regardless of a child process's
// cwd (the python executor runs in a temp workdir).
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");

export type TransactionType = "SNAPSHOT" | "APPEND";

export interface ResolvedInput {
  readonly datasetId: string;
  readonly filePath: string;
  readonly fileFormat: string;
}

export interface MaterializeResult {
  readonly datasetId: string;
  readonly rid: string;
  readonly rowCount: number;
  readonly columns: string[];
  readonly transactionId: string;
  readonly transactionType: TransactionType;
}

/** Resolve an input dataset RID to its latest committed data file on disk. */
export async function resolveDatasetByRid(rid: string): Promise<ResolvedInput | null> {
  const ds = await pool.query<{
    dataset_id: string;
    file_format: string;
    storage_path: string | null;
  }>(
    `SELECT dataset_id, file_format, storage_path FROM dataset WHERE rid = $1`,
    [rid],
  );
  if (ds.rowCount === 0) return null;
  const row = ds.rows[0];

  const tx = await pool.query<{ file_path: string | null }>(
    `SELECT file_path FROM dataset_transaction
       WHERE dataset_id = $1 AND status = 'committed'
       ORDER BY committed_at DESC NULLS LAST
       LIMIT 1`,
    [row.dataset_id],
  );
  const rawPath =
    ((tx.rowCount ?? 0) > 0 ? tx.rows[0].file_path : null) ?? row.storage_path;
  if (!rawPath) return null;
  // Resolve relative paths (legacy rows) against the server CWD.
  const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(rawPath);

  return { datasetId: row.dataset_id, filePath, fileFormat: row.file_format };
}

function moveInto(src: string, destDir: string, destName: string): string {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, destName);
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
    try {
      fs.unlinkSync(src);
    } catch {
      /* best-effort */
    }
  }
  return dest;
}

/**
 * Materialize a CSV file at `csvFilePath` as a committed transaction on the
 * dataset identified by `rid` (creating the dataset row if it does not exist).
 * SNAPSHOT replaces the dataset contents; APPEND adds to them.
 */
export async function materializeOutput(args: {
  rid: string;
  name: string;
  description?: string;
  csvFilePath: string;
  transactionType: TransactionType;
  actor: string;
}): Promise<MaterializeResult> {
  const scan = await scanFile(args.csvFilePath, "csv");
  const size = fs.statSync(args.csvFilePath).size;
  const schemaDef = JSON.stringify({
    columns: scan.columnNames,
    inferredTypes: scan.inferredTypes,
  });
  const fileName = `${args.name.replace(/[^a-zA-Z0-9._-]/g, "_")}.csv`;

  const client = await getClient();
  try {
    await client.query("BEGIN");

    // Resolve-or-create the dataset row by RID.
    let datasetId: string;
    const existing = await client.query<{ dataset_id: string }>(
      `SELECT dataset_id FROM dataset WHERE rid = $1 FOR UPDATE`,
      [args.rid],
    );
    if ((existing.rowCount ?? 0) > 0) {
      datasetId = existing.rows[0].dataset_id;
    } else {
      const ins = await client.query<{ dataset_id: string }>(
        `INSERT INTO dataset
           (name, description, file_format, rid, schema_definition,
            total_rows, total_size_bytes, created_by)
         VALUES ($1, $2, 'csv', $3, $4, 0, 0, $5)
         RETURNING dataset_id`,
        [args.name, args.description ?? null, args.rid, schemaDef, args.actor],
      );
      datasetId = ins.rows[0].dataset_id;
    }

    // Stage the file into the dataset's permanent transaction directory.
    const transactionId = crypto.randomUUID();
    const destDir = path.join(
      DATA_DIR,
      "datasets",
      datasetId,
      "transactions",
      transactionId,
    );
    const permanentPath = moveInto(args.csvFilePath, destDir, fileName);

    // SNAPSHOT supersedes prior committed transactions.
    if (args.transactionType === "SNAPSHOT") {
      await client.query(
        `UPDATE dataset_transaction
            SET metadata = COALESCE(metadata,'{}'::jsonb) || '{"superseded": true}'::jsonb
          WHERE dataset_id = $1 AND status = 'committed' AND transaction_id != $2`,
        [datasetId, transactionId],
      );
    }

    await client.query(
      `INSERT INTO dataset_transaction
         (transaction_id, dataset_id, transaction_type, status, file_path,
          file_name, file_size_bytes, row_count, schema_definition, metadata, committed_at)
       VALUES ($1, $2, $3, 'committed', $4, $5, $6, $7, $8, $9, NOW())`,
      [
        transactionId,
        datasetId,
        args.transactionType,
        permanentPath,
        fileName,
        size,
        scan.rowCount,
        schemaDef,
        JSON.stringify({ source: "transform-build", schemaHash: scan.schemaHash }),
      ],
    );

    // Roll up dataset totals + schema (SNAPSHOT replaces, APPEND adds).
    if (args.transactionType === "SNAPSHOT") {
      await client.query(
        `UPDATE dataset
            SET total_rows = $1, total_size_bytes = $2, storage_path = $3,
                file_format = 'csv', schema_definition = $4, updated_at = now()
          WHERE dataset_id = $5`,
        [scan.rowCount, size, permanentPath, schemaDef, datasetId],
      );
    } else {
      await client.query(
        `UPDATE dataset
            SET total_rows = total_rows + $1, total_size_bytes = total_size_bytes + $2,
                updated_at = now()
          WHERE dataset_id = $3`,
        [scan.rowCount, size, datasetId],
      );
    }

    await client.query("COMMIT");
    return {
      datasetId,
      rid: args.rid,
      rowCount: scan.rowCount,
      columns: scan.columnNames,
      transactionId,
      transactionType: args.transactionType,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
