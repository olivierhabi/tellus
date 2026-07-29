// ---------------------------------------------------------------------------
// jemma_run_log retention + bounded growth (Track 2 item #9).
//
// A real, executing mechanism — not a plan. The functions-publish
// worker process runs a maintenance tick (same scheduling pattern
// as its 1s claim pump: an unref'd setInterval) that:
//
//   1. Takes a Postgres advisory lock, so N API replicas serialize
//      — exactly one instance cleans at a time; the rest skip.
//   2. Deletes logs of TERMINAL runs older than the retention
//      period in bounded batches (WAL-friendly, no long locks).
//   3. Sweeps orphaned artifact blobs older than a grace window.
//
// NEVER deletes logs of QUEUED or RUNNING runs — the run-state
// filter is in the DELETE's own WHERE, not just the driver CTE.
//
// Configuration (established env-with-default convention):
//   FUNCTIONS_PUBLISH_LOG_RETENTION_DAYS        30 (0 disables)
//   FUNCTIONS_PUBLISH_LOG_CLEANUP_BATCH_SIZE    10000 log rows
//   FUNCTIONS_PUBLISH_LOG_CLEANUP_MAX_BATCHES   10 per tick
//   FUNCTIONS_PUBLISH_MAINTENANCE_INTERVAL_MS   3600000
//   FUNCTIONS_PUBLISH_ARTIFACT_SWEEP            "1" ("0" disables)
//
// PARTITIONING DECISION: current volume (one row per log line of
// functions-publish runs, ~10²–10⁴ rows/run) does not justify
// declarative partitioning, and this repo's migration runner has
// no online-rebuild convention (a partition swap would require a
// table rewrite + lock). Trigger threshold to revisit: sustained
// jemma_run_log growth past 50M rows OR cleanup batches
// consistently hitting maxBatches. Future strategy: create
// jemma_run_log_partitioned (RANGE on created_at, monthly),
// backfill in COPY batches behind an advisory lock, then
// rename-swap inside one transaction; retention then becomes
// DROP PARTITION instead of DELETE.
// ---------------------------------------------------------------------------

import type { Pool, PoolClient } from "pg";

import { sweepOrphanedFunctionArtifacts, type ArtifactSweepResult } from "../functionsRegistry/artifactStore";

export interface LogRetentionTunables {
  /** Days a terminal run's logs are kept. 0 disables cleanup. */
  readonly retentionDays: number;
  /** Max log rows deleted per batch. */
  readonly batchSize: number;
  /** Max batches per cleanup invocation. */
  readonly maxBatches: number;
  /** Maintenance tick period (used by the scheduler, not the cleanup). */
  readonly intervalMs: number;
  /** Also sweep orphaned artifact blobs. */
  readonly artifactSweep: boolean;
}

export function resolveLogRetentionTunables(
  env: NodeJS.ProcessEnv = process.env,
): LogRetentionTunables {
  return {
    retentionDays: Math.max(0, Number(env.FUNCTIONS_PUBLISH_LOG_RETENTION_DAYS ?? 30) || 0),
    batchSize: Math.max(1, Number(env.FUNCTIONS_PUBLISH_LOG_CLEANUP_BATCH_SIZE ?? 10_000) || 10_000),
    maxBatches: Math.max(1, Number(env.FUNCTIONS_PUBLISH_LOG_CLEANUP_MAX_BATCHES ?? 10) || 10),
    intervalMs: Math.max(60_000, Number(env.FUNCTIONS_PUBLISH_MAINTENANCE_INTERVAL_MS ?? 3_600_000) || 3_600_000),
    artifactSweep: (env.FUNCTIONS_PUBLISH_ARTIFACT_SWEEP ?? "1") !== "0",
  };
}

const ADVISORY_LOCK_NAME = "functions-publish-log-retention";
const TERMINAL_STATES = ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"] as const;

export interface LogCleanupResult {
  /** True when another instance already holds the advisory lock. */
  readonly skipped: boolean;
  readonly disabled: boolean;
  readonly batches: number;
  readonly deleted: number;
  readonly artifactSweep: ArtifactSweepResult | null;
}

/**
 * One bounded retention pass. Self-contained: acquires its own
 * client + advisory lock, loops bounded batches, always unlocks.
 * Safe to call concurrently from any number of instances.
 */
export async function runLogRetentionCleanup(
  pool: Pool,
  tunables: LogRetentionTunables = resolveLogRetentionTunables(),
): Promise<LogCleanupResult> {
  if (tunables.retentionDays === 0) {
    return { skipped: false, disabled: true, batches: 0, deleted: 0, artifactSweep: null };
  }
  const client: PoolClient = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [ADVISORY_LOCK_NAME],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) {
      return { skipped: true, disabled: false, batches: 0, deleted: 0, artifactSweep: null };
    }

    let batches = 0;
    let deleted = 0;
    while (batches < tunables.maxBatches) {
      // Bounded batch: drive from old terminal runs (partial index
      // jemma_run_terminal_finished_idx), cap the DELETE at
      // batchSize log rows. The run-state predicate is repeated in
      // the DELETE join, so a run that somehow flipped state
      // between CTE and DELETE still cannot lose logs.
      const result = await client.query(
        `WITH doomed_runs AS (
           SELECT rid FROM jemma_run
            WHERE state = ANY($1::text[])
              AND finished_at < now() - ($2::double precision * interval '1 day')
            ORDER BY finished_at
            LIMIT $3
         ), doomed_logs AS (
           SELECT l.id
             FROM jemma_run_log l
             JOIN doomed_runs d ON d.rid = l.run_rid
            ORDER BY l.id
            LIMIT $4
         )
         DELETE FROM jemma_run_log l
          USING doomed_logs d, jemma_run r
          WHERE l.id = d.id
            AND r.rid = l.run_rid
            AND r.state = ANY($1::text[])`,
        [TERMINAL_STATES, tunables.retentionDays, tunables.batchSize, tunables.batchSize],
      );
      batches += 1;
      deleted += result.rowCount ?? 0;
      if ((result.rowCount ?? 0) < tunables.batchSize) break;
    }

    let artifactSweep: ArtifactSweepResult | null = null;
    if (tunables.artifactSweep) {
      artifactSweep = await sweepOrphanedFunctionArtifacts(pool);
    }

    return { skipped: false, disabled: false, batches, deleted, artifactSweep };
  } finally {
    if (locked) {
      await client.query(
        `SELECT pg_advisory_unlock(hashtext($1))`,
        [ADVISORY_LOCK_NAME],
      ).catch(() => undefined);
    }
    client.release();
  }
}

export interface MaintenanceHandle {
  stop: () => void;
}

/**
 * Schedule the retention tick inside the worker process. First
 * tick runs immediately (bounded + advisory-locked, so a fleet
 * start is safe). Cleanup failures NEVER affect publishing —
 * they are caught and logged (bounded) and the next tick retries.
 */
export function startLogRetentionMaintenance(
  pool: Pool,
  tunables: LogRetentionTunables = resolveLogRetentionTunables(),
): MaintenanceHandle {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await runLogRetentionCleanup(pool, tunables);
      if (!result.skipped && !result.disabled && result.deleted > 0) {
        console.log(
          `functions-publish maintenance: deleted ${result.deleted} run-log row(s) in ${result.batches} batch(es)`,
        );
      }
      if (result.artifactSweep && result.artifactSweep.deleted > 0) {
        console.log(
          `functions-publish maintenance: swept ${result.artifactSweep.deleted} orphaned artifact blob(s)`,
        );
      }
    } catch (error) {
      // Bounded: classification only, no SQL, no run ids.
      console.warn(
        `functions-publish maintenance tick failed (${(error as Error).name}); retrying next tick`,
      );
    }
  };
  const timer = setInterval(() => void tick(), tunables.intervalMs);
  timer.unref();
  void tick();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
