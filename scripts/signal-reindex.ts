// Standalone signal-with-start for an Object Type's funnel workflow.
//
// Replicates `signalTemporalWorkflow` (src/services/funnel/temporal/worker.ts)
// but with its OWN Temporal Client, so it can run outside the backend process
// (no HTTP auth, no dependency on the backend's module-level `temporalClient`).
//
// For a CLOSED/FAILED workflow, signalWithStart starts a FRESH run and
// delivers the `sourceTransactionCommitted` signal → the workflow drains it
// → changelog → merge → OpenSearch sync → indexing → hydration.
//
// Usage: npx tsx scripts/signal-reindex.ts OlivierOrder1 [OlivierOrder2 ...]
import { Client, Connection } from "@temporalio/client";

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "tellus-funnel";
const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? "tellus-funnel-queue";
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";

async function signalOne(apiName: string, conn: Connection): Promise<void> {
  const client = new Client({ connection: conn, namespace: NAMESPACE });
  const signalId = `manual-reindex-${apiName.toLowerCase()}-${Date.now()}`;
  const handle = await client.workflow.signalWithStart("ObjectTypeFunnelWorkflow", {
    workflowId: `ObjectTypeFunnelWorkflow-${apiName}`,
    taskQueue: TASK_QUEUE,
    args: [{ ontologyId: ONTOLOGY_ID, objectTypeApiName: apiName }],
    signal: "sourceTransactionCommitted",
    signalArgs: [{ signalId }],
    workflowIdConflictPolicy: "USE_EXISTING",
  });
  console.log(`${apiName}: signalWithStart OK; firstRunId=${handle.firstExecutionRunId} signalId=${signalId}`);
}

async function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error("Usage: npx tsx scripts/signal-reindex.ts <ApiName> [<ApiName> ...]");
    process.exit(2);
  }
  const conn = await Connection.connect({ address: TEMPORAL_ADDRESS });
  console.log(`Connected to Temporal ${TEMPORAL_ADDRESS} ns=${NAMESPACE} queue=${TASK_QUEUE}`);
  let ok = 0;
  for (const apiName of targets) {
    try {
      await signalOne(apiName, conn);
      ok++;
    } catch (e) {
      console.error(`${apiName}: FAIL ${(e as Error).message}`);
    }
  }
  await conn.close();
  console.log(`Done: ${ok}/${targets.length} signaled`);
  process.exit(ok === targets.length ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", (e as Error).message);
  process.exit(1);
});
