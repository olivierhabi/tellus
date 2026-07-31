// Repair OlivierOrder (94d42ac1-...) via the FUNN-ISO durable dispatch:
// insert a durable funnel_signal, then drive the dispatcher tick until the
// run reaches a terminal state, printing each funnel_run/stage along the
// way. Exercises the same path as POST /api/v1/funnel/signals +
// funnelDispatcher without requiring auth plumbing.
import "dotenv/config";
import { query, pool } from "../src/db";
import { sendSignal } from "../src/services/funnel/durableWorkflow";
import {
  drainPendingSignals,
} from "../src/services/funnel/funnelDispatcher";
import {
  startTemporalWorker,
  isTemporalConnected,
} from "../src/services/funnel/temporal/worker";

const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const OT = "OlivierOrder";
const EXPECTED_ROWS = 746;

async function snapshot(label: string): Promise<void> {
  const runs = await query(
    `SELECT run_id, status, current_stage, objects_indexed, environment_id,
            error_message, started_at
       FROM funnel_run WHERE object_type_api_name = $1
       ORDER BY started_at DESC LIMIT 4`,
    [OT],
  );
  const state = await query(
    `SELECT fs.status, fs.objects_indexed, fs.environment_id, fs.error_message
       FROM funnel_state fs JOIN object_type ot ON ot.object_type_id = fs.object_type_id
      WHERE ot.api_name = $1`,
    [OT],
  );
  console.log(`--- ${label} ---`);
  console.log("funnel_run:", JSON.stringify(runs.rows, null, 1));
  console.log("funnel_state:", JSON.stringify(state.rows));
}

async function main(): Promise<void> {
  if (!isTemporalConnected()) {
    await startTemporalWorker();
  }
  if (!isTemporalConnected()) {
    throw new Error("temporal worker failed to start — cannot repair via Temporal path");
  }
  await snapshot("before");

  const signalId = await sendSignal({
    ontologyId: ONTOLOGY_ID,
    objectTypeApiName: OT,
    signalType: "editBatchPending",
  });
  console.log(`signal inserted: ${signalId}`);

  // Drive dispatcher ticks until the run is terminal.
  for (let i = 0; i < 30; i++) {
    await drainPendingSignals();
    const running = await query(
      `SELECT status FROM funnel_run WHERE object_type_api_name = $1
        AND status IN ('dispatch_pending','workflow_started','running')
        ORDER BY started_at DESC LIMIT 1`,
      [OT],
    );
    if (running.rows.length === 0) break;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  await new Promise((r) => setTimeout(r, 10_000)); // terminal projection settle
  await snapshot("after");

  const state = await query(
    `SELECT fs.status, fs.objects_indexed FROM funnel_state fs
       JOIN object_type ot ON ot.object_type_id = fs.object_type_id
      WHERE ot.api_name = $1`,
    [OT],
  );
  const count = await query(
    `SELECT count(*)::int AS n FROM object_instances
      WHERE object_type_api_name = $1`,
    [OT],
  ).catch(() => ({ rows: [{ n: -1 }] }));
  const status = state.rows[0]?.status;
  const objects = state.rows[0]?.objects_indexed;
  console.log(
    `\nRESULT: status=${status} objects_indexed=${objects} object_instances=${count.rows[0].n} expected=${EXPECTED_ROWS}`,
  );
  console.log(status === "indexed" && objects === EXPECTED_ROWS ? "REPAIR: PASS" : "REPAIR: FAIL");
  await pool.end();
  process.exit(status === "indexed" && objects === EXPECTED_ROWS ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", (e as Error).message);
  pool.end().finally(() => process.exit(1));
});
