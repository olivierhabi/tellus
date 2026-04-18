// ---------------------------------------------------------------------------
// Temporal worker bootstrap — Task B3
//
// Registers the ObjectTypeFunnelWorkflow + activities against the
// `tellus-funnel` namespace on the Temporal cluster. Called from
// `src/server.ts` at boot.
//
// If Temporal is unreachable (env var not set, or cluster down) the
// worker simply does not start and the PG-backed funnelDispatcher stays
// as the fallback — the two pipelines are interchangeable at the
// activity boundary, so there is no duplicate-work hazard.
// ---------------------------------------------------------------------------

import { NativeConnection, Worker } from "@temporalio/worker";
import { Client, Connection } from "@temporalio/client";
import * as activities from "./activities";
import type { SignalPayload } from "./workflows";

let workerInstance: Worker | null = null;
let temporalClient: Client | null = null;

/**
 * Is Temporal actually reachable? Return null (not throw) so server
 * startup never hard-fails on a down cluster.
 */
async function tryConnect(
  address: string
): Promise<{ native: NativeConnection; client: Connection } | null> {
  try {
    const native = await NativeConnection.connect({ address });
    const client = await Connection.connect({ address });
    return { native, client };
  } catch (err) {
    console.warn(
      `[temporal] could not connect to ${address}: ${(err as Error).message}`
    );
    return null;
  }
}

export async function startTemporalWorker(): Promise<boolean> {
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "tellus-funnel";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "tellus-funnel-queue";

  const conn = await tryConnect(address);
  if (!conn) return false;

  try {
    workerInstance = await Worker.create({
      connection: conn.native,
      namespace,
      taskQueue,
      workflowsPath: require.resolve("./workflows"),
      activities,
      // Keep the worker small for single-process dev; raise these in prod.
      maxConcurrentActivityTaskExecutions: 20,
      maxConcurrentWorkflowTaskExecutions: 10,
    });
    temporalClient = new Client({ connection: conn.client, namespace });
    // Fire-and-forget the run loop.
    void workerInstance.run().catch((err) => {
      console.error(`[temporal] worker run failed: ${(err as Error).message}`);
    });
    console.log(
      `[temporal] worker started on ${address} ns=${namespace} queue=${taskQueue}`
    );
    return true;
  } catch (err) {
    console.warn(`[temporal] worker bootstrap failed: ${(err as Error).message}`);
    return false;
  }
}

export async function stopTemporalWorker(): Promise<void> {
  if (workerInstance) {
    try {
      workerInstance.shutdown();
    } catch {
      /* ignore */
    }
    workerInstance = null;
  }
  temporalClient = null;
}

/**
 * Start (or update) the ObjectTypeFunnelWorkflow for an Object Type and
 * signal it. Idempotent: starting an already-running workflow returns
 * the existing handle. Returns false if Temporal is not connected.
 */
export async function signalTemporalWorkflow(
  ontologyId: string,
  objectTypeApiName: string,
  signalType: "sourceTransactionCommitted" | "editBatchPending" | "schemaChanged",
  payload: SignalPayload = {}
): Promise<boolean> {
  if (!temporalClient) return false;
  try {
    const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "tellus-funnel-queue";
    const workflowId = `ObjectTypeFunnelWorkflow-${objectTypeApiName}`;
    await temporalClient.workflow.signalWithStart("ObjectTypeFunnelWorkflow", {
      workflowId,
      taskQueue,
      args: [{ ontologyId, objectTypeApiName }],
      signal: signalType,
      signalArgs: [payload],
    });
    return true;
  } catch (err) {
    console.warn(
      `[temporal] signalWithStart failed for ${objectTypeApiName}: ${(err as Error).message}`
    );
    return false;
  }
}

export function isTemporalConnected(): boolean {
  return temporalClient != null && workerInstance != null;
}
