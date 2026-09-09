// ---------------------------------------------------------------------------
// Pipeline build scheduler — Foundry "Build schedule" parity.
//
// Periodically finds pipelines whose build schedule is ENABLED and DUE and
// kicks off a build through the exact same code path as a manual deploy
// (`DeploymentService.startDeployment`) — the output transactions, ontology
// signals and audits a scheduled build produces are indistinguishable from a
// user-triggered one, which is precisely what Foundry guarantees: schedules
// are just a second trigger mechanism.
//
// Design properties (same as services/connectivity/imports/scheduler.ts):
//   - Durable: due-state lives on `pipelines.schedule_next_run_at`, so a
//     restart never loses or double-fires a window.
//   - Multi-replica safe: due rows are claimed `FOR UPDATE SKIP LOCKED` and
//     their next_run_at advanced in the SAME statement.
//   - Catch-up safe: a missed window schedules ONE run from now().
//   - Overlap safe: startDeployment's supervisor enqueue coalesces onto the
//     in-flight deployment signal for the pipeline.
//
// Tunables:
//   TELLUS_PIPELINE_SCHEDULER_POLL_MS   poll cadence (default 30s)
//   TELLUS_PIPELINE_SCHEDULER_BATCH     max pipelines claimed per tick (25)
//   TELLUS_DISABLE_PIPELINE_SCHEDULER=1 turn the scheduler off
// ---------------------------------------------------------------------------

import foundryDb from "../../config/foundryDb";
import { DeploymentService } from '../deploymentService';
import { TransformService } from '../transformService';

const POLL_MS = Number(process.env.TELLUS_PIPELINE_SCHEDULER_POLL_MS ?? 30_000);
const BATCH = Number(process.env.TELLUS_PIPELINE_SCHEDULER_BATCH ?? 25);

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/**
 * Audit/actor label for scheduler-triggered builds. The identity of the build
 * owner is the pipeline's creator (triggeredBy) — the schedule itself is
 * surfaced via the deployment config marker below.
 */
export const SCHEDULE_TRIGGER_MARKER = "build_schedule";

/**
 * Atomically claim due, enabled pipelines and advance each one's
 * schedule_next_run_at one interval out — in a SINGLE statement. Returns the
 * claimed pipelines with their creators for the call to startDeployment.
 */
export async function claimDuePipelines(
  batch: number = BATCH,
): Promise<Array<{ id: string; project_id: string; created_by: string | null }>> {
  const rows = await foundryDb.raw(
    `UPDATE pipelines AS p
        SET schedule_last_run_at = now(),
            schedule_next_run_at =
              now() + make_interval(mins => p.schedule_interval_minutes)
      WHERE p.id IN (
        SELECT id
          FROM pipelines
         WHERE schedule_enabled
           AND schedule_interval_minutes IS NOT NULL
           AND schedule_interval_minutes > 0
           AND schedule_next_run_at IS NOT NULL
           AND schedule_next_run_at <= now()
         ORDER BY schedule_next_run_at
         FOR UPDATE SKIP LOCKED
         LIMIT ?
      )
      RETURNING p.id, p.project_id, p.created_by`,
    [batch],
  );
  const list = (rows?.rows ?? rows ?? []) as Array<{
    id: string;
    project_id: string;
    created_by: string | null;
  }>;
  return list;
}

/**
 * One scheduler sweep: claim the due pipelines and kick a build for each.
 * Errors per pipeline are logged, never thrown — one broken pipeline must not
 * starve the rest of the tick.
 */
export async function runSchedulerOnce(): Promise<number> {
  const claimed = await claimDuePipelines();
  if (claimed.length === 0) return 0;

  const deploymentService = new DeploymentService(
    foundryDb,
    new TransformService(foundryDb),
  );

  for (const pipeline of claimed) {
    try {
      // Supervisor mode (default) — enqueue the build signal, dispatcher
      // executes, identical to script-driven/manual triggers.
      await deploymentService.startDeployment(
        pipeline.project_id,
        pipeline.id,
        pipeline.created_by ?? "system",
        {},
        { idempotencyKey: `${SCHEDULE_TRIGGER_MARKER}:${pipeline.id}:${Date.now()}` },
      );
      console.log(
        `[pipelines/scheduler] scheduled build kicked for pipeline ${pipeline.id}`,
      );
    } catch (err) {
      console.warn(
        `[pipelines/scheduler] build failed to start for ${pipeline.id}: ${(err as Error).message}`,
      );
    }
  }
  return claimed.length;
}

export function startPipelineBuildScheduler(
  options: { intervalMs?: number } = {},
): void {
  if (timer) return;
  if (process.env.TELLUS_DISABLE_PIPELINE_SCHEDULER === "1") return;
  const intervalMs = options.intervalMs ?? POLL_MS;
  timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      await runSchedulerOnce();
    } catch (err) {
      console.warn(
        `[pipelines/scheduler] tick failed: ${(err as Error).message}`,
      );
    } finally {
      ticking = false;
    }
  }, intervalMs);
  timer.unref?.();
}

export function stopPipelineBuildScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
