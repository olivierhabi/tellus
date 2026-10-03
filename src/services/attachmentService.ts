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
import { uploadObject, getObjectStream, deleteObjects } from "./storageService";
import { buildSecurityFilter } from "../middleware/securityContext";
import type { SecurityContext } from "../middleware/securityContext";
import { incCounter } from "./funnel/metrics";

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

// ---------------------------------------------------------------------------
// Attachment visibility (Finding A — IDOR fix)
//
// Bytes are served only when (a) the caller uploaded the attachment
// (attachment.created_by === caller userId), or (b) the attachment is linked
// to an object the caller can READ through the security-filtered fetch
// (executeGetObject with buildSecurityFilter — the same pattern
// commentService.requireReadableParent uses).
//
// Linkage: an attachment becomes linked when its rid is passed as an
// attachment-type action parameter and lands on an object instance
// (object_instances.properties). There is no separate link table; the
// `linked_at` column exists for a future sweeper but is not stamped today,
// so linkage is resolved by finding object instances whose properties
// reference the rid. Unlinked attachments are uploader-only.
//
// Denials are indistinguishable from "not found" — callers return the same
// 404 envelope either way (no existence oracle).
// ---------------------------------------------------------------------------

/**
 * Batch-resolves which of the given attachment rids the principal may
 * access. Rule per rid: uploader (created_by === security.userId) always;
 * otherwise the caller must be able to READ at least one object the
 * attachment is linked to (via executeGetObject with the caller's security
 * filter — the same pattern commentService.requireReadableParent uses).
 * Unknown rids and unlinked attachments are uploader-only. Readable-object
 * results are cached per call so a batch shares lookups.
 */
export async function resolveAccessibleAttachmentRids(
  rids: string[],
  security: SecurityContext,
): Promise<Set<string>> {
  const visible = new Set<string>();
  const unique = [...new Set(rids.filter((r) => typeof r === "string" && r.length > 0))];
  if (unique.length === 0) return visible;

  const { rows } = await query(
    `SELECT rid, created_by FROM attachment WHERE rid = ANY($1)`,
    [unique],
  );
  const createdBy = new Map<string, string>(
    rows.map((r: { rid: string; created_by: string }) => [r.rid, r.created_by]),
  );

  const securityFilter = buildSecurityFilter(security);
  const readabilityCache = new Map<string, Promise<boolean>>();
  const canReadObject = (objectType: string, pk: string): Promise<boolean> => {
    const key = `${objectType}|${pk}`;
    let p = readabilityCache.get(key);
    if (!p) {
      p = import("./queryExecutor")
        .then((m) => m.executeGetObject(objectType, pk, securityFilter, null))
        .then((obj) => obj !== null)
        .catch(() => false); // fail-closed: lookup errors deny, never leak
      readabilityCache.set(key, p);
    }
    return p;
  };

  for (const rid of unique) {
    const createdByForRid = createdBy.get(rid);
    if (createdByForRid === undefined) continue; // unknown attachment: fail-closed
    if (createdByForRid === security.userId) {
      visible.add(rid);
      continue;
    }
    // Linked via an action: the rid was stored as a property value on an
    // object instance. `linked_at` is not stamped today, so resolve the
    // link target(s) from object_instances.properties.
    const linked = await query(
      `SELECT DISTINCT object_type_api_name AS ot, primary_key AS pk
         FROM object_instances
        WHERE properties::text LIKE '%' || $1 || '%'
        LIMIT 25`,
      [rid],
    );
    for (const cand of linked.rows as Array<{ ot: string; pk: string }>) {
      if (await canReadObject(cand.ot, cand.pk)) {
        visible.add(rid);
        break;
      }
    }
  }
  return visible;
}

export async function getAttachmentContent(
  rid: string,
  security: SecurityContext,
): Promise<{ stream: Readable; row: BlobRow } | null> {
  // IDOR guard (Finding A): serve bytes only to the uploader or to a caller
  // who can READ an object the attachment is linked to. Denials return null
  // so the route emits the same 404 envelope as a nonexistent attachment —
  // no existence oracle.
  const allowed = await resolveAccessibleAttachmentRids([rid], security);
  if (!allowed.has(rid)) return null;
  const row = await lookupBlob("attachment", rid);
  if (!row) return null;
  return { stream: await getObjectStream(row.storage_key), row };
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

// ---------------------------------------------------------------------------
// Attachment lifecycle (Foundry upload-attachments parity):
//   https://www.palantir.com/docs/foundry/action-types/upload-attachments
//
//   - An upload is TEMPORARY until linked to an object via an action.
//     Linking stamps `linked_at` (post-commit, best-effort — see
//     stampAttachmentsLinked, called from the action apply path).
//   - An upload never linked within ATTACHMENT_LINK_WINDOW_HOURS is swept
//     (bytes + row removed) by sweepUnlinkedAttachments.
//   - An attachment may be linked to at most ATTACHMENT_MAX_LINKED_OBJECTS
//     objects in its lifetime (verifyAttachmentReferences enforces this at
//     apply time; re-upload as a new attachment to link further).
// ---------------------------------------------------------------------------

/** `ri.attachments.main.attachment.<uuid>` — the only RID shape actions may link. */
export const ATTACHMENT_RID_PATTERN =
  /^ri\.attachments\.main\.attachment\.[0-9a-fA-F-]{36}$/;

export const ATTACHMENT_MAX_LINKED_OBJECTS = 10;
export const ATTACHMENT_LINK_WINDOW_HOURS = 1;

/** Deep-scan any value (scalars, arrays, objects) for attachment RIDs. */
export function extractAttachmentRids(
  value: unknown,
  into: Set<string> = new Set<string>(),
): Set<string> {
  if (typeof value === "string") {
    if (ATTACHMENT_RID_PATTERN.test(value)) into.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) extractAttachmentRids(v, into);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      extractAttachmentRids(v, into);
    }
  }
  return into;
}

/** Collect attachment RIDs referenced by compiled edits' property values. */
export function collectAttachmentRidsFromEdits(
  edits: Array<{ propertyValues?: Record<string, unknown> | null }>,
): string[] {
  const rids = new Set<string>();
  for (const edit of edits) {
    if (edit.propertyValues) extractAttachmentRids(edit.propertyValues, rids);
  }
  return [...rids];
}

export interface AttachmentReferenceCheck {
  missing: string[];
  overLinked: Array<{ rid: string; linkedObjects: number }>;
}

/**
 * Fail-fast verification for attachment RIDs an action is about to link:
 * every RID must exist, and none may already serve
 * ATTACHMENT_MAX_LINKED_OBJECTS objects. Linkage is resolved the same way
 * content visibility resolves it — RIDs stored on object instances
 * (object_instances.properties), since there is no separate link table.
 */
export async function verifyAttachmentReferences(
  rids: string[],
): Promise<AttachmentReferenceCheck> {
  const unique = [...new Set(rids.filter((r) => typeof r === "string" && r.length > 0))];
  if (unique.length === 0) return { missing: [], overLinked: [] };
  const { rows } = await query(
    `SELECT a.rid AS rid,
            COUNT(DISTINCT oi.object_type_api_name || '|' || oi.primary_key)::int AS links
       FROM attachment a
       LEFT JOIN object_instances oi
         ON oi.properties::text LIKE '%' || a.rid || '%'
      WHERE a.rid = ANY($1)
      GROUP BY a.rid`,
    [unique],
  );
  const seen = new Map<string, number>(
    (rows as Array<{ rid: string; links: number }>).map((r) => [r.rid, Number(r.links)]),
  );
  const missing = unique.filter((r) => !seen.has(r));
  const overLinked = unique
    .filter((r) => (seen.get(r) ?? 0) >= ATTACHMENT_MAX_LINKED_OBJECTS)
    .map((r) => ({ rid: r, linkedObjects: seen.get(r) ?? 0 }));
  return { missing, overLinked };
}

/**
 * Stamp `linked_at` (+ ontology when known) for attachments an action just
 * linked. Post-commit, best-effort: callers must never fail an apply on a
 * stamp error — log + metric instead.
 */
export async function stampAttachmentsLinked(
  rids: string[],
  ontologyId: string | null,
): Promise<number> {
  const unique = [...new Set(rids.filter((r) => typeof r === "string" && r.length > 0))];
  if (unique.length === 0) return 0;
  const ontologyUuid =
    ontologyId && /^[0-9a-fA-F-]{36}$/.test(ontologyId) ? ontologyId : null;
  const result = await query(
    `UPDATE attachment
        SET linked_at = COALESCE(linked_at, now()),
            ontology_id = COALESCE(ontology_id, $2::uuid)
      WHERE rid = ANY($1)`,
    [unique, ontologyUuid],
  );
  const stamped = result.rowCount ?? 0;
  incCounter("tellus_attachments_linked_total", {}, stamped);
  return stamped;
}

export interface AttachmentSweepResult {
  scanned: number;
  swept: number;
  blobsDeleted: number;
  dryRun: boolean;
  durationMs: number;
}

export interface AttachmentSweepOptions {
  /** Hours an upload may stay unlinked before removal. Default 1 (Foundry). */
  olderThanHours?: number;
  /** Max candidates removed per run. Default 200. */
  maxPerRun?: number;
  /** Log + metric only, delete nothing. Env ATTACHMENT_SWEEP_DRY_RUN also enables. */
  dryRun?: boolean;
}

/**
 * Remove uploads that were never linked to an object within the link
 * window. A candidate is swept only when NO object instance references its
 * RID — seeded/demo attachments referenced from synced instances are
 * therefore never touched. Blob deletion precedes row deletion; both are
 * idempotent so a crashed run simply retries.
 */
export async function sweepUnlinkedAttachments(
  options: AttachmentSweepOptions = {},
): Promise<AttachmentSweepResult> {
  const started = Date.now();
  const olderThanHours = options.olderThanHours ?? ATTACHMENT_LINK_WINDOW_HOURS;
  const maxPerRun = options.maxPerRun ?? 200;
  const dryRun =
    options.dryRun ?? process.env.ATTACHMENT_SWEEP_DRY_RUN === "true";
  const candidates = (
    await query(
      `SELECT rid, storage_key FROM attachment
        WHERE linked_at IS NULL
          AND created_at < now() - make_interval(hours => $1)
        ORDER BY created_at ASC
        LIMIT $2`,
      [olderThanHours, maxPerRun],
    )
  ).rows as Array<{ rid: string; storage_key: string }>;
  if (candidates.length === 0) {
    return { scanned: 0, swept: 0, blobsDeleted: 0, dryRun, durationMs: Date.now() - started };
  }
  const rids = candidates.map((c) => c.rid);
  const referenced = new Set(
    (
      await query(
        `SELECT DISTINCT a.rid AS rid
           FROM attachment a
           JOIN object_instances oi
             ON oi.properties::text LIKE '%' || a.rid || '%'
          WHERE a.rid = ANY($1)`,
        [rids],
      )
    ).rows.map((r: { rid: string }) => r.rid),
  );
  const sweepable = candidates.filter((c) => !referenced.has(c.rid));
  incCounter(
    "tellus_attachments_sweep_candidates_total",
    { dry_run: String(dryRun) },
    sweepable.length,
  );
  if (dryRun || sweepable.length === 0) {
    return {
      scanned: candidates.length,
      swept: 0,
      blobsDeleted: 0,
      dryRun,
      durationMs: Date.now() - started,
    };
  }
  const blobs = await deleteObjects(sweepable.map((c) => c.storage_key));
  const removed = await query(`DELETE FROM attachment WHERE rid = ANY($1)`, [
    sweepable.map((c) => c.rid),
  ]);
  const swept = removed.rowCount ?? 0;
  incCounter("tellus_attachments_swept_total", {}, swept);
  console.log(
    `[attachments/sweeper] swept ${swept} unlinked upload(s) (${blobs.deleted} blob(s) deleted, ${blobs.errors} blob error(s))`,
  );
  return {
    scanned: candidates.length,
    swept,
    blobsDeleted: blobs.deleted,
    dryRun,
    durationMs: Date.now() - started,
  };
}

let sweeperTimer: NodeJS.Timeout | null = null;
let sweeperRunning = false;

export interface AttachmentSweeperOptions extends AttachmentSweepOptions {
  intervalMs?: number;
}

/** Hourly background loop. Safe to call multiple times; never drops work. */
export function startAttachmentSweeper(options: AttachmentSweeperOptions = {}): void {
  if (sweeperTimer) return;
  const { intervalMs, ...sweepOptions } = options;
  sweeperTimer = setInterval(async () => {
    if (sweeperRunning) return;
    sweeperRunning = true;
    try {
      const result = await sweepUnlinkedAttachments(sweepOptions);
      if (result.swept > 0 || result.scanned > 0) {
        console.debug(JSON.stringify({ type: "attachment_sweep", ...result }));
      }
    } catch (err) {
      console.warn(`[attachments/sweeper] tick failed: ${(err as Error).message}`);
    } finally {
      sweeperRunning = false;
    }
  }, intervalMs ?? 3_600_000);
  sweeperTimer.unref?.();
}

export function stopAttachmentSweeper(): void {
  if (sweeperTimer) {
    clearInterval(sweeperTimer);
    sweeperTimer = null;
  }
}

