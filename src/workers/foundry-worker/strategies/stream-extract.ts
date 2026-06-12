// ---------------------------------------------------------------------------
// B5 — Shared streaming extract for snapshot + append strategies.
//
// One code path that both strategies use to read from the source Postgres and
// materialise rolling data files, with the production safety properties:
//
//   - READ-ONLY transaction + statement_timeout + idle-in-transaction timeout
//     wrap every extraction (defense-in-depth: even if a write somehow slipped
//     the SELECT-only parser, the source DB refuses it; a runaway query is
//     killed by statement_timeout instead of hanging the worker).
//   - Server-side cursor streaming (pg-cursor) in 5k-row batches, rolling a new
//     128 MiB file as needed — bounded memory regardless of result size. Append
//     deltas stream too (previously buffered the whole result set → OOM risk).
//   - Correct, type-aware high-watermark tracking: pg returns int8/numeric as
//     strings and timestamptz as Date; comparing those with JS `>` is
//     lexicographic and wrong ("10" < "9"). `compareWatermark` compares numbers
//     numerically (BigInt for integers), dates chronologically, else by string
//     (ISO timestamps still order correctly lexicographically).
//   - Records the ACTUAL written file path (Parquet, or the JSONL fallback when
//     no Parquet binding is present) so the Iceberg snapshot never points at a
//     file that isn't there.
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { promises as fs } from "node:fs";
import type { Client } from "pg";
import type { DataFile } from "../../../lib/iceberg/transaction";

export const TARGET_FILE_BYTES = 128 * 1024 * 1024;

const STATEMENT_TIMEOUT_MS = Number(
  process.env.TELLUS_SYNC_STATEMENT_TIMEOUT_MS ?? 300_000,
);
const IDLE_TX_TIMEOUT_MS = Number(
  process.env.TELLUS_SYNC_IDLE_TX_TIMEOUT_MS ?? 120_000,
);

// --- read-only transaction --------------------------------------------------

/**
 * Open a READ ONLY transaction with bounded statement + idle-in-transaction
 * timeouts. All extraction statements (DECLARE/FETCH or a plain query) run
 * inside it. Returns a `commit()` that ends the transaction.
 */
export async function beginReadOnlyTx(client: Client): Promise<() => Promise<void>> {
  await client.query("BEGIN");
  await client.query("SET TRANSACTION READ ONLY");
  await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
  await client.query(
    `SET LOCAL idle_in_transaction_session_timeout = ${IDLE_TX_TIMEOUT_MS}`,
  );
  let ended = false;
  return async () => {
    if (ended) return;
    ended = true;
    // READ ONLY → COMMIT and ROLLBACK are equivalent; COMMIT releases cleanly.
    await client.query("COMMIT").catch(() => client.query("ROLLBACK").catch(() => undefined));
  };
}

// --- type-aware watermark comparison ----------------------------------------

const NUMERIC_RE = /^[+-]?\d+(?:\.\d+)?$/;

/** -1 / 0 / +1 like a comparator; handles number, numeric-string, Date, text. */
export function compareWatermark(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;

  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : Date.parse(String(a));
    const tb = b instanceof Date ? b.getTime() : Date.parse(String(b));
    if (Number.isFinite(ta) && Number.isFinite(tb)) {
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    }
  }
  if (typeof a === "number" && typeof b === "number") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const as = String(a);
  const bs = String(b);
  if (NUMERIC_RE.test(as.trim()) && NUMERIC_RE.test(bs.trim())) {
    if (!as.includes(".") && !bs.includes(".")) {
      const ba = BigInt(as.trim());
      const bb = BigInt(bs.trim());
      return ba < bb ? -1 : ba > bb ? 1 : 0;
    }
    const na = Number(as);
    const nb = Number(bs);
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  return as < bs ? -1 : as > bs ? 1 : 0;
}

// --- cursor (portable; pg-cursor optional) ----------------------------------

interface CursorHandle {
  fetch(n: number): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

async function openCursor(
  client: Client,
  sql: string,
  params: unknown[],
): Promise<CursorHandle> {
  try {
    const Cursor: any = (await import("pg-cursor")).default;
    const cur = (client as any).query(new Cursor(sql, params));
    return {
      fetch: (n: number) =>
        new Promise((resolve, reject) =>
          cur.read(n, (err: Error | null, rows: Record<string, unknown>[]) =>
            err ? reject(err) : resolve(rows),
          ),
        ),
      close: () => new Promise<void>((resolve) => cur.close(() => resolve())),
    };
  } catch {
    // Fallback: single-shot (small fixtures / no pg-cursor binding).
    const r = await client.query<Record<string, unknown>>(sql, params);
    let done = false;
    return {
      async fetch() {
        if (done) return [];
        done = true;
        return r.rows;
      },
      async close() {
        /* noop */
      },
    };
  }
}

// --- writer (Parquet, JSONL fallback) ---------------------------------------

interface WriterHandle {
  appendRows(rows: Record<string, unknown>[]): Promise<{ bytes: number }>;
  close(): Promise<void>;
  /** The path actually written (Parquet, or the JSONL fallback). */
  actualPath(): string;
}

async function openWriter(path: string): Promise<WriterHandle> {
  try {
    const parquet: any = await import("parquetjs-lite");
    let writer: any = null;
    let bytes = 0;
    return {
      async appendRows(rows) {
        if (!writer) {
          const schema = inferParquetSchema(parquet, rows[0]);
          writer = await parquet.ParquetWriter.openFile(schema, path, {
            compression: "ZSTD",
          });
        }
        for (const r of rows) await writer.appendRow(r);
        bytes += rows.reduce((a, r) => a + Buffer.byteLength(JSON.stringify(r)), 0);
        return { bytes };
      },
      async close() {
        if (writer) await writer.close();
      },
      actualPath: () => path,
    };
  } catch {
    const jsonlPath = path.replace(/\.parquet$/, ".jsonl");
    await fs.mkdir(jsonlPath.substring(0, jsonlPath.lastIndexOf("/")), {
      recursive: true,
    });
    const fh = await fs.open(jsonlPath, "w");
    return {
      async appendRows(rows) {
        const buf = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
        await fh.write(buf);
        return { bytes: Buffer.byteLength(buf) };
      },
      async close() {
        await fh.close();
      },
      actualPath: () => jsonlPath,
    };
  }
}

function inferParquetSchema(parquet: any, sample: Record<string, unknown>): any {
  const cols: Record<string, { type: string; optional: boolean }> = {};
  for (const [k, v] of Object.entries(sample)) {
    if (typeof v === "number") {
      cols[k] = { type: Number.isInteger(v) ? "INT64" : "DOUBLE", optional: true };
    } else if (typeof v === "boolean") {
      cols[k] = { type: "BOOLEAN", optional: true };
    } else if (v instanceof Date) {
      cols[k] = { type: "TIMESTAMP_MILLIS", optional: true };
    } else {
      cols[k] = { type: "UTF8", optional: true };
    }
  }
  return new parquet.ParquetSchema(cols);
}

// --- high-level streaming extract -------------------------------------------

export interface StreamExtractOptions {
  client: Client;
  sql: string;
  params: unknown[];
  /** Directory to write data files into (…/<table>/data). */
  tableDir: string;
  /** File name prefix, e.g. `part-<buildRid>` or `append-<buildRid>`. */
  filePrefix: string;
  /** When set, track MAX(row[watermarkColumn]) across the stream. */
  watermarkColumn?: string;
  /** Starting watermark (its type drives the comparison). */
  initialWatermark?: unknown;
  /** Roll a new file at this many bytes (default 128 MiB). */
  targetFileBytes?: number;
  onBatch?(rowsSoFar: number): void;
}

export interface StreamExtractResult {
  dataFiles: DataFile[];
  totalRows: number;
  /** MAX of the watermark column observed (undefined if not tracked / no rows). */
  observedMax: unknown;
}

/**
 * Stream `sql` (already SELECT-only validated + parameterized) to rolling data
 * files under `tableDir`, inside a READ ONLY transaction. Returns the produced
 * files, total row count, and (optionally) the max watermark observed.
 */
export async function streamQueryToFiles(
  opts: StreamExtractOptions,
): Promise<StreamExtractResult> {
  const targetBytes = opts.targetFileBytes ?? TARGET_FILE_BYTES;
  const commit = await beginReadOnlyTx(opts.client);
  const cursor = await openCursor(opts.client, opts.sql, opts.params);

  const dataFiles: DataFile[] = [];
  let fileIndex = 0;
  let writer: WriterHandle | null = null;
  let curBytes = 0;
  let curRows = 0;
  let totalRows = 0;
  let observedMax: unknown = opts.initialWatermark;

  const rollClose = async () => {
    if (writer) {
      await writer.close();
      dataFiles.push({
        path: writer.actualPath(),
        rowCount: curRows,
        fileSizeBytes: curBytes,
      });
    }
  };

  try {
    for (;;) {
      const batch = await cursor.fetch(5_000);
      if (batch.length === 0) break;
      totalRows += batch.length;

      if (!writer) {
        await fs.mkdir(opts.tableDir, { recursive: true });
        const path = join(
          opts.tableDir,
          `${opts.filePrefix}-${String(fileIndex).padStart(5, "0")}.parquet`,
        );
        writer = await openWriter(path);
      }

      const { bytes } = await writer.appendRows(batch);
      curBytes += bytes;
      curRows += batch.length;

      if (opts.watermarkColumn) {
        for (const r of batch) {
          const v = r[opts.watermarkColumn];
          if (v != null && (observedMax == null || compareWatermark(v, observedMax) > 0)) {
            observedMax = v;
          }
        }
      }

      opts.onBatch?.(totalRows);

      if (curBytes >= targetBytes) {
        await rollClose();
        fileIndex += 1;
        writer = null;
        curBytes = 0;
        curRows = 0;
      }
    }
    await rollClose();
  } finally {
    await cursor.close().catch(() => undefined);
    await commit().catch(() => undefined);
  }

  return { dataFiles, totalRows, observedMax };
}
