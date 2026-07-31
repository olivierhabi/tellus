// One-shot: terminate a stuck ObjectTypeFunnelWorkflow in Temporal so
// the next save-to-ontology starts fresh instead of delivering signals
// to a workflow whose activity is hung. Equivalent to:
//   tctl workflow terminate --workflow_id ObjectTypeFunnelWorkflow-<OT>
// but without requiring tctl.
//
// Usage:
//   npx tsx scripts/terminate-stuck-funnel-workflow.ts <objectTypeApiName>
import "dotenv/config";
import { Client, Connection } from "@temporalio/client";

(async () => {
  const objectType = process.argv[2];
  if (!objectType) {
    process.stderr.write("Usage: terminate-stuck-funnel-workflow.ts <objectTypeApiName>\n");
    process.exit(2);
  }
  // FUNN-ISO: identity-resolved namespace; workflow ids are RID-keyed
  // (new dispatches) with a legacy api-name fallback (migration window).
  const { resolveEnvironmentIdentity } = await import("../src/config/environmentIdentity");
  const identity = resolveEnvironmentIdentity();
  const address = identity.temporalAddress;
  const namespace = identity.temporalNamespace;
  const ridLookup = await (await import("../src/db")).query(
    `SELECT object_type_id, ontology_id FROM object_type WHERE api_name = $1 LIMIT 1`,
    [objectType],
  );
  const rid = ridLookup.rows[0];
  const workflowId = rid
    ? `ObjectTypeFunnelWorkflow/${rid.ontology_id}/${rid.object_type_id}`
    : `ObjectTypeFunnelWorkflow-${objectType}`;

  const conn = await Connection.connect({ address });
  const client = new Client({ connection: conn, namespace });
  const handle = client.workflow.getHandle(workflowId);

  try {
    const desc = await handle.describe();
    console.log(
      JSON.stringify({
        workflowId,
        runId: desc.runId,
        status: desc.status.name,
        startTime: desc.startTime,
      }, null, 2)
    );
    if (desc.status.name === "RUNNING") {
      await handle.terminate("manual unstick — workflow was blocked");
      console.log("TERMINATED");
    } else {
      console.log("SKIPPED (not running)");
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (/not found/i.test(msg) || /NotFound/i.test(msg)) {
      console.log("NOT FOUND (no workflow with this id)");
    } else {
      throw err;
    }
  } finally {
    await conn.close();
  }
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`CRASH: ${err?.stack ?? err}\n`);
  process.exit(1);
});
