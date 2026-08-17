// ---------------------------------------------------------------------------
// src/services/uploadProgress.ts
//
// Server-side store for in-flight upload progress, polled by the frontend
// while a multipart POST .../upload is in flight (see UploadFilesDialog).
//
// Why this exists: axios `onUploadProgress` only reports bytes received by
// the server. The server still has to stream the staged file to S3 — the
// longest phase on a fast client link — and that work is invisible to the
// client without a channel. `@aws-sdk/lib-storage`'s `Upload` emits
// `httpUploadProgress`; foundryUploadService feeds it here, and a poll route
// reads it back. So the bar reflects true end-to-end progress: network
// (client→server) via onUploadProgress, then storage (server→S3) via polling.
//
// Backing store: Redis (multi-replica-safe — any API instance can answer a
// poll, not just the one handling the POST). Uses the same lazy,
// self-contained getRedis() pattern as services/bffSessionService.ts and
// linkPagination.ts (own connection, no coupling to the boot-created client).
//
// Failure mode — fail open, not closed. Progress is advisory; the upload
// itself is unaffected. If Redis is unreachable, record/read silently no-op
// and the bar simply won't advance past the network phase — never a 5xx.
// ---------------------------------------------------------------------------

import { connectRedisBounded, describeRedisError } from '../lib/redisConnect';

type RedisLike = {
  get(k: string): Promise<string | null>;
  set(k: string, v: string, o?: { EX?: number }): Promise<unknown>;
  del(k: string): Promise<unknown>;
};

export interface UploadProgressPayload {
  /** Always 's3' for now (the only server-side phase reported through here). */
  phase?: 's3';
  /** Bytes streamed to S3 so far (aggregate across files in the request). */
  loaded?: number;
  /** Total bytes to stream (sum of staged file sizes; 0 if unknown). */
  total?: number;
  /** 0-based index of the file currently streaming (multi-file requests). */
  fileIndex?: number;
  /** Original filename of the file currently streaming. */
  fileName?: string;
  /** Terminal marker; presence means the request finished (success/error). */
  status?: 'done' | 'error';
  /** Optional error message when status === 'error'. */
  message?: string;
}

let redisInstance: RedisLike | null | undefined;
// Guards the connect against the thundering herd: lib-storage emits
// httpUploadProgress many times per second during a multipart upload, and
// without this each event would spawn its own createClient+connect() (the
// cache isn't set until the first connect resolves) — a socket storm that can
// stall. Concurrent callers share the single in-flight connect.
let redisConnecting: Promise<RedisLike | null> | null = null;

// Bounded connect lives in lib/redisConnect.ts. This module previously used a
// retry-forever reconnectStrategy, so `connect()` never settled while Redis was
// down — and because the pending promise is cached in `redisConnecting` below,
// every httpUploadProgress event blocked on it. See lib/redisConnect.ts.
async function connectRedis(): Promise<RedisLike | null> {
  try {
    const client = await connectRedisBounded<RedisLike>({
      logPrefix: '[upload-progress]',
    });
    redisInstance = client;
    return client;
  } catch (err) {
    // Fail open and stay failed — the upload proceeds, only the progress bar
    // is unavailable. Caching `null` avoids re-paying the deadline per event.
    console.warn(
      `[upload-progress] progress unavailable (${describeRedisError(err)}) — upload continues`,
    );
    redisInstance = null;
    return null;
  }
}

async function getRedis(): Promise<RedisLike | null> {
  if (redisInstance !== undefined) return redisInstance;
  if (redisConnecting) return redisConnecting;
  redisConnecting = connectRedis().finally(() => {
    redisConnecting = null;
  });
  return redisConnecting;
}

// TTL ≥ UPLOAD_REQUEST_TIMEOUT_MS (default 10 min) so the key outlives the
// upload, then self-cleans so abandoned entries don't accumulate.
const TTL_SECONDS = Number(process.env.UPLOAD_PROGRESS_TTL_SECONDS ?? 600);
const keyFor = (uploadId: string) => `upload:progress:${uploadId}`;

/**
 * Record the latest progress for an in-flight upload. Fail-open: a Redis
 * failure is swallowed (the upload continues; the bar just won't update).
 */
export async function recordProgress(
  uploadId: string,
  payload: UploadProgressPayload,
): Promise<void> {
  if (!uploadId) return;
  try {
    const redis = await getRedis();
    if (!redis) return;
    await redis.set(keyFor(uploadId), JSON.stringify(payload), {
      EX: TTL_SECONDS,
    });
  } catch {
    /* fail open — progress is advisory */
  }
}

/**
 * Read the latest progress for an upload, or null if absent/expired/Redis-down.
 */
export async function readProgress(
  uploadId: string,
): Promise<UploadProgressPayload | null> {
  if (!uploadId) return null;
  try {
    const redis = await getRedis();
    if (!redis) return null;
    const raw = await redis.get(keyFor(uploadId));
    if (!raw) return null;
    return JSON.parse(raw) as UploadProgressPayload;
  } catch {
    return null;
  }
}

/**
 * Best-effort cleanup (called on terminal states is optional — the TTL is the
 * real cleanup). Exposed for symmetry/tests.
 */
export async function clearProgress(uploadId: string): Promise<void> {
  if (!uploadId) return;
  try {
    const redis = await getRedis();
    if (!redis) return;
    await redis.del(keyFor(uploadId));
  } catch {
    /* fail open */
  }
}
