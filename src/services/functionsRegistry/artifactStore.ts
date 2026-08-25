// ---------------------------------------------------------------------------
// Function-publish artifact blob storage (Track 2 item #8).
//
// Replaces `artifact_blob_id = "inline:<prefix>"` + full source text
// embedded in `manifest_json` with real immutable, content-addressed
// objects in the established object-storage abstraction
// (storageService → S3/MinIO) — the same store and conventions as
// the Developer Console artifact registry (migration 115):
// digest-keyed objects, head-before-upload dedup, metadata digest
// verification, digest check on read.
//
// ARTIFACT FORMAT v1
//   key:     functions-publish/artifacts/v1/<sha256-of-bundle>.json.gz
//   bytes:   gzip(JSON bundle)  — the bundle is the deterministic
//            canonical JSON produced by the build stage
//            ({exports, sources, signatures}).
//   blobId:  "s3:<key>" stored in function_version.artifact_blob_id.
//
// The artifact identity is the SHA-256 of the UNCOMPRESSED bundle
// (function_version.artifact_sha256) — unchanged from the inline
// era, so digest semantics do not drift across the migration.
// gzip is transport encoding only.
//
// READ COMPATIBILITY: historical rows keep "inline:<prefix>" blob
// ids and manifest_json.sources — resolveFunctionSources() serves
// those from the manifest forever; historical rows are never
// rewritten. New rows carry "s3:" blob ids and NO sources in the
// manifest.
//
// ORPHANS: a blob uploaded before a rolled-back publish is
// immutable, dedup-safe, and unreferenced.
// sweepOrphanedFunctionArtifacts() removes unreferenced objects
// older than a grace window; it NEVER deletes a blob whose digest
// is referenced by any function_version row.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Pool } from "pg";

import {
  deleteObject,
  ensureBucket,
  getObjectBuffer,
  headObject,
  listObjects,
  uploadObject,
} from "../storageService";

/** Named bounds (uncompressed bundle, stored bytes, source shape). */
export const FUNCTION_ARTIFACT_MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
export const FUNCTION_ARTIFACT_MAX_STORED_BYTES = 4 * 1024 * 1024;
export const FUNCTION_ARTIFACT_MAX_SOURCE_FILES = 512;
export const FUNCTION_ARTIFACT_MAX_SOURCE_BYTES = 1024 * 1024;

export const FUNCTION_ARTIFACT_KEY_PREFIX = "functions-publish/artifacts/v1/";
export const FUNCTION_ARTIFACT_BLOB_PREFIX = "s3:";
export const LEGACY_INLINE_BLOB_PREFIX = "inline:";

export class FunctionArtifactError extends Error {
  constructor(
    readonly code:
      | "ARTIFACT_TOO_LARGE"
      | "ARTIFACT_IMMUTABILITY_VIOLATION"
      | "ARTIFACT_NOT_FOUND"
      | "ARTIFACT_INTEGRITY"
      | "ARTIFACT_UNREADABLE_FORMAT"
      | "ARTIFACT_STORE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "FunctionArtifactError";
  }
}

export interface ArtifactPutResult {
  readonly blobId: string;
  readonly storedBytes: number;
  /** True when the object already existed (same digest re-upload). */
  readonly deduplicated: boolean;
}

export interface FunctionArtifactStore {
  put(args: { digest: string; bundle: string }): Promise<ArtifactPutResult>;
  /** Fetch + verify + decompress a bundle by blob id. */
  getBundle(blobId: string): Promise<string>;
}

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function artifactKeyForDigest(digest: string): string {
  return `${FUNCTION_ARTIFACT_KEY_PREFIX}${digest}.json.gz`;
}

const BLOB_ID_RE = /^s3:(functions-publish\/artifacts\/v1\/([0-9a-f]{64})\.json\.gz)$/;

/** Parse a blob id into its object key + embedded digest. */
export function parseArtifactBlobId(
  blobId: string,
): { key: string; digest: string } | null {
  const match = BLOB_ID_RE.exec(blobId);
  if (!match) return null;
  return { key: match[1], digest: match[2] };
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? "";
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}

/**
 * The production store: S3/MinIO via storageService. The bucket is
 * ensured lazily, once per process (ensureBucket is idempotent).
 */
export function createS3FunctionArtifactStore(): FunctionArtifactStore {
  let bucketReady: Promise<void> | null = null;
  const ready = () => (bucketReady ??= ensureBucket());

  return {
    async put({ digest, bundle }): Promise<ArtifactPutResult> {
      const uncompressedBytes = Buffer.byteLength(bundle);
      if (uncompressedBytes > FUNCTION_ARTIFACT_MAX_UNCOMPRESSED_BYTES) {
        throw new FunctionArtifactError(
          "ARTIFACT_TOO_LARGE",
          `artifact bundle is ${uncompressedBytes} bytes, above the ${FUNCTION_ARTIFACT_MAX_UNCOMPRESSED_BYTES}-byte limit`,
        );
      }
      const stored = gzipSync(Buffer.from(bundle, "utf8"), { level: 9 });
      if (stored.byteLength > FUNCTION_ARTIFACT_MAX_STORED_BYTES) {
        throw new FunctionArtifactError(
          "ARTIFACT_TOO_LARGE",
          `compressed artifact is ${stored.byteLength} bytes, above the ${FUNCTION_ARTIFACT_MAX_STORED_BYTES}-byte limit`,
        );
      }
      const key = artifactKeyForDigest(digest);
      await ready();
      // Head-before-upload: duplicate publication of identical
      // content is a safe no-op (content-addressed dedup).
      try {
        const head = await headObject(key);
        if (head.metadata?.sha256 !== digest) {
          // The storage API does not itself guarantee content
          // addressing — verify the collision explicitly.
          throw new FunctionArtifactError(
            "ARTIFACT_IMMUTABILITY_VIOLATION",
            "existing artifact object failed immutable digest verification",
          );
        }
        return { blobId: `${FUNCTION_ARTIFACT_BLOB_PREFIX}${key}`, storedBytes: head.contentLength, deduplicated: true };
      } catch (error) {
        if (error instanceof FunctionArtifactError) throw error;
        if (!isNotFound(error)) {
          throw new FunctionArtifactError(
            "ARTIFACT_STORE_UNAVAILABLE",
            `artifact store head failed: ${(error as Error).message.slice(0, 200)}`,
          );
        }
      }
      try {
        await uploadObject(key, stored, "application/gzip", {
          sha256: digest,
          format: "functions-publish-bundle/v1",
        });
      } catch (error) {
        throw new FunctionArtifactError(
          "ARTIFACT_STORE_UNAVAILABLE",
          `artifact store upload failed: ${(error as Error).message.slice(0, 200)}`,
        );
      }
      return { blobId: `${FUNCTION_ARTIFACT_BLOB_PREFIX}${key}`, storedBytes: stored.byteLength, deduplicated: false };
    },

    async getBundle(blobId): Promise<string> {
      const parsed = parseArtifactBlobId(blobId);
      if (!parsed) {
        throw new FunctionArtifactError(
          "ARTIFACT_UNREADABLE_FORMAT",
          "artifact blob id is not a functions-publish v1 object reference",
        );
      }
      let bytes: Buffer;
      try {
        bytes = await getObjectBuffer(parsed.key);
      } catch (error) {
        if (isNotFound(error)) {
          throw new FunctionArtifactError(
            "ARTIFACT_NOT_FOUND",
            "the published artifact is missing from object storage; the version metadata exists but its bundle is gone",
          );
        }
        throw new FunctionArtifactError(
          "ARTIFACT_STORE_UNAVAILABLE",
          `artifact store read failed: ${(error as Error).message.slice(0, 200)}`,
        );
      }
      let bundle: string;
      try {
        bundle = gunzipSync(bytes).toString("utf8");
      } catch {
        throw new FunctionArtifactError(
          "ARTIFACT_INTEGRITY",
          "the stored artifact is not a valid gzip payload",
        );
      }
      if (sha256Hex(bundle) !== parsed.digest) {
        throw new FunctionArtifactError(
          "ARTIFACT_INTEGRITY",
          "artifact digest verification failed: stored content does not match its content-addressed identity",
        );
      }
      return bundle;
    },
  };
}

// ---------------------------------------------------------------------------
// Read path shared by execution-time consumers (functionActionExecutor,
// actionTypes route). Backward compatible:
//   1. manifest_json.sources present → historical inline row.
//   2. artifact_blob_id "s3:..." → real blob fetch.
// Anything else is an unreadable row (actionable null).
// ---------------------------------------------------------------------------

export interface VersionArtifactRow {
  readonly artifact_blob_id?: string | null;
  readonly manifest_json?: { sources?: Record<string, unknown> } | null;
}

let defaultStore: FunctionArtifactStore | null = null;
function storeOrDefault(store?: FunctionArtifactStore): FunctionArtifactStore {
  if (store) return store;
  defaultStore ??= createS3FunctionArtifactStore();
  return defaultStore;
}

/**
 * Resolve the published source map for a registry version row.
 * Returns null when the row predates source persistence entirely.
 * Throws FunctionArtifactError on missing/corrupt blobs.
 */
export async function resolveFunctionSources(
  row: VersionArtifactRow,
  store?: FunctionArtifactStore,
): Promise<Record<string, string> | null> {
  const inline = row.manifest_json?.sources;
  if (inline && typeof inline === "object") {
    const sources: Record<string, string> = {};
    for (const [apiName, source] of Object.entries(inline)) {
      if (typeof source === "string") sources[apiName] = source;
    }
    if (Object.keys(sources).length > 0) return sources;
  }
  const blobId = row.artifact_blob_id;
  if (typeof blobId === "string" && blobId.startsWith(FUNCTION_ARTIFACT_BLOB_PREFIX)) {
    const bundle = await storeOrDefault(store).getBundle(blobId);
    const parsed = JSON.parse(bundle) as { sources?: Record<string, unknown> };
    const sources: Record<string, string> = {};
    for (const [apiName, source] of Object.entries(parsed.sources ?? {})) {
      if (typeof source === "string") sources[apiName] = source;
    }
    return sources;
  }
  return null;
}

/** Single-function convenience over resolveFunctionSources. */
export async function resolveFunctionSource(
  row: VersionArtifactRow,
  apiName: string,
  store?: FunctionArtifactStore,
): Promise<string | null> {
  const sources = await resolveFunctionSources(row, store);
  const source = sources?.[apiName];
  return typeof source === "string" && source.length > 0 ? source : null;
}

// ---------------------------------------------------------------------------
// Orphan garbage collection. A blob is orphan when no function_version
// row references its digest. Objects younger than `olderThanMs` are
// never touched (an in-flight publish may be about to reference them).
// Bounded: at most `limit` candidates examined per invocation.
// ---------------------------------------------------------------------------

export interface ArtifactSweepResult {
  readonly scanned: number;
  readonly deleted: number;
  readonly referenced: number;
  readonly tooRecent: number;
}

export async function sweepOrphanedFunctionArtifacts(
  pool: Pool,
  opts: { olderThanMs?: number; limit?: number } = {},
): Promise<ArtifactSweepResult> {
  const olderThanMs = opts.olderThanMs ?? 24 * 60 * 60 * 1000;
  const limit = Math.max(1, Math.min(1_000, opts.limit ?? 200));
  // Content-addressing bounds the keyspace to one object per unique
  // bundle; each invocation examines a bounded slice. Listing order
  // is lexicographic over digests, so repeated sweeps rotate
  // coverage as deletions shrink the set.
  const keys = (await listObjects(FUNCTION_ARTIFACT_KEY_PREFIX)).slice(0, limit);
  if (keys.length === 0) return { scanned: 0, deleted: 0, referenced: 0, tooRecent: 0 };

  const digests = keys
    .map((key) => /([0-9a-f]{64})\.json\.gz$/.exec(key)?.[1])
    .filter((digest): digest is string => typeof digest === "string");
  const referenced = new Set(
    digests.length === 0
      ? []
      : (
          await pool.query<{ artifact_sha256: string }>(
            `SELECT artifact_sha256 FROM function_version
              WHERE artifact_sha256 = ANY($1::text[])`,
            [digests],
          )
        ).rows.map((row) => row.artifact_sha256),
  );

  let deleted = 0;
  let referencedCount = 0;
  let tooRecent = 0;
  const cutoff = Date.now() - olderThanMs;
  for (const key of keys) {
    const digest = /([0-9a-f]{64})\.json\.gz$/.exec(key)?.[1];
    if (digest && referenced.has(digest)) {
      referencedCount += 1;
      continue;
    }
    let lastModified: Date | undefined;
    try {
      lastModified = (await headObject(key)).lastModified;
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    if (lastModified && lastModified.getTime() > cutoff) {
      tooRecent += 1;
      continue;
    }
    await deleteObject(key);
    deleted += 1;
  }
  return { scanned: keys.length, deleted, referenced: referencedCount, tooRecent };
}
