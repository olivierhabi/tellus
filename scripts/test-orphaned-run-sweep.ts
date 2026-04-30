// Verify the B3 orphaned funnel_run sweeper: inject a stuck 'running'
// row, run sweepOrphanedFunnelRuns, assert it's now 'failed' with the
// marker error message AND the stage-run children are closed too.
import "dotenv/config";
import { query } from "../src/db";
import { sweepOrphanedFunnelRuns } from "../src/services/funnel/durableWorkflow";

(async () => {
  // 1. Seed an orphaned run — old `started_at` simulates a row left
  //    behind by a killed worker.
  const insRun = await query(
    `INSERT INTO funnel_run
       (ontology_id, object_type_api_name, workflow_type, status,
        current_stage, started_at)
     VALUES ($1, $2, 'ObjectTypeFunnelWorkflow.temporal', 'running',
             'merge', now() - interval '6 hours')
     RETURNING run_id`,
    ["00000000-0000-0000-0000-000000000001", "SweepTest_DELETEME"]
  );
  const runId = insRun.rows[0].run_id as string;

  await query(
    `INSERT INTO funnel_stage_run
       (run_id, stage, status, attempt, started_at)
     VALUES ($1, 'merge', 'running', 1, now() - interval '6 hours')`,
    [runId]
  );

  // 2. Run the sweeper.
  const result = await sweepOrphanedFunnelRuns();

  // 3. Inspect state.
  const runRow = await query(
    `SELECT status, error_message, completed_at IS NOT NULL AS has_completed_at
       FROM funnel_run WHERE run_id = $1`,
    [runId]
  );
  const stageRow = await query(
    `SELECT status, error_message, finished_at IS NOT NULL AS has_finished_at
       FROM funnel_stage_run WHERE run_id = $1`,
    [runId]
  );

  const report = {
    seededRunId: runId,
    sweepReturned: {
      sweptRunIds: result.sweptRunIds.length,
      sweptStageRuns: result.sweptStageRuns,
      includedTargetRun: result.sweptRunIds.includes(runId),
    },
    runAfter: runRow.rows[0],
    stageAfter: stageRow.rows[0],
  };
  console.log(JSON.stringify(report, null, 2));

  const runOk =
    report.runAfter.status === "failed" &&
    /orphaned by worker restart/i.test(report.runAfter.error_message ?? "") &&
    report.runAfter.has_completed_at === true;
  const stageOk =
    report.stageAfter.status === "failed" &&
    report.stageAfter.has_finished_at === true;
  const sweepOk =
    report.sweepReturned.includedTargetRun &&
    report.sweepReturned.sweptStageRuns >= 1;

  // Cleanup — this is a disposable fixture regardless of outcome.
  await query(`DELETE FROM funnel_stage_run WHERE run_id = $1`, [runId]);
  await query(`DELETE FROM funnel_run WHERE run_id = $1`, [runId]);

  const pass = runOk && stageOk && sweepOk;
  console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  process.stderr.write(`TEST HARNESS CRASHED: ${err?.stack ?? err}\n`);
  process.exit(2);
});
