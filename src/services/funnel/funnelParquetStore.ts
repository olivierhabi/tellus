// ---------------------------------------------------------------------------
// Funnel Parquet store — by-reference row persistence (Option 2).
//
// CONTRACT (for the next engineer — read this before changing the shape):
//
//   Changelog + merged rows are persisted as a Parquet object in MinIO; the
//   `funnel_snapshot.summary_json` row carries ONLY a small `parquet_ref`
//   (this module's `ParquetRef`), never the rows. This replaces the old
//   `inline_rows` jsonb array, which at ~573 MB for a 1M-row source crashed
//   the 768 MiB-capped Postgres backend at the INSERT (the
//   "stuck-at-changelog" incident — see memory
//   `funnel-changelog-1m-inline-rows-pg-oom`).
//
//   `parquet_ref` shape (versioned via `refVersion`):
//     { refVersion: 1, bucket, key, rowCount, sizeBytes }
//
//   Key convention: `changelogs/<objectTypeApiName>/<snapshotId>.parquet`
//   (merged: `merged/<objectTypeApiName>/<snapshotId>.parquet`). The key is
//   DERIVED FROM THE SNAPSHOT ID (pre-generated before the commit) so:
//     • each snapshot owns exactly one Parquet object — NEVER overwritten,
//       so time-travel reads of old snapshots stay correct (overwriting on
//       retry would corrupt an earlier snapshot's parquet for a later drain);
//     • a failed-retry attempt (snapshot id pre-generated but the Postgres
//       row never committed) leaves an orphan at `.../<that-snapshotId>.parquet`
//       that is SAFELY IGNORABLE + garbage-collectable: a sweeper lists the
//       prefix and deletes any key whose snapshot id is not in
//       `funnel_snapshot` (a one-line anti-join). We intentionally do NOT
//       overwrite, because a snapshotting system must keep old snapshots
//       readable; orphan-GC is the correct tradeoff (design requirement #4).
//
//   Atomicity: the Parquet object is written (uploadObject, multipart, never
//   resident in Node) BEFORE the Postgres snapshot row commits. If the
//   commit fails, the orphan is best-effort deleted (deleteOrphanParquetRef)
//   and in any case GC-able. A partial/interrupted multipart upload leaves
//   NO readable object (S3 only assembles on `complete`), so a later
//   successful commit's `parquet_ref` can never point at a corrupt object.
//
//   Access control: the object is read back through `storageService`
//   (server-side, MinIO creds + the same S3 client/circuit-breaker the rest
//   of the API uses). `parquet_ref` contains only bucket+key — no presigned
//   URL — so a client cannot fetch it directly without going through the
//   API's authorization boundary. Route handlers that surface `summary_json`
//   wholesale should strip `parquet_ref` (it is internal storage metadata).
//
//   Versioning: `refVersion: 1`. A future v2 (e.g. columnar properties
//   instead of JSON-string, or a partitioned multi-file manifest) bumps the
//   number; `resolveParquetRef` MUST branch on `refVersion` and reject
//   unknown versions loudly (a v2 reader encountering a v3 ref throws rather
//   than mis-parsing). Legacy snapshots (no `parquet_ref`, only
//   `inline_rows`) are handled by the loaders' inline_rows fallback — no
//   migration.
//
//   Observability: every write + read emits a structured `[funnel-parquet]`
//   log line (object type, key, rowCount, sizeBytes, durationMs, outcome)
//   so a failure is obviously the parquet path — not an opaque
//   Postgres/Temporal error like the one that masked this incident.
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { pipeline } from "stream/promises";
import {
  writeRowsToParquetStream,
  discardStagedParquet,
  type ParquetColumn,
} from "../pipelines/parquetWriter";
import {
  acquireConnection,
  queryAll,
  streamQuery,
  releaseConnection,
} from "../duckdb/pool";
import {
  uploadObject,
  getObjectStream,
  deleteObject,
  buildDuckDbReadUri,
} from "../storageService";

/** Current parquet_ref shape version. Bump on any incompatible change to
 *  the Parquet schema or ref shape; `resolveParquetRef` branches on it. */
export const PARQUET_REF_VERSION = 1;

/** Small, N-independent reference to a Parquet object in MinIO. Stored in
 *  `funnel_snapshot.summary_json.parquet_ref`. */
export interface ParquetRef {
  /** Shape version. `resolveParquetRef` validates this; unknown versions
   *  throw so a future v2 reader does not silently mis-parse a v3 ref. */
  refVersion: number;
  bucket: string;
  key: string;
  rowCount: number;
  sizeBytes: number;
}

/**
 * Fixed Parquet schema for a changelog row. `properties` is a JSON-string
 * VARCHAR so the schema does not depend on the Object Type's columns.
 */
export const CHANGELOG_PARQUET_COLUMNS: ParquetColumn[] = [
  { name: "primary_key", type: "string" },
  { name: "operation", type: "string" },
  { name: "properties", type: "string" }, // JSON.stringify of the properties Record
  { name: "source_transaction_id", type: "string" },
  { name: "source_commit_timestamp", type: "string" },
];

/** Fixed Parquet schema for a merged row. `properties` + `markings` are
 *  JSON-string VARCHAR columns. */
export const MERGED_PARQUET_COLUMNS: ParquetColumn[] = [
  { name: "primary_key", type: "string" },
  { name: "properties", type: "string" }, // JSON.stringify of the properties Record
  { name: "markings", type: "string" }, // JSON.stringify of the markings string[]
  { name: "operation", type: "string" },
  { name: "source_datasource_id", type: "string" },
  { name: "source_transaction_id", type: "string" },
];

/** MinIO key for a changelog Parquet object, derived from the snapshot id
 *  (deterministic per snapshot — see the CONTRACT above). */
export function changelogParquetKey(
  objectTypeApiName: string,
  snapshotId: string,
): string {
  return `changelogs/${objectTypeApiName}/${snapshotId}.parquet`;
}

/** MinIO key for a merged-rows Parquet object, derived from the merged
 *  snapshot id. */
export function mergedParquetKey(
  objectTypeApiName: string,
  snapshotId: string,
): string {
  return `merged/${objectTypeApiName}/${snapshotId}.parquet`;
}

/**
 * Validate + normalise a `parquet_ref` read from `summary_json`. Rejects
 * unknown `refVersion` loudly. Returns `null` for a missing/invalid ref
 * (callers fall back to legacy `inline_rows`).
 */
export function resolveParquetRef(
  raw: unknown,
): ParquetRef | null {
  if (!raw || typeof raw !== "object") return null;
  const ref = raw as Partial<ParquetRef> & { refVersion?: unknown };
  if (!ref.refVersion || ref.refVersion !== PARQUET_REF_VERSION) {
    // Unknown future version — do NOT silently mis-parse. Let the caller
    // decide; the loaders fall back to inline_rows (legacy) so a stale
    // v2 reader on a v3 ref degrades rather than corrupts.
    if (ref.refVersion && ref.refVersion !== PARQUET_REF_VERSION) {
      console.warn(
        `[funnel-parquet] unknown parquet_ref refVersion=${ref.refVersion} ` +
          `(expected ${PARQUET_REF_VERSION}); falling back to inline_rows`,
      );
    }
    return null;
  }
  if (!ref.key || !ref.bucket) return null;
  return {
    refVersion: ref.refVersion,
    bucket: String(ref.bucket),
    key: String(ref.key),
    rowCount: Number(ref.rowCount ?? 0),
    sizeBytes: Number(ref.sizeBytes ?? 0),
  };
}

/**
 * Stream rows to a Parquet object in MinIO. Writes the object BEFORE the
 * caller commits the Postgres snapshot row (call ordering: write parquet →
 * commitSnapshot with the returned ref). On a caller-side commit failure
 * the orphaned object should be removed via {@link deleteOrphanParquetRef}.
 *
 * Returns `null` for a zero-row stream (no Parquet is written; the caller
 * commits a snapshot with `parquet_ref: null`).
 */
export async function writeParquetRef(opts: {
  columns: ParquetColumn[];
  rows: AsyncIterable<Record<string, unknown>>;
  key: string;
  objectTypeApiName: string;
  /** stage label for observability: "changelog" | "merged". */
  stage: "changelog" | "merged";
}): Promise<ParquetRef | null> {
  const startedAt = Date.now();
  const parquet = await writeRowsToParquetStream({
    columns: opts.columns,
    rows: opts.rows,
  });
  if (!parquet) {
    console.log(
      `[funnel-parquet] write ${opts.stage} ot=${opts.objectTypeApiName} ` +
        `key=${opts.key} rows=0 outcome=empty durationMs=${Date.now() - startedAt}`,
    );
    return null; // zero rows — no object, no ref
  }
  let ref: ParquetRef | null = null;
  try {
    // Ensure the descriptor is open before an upload adapter can resolve.
    // Some test/in-memory adapters acknowledge immediately without consuming
    // the stream; unlinking the staged file first otherwise produces a later
    // process-level ENOENT from createReadStream.
    const stream = fs.createReadStream(parquet.localPath);
    await new Promise<void>((resolve, reject) => {
      stream.once("open", () => resolve());
      stream.once("error", reject);
    });
    let up: Awaited<ReturnType<typeof uploadObject>>;
    try {
      up = await uploadObject(
        opts.key,
        stream,
        "application/vnd.apache.parquet",
        undefined,
        parquet.sizeBytes,
      );
    } finally {
      stream.destroy();
    }
    ref = {
      refVersion: PARQUET_REF_VERSION,
      bucket: up.bucket,
      key: up.key,
      rowCount: parquet.rowCountExact,
      sizeBytes: parquet.sizeBytes,
    };
    console.log(
      `[funnel-parquet] write ${opts.stage} ot=${opts.objectTypeApiName} ` +
        `key=${ref.key} rowCount=${ref.rowCount} sizeBytes=${ref.sizeBytes} ` +
        `durationMs=${Date.now() - startedAt} outcome=ok`,
    );
    return ref;
  } catch (err) {
    console.warn(
      `[funnel-parquet] write ${opts.stage} FAILED ot=${opts.objectTypeApiName} ` +
        `key=${opts.key} rowCount=${parquet.rowCountExact} sizeBytes=${parquet.sizeBytes} ` +
        `durationMs=${Date.now() - startedAt} err=${(err as Error).message}`,
    );
    throw err;
  } finally {
    discardStagedParquet(parquet.localPath);
  }
}

/**
 * Best-effort removal of an orphaned Parquet object whose Postgres snapshot
 * row failed to commit. Idempotent (S3 delete is silent on NotFound). Safe
 * to call in a catch block — never throws. The orphan is also safely
 * ignorable + GC-able (the key is the snapshot id; a sweeper deletes keys
 * whose snapshot id is not in funnel_snapshot).
 */
export async function deleteOrphanParquetRef(ref: ParquetRef | null): Promise<void> {
  if (!ref) return;
  try {
    await deleteObject(ref.key);
  } catch {
    /* best-effort — the orphan is also safely ignorable + GC-able */
  }
}

/**
 * Read a Parquet object back from MinIO into a flat row array. Downloads the
 * object via `storageService.getObjectStream` (the server-side path — same
 * S3 client/circuit-breaker/creds the API uses; `localhost:9000` works on
 * the dev host where the in-container `minio` DNS name does not resolve) to
 * a local temp file, then DuckDB `read_parquet` decodes it (httpfs disabled
 * — no S3 creds needed in DuckDB). This is the symmetric inverse of the
 * write path: the parquet BYTES are streamed to disk (never a JS buffer),
 * so this does NOT reproduce the old "download the whole parquet into a
 * buffer then parse" landmine.
 *
 * `mapFn` adapts each flat parquet row to the caller's row type (e.g.
 * JSON.parse the `properties`/`markings` JSON-string columns back to
 * objects). The result is a full array in Node memory — bounded by the row
 * count; for very large N the caller should route through the DuckDB merge
 * reduction (which stages via SQL, no JS array).
 */
export async function readParquetRows<T>(
  ref: ParquetRef,
  mapFn: (row: Record<string, unknown>) => T,
): Promise<T[]> {
  const startedAt = Date.now();
  // Q2 gate (was a documented-but-unimplemented TODO at the old L262-264):
  // refuse to materialise an oversized result into a JS array. The download
  // step below is streaming-safe, but `queryAll`+`rows.map` materialise the
  // FULL result — for a 4.65M-row merged/changelog parquet (OO7) that's a
  // multi-GiB O(N) heap wall. Callers above the threshold MUST use
  // `streamParquetRows` (async-iterable, flat memory) instead. Default 2M
  // keeps OO4 (848k) materialising unchanged; OO7 (4.65M) is forced onto the
  // streaming path. Env-config: TELLUS_PARQUET_READ_MAX_ROWS.
  const maxRows = Number(process.env.TELLUS_PARQUET_READ_MAX_ROWS ?? "") || 2_000_000;
  if (ref.rowCount > maxRows) {
    throw new Error(
      `readParquetRows: ref.rowCount=${ref.rowCount} exceeds ` +
        `TELLUS_PARQUET_READ_MAX_ROWS=${maxRows}; use streamParquetRows() ` +
        `for large results (the materialising path would OOM the pod).`
    );
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "funnel-parquet-read-"));
  const localPath = path.join(dir, "rows.parquet");
  try {
    const stream = await getObjectStream(ref.key);
    await pipeline(stream, fs.createWriteStream(localPath));
    const conn = await acquireConnection({ skipHttpfs: true });
    try {
      const rows = await queryAll<Record<string, unknown>>(
        conn,
        `SELECT * FROM read_parquet('${localPath.replace(/'/g, "''")}')`,
      );
      const out = rows.map(mapFn);
      console.log(
        `[funnel-parquet] read key=${ref.key} rowCount=${ref.rowCount} ` +
          `sizeBytes=${ref.sizeBytes} rowsDecoded=${out.length} ` +
          `durationMs=${Date.now() - startedAt} outcome=ok`,
      );
      return out;
    } finally {
      releaseConnection(conn);
    }
  } catch (err) {
    console.warn(
      `[funnel-parquet] read FAILED key=${ref.key} rowCount=${ref.rowCount} ` +
        `sizeBytes=${ref.sizeBytes} durationMs=${Date.now() - startedAt} ` +
        `err=${(err as Error).message}`,
    );
    throw err;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Streaming variant of `readParquetRows` — yields mapped rows ONE AT A TIME
 * via `streamQuery` (the DuckDB binding's async-iterable `.stream`), so a
 * multi-million-row parquet read-back NEVER materialises into a JS array.
 * The download step (S3 → temp file) is byte-identical to `readParquetRows`
 * (streaming-safe); only the decode + return differ (async-iterable vs full
 * array). Used by Phase 1's merge/indexing re-reads for OO7 (4.65M rows) —
 * the path `readParquetRows`' threshold gate now refuses for results > 2M.
 */
export async function* streamParquetRows<T>(
  ref: ParquetRef,
  mapFn: (row: Record<string, unknown>) => T,
): AsyncGenerator<T> {
  const startedAt = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "funnel-parquet-stream-"));
  const localPath = path.join(dir, "rows.parquet");
  try {
    const stream = await getObjectStream(ref.key);
    await pipeline(stream, fs.createWriteStream(localPath));
    const conn = await acquireConnection({ skipHttpfs: true });
    try {
      const sql = `SELECT * FROM read_parquet('${localPath.replace(/'/g, "''")}')`;
      let decoded = 0;
      for await (const row of streamQuery<Record<string, unknown>>(conn, sql)) {
        yield mapFn(row);
        decoded++;
      }
      console.log(
        `[funnel-parquet] stream key=${ref.key} rowCount=${ref.rowCount} ` +
          `sizeBytes=${ref.sizeBytes} rowsDecoded=${decoded} ` +
          `durationMs=${Date.now() - startedAt} outcome=ok`,
      );
    } finally {
      releaseConnection(conn);
    }
  } catch (err) {
    console.warn(
      `[funnel-parquet] stream FAILED key=${ref.key} rowCount=${ref.rowCount} ` +
        `sizeBytes=${ref.sizeBytes} durationMs=${Date.now() - startedAt} ` +
        `err=${(err as Error).message}`,
    );
    throw err;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Parse a JSON-string column back to an object; null/invalid → {}. */
export function parseJsonColumn(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Parse a JSON-string column back to a string array; null/invalid → []. */
export function parseJsonArrayColumn(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** Build the `s3://bucket/key` URI stored in the snapshot manifest's
 *  `file_path` for a Parquet ref. */
export function parquetRefToUri(ref: ParquetRef): string {
  return buildDuckDbReadUri(ref.bucket, ref.key);
}

/** Pre-generate a snapshot id for the parquet-keyed by-reference path. */
export function newSnapshotId(): string {
  return randomUUID();
}
