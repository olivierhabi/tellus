// ---------------------------------------------------------------------------
// src/services/funnel/mergeProgress.ts
//
// Server-side checkpoint for the merge stage's PG upsert/delete tail, keyed by
// the Temporal activity's driving `runKey` (the signal id threaded from
// runMergeActivity → mergeChangesFromSnapshots → mergeChangesSQL).
//
// WHY: the DuckDB SQL k-way merge streams `merged_result` (flat memory) into a
// single Postgres BEGIN/COMMIT (one transaction — matches the pure-TS path's
// atomicity). The parquet write + commitSnapshot are idempotent-ish (snapshot id
// pre-generated; an interrupted retry leaves a GC-able orphan per the
// funnelParquetStore CONTRACT). The ONLY expensive, non-idempotent-by-skip part
// is the PG upsert/delete tail (4.65M rows for OO7). A checkpoint lets a retry
// that crashed AFTER the PG COMMIT but before the activity returned SKIP the
// re-upsert — the committed rows are already in object_instances.
//
// SAFETY MODEL (one transaction): the checkpoint stores `{committed, lastPk}`.
//   • committed=false is written before the PG streaming starts; lastPk is
//     updated periodically DURING the transaction (advisory — the transaction
//     has NOT committed yet).
//   • committed=true is written ONLY after `COMMIT` succeeds.
// On resume:
//   • committed=true  → the PG tail is durable; SKIP the streaming+transaction
//     (still redo merge+upload+commitSnapshot+markEdits — those are idempotent).
//   • committed=false → a prior attempt crashed mid-transaction; the transaction
//     rolled back, so redo the PG tail from scratch. Upserts are idempotent
//     (ON CONFLICT DO UPDATE) and deletes are idempotent (WHERE pk = ANY), so a
//     full redo is correct. The `lastPk` here is advisory progress only.
//
// This means true "resume from batch 600" mid-stream is NOT safe with one atomic
// transaction (a mid-stream checkpoint + rollback would skip uncommitted rows →
// data loss). The design's batch-level resume would require per-batch
// transactions; we keep ONE transaction (matching current atomicity) and accept
// full-redo on mid-transaction crashes. The valuable case — crash after COMMIT,
// skip the 4.65M re-upsert — IS achieved.
//
// FAILURE MODE — fail open, not closed (mirrors uploadProgress.ts): if Redis is
// unreachable, record/read silently no-op and the merge proceeds WITHOUT resume
// (a retry redoes the PG tail — correct, just slower). Redis can never block or
// fail the merge.
//
// 2026-08-16 — that promise used to be FALSE. This module's own
// `reconnectStrategy` returned a number, which in node-redis v4 means "retry
// forever", so `client.connect()` never settled while Redis was down and the
// pending promise was cached for the process lifetime. `readMergeProgress()` at
// the top of the merge PG tail therefore hung the merge activity indefinitely —
// ObjectStorage V2 indexing stuck on "Merge changes" for three days. The
// bounded-connect contract now lives in lib/redisConnect.ts; see that file for
// why a `connectTimeout` alone cannot bound this. The fail-open promise above is
// now actually enforced: getRedis() cannot block for longer than the connect
// deadline (default 3s), and once it has failed it stays failed for the process.
// ---------------------------------------------------------------------------

import { connectRedisBounded, describeRedisError } from "../../lib/redisConnect";

type RedisLike = {
  get(k: string): Promise<string | null>;
  set(k: string, v: string, o?: { EX?: number }): Promise<unknown>;
  del(k: string): Promise<unknown>;
};

export interface MergeCheckpoint {
  /** True only after the PG upsert/delete transaction COMMITTED. */
  committed: boolean;
  /** Last primary_key streamed (advisory progress when committed=false;
   *  the resume-skip sentinel when committed=true). */
  lastPk: string | null;
  /** Count of rows streamed so far (observability). */
  rowsProcessed: number;
  /** Upsert count (restored on a skipPgTail retry so the committed snapshot's
   *  summary carries accurate counts without re-streaming). */
  upserts?: number;
  /** Delete count (restored on a skipPgTail retry). */
  deletes?: number;
}

let redisInstance: RedisLike | null | undefined;
let redisConnecting: Promise<RedisLike | null> | null = null;

async function connectRedis(): Promise<RedisLike | null> {
  try {
    const client = await connectRedisBounded<RedisLike>({
      logPrefix: "[merge-progress]",
    });
    redisInstance = client;
    return client;
  } catch (err) {
    // Fail open and STAY failed: caching `null` means the merge never pays the
    // connect deadline again for the life of the process. A restart re-tries.
    console.warn(
      `[merge-progress] checkpoint unavailable (${describeRedisError(err)}) — merge continues without resume`,
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

// TTL ≥ the longest expected merge PG tail (OO7 4.65M upserts ≈ minutes) +
// Temporal retry backoff. Default 1h so the key outlives the activity and
// self-cleans abandoned entries.
const TTL_SECONDS = Number(process.env.MERGE_PROGRESS_TTL_SECONDS ?? 3600);
const keyFor = (runKey: string) => `merge:progress:${runKey}`;

/**
 * Record the merge checkpoint for `runKey`. Fail-open: a Redis failure is
 * swallowed (the merge continues; a retry simply redoes the PG tail).
 */
export async function recordMergeProgress(
  runKey: string,
  payload: MergeCheckpoint,
): Promise<void> {
  if (!runKey) return;
  try {
    const redis = await getRedis();
    if (!redis) return;
    await redis.set(keyFor(runKey), JSON.stringify(payload), {
      EX: TTL_SECONDS,
    });
  } catch {
    /* fail open — checkpoint is advisory */
  }
}

/**
 * Read the merge checkpoint for `runKey`, or null if absent/expired/Redis-down.
 */
export async function readMergeProgress(
  runKey: string,
): Promise<MergeCheckpoint | null> {
  if (!runKey) return null;
  try {
    const redis = await getRedis();
    if (!redis) return null;
    const raw = await redis.get(keyFor(runKey));
    if (!raw) return null;
    return JSON.parse(raw) as MergeCheckpoint;
  } catch {
    return null;
  }
}

/**
 * Best-effort cleanup (called after a successful merge so a re-run of the same
 * runKey starts fresh). The TTL is the real cleanup; this is opportunistic.
 */
export async function clearMergeProgress(runKey: string): Promise<void> {
  if (!runKey) return;
  try {
    const redis = await getRedis();
    if (!redis) return;
    await redis.del(keyFor(runKey));
  } catch {
    /* fail open */
  }
}
