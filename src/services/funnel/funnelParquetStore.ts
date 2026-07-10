// ---------------------------------------------------------------------------
// Funnel Parquet store — by-reference row persistence (Option 2)
//
// The changelog and merged stages used to inline their full row arrays into
// `funnel_snapshot.summary_json` (jsonb). At ~83k rows that was ~42 MB and
// fine; at 1M rows (~573 MB) the jsonb INSERT parameter crashed the
// 768 MiB-capped Postgres backend (the "stuck at changelog" incident — see
// memory `funnel-changelog-1m-inline-rows-pg-oom`). This module is the
// replacement: rows are persisted as a Parquet object in MinIO and the
// snapshot's `summary_json` carries only a small `parquet_ref` (bucket,
// key, rowCount, sizeBytes) — N-independent on the Postgres side.
//
// Write path: stream rows → DuckDB temp table (batched, disk-spillable) →
//   COPY to a local .parquet → `storageService.uploadObject` (multipart,
//   never resident in Node) → unlink the local file. The Parquet object is
//   written BEFORE the Postgres snapshot row commits; if the commit fails
//   the orphaned object is best-effort deleted (idempotent `deleteObject`),
//   and is in any case safely ignorable + garbage-collectable (the key is a
//   per-call uuid, so a retry never collides with a referenced object).
//
// Read path: `getObjectStream` → local temp file → DuckDB `read_parquet`
//   (skipHttpfs — the dev API server runs on the host where the in-container
//   `minio` DNS name does not resolve, so we go through `storageService`
//   which uses `S3_ENDPOINT=localhost:9000`). This is the symmetric inverse
//   of the write path and avoids configuring DuckDB httpfs/S3 creds.
//
// Shape: the variable-per-OT `properties` (and merged `markings`) fields are
// stored as JSON-string VARCHAR columns so the Parquet schema is FIXED per
// row kind (OT-agnostic, no need to peek the first row to derive columns,
// robust to heterogeneous rows). `readParquetRows` JSON.parses them back.
//
// Legacy compatibility: snapshots committed before this change still carry
// `summary_json.inline_rows`. The loaders (`loadChangelogRowsFromSnapshot`,
// `loadMergedRowsFromSnapshot`) branch on the presence of `parquet_ref` vs
// `inline_rows` — no data migration.
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
  releaseConnection,
} from "../duckdb/pool";
import {
  uploadObject,
  getObjectStream,
  deleteObject,
  buildDuckDbReadUri,
} from "../storageService";

/** Small, N-independent reference to a Parquet object in MinIO. Stored in
 *  `funnel_snapshot.summary_json.parquet_ref`. */
export interface ParquetRef {
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

/** MinIO key for a changelog Parquet object. `changelogs/<apiName>/<uuid>`. */
export function changelogParquetKey(objectTypeApiName: string): string {
  return `changelogs/${objectTypeApiName}/${randomUUID()}.parquet`;
}

/** MinIO key for a merged-rows Parquet object. `merged/<apiName>/<uuid>`. */
export function mergedParquetKey(objectTypeApiName: string): string {
  return `merged/${objectTypeApiName}/${randomUUID()}.parquet`;
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
}): Promise<ParquetRef | null> {
  const parquet = await writeRowsToParquetStream({
    columns: opts.columns,
    rows: opts.rows,
  });
  if (!parquet) return null; // zero rows — no object, no ref
  try {
    const up = await uploadObject(
      opts.key,
      fs.createReadStream(parquet.localPath),
      "application/vnd.apache.parquet",
      undefined,
      parquet.sizeBytes,
    );
    return {
      bucket: up.bucket,
      key: up.key,
      rowCount: parquet.rowCountExact,
      sizeBytes: parquet.sizeBytes,
    };
  } finally {
    discardStagedParquet(parquet.localPath);
  }
}

/**
 * Best-effort removal of an orphaned Parquet object whose Postgres snapshot
 * row failed to commit. Idempotent (S3 delete is silent on NotFound). Safe
 * to call in a catch block — never throws.
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
 * object via `storageService.getObjectStream` (localhost S3 endpoint — works
 * on the dev host) to a local temp file, then DuckDB `read_parquet` decodes
 * it (httpfs disabled — no S3 creds needed in DuckDB). The downloaded temp
 * file is removed in `finally`.
 *
 * `mapFn` adapts each flat parquet row to the caller's row type (e.g.
 * JSON.parse the `properties`/`markings` JSON-string columns back to
 * objects). The result is a full array in Node memory — bounded by the row
 * count; for very large N the merge reduction is itself O(n) memory.
 */
export async function readParquetRows<T>(
  ref: ParquetRef,
  mapFn: (row: Record<string, unknown>) => T,
): Promise<T[]> {
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
      return rows.map(mapFn);
    } finally {
      releaseConnection(conn);
    }
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
