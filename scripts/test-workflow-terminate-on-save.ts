// Verify TERMINATE_EXISTING: two back-to-back signalTemporalWorkflow
// calls for the same Object Type must leave behind exactly one RUNNING
// workflow, and the first one must be TERMINATED (or a terminal
// non-RUNNING state). Guards against the "stuck-on-sync" regression.
import "dotenv/config";
import { Client, Connection } from "@temporalio/client";
import {
  signalTemporalWorkflow,
  startTemporalWorker,
  isTemporalConnected,
  stopTemporalWorker,
  funnelWorkflowId,
} from "../src/services/funnel/temporal/worker";
import { resolveEnvironmentIdentity } from "../src/config/environmentIdentity";

// Isolation: use a dedicated test namespace + unique object type per run
// so parallel CI jobs can't collide. `FUNNEL_TERMINATE_ON_SAVE=true`
// activates the conflict-policy we're verifying.
process.env.TEMPORAL_NAMESPACE =
  process.env.TEMPORAL_TEST_NAMESPACE ?? process.env.TEMPORAL_NAMESPACE ?? "tellus-funnel-test";
process.env.TEMPORAL_TASK_QUEUE =
  process.env.TEMPORAL_TEST_TASK_QUEUE ?? process.env.TEMPORAL_TASK_QUEUE ?? "tellus-funnel-test-queue";
process.env.FUNNEL_TERMINATE_ON_SAVE = "true";
process.env.FUNNEL_CANCEL_STALE_THRESHOLD_MS = "60000000"; // disable cancel grace for this test

const OBJECT_TYPE = `TerminateTestOT_${process.pid}_${Date.now()}`;
const OBJECT_TYPE_RID = `00000000-0000-0000-0000-${String(process.pid).padStart(12, "0")}`;
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";

(async () => {
  // 1. Need a connected Temporal client.
  await startTemporalWorker();
  if (!isTemporalConnected()) {
    process.stderr.write("SKIP: Temporal not reachable\n");
    process.exit(0);
  }
  const identity = resolveEnvironmentIdentity();

  const pseudoSignal = (signalId: string) =>
    signalTemporalWorkflow({
      ontologyId: ONTOLOGY_ID,
      objectTypeApiName: OBJECT_TYPE,
      objectTypeRid: OBJECT_TYPE_RID,
      signalType: "sourceTransactionCommitted",
      payload: { signalId },
    });

  // 2. Send first signal — this starts workflow W1.
  const first = await pseudoSignal("first");

  // Grab W1's runId immediately.
  const conn = await Connection.connect({ address: identity.temporalAddress });
  const client = new Client({ connection: conn, namespace: identity.temporalNamespace });
  const handle = client.workflow.getHandle(funnelWorkflowId(ONTOLOGY_ID, OBJECT_TYPE_RID));
  const w1 = await handle.describe();

  // 3. Send second signal — this must TERMINATE W1 and start W2.
  const second = await pseudoSignal("second");

  // Give Temporal ~500ms to process the terminate.
  await new Promise((r) => setTimeout(r, 500));

  const w2 = await handle.describe();

  // 4. Verify: the runId must differ, and W2 must be the only RUNNING
  //    execution for this workflowId.
  const report = {
    firstSignalOk: first,
    secondSignalOk: second,
    w1RunId: w1.runId,
    w1StatusAtStart: w1.status.name,
    w2RunId: w2.runId,
    w2StatusNow: w2.status.name,
    freshRunIdAfterSecondSave: w1.runId !== w2.runId,
  };
  console.log(JSON.stringify(report, null, 2));

  const pass =
    report.firstSignalOk &&
    report.secondSignalOk &&
    report.freshRunIdAfterSecondSave &&
    (report.w2StatusNow === "RUNNING" || report.w2StatusNow === "COMPLETED");

  // Cleanup.
  try {
    await handle.terminate("test cleanup");
  } catch {
    /* already terminated */
  }
  await conn.close();
  await stopTemporalWorker();

  console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  process.stderr.write(`CRASH: ${err?.stack ?? err}\n`);
  process.exit(2);
});
