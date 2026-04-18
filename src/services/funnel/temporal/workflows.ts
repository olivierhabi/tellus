// ---------------------------------------------------------------------------
// Temporal workflows — Task B3
//
// ObjectTypeFunnelWorkflow is the spine of the Funnel. One long-running
// parent workflow per Object Type, listening on three signals
// (sourceTransactionCommitted, editBatchPending, schemaChanged). Each
// signal wakes the workflow and drives the four-stage chain:
//   changelog (B4) → merge (B5) → indexing (B6) → hydration (B8)
//
// Determinism rules:
//   * No Math.random, Date.now, network, filesystem, or require() calls
//     inside this file — all I/O is in the activities.
//   * We rely on `@temporalio/workflow` primitives (proxyActivities,
//     defineSignal, condition, sleep) which Temporal patches to be
//     deterministic under replay.
// ---------------------------------------------------------------------------

import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  sleep,
} from "@temporalio/workflow";
import type * as Activities from "./activities";

// Activity proxies with per-stage timeouts + retry policies matching the
// spec §B3 values exactly:
//   Changelog: 1 hour, 5 attempts
//   Merge:     2 hours, 5 attempts
//   Indexing:  4 hours, 3 attempts
//   Hydration: 30 minutes, 10 attempts
//
// Temporal doesn't support per-activity options on a single proxy, so we
// instantiate one proxy per stage. Each call site below references the
// proxy that carries its stage's SLA.
const BACKOFF = {
  initialInterval: "1s",
  maximumInterval: "60s",
  backoffCoefficient: 2,
} as const;

const { runChangelogActivity } = proxyActivities<typeof Activities>({
  startToCloseTimeout: "1 hour",
  retry: { ...BACKOFF, maximumAttempts: 5 },
});

const { runMergeActivity } = proxyActivities<typeof Activities>({
  startToCloseTimeout: "2 hours",
  retry: { ...BACKOFF, maximumAttempts: 5 },
});

const { runIndexingActivityProxy } = proxyActivities<typeof Activities>({
  startToCloseTimeout: "4 hours",
  retry: { ...BACKOFF, maximumAttempts: 3 },
});

const { runHydrationActivityProxy } = proxyActivities<typeof Activities>({
  startToCloseTimeout: "30 minutes",
  retry: { ...BACKOFF, maximumAttempts: 10 },
});

// Projection to Postgres is best-effort and should never block the
// pipeline — short timeout, bounded retries.
const { projectStageToPostgres } = proxyActivities<typeof Activities>({
  startToCloseTimeout: "1 minute",
  retry: { ...BACKOFF, maximumAttempts: 3 },
});

// Signals the parent workflow listens on. The dispatcher (or an external
// Temporal client) signals the workflow via
// `client.workflow.getHandle(workflowId).signal(sourceTxnSignal, {...})`.
export interface SignalPayload {
  signalId?: string;
  transactionId?: string;
  editBatchSize?: number;
  schemaChangeEventId?: string;
}

export const sourceTxnSignal = defineSignal<[SignalPayload]>("sourceTransactionCommitted");
export const editBatchSignal = defineSignal<[SignalPayload]>("editBatchPending");
export const schemaChangeSignal = defineSignal<[SignalPayload]>("schemaChanged");

export interface ObjectTypeFunnelInput {
  ontologyId: string;
  objectTypeApiName: string;
}

/**
 * Parent workflow per Object Type. Runs forever (as designed) —
 * `continueAsNew` should be periodically called to keep event history
 * bounded in a production deployment. That's omitted here for brevity;
 * add it once you onboard >100 types.
 */
export async function ObjectTypeFunnelWorkflow(
  input: ObjectTypeFunnelInput
): Promise<void> {
  const pending: SignalPayload[] = [];
  setHandler(sourceTxnSignal, (p) => { pending.push(p); });
  setHandler(editBatchSignal, (p) => { pending.push(p); });
  setHandler(schemaChangeSignal, (p) => { pending.push(p); });

  // Monotonic counter used as a fallback runKey when a signal arrives
  // without a `signalId`. Scoped to the workflow instance; persisted
  // across replays by Temporal's history.
  let pendingDrainedCount = 0;

  while (true) {
    // Block until we have work OR a 5-minute heartbeat tick (keeps
    // history progressing even during idle so visibility stays fresh).
    const hasWork = await Promise.race([
      condition(() => pending.length > 0, "5m").then(() => "work"),
      sleep("5m").then(() => "tick"),
    ]);
    if (hasWork === "tick" && pending.length === 0) continue;

    // Drain all queued signals as one pipeline pass. Temporal workflows
    // are single-threaded so this loop is safe.
    //
    // CRITICAL: pass a per-signal `runKey` to every
    // `projectStageToPostgres` call so each save → its own funnel_run
    // row. The parent workflow is long-lived; without runKey scoping,
    // the ON CONFLICT (temporal_workflow_id) clause in the activity
    // would merge every pipeline execution into a single row and the
    // UI would see no new run on repeat saves.
    while (pending.length > 0) {
      const sig = pending.shift() as SignalPayload | undefined;
      // Fall back to a Temporal-deterministic monotonic workflow time
      // if the caller didn't attach a signalId. Temporal's `sleep(1)`
      // returning immediately gives us a workflow-history-safe sentinel
      // — `Date.now()` is NOT deterministic inside a workflow.
      const runKey = sig?.signalId ?? `nosig-${pendingDrainedCount++}`;

      await projectStageToPostgres({ ...input, currentStage: "changelog", runKey });
      const changelog = await runChangelogActivity(input);

      await projectStageToPostgres({
        ...input,
        currentStage: "merge",
        completedPrevious: "changelog",
        runKey,
      });
      const merge = await runMergeActivity({ ...input, changelogRows: changelog.rows });

      await projectStageToPostgres({
        ...input,
        currentStage: "indexing",
        objectsIndexed: merge.upserts,
        completedPrevious: "merge",
        runKey,
      });
      const indexing = await runIndexingActivityProxy({
        ...input,
        mergedRows: merge.mergedRows,
        editIds: merge.editIds,
      });

      await projectStageToPostgres({
        ...input,
        currentStage: "hydration",
        completedPrevious: "indexing",
        runKey,
      });
      await runHydrationActivityProxy({
        ...input,
        publishedSplitIds: indexing.publishedSplitIds,
      });

      await projectStageToPostgres({
        ...input,
        currentStage: null,
        completedPrevious: "hydration",
        runKey,
      });
    }
  }
}
