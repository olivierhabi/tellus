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
import * as pipelineActivities from "../../pipelines/temporal/activities";
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
      // PB-B4 follow-3.1 — register both the Funnel's own workflows
      // and the Pipeline-Builder workflows under the same worker so
      // pb-b4 iceberg maintenance runs on the existing task queue.
      // Worker.create only accepts one workflowsPath per worker, so
      // we expose a re-exporting bridge module that barrels both sets
      // into a single package; activities merge cleanly via spread.
      workflowsPath: require.resolve("./workflowsBundle"),
      activities: { ...activities, ...pipelineActivities },
      // Keep the worker small for single-process dev; raise these in prod.
      maxConcurrentActivityTaskExecutions: 20,
      maxConcurrentWorkflowTaskExecutions: 10,
    });
    temporalClient = new Client({ connection: conn.client, namespace });
    // Fire-and-forget the run loop.
    void workerInstance.run().catch(async (err) => {
      console.error(`[temporal] worker run failed: ${(err as Error).message}`);
      // PB-B9 — temporal_workflow_failures_total counter.
      try {
        const { recordTemporalFailure } = await import(
          "../../pipelines/metrics"
        );
        recordTemporalFailure(
          "worker",
          (err as Error).name ?? "unknown",
        );
      } catch {
        /* ignore */
      }
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
  signalType:
    | "sourceTransactionCommitted"
    | "editBatchPending"
    | "schemaChanged"
    | "pipelineDeployCompleted",
  payload: SignalPayload = {}
): Promise<boolean> {
  if (!temporalClient) return false;
  try {
    const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "tellus-funnel-queue";
    const workflowId = `ObjectTypeFunnelWorkflow-${objectTypeApiName}`;

    // Determine conflict policy — prod-safe default `USE_EXISTING` keeps
    // the spec's "one long-running parent workflow per OT" invariant.
    // Opt-in `FUNNEL_TERMINATE_ON_SAVE=true` makes every save forcibly
    // replace an in-flight workflow (the verify-funnel-reset semantic).
    // Before terminating we give the workflow up to
    // FUNNEL_CANCEL_TIMEOUT_MS (default 30s) to exit gracefully via a
    // cancel — so an activity that's merely retrying a transient PG/S3
    // error gets to finish its attempt and idempotently commit.
    const terminateOnSave = process.env.FUNNEL_TERMINATE_ON_SAVE === "true";
    if (terminateOnSave) {
      await cancelWithTimeoutIfStuck(workflowId);
      incrementCounter("funnel_workflow_terminate_on_save_total", {
        object_type: objectTypeApiName,
      });
    }

    // Resolve the continue-as-new threshold HERE on the host. Temporal
    // workflow code runs inside a V8 isolate sandbox with no `process`
    // global, so `process.env.*` MUST NOT be read inside workflows.ts —
    // doing so throws `ReferenceError: process is not defined` the moment
    // the workflow starts. See ObjectTypeFunnelInput.continueAsNewThreshold.
    const continueAsNewThresholdRaw =
      process.env.FUNNEL_WORKFLOW_CONTINUE_AS_NEW_THRESHOLD;
    const continueAsNewThresholdParsed = continueAsNewThresholdRaw
      ? Number(continueAsNewThresholdRaw)
      : NaN;
    const continueAsNewThreshold =
      Number.isFinite(continueAsNewThresholdParsed) &&
      continueAsNewThresholdParsed > 0
        ? Math.floor(continueAsNewThresholdParsed)
        : undefined;

    await temporalClient.workflow.signalWithStart("ObjectTypeFunnelWorkflow", {
      workflowId,
      taskQueue,
      args: [{ ontologyId, objectTypeApiName, continueAsNewThreshold }],
      signal: signalType,
      signalArgs: [payload],
      workflowIdConflictPolicy: terminateOnSave ? "TERMINATE_EXISTING" : "USE_EXISTING",
    });
    incrementCounter("funnel_signal_with_start_total", {
      object_type: objectTypeApiName,
      signal_type: signalType,
    });
    return true;
  } catch (err) {
    incrementCounter("funnel_signal_with_start_errors_total", {
      object_type: objectTypeApiName,
    });
    console.warn(
      `[temporal] signalWithStart failed for ${objectTypeApiName}: ${(err as Error).message}`
    );
    return false;
  }
}

/**
 * Graceful-replace pattern: if a workflow for this ID is currently
 * running and has been for longer than `FUNNEL_CANCEL_STALE_THRESHOLD_MS`
 * (default 2 min), send a cancel, wait up to `FUNNEL_CANCEL_TIMEOUT_MS`
 * (default 30s) for it to exit, then let the caller's signalWithStart
 * with TERMINATE_EXISTING finish the job. Side effects from the
 * in-flight activity are allowed to complete idempotently — the
 * activity code is written so that partial writes + retries converge.
 */
async function cancelWithTimeoutIfStuck(workflowId: string): Promise<void> {
  if (!temporalClient) return;
  const staleMs = Number(process.env.FUNNEL_CANCEL_STALE_THRESHOLD_MS ?? 2 * 60 * 1000);
  const timeoutMs = Number(process.env.FUNNEL_CANCEL_TIMEOUT_MS ?? 30_000);
  try {
    const handle = temporalClient.workflow.getHandle(workflowId);
    const desc = await handle.describe();
    if (desc.status.name !== "RUNNING") return;
    const ageMs = Date.now() - desc.startTime.getTime();
    if (ageMs < staleMs) return; // still fresh; let signalWithStart reuse or terminate
    incrementCounter("funnel_workflow_cancel_attempted_total", {
      object_type: workflowId.replace(/^ObjectTypeFunnelWorkflow-/, ""),
    });
    await handle.cancel();
    const giveUpAt = Date.now() + timeoutMs;
    while (Date.now() < giveUpAt) {
      await new Promise((r) => setTimeout(r, 500));
      const now = await handle.describe();
      if (now.status.name !== "RUNNING") {
        incrementCounter("funnel_workflow_cancelled_cleanly_total", {});
        return;
      }
    }
    incrementCounter("funnel_workflow_cancel_timeout_total", {});
    // Fall through — caller's signalWithStart(TERMINATE_EXISTING) will
    // forcibly close the workflow.
  } catch (err) {
    const msg = (err as Error).message;
    // Not-found = workflow doesn't exist yet; nothing to cancel.
    if (!/not found/i.test(msg) && !/NotFound/i.test(msg)) {
      console.warn(
        `[temporal] cancelWithTimeoutIfStuck(${workflowId}): ${msg}`
      );
    }
  }
}

/** Internal metrics handle — delegates to the ../metrics module when
 *  available. We require it lazily so the worker module stays usable
 *  in unit tests where the metrics module might not be wired. */
function incrementCounter(name: string, labels: Record<string, string>): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require("../metrics") as typeof import("../metrics");
    m.incCounter(name, labels);
  } catch {
    /* metrics module not loaded — no-op */
  }
}

/** Internal accessor used by the sweeper. Null when Temporal isn't connected. */
export function getTemporalClient(): Client | null {
  return temporalClient;
}

export function isTemporalConnected(): boolean {
  return temporalClient != null && workerInstance != null;
}
