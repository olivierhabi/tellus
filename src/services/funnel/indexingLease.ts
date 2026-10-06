// ---------------------------------------------------------------------------
// indexingLease — the three lock signals for funnel_state indexing locks.
//
// Phase 0 proved one signal is not enough:
//   * updated_at (lease heartbeat, written on stage transitions) lives on the
//     JS main thread, which stayed responsive through a native-thread
//     deadlock — so it detects a DEAD process but never a STUCK one;
//   * last_progress_at (movement, written only when rows/bytes advance)
//     detects a STUCK process but says nothing about one that never
//     instrumented itself.
//
// The three signals and their owners:
//   1. touchIndexingLock — lease heartbeat ("process alive"). Called at merge
//      stage boundaries. Moves updated_at only.
//   2. reportIndexingProgress — movement ("work advancing"). Called from the
//      out-of-process prefix progress callback and the PG-tail batch loop.
//      Moves last_progress_at (and updated_at with it).
//   3. sweepStalledIndexing — watchdog ("alive but not moving"). Fails runs
//      whose last_progress_at is older than the stall budget. Skips rows with
//      NULL last_progress_at: those predate instrumentation (or never opted
//      in) and belong to the boot reconciler, not the watchdog — failing
//      them here would punish slow-but-uninstrumented runs.
//   4. reconcileStaleIndexingLocks — boot ("owner cannot be alive").
//      Releases 'indexing' rows whose active run is terminal-or-missing AND
//      whose heartbeat is older than the boot grace. Never touches a row
//      whose run is still 'running': Temporal may resume it after restart.
//
// All mutators are scoped to status='indexing' and idempotent: re-running
// them changes nothing.
// ---------------------------------------------------------------------------

import { query } from "../../db";

export const INDEXING_STALL_AFTER_MS_DEFAULT = 600_000; // 10 min
export const INDEXING_BOOT_STALE_MS_DEFAULT = 900_000; // 15 min

function positiveIntEnv(value: string | undefined, def: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Watchdog budget: no movement for this long => STALLED. */
export function indexingStallAfterMs(): number {
  return positiveIntEnv(
    process.env.FUNNEL_INDEXING_STALL_AFTER_MS,
    INDEXING_STALL_AFTER_MS_DEFAULT,
  );
}

/** Boot grace: a lock untouched for this long with no live run is released. */
export function indexingBootStaleMs(): number {
  return positiveIntEnv(
    process.env.FUNNEL_INDEXING_BOOT_STALE_MS,
    INDEXING_BOOT_STALE_MS_DEFAULT,
  );
}

function toMs(t: unknown): number | null {
  if (t === null || t === undefined) return null;
  const ms = new Date(t as string).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Pure: is this timestamp older than the budget? `null` (never written)
 * returns false — absence of a signal must not read as a stale signal.
 */
export function isTimestampStale(
  at: unknown,
  nowMs: number,
  staleMs: number,
): boolean {
  const ms = toMs(at);
  if (ms === null) return false;
  return nowMs - ms > staleMs;
}

/**
 * Pure: should the watchdog fail this lock? Only when movement was
 * instrumented (non-null last_progress_at) and has gone quiet past the
 * budget. NULL means "not instrumented" — the boot reconciler owns it.
 */
export function shouldMarkStalled(
  lastProgressAt: unknown,
  nowMs: number,
  stallMs: number,
): boolean {
  if (lastProgressAt === null || lastProgressAt === undefined) return false;
  return isTimestampStale(lastProgressAt, nowMs, stallMs);
}

/**
 * Resolve (ontologyId, apiName) to the funnel_state lock key. Null when the
 * object type is gone (deleted mid-run) — callers treat that as "nothing to
 * touch", never as an error.
 */
export async function resolveLeaseObjectTypeId(
  ontologyId: string,
  objectTypeApiName: string,
): Promise<string | null> {
  const res = await query(
    `SELECT object_type_id FROM object_type
      WHERE ontology_id = $1 AND api_name = $2
      LIMIT 1`,
    [ontologyId, objectTypeApiName],
  );
  const id = (res.rows?.[0] as { object_type_id?: string } | undefined)
    ?.object_type_id;
  return id ?? null;
}

/** Lease heartbeat: the holder process is alive. Scoped to live locks. */
export async function touchIndexingLock(
  objectTypeId: string,
): Promise<boolean> {
  const res = await query(
    `UPDATE funnel_state
        SET updated_at = now()
      WHERE object_type_id = $1 AND status = 'indexing'`,
    [objectTypeId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Movement: rows/bytes actually advanced. Scoped to live locks. */
export async function reportIndexingProgress(
  objectTypeId: string,
): Promise<boolean> {
  const res = await query(
    `UPDATE funnel_state
        SET last_progress_at = now(), updated_at = now()
      WHERE object_type_id = $1 AND status = 'indexing'`,
    [objectTypeId],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface StalledLock {
  object_type_id: string;
  active_run_id: string | null;
  last_progress_at: string;
  updated_at: string;
}

export interface SweepResult {
  swept: StalledLock[];
}

/**
 * Watchdog: fail instrumented-but-quiet locks and their live runs. Each
 * UPDATE is scoped (status='indexing' / run still 'running') so concurrent
 * sweeps and legitimately-finishing runs cannot clobber each other; the
 * whole sweep is idempotent. Throws on DB error — the caller (dispatcher
 * tick) logs and continues.
 */
export async function sweepStalledIndexing(
  stallMs: number = indexingStallAfterMs(),
): Promise<SweepResult> {
  const stale = await query(
    `UPDATE funnel_state
        SET status = 'failed',
            error_message = 'STALLED: no indexing progress within the stall budget; ' ||
              'see indexingLease.sweepStalledIndexing',
            updated_at = now()
      WHERE status = 'indexing'
        AND last_progress_at IS NOT NULL
        AND last_progress_at < now() - ($1::text || ' milliseconds')::interval
      RETURNING object_type_id, active_run_id, last_progress_at, updated_at`,
    [String(Math.floor(stallMs))],
  );
  const swept = (stale.rows ?? []) as StalledLock[];
  for (const row of swept) {
    if (!row.active_run_id) continue;
    try {
      await query(
        `UPDATE funnel_run
            SET status = 'failed',
                error_message = 'STALLED: indexing lock showed no progress within the stall budget',
                completed_at = now()
          WHERE run_id = $1 AND status = 'running'`,
        [row.active_run_id],
      );
    } catch (err) {
      // The lock is already failed; a run row that cannot be marked is a
      // reconciler/belt-and-braces concern, not a reason to un-fail it.
      console.warn(
        `[indexing-lease] swept lock ${row.object_type_id} but could not ` +
          `mark run ${row.active_run_id} failed: ${(err as Error).message}`,
      );
    }
  }
  if (swept.length > 0) {
    console.warn(
      `[indexing-lease] STALLED ${swept.length} indexing lock(s): ` +
        swept.map((r) => r.object_type_id).join(", "),
    );
  }
  return { swept };
}

export interface ReconcileResult {
  released: string[];
}

/**
 * Boot: release 'indexing' locks that cannot have a live owner — heartbeat
 * older than the boot grace AND linked run terminal-or-missing. A lock whose
 * run is still 'running' is left alone: Temporal may resume it after
 * restart (the boot sweep in durableWorkflow owns run-level reconciliation).
 * Idempotent; safe to run on every boot.
 */
export async function reconcileStaleIndexingLocks(
  bootStaleMs: number = indexingBootStaleMs(),
): Promise<ReconcileResult> {
  const res = await query(
    `UPDATE funnel_state fs
        SET status = 'failed',
            error_message = 'boot-reconcile: indexing lock with no live run; ' ||
              'released at startup',
            updated_at = now()
      WHERE fs.status = 'indexing'
        AND fs.updated_at < now() - ($1::text || ' milliseconds')::interval
        AND NOT EXISTS (
          SELECT 1 FROM funnel_run fr
           WHERE fr.run_id = fs.active_run_id
             AND fr.status = 'running'
        )
      RETURNING fs.object_type_id`,
    [String(Math.floor(bootStaleMs))],
  );
  const released = ((res.rows ?? []) as { object_type_id: string }[]).map(
    (r) => r.object_type_id,
  );
  if (released.length > 0) {
    console.warn(
      `[indexing-lease] boot-released ${released.length} stale indexing ` +
        `lock(s): ${released.join(", ")}`,
    );
  }
  return { released };
}

export interface IndexingLockDescription {
  status: string;
  objectsIndexed: number;
  updatedAt: string | null;
  activeRunId: string | null;
  runStage: string | null;
  runStartedAt: string | null;
}

/**
 * Read model for the 409 REINDEX_IN_PROGRESS body: what holds the lock, what
 * stage its run is in, and when either was last heard from. Returns null
 * when no lock row exists (caller then keeps the generic message).
 */
export async function describeIndexingLock(
  objectTypeId: string,
): Promise<IndexingLockDescription | null> {
  const res = await query(
    `SELECT fs.status, fs.objects_indexed, fs.updated_at, fs.active_run_id,
            fr.current_stage, fr.started_at
       FROM funnel_state fs
       LEFT JOIN funnel_run fr
         ON fr.run_id = fs.active_run_id AND fr.status = 'running'
      WHERE fs.object_type_id = $1`,
    [objectTypeId],
  );
  const row = (res.rows?.[0] ?? null) as {
    status: string;
    objects_indexed: number;
    updated_at: string | null;
    active_run_id: string | null;
    current_stage: string | null;
    started_at: string | null;
  } | null;
  if (!row) return null;
  return {
    status: row.status,
    objectsIndexed: Number(row.objects_indexed ?? 0),
    updatedAt: row.updated_at,
    activeRunId: row.active_run_id,
    runStage: row.current_stage,
    runStartedAt: row.started_at,
  };
}
