// ---------------------------------------------------------------------------
// Uploaded-dataset reader (Dataset Preview).
//
// Read-side counterpart to `synced-dataset-reader` for datasets whose data came
// from a manual file upload (or a pipeline that wrote a delimited object)
// rather than a data-connection sync. The bytes live as an object in MinIO/S3
// (the `foundry_datasets.file_path`).
//
// SCALABILITY: this STREAMS the object and stops after `limit` rows — it never
// buffers the whole file and never stages a temp file on disk. Destroying the
// parser also aborts the S3 GET at the socket, so a 5-row preview of a 2 GB
// upload transfers only the leading bytes. Memory is bounded to ~`limit` rows
// regardless of object size. Mirrors the proven `transformService.readCsvRows`
// streaming pattern (delimiter-by-extension, sanitized headers, BOM handling).
//
// Returns a well-formed empty preview (never throws) on a storage/parse error,
// so the preview page degrades to the "not built yet" state instead of 500ing —
// matching `readSyncedPreview`'s behaviour for an un-built sync. Read failures
// are logged at error level (structured) so a genuine storage outage is
// observable rather than silently indistinguishable from "no data".
// ---------------------------------------------------------------------------

import type { Readable } from "node:stream";
import { parse } from "csv-parse";
import { getObjectStream } from "../storageService";
import { sanitizeCsvHeader } from "../../utils/csvHeader";
import { log } from "../structuredLogger";
import {
  classifyValue,
  type PreviewColumn,
  type PreviewColumnType,
  type SyncedPreview,
} from "./synced-dataset-reader";

/** Strip a leading BOM from a string (header keys arrive BOM-prefixed). */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Delimited-text delimiter from the object extension (CSV default, TSV tab). */
function delimiterForKey(objectKey: string): "\t" | "," {
  return objectKey.toLowerCase().endsWith(".tsv") ? "\t" : ",";
}

/** Infer one display type per column (majority of non-null sampled values). */
function inferColumnType(
  column: string,
  rows: Record<string, unknown>[],
): PreviewColumnType {
  const counts = new Map<PreviewColumnType, number>();
  for (const row of rows) {
    const t = classifyValue(row[column]);
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: PreviewColumnType = "text";
  let bestN = 0;
  for (const [t, n] of counts) {
    if (n > bestN) {
      best = t;
      bestN = n;
    }
  }
  // integer is a refinement of numeric: widen if any decimal appears so the
  // column type doesn't misrepresent the data.
  if (best === "integer" && (counts.get("numeric") ?? 0) > 0) best = "numeric";
  return best;
}

/**
 * Stream the object through csv-parse, capturing the header order and the first
 * `limit` rows, then stop. Resolves `{ header, rows }`; rejects on a stream or
 * parse error (the caller degrades that to an empty preview).
 */
function streamBounded(
  stream: Readable,
  delimiter: "\t" | ",",
  limit: number,
  objectKey: string,
): Promise<{ header: string[]; rows: Record<string, string>[] }> {
  return new Promise((resolve, reject) => {
    const rows: Record<string, string>[] = [];
    let header: string[] = [];
    let settled = false;

    const parser = parse({
      delimiter,
      // The sanitizer guarantees record keys are 1:1 with physical header
      // cells even when the source has duplicate/blank headers. Capture the
      // resulting order so the grid matches the file's column order.
      columns: (h: string[]) => {
        header = sanitizeCsvHeader(h, { source: objectKey });
        return header;
      },
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true,
    });

    const settle = () => {
      if (!settled) {
        settled = true;
        resolve({ header, rows });
      }
    };

    parser.on("readable", () => {
      let record: Record<string, string>;
      while ((record = parser.read() as Record<string, string>) !== null) {
        const clean: Record<string, string> = {};
        for (const [k, v] of Object.entries(record)) clean[stripBom(k)] = v;
        rows.push(clean);
        if (rows.length >= limit) {
          // Stops parsing AND aborts the underlying S3 transfer.
          parser.destroy();
          stream.destroy();
          break;
        }
      }
    });

    parser.on("error", (err) => {
      stream.destroy();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    parser.on("end", settle);
    parser.on("close", settle);
    stream.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    stream.pipe(parser);
  });
}

/**
 * Read a bounded preview of an object-backed dataset. `objectKey` is the
 * storage key recorded on `foundry_datasets.file_path`. Column ORDER follows
 * the file header; the total row count is owned by the caller (the registry
 * row's authoritative `row_count`), so this only reads the first `limit` rows.
 */
export async function readUploadedPreview(
  objectKey: string,
  limit: number,
): Promise<SyncedPreview> {
  try {
    const stream = await getObjectStream(objectKey);
    const { header, rows } = await streamBounded(
      stream,
      delimiterForKey(objectKey),
      Math.max(1, limit),
      objectKey,
    );
    const columns: PreviewColumn[] = header.map((name) => ({
      name,
      type: inferColumnType(name, rows),
    }));
    // Object-backed datasets have no Iceberg snapshot; size/row metadata is
    // surfaced from the registry row by the caller.
    return { columns, rows, snapshot: null };
  } catch (err) {
    log.error({
      msg: "uploaded dataset preview read failed",
      objectKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return { columns: [], rows: [], snapshot: null };
  }
}
