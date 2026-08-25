// ===========================================================================
// crashSweeper.ts — startup reconciliation for stuck transform builds.
//
// "Would break in production" item: a backend crash mid-build left the build
// stuck in `running` forever (the in-process `void runBuild` died with the
// process; nothing advanced the build to a terminal state).
//
// Gap 2 (durable/resumable scheduling) split this into two cases:
//   - 'running' -> the process was MID-EXECUTION when it died. Resuming would
//     re-run a transform that may have already written partial output, so it
//     is NOT safe to resume. Mark it 'failed' (the user retries explicitly
//     via POST /builds/:rid/retry). This is what this sweeper does.
//   - 'queued' -> the build was enqueued but runBuild never advanced it past
//     the status='running' UPDATE (the process died before execution began).
//     No partial state exists, so it IS safe to re-run. That recovery is
//     handled by requeueQueuedBuilds() in buildService.ts, called after this
//     sweeper on boot. (Previously the sweeper failed BOTH; 'queued' is now
//     recovered, not abandoned — the idempotent-recovery half of Gap 2.)
// ===========================================================================
import { pool } from "../../../db.js";

/** Mark 'running' builds as failed — the process that was executing them is
 * gone after a restart/crash, and mid-execution resume is unsafe. 'queued'
 * builds are NOT failed here; they are re-queued by requeueQueuedBuilds().
 * Returns the count swept. */
export async function sweepStaleTransformBuilds(): Promise<number> {
  const r = await pool.query(
    `UPDATE transform_build
        SET status = 'failed',
            ended_at = COALESCE(ended_at, now()),
            reason = COALESCE(reason, 'build process lost (backend restart/crash) — crash-recovery sweeper')
      WHERE status = 'running'`,
  );
  return r.rowCount ?? 0;
}
