// ---------------------------------------------------------------------------
// B5 — Table-import scheduler.
//
// Periodically finds enabled table-import schedules that are DUE and enqueues a
// build for each through the exact same path as a manual "Run"
// (`enqueueBuildForImport`). Design properties:
//
//   - Durable: due-state lives in `table_imports.next_run_at`, not in memory,
//     so a restart never loses or double-fires a schedule.
//   - Multi-replica safe: the claim query selects due rows
//     `FOR UPDATE SKIP LOCKED` and advances `next_run_at` in the SAME
//     statement, so two server replicas can never claim the same import for the
//     same tick.
//   - Overlap safe: enqueue coalesces onto an in-flight build via the
//     single-active lock, so a long-running build never stacks duplicate runs.
//   - Catch-up safe: a missed window (server down) schedules the next run from
//     `now()`, not a burst of backfilled runs.
//
// Cadence is a plain interval in minutes (no cron dependency). Tunables:
//   TELLUS_TABLE_IMPORT_SCHEDULER_POLL_MS  poll cadence (default 30s)
//   TELLUS_TABLE_IMPORT_SCHEDULER_BATCH    max imports claimed per tick (50)
//   TELLUS_DISABLE_TABLE_IMPORT_SCHEDULER=1  turn the scheduler off
// ---------------------------------------------------------------------------

import { hostname } from "node:os";
import type { Pool } from "pg";
import { pool } from "../../../db";
import { enqueueBuildForImport } from "./handlers";
import { SCHEDULE_ACTOR_TABLE_IMPORT } from "./triggers";

const POLL_MS = Number(
  process.env.TELLUS_TABLE_IMPORT_SCHEDULER_POLL_MS ?? 30_000,
);
const BATCH = Number(process.env.TELLUS_TABLE_IMPORT_SCHEDULER_BATCH ?? 50);

// Audit principal recorded on scheduler-triggered builds. Shared with the build
// envelope's trigger classifier so "Started by" reads "Build schedule".
const SYSTEM_ACTOR = SCHEDULE_ACTOR_TABLE_IMPORT;

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/**
 * Atomically claim the due, enabled, non-deleted imports and advance each one's
 * `next_run_at` one interval out — in a SINGLE statement. The subselect locks
 * only the rows it returns (`FOR UPDATE SKIP LOCKED`), so concurrent pollers /
 * replicas never claim the same import twice. Advancing from `now()` (not from
 * the scheduled time) makes a missed window schedule ONE next run, never a
 * backfill burst (catch-up safe). Pure DB; extracted so the reliability suite
 * can exercise it directly. Returns the claimed import rids.
 */
export async function claimDueImports(db: Pool, batch: number): Promise<string[]> {
  const claimed = await db.query<{ rid: string }>(
    `UPDATE table_imports AS t
        SET last_run_at = now(),
            next_run_at =
              now() + make_interval(mins => t.schedule_interval_minutes)
      WHERE t.rid IN (
        SELECT rid
          FROM table_imports
         WHERE schedule_enabled
           AND deleted_at IS NULL
           AND schedule_interval_minutes IS NOT NULL
           AND next_run_at IS NOT NULL
           AND next_run_at <= now()
         ORDER BY next_run_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      )
      RETURNING t.rid`,
    [batch],
  );
  return claimed.rows.map((r) => r.rid);
}

/**
 * One scheduler sweep: atomically claim due imports (advancing their next run
 * so no other replica/tick re-claims them) and enqueue a build for each.
 */
export async function runSchedulerOnce(
  workerId: string = `${hostname()}-${process.pid}`,
): Promise<number> {
  const claimedRids = await claimDueImports(pool, BATCH);

  let dispatched = 0;
  for (const rid of claimedRids) {
    try {
      const { buildRid, coalesced } = await enqueueBuildForImport(
        rid,
        SYSTEM_ACTOR,
      );
      dispatched += 1;
      // Record the scheduler-triggered build for observability.
      await pool
        .query(
          `UPDATE table_imports SET last_scheduled_build_rid=$2 WHERE rid=$1`,
          [rid, buildRid],
        )
        .catch(() => undefined);
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          type: "table_import_scheduled_run",
          workerId,
          importRid: rid,
          buildRid,
          coalesced,
        }),
      );
    } catch (err) {
      // A single import failing to enqueue must not abort the sweep. Its
      // next_run_at was already advanced, so it retries next interval.
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          type: "table_import_schedule_error",
          importRid: rid,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return dispatched;
}

export function startTableImportScheduler(): void {
  if (process.env.TELLUS_DISABLE_TABLE_IMPORT_SCHEDULER === "1") return;
  if (timer) return;
  const tick = (): void => {
    if (ticking) return; // never overlap sweeps
    ticking = true;
    void runSchedulerOnce()
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error("[table-import-scheduler] sweep failed:", e);
      })
      .finally(() => {
        ticking = false;
      });
  };
  timer = setInterval(tick, POLL_MS);
  // Don't keep the event loop alive solely for the scheduler.
  timer.unref?.();
}

export function stopTableImportScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
