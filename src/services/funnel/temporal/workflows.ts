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

// heartbeatTimeout: every stage activity runs startHeartbeatLoop (5s ticks),
// so 120s of silence means the worker is GONE (crash/SIGKILL/deploy). Without
// this, Temporal cannot detect worker death and a stage stalls for the FULL
// startToCloseTimeout before retrying (observed: a merge sat "Started" for
// 90+ minutes after the worker was SIGTERMed mid-activity).
const { runChangelogActivity } = proxyActivities<typeof Activities>({
  startToCloseTimeout: "1 hour",
  heartbeatTimeout: "120s",
  retry: { ...BACKOFF, maximumAttempts: 5 },
});

const { runMergeActivity } = proxyActivities<typeof Activities>({
  startToCloseTimeout: "2 hours",
  heartbeatTimeout: "120s",
  retry: { ...BACKOFF, maximumAttempts: 5 },
});

const { runIndexingActivityProxy } = proxyActivities<typeof Activities>({
  startToCloseTimeout: "4 hours",
  heartbeatTimeout: "120s",
  retry: { ...BACKOFF, maximumAttempts: 3 },
});

const { runHydrationActivityProxy } = proxyActivities<typeof Activities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "120s",
  retry: { ...BACKOFF, maximumAttempts: 10 },
});

// Projection to Postgres is best-effort and should never block the
// pipeline — short timeout, bounded retries.
const { projectStageToPostgres } = proxyActivities<typeof Activities>({
  startToCloseTimeout: "1 minute",
  retry: { ...BACKOFF, maximumAttempts: 3 },
});

// Terminal `funnel_state` projection (badge: Indexed / Failed). Lives on the
// same low-timeout policy as `projectStageToPostgres` — the underlying helper
// already swallows DB errors internally, so retries here exist only to absorb
// transient worker → Postgres network blips.
const { projectFunnelTerminalActivity } = proxyActivities<typeof Activities>({
  startToCloseTimeout: "1 minute",
  retry: { ...BACKOFF, maximumAttempts: 3 },
});

// OpenSearch sync — runs after merge so the FE search panel
// (`useObjectSearch` → /api/v1/objects/:apiName/search → OpenSearch)
// reflects freshly-merged rows immediately. Without this the badge says
// "Indexed / 500 objects" but the right-rail search returns 0 hits and
// the "500 objects pending index" empty-state fires. 10 min is generous
// for a 1M-row index; bulkIndex pages internally.
const { syncOpenSearchActivity } = proxyActivities<typeof Activities>({
  // 60 min + heartbeatTimeout: a 5.6M-row OT (OlivierOrder2) bulk-indexes
  // ~4.66M docs into a fresh OpenSearch index. On the dev single-box cluster
  // that is ~8 s / 5000-doc page (~2 hr total) — far beyond the prior 10-min
  // startToCloseTimeout, which exhausted the 5-attempt retry budget mid-sync
  // (the resume cursor is durable, but each attempt only covered ~75 pages).
  // 60 min lets one attempt cover ~450 pages; 5 attempts × 60 min = 5 hr
  // budget for a ~2 hr sync. heartbeatTimeout=120 s makes a worker death
  // (OOM/SIGTERM) auto-retry from the heartbeat cursor instead of orphaning
  // the activity (no heartbeatTimeout → stuck until startToClose). The sync
  // heartbeats after every page (pages run <60 s), so 120 s is false-retry-safe.
  startToCloseTimeout: "60 minutes",
  heartbeatTimeout: "120 seconds",
  retry: { ...BACKOFF, maximumAttempts: 5 },
});

// Signals the parent workflow listens on. The dispatcher (or an external
// Temporal client) signals the workflow via
// `client.workflow.getHandle(workflowId).signal(sourceTxnSignal, {...})`.
export interface SignalPayload {
  signalId?: string;
  /** FUNN-ISO-6: pre-created funnel_run (status=dispatch_pending) this
   *  signal drives — binds outbox row ↔ Temporal execution for terminal
   *  CAS + audit. */
  funnelRunId?: string;
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
  /**
   * FUNN-ISO-2 — stable object-type RID. The dispatching environment
   * resolved (ontologyId, apiName, rid) at dispatch time; the activity
   * fence verifies the triple against the database it actually reads, so a
   * worker pointed at the wrong DB can never "successfully" run a pass
   * whose expected resources do not exist there.
   */
  objectTypeRid?: string;
  /**
   * FUNN-ISO-3 — deployment environment identity stamped into the workflow
   * at dispatch. Every activity fence-compares it against (a) its own
   * worker identity and (b) the database seal. Immutable per workflow run.
   */
  environmentId?: string;
  /**
   * FNL-H1 — state carried across a `continueAsNew` boundary. Fresh
   * workflow invocations omit this; continue-as-new child workflows
   * receive the parent's running state so SLI counters and the
   * last-processed signal id survive the history-compaction cut.
   */
  seedCompletedRuns?: number;
  seedLastProcessedSignalId?: string;
  /**
   * Override for `CONTINUE_AS_NEW_DEFAULT_THRESHOLD`. Resolved on the
   * host side (worker.ts reads `FUNNEL_WORKFLOW_CONTINUE_AS_NEW_THRESHOLD`
   * and forwards it here). The Temporal workflow sandbox has no `process`
   * global, so env reads MUST happen outside the workflow and be threaded
   * in via input — otherwise the workflow throws
   * `ReferenceError: process is not defined` on startup.
   */
  continueAsNewThreshold?: number;
}

/**
 * Default threshold at which the workflow self-truncates via
 * `continueAsNew`. Override via `FUNNEL_WORKFLOW_CONTINUE_AS_NEW_THRESHOLD`
 * on the worker/host side (see `signalTemporalWorkflow` in `worker.ts`).
 */
export const CONTINUE_AS_NEW_DEFAULT_THRESHOLD = 100;

function resolveContinueAsNewThreshold(input: ObjectTypeFunnelInput): number {
  const n = input.continueAsNewThreshold;
  if (typeof n === "number" && Number.isFinite(n) && n > 0) {
    return Math.floor(n);
  }
  return CONTINUE_AS_NEW_DEFAULT_THRESHOLD;
}

/**
 * Walk the Temporal failure `.cause` chain to the root ApplicationFailure so
 * `funnel_state.error_message` carries the REAL error (e.g. "Cannot create a
 * string longer than 0x1fffffe8 characters") instead of the generic wrapper
 * "Activity task failed" that Temporal wraps activity failures in. Without
 * this unwrap, the OO7 root cause was masked by the ActivityFailure's own
 * `.message` and the UI badge showed a useless "Activity task failed".
 *
 * Pure property access — deterministic, safe inside the workflow sandbox.
 * Falls back to the top-level `.message` if no cause chain is present.
 */
/**
 * Walk the Temporal failure `.cause` chain looking for a specific typed
 * error name (e.g. "FunnelObjectTypeMissing",
 * "FunnelExecutionEnvironmentMismatch"). Temporal wraps activity throws in
 * ActivityFailure/ApplicationFailure — custom error .name is preserved on
 * ApplicationFailure.type (and .message otherwise).
 *
 * Pure property access — deterministic, safe inside the workflow sandbox.
 */
function isTypedCause(err: unknown, typeName: string): boolean {
  let cur = err as { name?: string; type?: string; message?: string; cause?: unknown } | undefined;
  let depth = 0;
  while (cur && depth < 16) {
    if (cur.name === typeName || cur.type === typeName) return true;
    if (typeof cur.message === "string" && cur.message.includes(typeName)) return true;
    cur = cur.cause as typeof cur;
    depth++;
  }
  return false;
}

function rootCauseMessage(err: unknown): string {
  let cur = err as { message?: string; cause?: unknown } | undefined;
  let msg = cur instanceof Error ? cur.message : "Funnel pipeline failed";
  let depth = 0;
  while (cur?.cause && depth < 16) {
    const c = cur.cause as { message?: string; cause?: unknown } | undefined;
    if (c && typeof c.message === "string" && c.message.length > 0) {
      msg = c.message;
    }
    cur = c;
    depth++;
  }
  return msg;
}

/**
 * Parent workflow per Object Type. FNL-H1 — once the workflow has
 * completed `CONTINUE_AS_NEW_DEFAULT_THRESHOLD` signals it calls
 * `continueAsNew(...)` with the rolling counters so Temporal's history
 * stays bounded even for 100k+ signals.
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
  let completedRuns = input.seedCompletedRuns ?? 0;
  let lastProcessedSignalId = input.seedLastProcessedSignalId;
  const threshold = resolveContinueAsNewThreshold(input);

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
      /** FUNN-ISO-6: the pre-created funnel_run (dispatch_pending) this
       *  signal drives — threaded into terminal projections for CAS. */
      const funnelRunId = sig?.funnelRunId;

      // Per-signal terminal projection — wraps the four-stage pipeline so
      // `funnel_state.status` always flips from 'indexing' to either
      // 'indexed' (with the run's objects_indexed count) or 'failed' (with
      // the activity error message). Before this guard existed the badge
      // could stay stuck at 'indexing' forever if the pipeline threw
      // anywhere between changelog and hydration — the dispatcher had
      // already set `pre_temporal: 'indexing'` and nothing else ever ran
      // to advance it. Wrapping here means a single round-trip to the
      // projection activity catches both happy- and sad-path exits.
      try {
        await projectStageToPostgres({ ...input, currentStage: "changelog", runKey });
        const changelog = await runChangelogActivity(input);

        await projectStageToPostgres({
          ...input,
          currentStage: "merge",
          completedPrevious: "changelog",
          runKey,
          stageOutput: {
            rowsEmitted: changelog.rowsEmitted,
            snapshotId: changelog.snapshotId,
          },
        });
        const merge = await runMergeActivity({
          ...input,
          changelogSnapshotId: changelog.snapshotId,
          changelogOwnedProperties: changelog.ownedProperties,
          runKey,
        });

        // Sync the freshly-merged rows into OpenSearch so the FE search
        // panel can see them in the same round-trip. Runs BEFORE the
        // Quickwit indexing stage because that path goes through Kafka
        // and has its own publish-wait — we don't want the FE pretending
        // the OT is empty for that interval. Best-effort: if the sync
        // fails we still continue with Quickwit indexing so the funnel's
        // primary store stays consistent; the terminal projection's
        // outer catch will surface any error in `funnel_state`.
        await syncOpenSearchActivity({
          ontologyId: input.ontologyId,
          objectTypeApiName: input.objectTypeApiName,
          objectTypeRid: input.objectTypeRid,
          environmentId: input.environmentId,
        });

        await projectStageToPostgres({
          ...input,
          currentStage: "indexing",
          objectsIndexed: merge.upserts,
          completedPrevious: "merge",
          runKey,
          stageOutput: {
            upserts: merge.upserts,
            deletes: merge.deletes,
            mergedRowCount: merge.mergedRowCount,
            mergedSnapshotId: merge.mergedSnapshotId,
          },
        });
        const indexing = await runIndexingActivityProxy({
          ...input,
          mergedSnapshotId: merge.mergedSnapshotId,
          mergedRowCount: merge.mergedRowCount,
        });

        await projectStageToPostgres({
          ...input,
          currentStage: "hydration",
          completedPrevious: "indexing",
          runKey,
          stageOutput: {
            editsIndexed: indexing.editsIndexed,
            publishedSplitCount: indexing.publishedSplitIds.length,
            quickwit: indexing.quickwit,
          },
        });
        const hydration = await runHydrationActivityProxy({
          ...input,
          publishedSplitIds: indexing.publishedSplitIds,
        });

        await projectStageToPostgres({
          ...input,
          currentStage: null,
          completedPrevious: "hydration",
          runKey,
          stageOutput: { prefetched: hydration.prefetched },
        });

        // Terminal projection: flip the UI badge from 'indexing' → 'indexed'
        // and stamp `funnel_state.objects_indexed` with the merge stage's
        // upsert count (which is the count of distinct primary keys
        // surfaced from the backing datasource on this run). The shared
        // helper additionally broadcasts a `funnel_state.changed` WebSocket
        // event so the OT overview page updates in sub-second latency.
        await projectFunnelTerminalActivity({
          ontologyId: input.ontologyId,
          objectTypeApiName: input.objectTypeApiName,
          objectTypeRid: input.objectTypeRid,
          environmentId: input.environmentId,
          status: "indexed",
          objectsIndexed: merge.upserts,
          funnelRunId,
          runKey,
        });
      } catch (err) {
        // FUNN-ISO-4 — an expected-identity projection that cannot resolve
        // the object type means the type was deleted mid-run (or, in the
        // bad old world, the activity landed in the wrong DB). Mark the run
        // with the explicit terminal state `object_type_deleted` and
        // continue draining signals — do NOT rethrow (the pipeline itself
        // was fine) and never report "indexed".
        if (isTypedCause(err, "FunnelObjectTypeMissing")) {
          try {
            await projectFunnelTerminalActivity({
              ontologyId: input.ontologyId,
              objectTypeApiName: input.objectTypeApiName,
              objectTypeRid: input.objectTypeRid,
              environmentId: input.environmentId,
              status: "cancelled",
              errorMessage: `object_type_deleted: ${rootCauseMessage(err)}`,
              funnelRunId,
              runKey,
              allowObjectTypeDeletedMarking: true,
            });
          } catch {
            /* projection best-effort; there is no OT left to write to */
          }
          continue;
        }
        // ANY exception in the four-stage pipeline lands us here. We must
        // still flip the badge so the user sees 'Failed' instead of an
        // eternal 'Indexing' spinner — then re-throw so Temporal applies
        // its activity-level retry policy and writes the workflow failure
        // to history.
        // Unwrap the Temporal ActivityFailure `.cause` chain to the REAL
        // root message — otherwise the badge shows the generic "Activity task
        // failed" wrapper instead of e.g. "Cannot create a string longer than
        // 0x1fffffe8 characters" (the OO7 symptom). Also pass `runKey` so the
        // projection marks funnel_run failed (not just funnel_state) — closing
        // the divergence that left funnel_run stuck at "changelog".
        const message = rootCauseMessage(err);
        // Best-effort — if projection itself throws (e.g. PG down), the
        // outer rethrow still surfaces the original pipeline error.
        try {
          await projectFunnelTerminalActivity({
            ontologyId: input.ontologyId,
            objectTypeApiName: input.objectTypeApiName,
            objectTypeRid: input.objectTypeRid,
            environmentId: input.environmentId,
            status: "failed",
            errorMessage: message,
            funnelRunId,
            runKey,
            allowObjectTypeDeletedMarking: true,
          });
        } catch {
          /* projection is best-effort; original error wins below */
        }
        throw err;
      }

      completedRuns++;
      if (sig?.signalId) lastProcessedSignalId = sig.signalId;
    }

    // FNL-H1 — once we've completed `threshold` signals, continue-as-new
    // so Temporal history resets. State that must survive is passed via
    // the child workflow's input; the rest lives in Postgres (`funnel_run`
    // is the durable ledger).
    if (completedRuns >= threshold) {
      // `continueAsNew` throws a ContinueAsNew error that the Temporal
      // runtime catches to start the child workflow.
      const { continueAsNew } = await import("@temporalio/workflow");
      await continueAsNew<typeof ObjectTypeFunnelWorkflow>({
        ontologyId: input.ontologyId,
        objectTypeApiName: input.objectTypeApiName,
        seedCompletedRuns: 0,
        seedLastProcessedSignalId: lastProcessedSignalId,
        // Preserve the host-resolved threshold across the continue-as-new
        // boundary so the child workflow doesn't fall back to the default
        // when the operator has configured a non-default value.
        continueAsNewThreshold: input.continueAsNewThreshold,
      });
      // Unreachable — continueAsNew throws internally — but TS needs it.
      return;
    }
  }
}
