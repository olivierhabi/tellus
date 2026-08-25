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
// Env (FUNN-ISO): TELLUS_ENVIRONMENT_ID / TEMPORAL_NAMESPACE /
// TEMPORAL_TASK_QUEUE pick the deployment — this script dispatches through
// the SAME identity-resolved namespace+queue as the app it emulates, never
// an implicit shared fallback.
import "dotenv/config";
import { Client, Connection } from "@temporalio/client";
import { resolveEnvironmentIdentity } from "../src/config/environmentIdentity";
import { funnelWorkflowId } from "../src/services/funnel/temporal/worker";
import { query } from "../src/db";

const IDENTITY = resolveEnvironmentIdentity();
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";

async function signalOne(apiName: string, conn: Connection): Promise<void> {
  // Resolve the stable RID — new-dispatch workflow ids are
  // `ObjectTypeFunnelWorkflow/<ontologyRid>/<objectTypeRid>`.
  const ot = await query(
    `SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2 LIMIT 1`,
    [ONTOLOGY_ID, apiName],
  );
  const rid = ot.rows[0]?.object_type_id as string | undefined;
  if (!rid) {
    console.warn(`${apiName}: object type not found in ontology ${ONTOLOGY_ID} — skipping`);
    return;
  }
  const client = new Client({ connection: conn, namespace: IDENTITY.temporalNamespace });
  const signalId = `manual-reindex-${apiName.toLowerCase()}-${Date.now()}`;
  const handle = await client.workflow.signalWithStart("ObjectTypeFunnelWorkflow", {
    workflowId: funnelWorkflowId(ONTOLOGY_ID, rid),
    taskQueue: IDENTITY.temporalTaskQueue,
    args: [{
      ontologyId: ONTOLOGY_ID,
      objectTypeApiName: apiName,
      objectTypeRid: rid,
      environmentId: IDENTITY.environmentId,
    }],
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
  const conn = await Connection.connect({ address: IDENTITY.temporalAddress });
  console.log(`Connected to Temporal ${IDENTITY.temporalAddress} ns=${IDENTITY.temporalNamespace} queue=${IDENTITY.temporalTaskQueue} env=${IDENTITY.environmentId}`);
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
