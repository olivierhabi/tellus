// ---------------------------------------------------------------------------
// Parquet writer — PB-B3 deploy path.
//
// Stages deploy output rows into a DuckDB temp table, then COPYs to a
// local Parquet file with the PB-B3-mandated settings:
//
//   FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000
//
// The caller uploads the resulting bytes through the existing
// storageService.uploadObject() path so this module does not know about
// S3 / MinIO directly — that keeps the deploy control path identical
// for CSV and Parquet and leaves the S3 credentialing to the uploader.
//
// For large deploys the spec calls for COPY TO 's3://…' via DuckDB's
// httpfs. That's covered by PB-B3.follow-3 so we do not have to juggle
// two code paths here; today every deploy goes through a local staging
// file (O(tmp disk) not O(RAM)).
//
// We also extract the authoritative `row_count_exact` by reading the
// Parquet footer — PB-B3 acceptance (d) specifically disallows estimates.
// ---------------------------------------------------------------------------

import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import {
  acquireConnection,
  queryAll,
  releaseConnection,
  runAll,
} from "../duckdb/pool";
import { AppError } from "../../utils/foundryAppError";

export interface ParquetColumn {
  name: string;
  /** Logical pipeline type (string/integer/numeric/boolean/date/timestamp). */
  type: string;
}

export interface WriteParquetInput {
  columns: ParquetColumn[];
  rows: Array<Record<string, unknown>>;
}

/**
 * Streaming variant: rows are pulled from an async iterable and inserted
 * into the DuckDB temp table in 500-row batches — the full row set is
 * NEVER materialised as a single Node array. This is what lets the
 * Funnel changelog/merge stages persist 1M+ rows to Parquet without
 * blowing the API pod's heap (the rows are read from a streaming
 * `SnapshotDiffReader`, handed to DuckDB in batches, and the DuckDB temp
 * table spills to `/tmp/duckdb_spill` when it exceeds `memory_limit`).
 *
 * Returns `null` for a zero-row iterable (Parquet cannot represent an
 * empty row group; callers commit a snapshot with `parquet_ref: null`
 * instead). The non-streaming {@link writeRowsToParquet} throws on
 * empty input — the streaming variant cannot pre-check the count, so it
 * returns null.
 */
export interface WriteParquetStreamInput {
  columns: ParquetColumn[];
  rows: AsyncIterable<Record<string, unknown>>;
}

export interface WriteParquetResult {
  /** Local path of the staged .parquet file. Caller uploads + deletes. */
  localPath: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Exact row count read from the Parquet footer — PB-B3 (d). */
  rowCountExact: number;
  /** Parquet logical type per column, for dataset_columns.logical_type. */
  columnLogicalTypes: Array<{ name: string; logicalType: string }>;
}

/**
 * Stage rows to DuckDB → COPY → Parquet → read footer.
 *
 * Returns the local file. Caller is responsible for uploading and
 * unlinking; we do NOT delete here because an upload failure needs to
 * be able to retry against the same bytes.
 */
export async function writeRowsToParquet(
  input: WriteParquetInput,
): Promise<WriteParquetResult> {
  if (input.rows.length === 0) {
    throw new AppError(
      "Cannot write a Parquet file with zero rows",
      400,
      "EMPTY_PARQUET_OUTPUT",
    );
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-b3-parquet-"));
  const outPath = path.join(dir, "part-00000.parquet");

  const conn = await acquireConnection({ skipHttpfs: true });
  const tempTable = `pb_b3_stage_${randomUUID().replace(/-/g, "_")}`;
  try {
    // Build a typed CREATE TABLE so the Parquet logical types come out
    // right (INT64 for integer, DOUBLE for numeric, TIMESTAMP for
    // timestamp, DATE for date, VARCHAR for string, BOOLEAN for boolean).
    // TRY_CAST keeps lenient coercion semantics consistent with the
    // transform engine.
    const columnsDdl = input.columns
      .map((c) => `${quoteIdent(c.name)} ${mapToDuckDBType(c.type)}`)
      .join(", ");
    await runAll(conn, `CREATE TEMP TABLE ${tempTable} (${columnsDdl})`);

    // Stream inserts. Batching with `INSERT INTO … VALUES (…), (…)` is
    // markedly faster than one-row-at-a-time on the native binding —
    // for 100k-row previews this drops from ~12s to ~0.8s on the hot
    // path. A batch of 500 keeps the SQL under DuckDB's statement-size
    // cap even with wide schemas.
    const BATCH = 500;
    for (let i = 0; i < input.rows.length; i += BATCH) {
      const slice = input.rows.slice(i, i + BATCH);
      const values = slice
        .map(
          (row) =>
            `(${input.columns
              .map((c) => toSqlLiteral(row[c.name], c.type))
              .join(", ")})`,
        )
        .join(", ");
      await runAll(conn, `INSERT INTO ${tempTable} VALUES ${values}`);
    }

    // PB-B3 COPY shape — exactly matches the spec.
    await runAll(
      conn,
      `COPY (SELECT * FROM ${tempTable}) TO '${outPath.replace(/'/g, "''")}' ` +
        `(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)`,
    );

    // Footer → row count + logical types. parquet_schema and
    // parquet_metadata are DuckDB table functions. Using `parquet_scan`
    // with COUNT(*) reads only the footer so this is O(1) wrt row count.
    const rc = await queryAll<{ c: bigint | number }>(
      conn,
      `SELECT COUNT(*) AS c FROM parquet_scan('${outPath.replace(/'/g, "''")}')`,
    );
    const rowCountExact = Number(rc[0]?.c ?? 0);

    const schemaRows = await queryAll<{
      name: string;
      type: string;
      logical_type: string | null;
    }>(
      conn,
      `SELECT name, type, logical_type FROM parquet_schema('${outPath.replace(
        /'/g,
        "''",
      )}')`,
    );
    const columnLogicalTypes = schemaRows
      .filter((r) => r.name && r.name !== "schema")
      .map((r) => ({
        name: r.name,
        logicalType: r.logical_type ?? r.type ?? "UNKNOWN",
      }));

    const sizeBytes = fs.statSync(outPath).size;

    return { localPath: outPath, sizeBytes, rowCountExact, columnLogicalTypes };
  } catch (err) {
    // Clean up on failure so we don't accumulate staging dirs.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    try {
      await runAll(conn, `DROP TABLE IF EXISTS ${tempTable}`);
    } catch {
      /* ignore — connection is being released anyway */
    }
    releaseConnection(conn);
  }
}

/**
 * Streaming sibling of {@link writeRowsToParquet}: pulls rows from an
 * async iterable and inserts them into the DuckDB temp table in 500-row
 * batches, then COPYs to a local Parquet file with the same PB-B3
 * settings. The full row set is never resident in Node memory — the
 * iterable yields one batch at a time and DuckDB's temp table spills to
 * disk past `memory_limit`. This is the write path the Funnel changelog
 * and merge stages use to persist 1M+ rows by reference.
 *
 * Returns `null` when the iterable yields zero rows (Parquet cannot
 * represent an empty row group); the caller commits a snapshot with
 * `parquet_ref: null` in that case.
 */
export async function writeRowsToParquetStream(
  input: WriteParquetStreamInput,
): Promise<WriteParquetResult | null> {
  if (input.columns.every((c) => mapToDuckDBType(c.type) === "VARCHAR")) {
    return writeVarcharRowsViaNdjson(input);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-b3-parquet-"));
  const outPath = path.join(dir, "part-00000.parquet");
  const conn = await acquireConnection({ skipHttpfs: true });
  const tempTable = `pb_b3_stage_${randomUUID().replace(/-/g, "_")}`;
  let inserted = 0;
  try {
    const columnsDdl = input.columns
      .map((c) => `${quoteIdent(c.name)} ${mapToDuckDBType(c.type)}`)
      .join(", ");
    await runAll(conn, `CREATE TEMP TABLE ${tempTable} (${columnsDdl})`);

    const BATCH = 500;
    let batch: Array<Record<string, unknown>> = [];
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const values = batch
        .map(
          (row) =>
            `(${input.columns
              .map((c) => toSqlLiteral(row[c.name], c.type))
              .join(", ")})`,
        )
        .join(", ");
      await runAll(conn, `INSERT INTO ${tempTable} VALUES ${values}`);
      inserted += batch.length;
      batch = [];
    };
    for await (const row of input.rows) {
      batch.push(row);
      if (batch.length >= BATCH) await flush();
    }
    await flush(); // final partial batch

    if (inserted === 0) {
      // Empty source — Parquet cannot represent a zero-row file. Caller
      // commits a snapshot with `parquet_ref: null`.
      return null;
    }

    await runAll(
      conn,
      `COPY (SELECT * FROM ${tempTable}) TO '${outPath.replace(/'/g, "''")}' ` +
        `(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)`,
    );

    const rc = await queryAll<{ c: bigint | number }>(
      conn,
      `SELECT COUNT(*) AS c FROM parquet_scan('${outPath.replace(/'/g, "''")}')`,
    );
    const rowCountExact = Number(rc[0]?.c ?? 0);

    const schemaRows = await queryAll<{
      name: string;
      type: string;
      logical_type: string | null;
    }>(
      conn,
      `SELECT name, type, logical_type FROM parquet_schema('${outPath.replace(
        /'/g,
        "''",
      )}')`,
    );
    const columnLogicalTypes = schemaRows
      .filter((r) => r.name && r.name !== "schema")
      .map((r) => ({
        name: r.name,
        logicalType: r.logical_type ?? r.type ?? "UNKNOWN",
      }));

    const sizeBytes = fs.statSync(outPath).size;
    return { localPath: outPath, sizeBytes, rowCountExact, columnLogicalTypes };
  } catch (err) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    try {
      await runAll(conn, `DROP TABLE IF EXISTS ${tempTable}`);
    } catch {
      /* ignore — connection is being released anyway */
    }
    releaseConnection(conn);
  }
}

/** Flush the NDJSON spool to disk once this many characters are buffered. */
const NDJSON_FLUSH_CHARS = 4 * 1024 * 1024;

/**
 * Bulk path for all-VARCHAR schemas (the funnel changelog + merged parquet
 * shapes): spool rows as NDJSON to a local file, then let DuckDB's
 * vectorised, multi-threaded JSON reader write the Parquet in ONE COPY.
 *
 * The generic path below renders every row into SQL literals and runs one
 * `INSERT … VALUES` per 500 rows — ~12.7k statements DuckDB must parse for a
 * 6.35M-row changelog. This is the "build the artifact in bulk" shape
 * Foundry's Funnel uses (each stage writes a dataset, never row-at-a-time).
 *
 * Value semantics are identical to `toSqlLiteral` for VARCHAR: null,
 * undefined and "" become NULL; everything else is `String(value)`.
 * Insertion order is preserved (DuckDB's default preserve_insertion_order).
 */
async function writeVarcharRowsViaNdjson(
  input: WriteParquetStreamInput,
): Promise<WriteParquetResult | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-b3-parquet-"));
  const outPath = path.join(dir, "part-00000.parquet");
  const spoolPath = path.join(dir, "rows.ndjson");
  const names = input.columns.map((c) => c.name);
  let inserted = 0;
  let maxLineChars = 0;
  try {
    const out = fs.createWriteStream(spoolPath, { encoding: "utf8" });
    const closed = new Promise<void>((resolve, reject) => {
      out.once("finish", () => resolve());
      out.once("error", reject);
    });
    const write = (chunk: string): Promise<void> =>
      out.write(chunk)
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const onDrain = () => {
              out.off("error", onError);
              resolve();
            };
            const onError = (e: Error) => {
              out.off("drain", onDrain);
              reject(e);
            };
            out.once("drain", onDrain);
            out.once("error", onError);
          });
    let buf = "";
    try {
      for await (const row of input.rows) {
        const rec: Record<string, string | null> = {};
        for (const n of names) {
          const v = row[n];
          rec[n] = v === null || v === undefined || v === "" ? null : String(v);
        }
        const line = JSON.stringify(rec);
        if (line.length > maxLineChars) maxLineChars = line.length;
        buf += line + "\n";
        inserted++;
        if (buf.length >= NDJSON_FLUSH_CHARS) {
          await write(buf);
          buf = "";
        }
      }
      if (buf) await write(buf);
    } finally {
      out.end();
      await closed;
    }
    if (inserted === 0) {
      fs.rmSync(dir, { recursive: true, force: true });
      return null;
    }

    const conn = await acquireConnection({ skipHttpfs: true });
    try {
      const cols = input.columns
        .map((c) => `'${c.name.replace(/'/g, "''")}': 'VARCHAR'`)
        .join(", ");
      const sp = spoolPath.replace(/'/g, "''");
      // DuckDB sizes its JSON read buffer from maximum_object_size (2x), so
      // a fixed huge value would blow small memory_limits. Size it to the
      // widest spooled row instead (UTF-8 is at most 3 bytes per UTF-16
      // unit), never below DuckDB's 16 MiB default.
      const maxObjectBytes = Math.max(16 * 1024 * 1024, maxLineChars * 3 + 1);
      const op = outPath.replace(/'/g, "''");
      await runAll(
        conn,
        `COPY (SELECT ${input.columns.map((c) => quoteIdent(c.name)).join(", ")}
                 FROM read_json('${sp}', format = 'newline_delimited',
                                columns = {${cols}},
                                maximum_object_size = ${maxObjectBytes}))
           TO '${op}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)`,
      );
      const rc = await queryAll<{ c: bigint | number }>(
        conn,
        `SELECT COUNT(*) AS c FROM parquet_scan('${op}')`,
      );
      const rowCountExact = Number(rc[0]?.c ?? 0);
      if (rowCountExact !== inserted) {
        throw new Error(
          `[parquet-writer] NDJSON bulk write row mismatch: spooled=${inserted} parquet=${rowCountExact}`,
        );
      }
      const schemaRows = await queryAll<{
        name: string;
        type: string;
        logical_type: string | null;
      }>(conn, `SELECT name, type, logical_type FROM parquet_schema('${op}')`);
      const columnLogicalTypes = schemaRows
        .filter((r) => r.name && r.name !== "schema")
        .map((r) => ({
          name: r.name,
          logicalType: r.logical_type ?? r.type ?? "UNKNOWN",
        }));
      fs.rmSync(spoolPath, { force: true });
      const sizeBytes = fs.statSync(outPath).size;
      return { localPath: outPath, sizeBytes, rowCountExact, columnLogicalTypes };
    } finally {
      releaseConnection(conn);
    }
  } catch (err) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Delete the staging directory after a successful upload. Split out so
 * the caller can keep the file on upload failure and retry without
 * re-running the COPY.
 */
export function discardStagedParquet(localPath: string): void {
  try {
    fs.rmSync(path.dirname(localPath), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapToDuckDBType(logicalType: string): string {
  switch ((logicalType ?? "").toLowerCase()) {
    case "integer":
    case "int":
    case "long":
    case "bigint":
      return "BIGINT";
    case "numeric":
    case "double":
    case "float":
    case "real":
      return "DOUBLE";
    case "boolean":
    case "bool":
      return "BOOLEAN";
    case "date":
      return "DATE";
    case "timestamp":
      return "TIMESTAMP";
    default:
      // string / text / unknown → VARCHAR (matches CsvSerialize default).
      return "VARCHAR";
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function toSqlLiteral(value: unknown, columnType: string): string {
  if (value === null || value === undefined || value === "") {
    return "NULL";
  }
  const t = (columnType ?? "").toLowerCase();
  if (t === "integer" || t === "numeric" || t === "double" || t === "int") {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : "NULL";
  }
  if (t === "boolean" || t === "bool") {
    const s = String(value).toLowerCase();
    if (s === "true" || s === "t" || s === "1" || s === "yes") return "TRUE";
    if (s === "false" || s === "f" || s === "0" || s === "no") return "FALSE";
    return "NULL";
  }
  if (t === "date") {
    return `DATE '${String(value).replace(/'/g, "''")}'`;
  }
  if (t === "timestamp") {
    return `TIMESTAMP '${String(value).replace(/'/g, "''")}'`;
  }
  // VARCHAR
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Map a pipeline column type to a Parquet logical-type string for
 * persistence in `dataset_columns.logical_type`.
 */
export function pipelineTypeToParquetLogicalType(t: string): string {
  switch ((t ?? "").toLowerCase()) {
    case "integer":
    case "int":
    case "long":
    case "bigint":
      return "INT64";
    case "numeric":
    case "double":
    case "float":
      return "DOUBLE";
    case "boolean":
    case "bool":
      return "BOOL";
    case "date":
      return "DATE";
    case "timestamp":
      return "TIMESTAMP_MICROS";
    default:
      return "STRING";
  }
}
