// ---------------------------------------------------------------------------
// Attachment / media-item upload service (action parameter parity).
//
// Foundry contract (docs: ontologies-v2/resources/attachments/upload-attachment):
//   POST /api/v2/ontologies/attachments/upload?filename=...
//     Content-Type: application/octet-stream, raw file bytes
//   → 200 { rid, filename, sizeBytes, mediaType }
//   rid = `ri.attachments.main.attachment.<uuid>` — the value later passed
//   as the attachment-type action parameter in applyAction.
//
// Tellus's media picker is upload-only (no media-set browser); media items
// get `ri.mio.main.media-item.<uuid>` rids so the existing signed-media-read
// path (`signMediaReadToken`) can serve them by rid.
//
// Scaling: request bodies are NEVER buffered in heap. The raw stream is
// piped to a staging file on disk (same idiom as foundryMulter), then
// streamed to object storage via uploadObject (multipart, 5 MB parts), and
// the staged file is deleted in a finally block. A hard size cap aborts the
// pipe mid-stream so an unbounded body cannot fill the disk.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { query } from "../db";
import { uploadObject, getObjectStream } from "./storageService";

export const MAX_UPLOAD_BYTES = parseInt(
  process.env.ATTACHMENT_MAX_BYTES ?? String(200 * 1024 * 1024),
  10,
);

export class UploadValidationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly errorName: string,
  ) {
    super(message);
  }
}

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function mediaTypeForFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MEDIA_TYPES[ext] ?? "application/octet-stream";
}

function getStagingDir(): string {
  const dir =
    process.env.UPLOAD_STAGING_DIR ??
    path.join(process.env.DATA_DIR || "./data", "uploads", "_staging");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[^\w.\- ]+/g, "_");
  return base.length > 0 ? base.slice(0, 140) : "file";
}

/**
 * Pipe an incoming request stream to a staging file, counting bytes.
 * Rejects with UploadValidationError(413) the moment the stream exceeds
 * MAX_UPLOAD_BYTES and destroys the partial file.
 */
export async function stageToDisk(
  body: Readable,
): Promise<{ stagedPath: string; size: number }> {
  const stagedPath = path.join(getStagingDir(), `attach-${randomUUID()}`);
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc: string, cb: (err?: Error | null, data?: Buffer) => void) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        cb(
          new UploadValidationError(
            `Upload exceeds the ${MAX_UPLOAD_BYTES} byte limit.`,
            413,
            "AttachmentSizeLimitExceeded",
          ),
        );
        return;
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(body, counter, fs.createWriteStream(stagedPath));
  } catch (err) {
    fs.rmSync(stagedPath, { force: true });
    throw err;
  }
  return { stagedPath, size };
}

export interface BlobRecord {
  rid: string;
  filename: string;
  sizeBytes: number;
  mediaType: string;
  storageKey: string;
  createdBy: string;
}

async function persistUpload(input: {
  rid: string;
  table: "attachment" | "media_item";
  keyPrefix: string;
  filename: string;
  stagedPath: string;
  size: number;
  contentType: string;
  createdBy: string;
  ontologyId: string | null;
}): Promise<BlobRecord> {
  const key = `${input.keyPrefix}/${randomUUID()}_${sanitizeFilename(input.filename)}`;
  try {
    await uploadObject(
      key,
      fs.createReadStream(input.stagedPath),
      input.contentType,
      undefined,
      input.size,
    );
  } finally {
    fs.rmSync(input.stagedPath, { force: true });
  }
  await query(
    `INSERT INTO ${input.table}
       (rid, ontology_id, filename, size_bytes, media_type, storage_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.rid,
      input.ontologyId,
      input.filename,
      input.size,
      input.contentType,
      key,
      input.createdBy,
    ],
  );
  return {
    rid: input.rid,
    filename: input.filename,
    sizeBytes: input.size,
    mediaType: input.contentType,
    storageKey: key,
    createdBy: input.createdBy,
  };
}

/** Foundry AttachmentV2 response shape. */
export interface AttachmentV2 {
  rid: string;
  filename: string;
  sizeBytes: string;
  mediaType: string;
}

export async function uploadAttachment(input: {
  filename: string;
  stagedPath: string;
  size: number;
  createdBy: string;
  ontologyId: string | null;
  contentType?: string;
}): Promise<AttachmentV2> {
  const rid = `ri.attachments.main.attachment.${randomUUID()}`;
  const record = await persistUpload({
    rid,
    table: "attachment",
    keyPrefix: "attachments",
    filename: input.filename,
    stagedPath: input.stagedPath,
    size: input.size,
    contentType: input.contentType ?? mediaTypeForFilename(input.filename),
    createdBy: input.createdBy,
    ontologyId: input.ontologyId,
  });
  return {
    rid: record.rid,
    filename: record.filename,
    sizeBytes: String(record.sizeBytes),
    mediaType: record.mediaType,
  };
}

export interface MediaItemV2 {
  mediaItemRid: string;
  filename: string;
  sizeBytes: string;
  mediaType: string;
}

export async function uploadMediaItem(input: {
  filename: string;
  stagedPath: string;
  size: number;
  createdBy: string;
  ontologyId: string | null;
}): Promise<MediaItemV2> {
  const rid = `ri.mio.main.media-item.${randomUUID()}`;
  const record = await persistUpload({
    rid,
    table: "media_item",
    keyPrefix: "media",
    filename: input.filename,
    stagedPath: input.stagedPath,
    size: input.size,
    contentType: mediaTypeForFilename(input.filename),
    createdBy: input.createdBy,
    ontologyId: input.ontologyId,
  });
  return {
    mediaItemRid: record.rid,
    filename: record.filename,
    sizeBytes: String(record.sizeBytes),
    mediaType: record.mediaType,
  };
}

interface BlobRow {
  rid: string;
  filename: string;
  size_bytes: string;
  media_type: string;
  storage_key: string;
}

async function lookupBlob(
  table: "attachment" | "media_item",
  rid: string,
): Promise<BlobRow | null> {
  const { rows } = await query(
    `SELECT rid, filename, size_bytes, media_type, storage_key FROM ${table} WHERE rid = $1`,
    [rid],
  );
  return (rows[0] as BlobRow | undefined) ?? null;
}

export async function getAttachmentContent(
  rid: string,
): Promise<{ stream: Readable; row: BlobRow } | null> {
  const row = await lookupBlob("attachment", rid);
  if (!row) return null;
  return { stream: await getObjectStream(row.storage_key), row };
}
