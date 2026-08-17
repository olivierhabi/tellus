// ---------------------------------------------------------------------------
// closeOpenStageRuns — the terminal-run stage-row invariant.
//
// INVARIANT: a `funnel_run` row at a terminal status ('completed', 'failed',
// 'cancelled') must NEVER have `funnel_stage_run` children left at 'pending'
// or 'running'. A run cannot be terminal while one of its stages is still
// executing, so such a row is not a state — it is a leak.
//
// Why this matters, traced end to end. `GET /funnel/runs/...`
// (respondWithFunnelRuns) returns stage rows verbatim, and the FE maps them
// straight through:
//
//     if (s.status === "succeeded") return "succeeded";
//     if (s.status === "running")   return "running";   // ← spinner
//
// while the header badge is derived from the RUN. So a stranded 'running'
// merge row renders a merge node that spins forever underneath a "Failed"
// header — the operator has no way to tell a genuinely in-flight merge from a
// dead one, and "Force Reindex" looks like it did nothing. This is the
// "stuck on Merge changes" report, and it is a bookkeeping defect, not a
// stalled pipeline.
//
// Why a shared helper rather than fixing one call site: the leak existed
// because closing stage rows was implemented only in the two boot sweeps in
// durableWorkflow.ts, and those close rows exclusively for run_ids they
// themselves transitioned (`WHERE run_id = ANY($1) AND status IN (...)`,
// selected by `funnel_run.status = 'running'`). Any OTHER writer that moves a
// run to terminal — the in-process runWorkflow catch, or the Temporal path's
// terminal projection — updated `funnel_run` alone, so its stage rows were
// never again reachable by a sweep: already-'failed' runs are not selected.
// Every terminal writer must therefore call this, and the wording below
// deliberately matches the sweeps' so operators see one vocabulary.
// ---------------------------------------------------------------------------

import { query } from "../../db";

/** Terminal statuses of `funnel_run`, per its CHECK constraint. */
export type TerminalRunStatus = "completed" | "failed" | "cancelled";

/**
 * Fail any `funnel_stage_run` rows for `runId` still at 'pending'/'running'.
 *
 * Note `funnel_stage_run.status` has NO 'cancelled' value (unlike
 * funnel_state) — its CHECK is pending|running|succeeded|failed|timed_out — so
 * a cancelled run's open stages are closed as 'failed' with the cancellation
 * reason in `error_message`. That is the honest record: the stage did not
 * succeed, and the message says why.
 *
 * Best-effort by contract: this is bookkeeping that runs on paths already
 * handling a failure, and throwing here would mask the original error. The
 * count is returned so callers can log it; failures are swallowed and reported
 * as 0.
 */
export async function closeOpenStageRuns(
  runId: string,
  reason: string,
): Promise<number> {
  if (!runId) return 0;
  try {
    const res = await query(
      `UPDATE funnel_stage_run
          SET status        = 'failed',
              error_message = COALESCE(error_message, $2),
              finished_at   = COALESCE(finished_at, now())
        WHERE run_id = $1
          AND status IN ('pending', 'running')
        RETURNING stage_run_id`,
      [runId, reason || "run reached a terminal status with this stage still open"],
    );
    return res.rowCount ?? 0;
  } catch (err) {
    // A transitional deployment may not have the B3 tables yet.
    console.warn(
      JSON.stringify({
        level: "warn",
        type: "funnel_stage_run_closure_failed",
        runId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return 0;
  }
}

/**
 * Same, keyed by `temporal_workflow_id` — the Temporal terminal projection
 * knows the workflow id, not the run id, and resolving it to a run_id first
 * would be a second round trip that can race the run's own update.
 *
 * Scoped to runs that are ALREADY terminal so this can never close the stage
 * rows of a live run that happens to share the workflow id prefix.
 */
export async function closeOpenStageRunsByWorkflowId(
  temporalWorkflowId: string,
  reason: string,
): Promise<number> {
  if (!temporalWorkflowId) return 0;
  try {
    const res = await query(
      `UPDATE funnel_stage_run sr
          SET status        = 'failed',
              error_message = COALESCE(sr.error_message, $2),
              finished_at   = COALESCE(sr.finished_at, now())
        WHERE sr.status IN ('pending', 'running')
          AND sr.run_id IN (
            SELECT run_id FROM funnel_run
             WHERE temporal_workflow_id = $1
               AND status IN ('completed', 'failed', 'cancelled')
          )
        RETURNING sr.stage_run_id`,
      [
        temporalWorkflowId,
        reason || "run reached a terminal status with this stage still open",
      ],
    );
    return res.rowCount ?? 0;
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        type: "funnel_stage_run_closure_failed",
        temporalWorkflowId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return 0;
  }
}
