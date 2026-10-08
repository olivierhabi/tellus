// ---------------------------------------------------------------------------
// Funnel Dispatcher — runtime loop
//
// Background worker that consumes pending `funnel_signal` rows and drives
// each Object Type's durable workflow through the four-stage pipeline:
//   changelog (B4) → merge (B5) → indexing (B6) → hydration (B8).
//
// Today this is a single-process, single-tenant loop. In production it
// would be a fleet of Temporal workers; `durableWorkflow.ts` is shaped so
// the workflow function can be hoisted into Temporal's TS SDK without
// changing the activity implementations.
//
// The dispatcher picks one signal at a time per object type (FOR UPDATE
// SKIP LOCKED), runs the stage chain inside a `runWorkflow`, and advances
// the externally-visible `current_stage` tag in `funnel_run` so the UI
// can project status in < 1 second (B3 acceptance).
// ---------------------------------------------------------------------------

import { query } from "../../db";
import { claimNextSignal, runWorkflow, WorkflowContext } from "./durableWorkflow";
import { sleepForStageDelay, writeStageReceipt } from "./stageDelay";
import { projectFunnelTerminalToState } from "./funnelStateProjection";
import {
  getEnvironmentIdentity,
  identityLogFields,
} from "../../config/environmentIdentity";
import {
  observeDispatchPendingAge,
  recordRunStuck,
} from "./isolationMetrics";
import {
  computeChangelog,
  SnapshotDiffReader,
  SourceChangeRow,
} from "./changelogStage";
import {
  DatasourceContribution,
  EditStrategy,
  loadChangelogRowsFromSnapshot,
} from "./mergeStage";
import {
  createTable,
  funnelNamespace,
  getTable,
  FunnelDatasetRow,
} from "./icebergCatalog";
import {
  getPendingMergeEdits,
  getPendingIndexEdits,
  markEditsAppliedToIndex,
} from "../../models/ontologyEdit";
import { runIndexingActivity } from "../quickwit/indexingActivity";
import {
  buildFullIndexBatch,
  recordIndexingDeferred,
  updatePendingIndexGauges,
} from "./indexingStage";
import { ensureIndex } from "../quickwit/indexManager";
import { MergedRow } from "../quickwit/docBuilder";
import { runHydrationActivity } from "../quickwit/hydrationActivity";
import { isTemporalConnected } from "./temporal/worker";
import {
  duckdbIcebergDiffReader,
  isDuckDBAvailable,
  mergeChangesMaybeDuckDB,
} from "./duckdbIceberg";

export interface DispatcherOptions {
  intervalMs?: number;
  /** If set, dispatcher runs against these types only (dev/test). */
  objectTypes?: string[];
}

let loopTimer: NodeJS.Timeout | null = null;
let loopRunning = false;

/**
 * Start the dispatcher loop. Safe to call multiple times — subsequent
 * calls are no-ops. The loop is self-throttling: a slow tick cannot
 * stack up, because we gate re-entry with `loopRunning`.
 */
export function startFunnelDispatcher(options: DispatcherOptions = {}): void {
  if (loopTimer) return;
  const intervalMs = options.intervalMs ?? 2_000;
  loopTimer = setInterval(async () => {
    if (loopRunning) return;
    loopRunning = true;
    try {
      await tick(options);
    } catch (err) {
      console.warn(
        `[funnel/dispatcher] tick failed: ${(err as Error).message}`
      );
    } finally {
      loopRunning = false;
    }
  }, intervalMs);
  loopTimer.unref?.();
}

export function stopFunnelDispatcher(): void {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
}

/**
 * Drain pending signals for every Object Type. Exposed for tests so a
 * fixture can pump the pipeline deterministically.
 */
export async function drainPendingSignals(
  options: DispatcherOptions = {}
): Promise<number> {
  return tick(options);
}

async function tick(options: DispatcherOptions): Promise<number> {
  // B3: if Temporal is connected, it is the authoritative pipeline —
  // the `/signals` endpoint already did `signalWithStart` against the
  // Temporal worker. The PG dispatcher must NOT also process the same
  // signals (that produced duplicate funnel_run rows and double-
  // committed snapshots). We still mark signals consumed so the inbox
  // stays drained for audit + testing.
  const temporalActive = isTemporalConnected();
  if (temporalActive) {
    // Best-effort retry of stale dispatch rows before processing new signals.
    try {
      await reconcileStaleDispatches();
      await reportStaleIndexingStates();
    } catch (err) {
      console.warn(`[funnel/dispatcher] reconcile tick failed: ${(err as Error).message}`);
    }
  }
  // Stall watchdog (both paths hold funnel_state locks — Temporal-driven and
  // PG-dispatcher alike). Two distinct sweeps on two distinct signals:
  // last_progress_at => STALLED (alive but not moving); lease_heartbeat_at
  // => DEAD (holder gone, no live run). A wedged run surfaces within the
  // stall budget instead of spinning forever.
  try {
    const { sweepStalledIndexing, sweepDeadIndexingLocks } = await import("./indexingLease");
    await sweepStalledIndexing();
    await sweepDeadIndexingLocks();
  } catch (err) {
    console.warn(`[funnel/dispatcher] stall sweep failed: ${(err as Error).message}`);
  }
  const objectTypes = options.objectTypes ?? (await listObjectTypesWithSignals());
  let runsStarted = 0;
  for (const objectTypeApiName of objectTypes) {
    const signal = await claimNextSignal(objectTypeApiName, null);
    if (!signal) continue;

    if (temporalActive) {
      // FUNN-ISO-6 — durable dispatch with ack + CAS. The outbox record is
      // the durable funnel_signal row (already claimed transactionally);
      // the funnel_run row is created FIRST with status 'dispatch_pending',
      // and only AFTER Temporal acknowledges the workflow start do we CAS
      // it to 'workflow_started'. If dispatch fails, the run stays
      // dispatch_pending and `reconcileStaleDispatches` retries it on the
      // next tick — no silent loss of either the signal or the status flip.
      const dispatched = await dispatchSignalToTemporal(
        signal.ontology_id,
        objectTypeApiName,
        signal,
      );
      if (dispatched) runsStarted++;
      continue;
    }

    // PG-dispatcher path. Flip the UI badge to "Indexing" BEFORE the
    // workflow runs so the user sees activity within one client poll
    // tick. Then project the terminal state (indexed / failed) once
    // `runWorkflow` returns. The funnel pipeline itself only writes
    // to `funnel_run` + `funnel_pipeline_state`; without this
    // projection the user-facing `funnel_state.status` would stay at
    // its previous value forever (typically `not_indexed`), which is
    // the bug pre-2026-05-06.
    const pgEnvId = getEnvironmentIdentity().environmentId;
    const otRow = await query(
      `SELECT object_type_id FROM object_type
        WHERE ontology_id = $1 AND api_name = $2 LIMIT 1`,
      [signal.ontology_id, objectTypeApiName],
    );
    const pgObjectTypeRid = otRow.rows[0]?.object_type_id as string | undefined;
    await projectFunnelTerminalToState(
      signal.ontology_id,
      objectTypeApiName,
      "indexing",
      { environmentId: pgEnvId, objectTypeRid: pgObjectTypeRid },
    );

    const result = await runWorkflow(
      {
        ontologyId: signal.ontology_id,
        objectTypeApiName,
        signalPayload: signal.payload,
      },
      (ctx) => objectTypeFunnelWorkflow(ctx, signal.signal_type, signal.payload)
    );

    if (result.status === "completed") {
      await projectFunnelTerminalToState(
        signal.ontology_id,
        objectTypeApiName,
        "indexed",
        {
          runId: result.runId,
          environmentId: pgEnvId,
          objectTypeRid: pgObjectTypeRid,
        },
      );
    } else {
      await projectFunnelTerminalToState(
        signal.ontology_id,
        objectTypeApiName,
        "failed",
        {
          runId: result.runId,
          errorMessage: result.errorMessage ?? "Funnel pipeline failed",
          environmentId: pgEnvId,
          objectTypeRid: pgObjectTypeRid,
        },
      );
    }

    await query(
      `UPDATE funnel_signal SET consumed_by_run_id = $1 WHERE signal_id = $2`,
      [result.runId, signal.signal_id]
    );
    runsStarted++;
  }
  return runsStarted;
}

// ---------------------------------------------------------------------------
// projectFunnelTerminalToState moved to ./funnelStateProjection (2026-05-16)
// so the Temporal worker can reuse the exact same projection semantics.
// Both this dispatcher and `temporal/activities.ts::projectFunnelTerminalActivity`
// call into the shared helper, which fixes a class of "indexing-stuck" bugs
// caused by drifted implementations on the two pipeline paths.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FUNN-ISO-6 — Durable Temporal dispatch.
//
// The funnel_signal claim IS the outbox transaction (FOR UPDATE SKIP LOCKED
// inside claimNextSignal). Here we:
//   1. resolve the object-type RID (stable identity),
//   2. pre-create funnel_run(status='dispatch_pending', environment_id=…),
//      keyed on the deterministic `temporal_workflow_id` — idempotent by
//      construction (redelivered claims upsert onto the same row),
//   3. call signalTemporalWorkflow and, only on Temporal ack, CAS the run
//      to 'workflow_started' and flip the UI badge to 'indexing'.
// On dispatch failure the run STAYS dispatch_pending and
// `reconcileStaleDispatches` retries — nothing is silently lost.
// ---------------------------------------------------------------------------

const DISPATCH_STALE_AFTER_MS = Number(
  process.env.FUNNEL_DISPATCH_STALE_AFTER_MS ?? 30_000,
);

/**
 * Insert the dispatch_pending run row stamping the immutable execution-plan
 * snapshot (FUNN-ISO-4). Exported so the pipeline-evolution tests can
 * exercise plan stamping directly.
 */
export async function insertDispatchPendingRun(
  ontologyId: string,
  objectTypeApiName: string,
  temporalWorkflowId: string,
  payload: Record<string, unknown>,
): Promise<string | undefined> {
  const identity = getEnvironmentIdentity();
  const { currentDefinition } = await import("./executionPlan");
  const plan = currentDefinition();
  const insert = await query(
    `INSERT INTO funnel_run
       (ontology_id, object_type_api_name, workflow_type, status,
        signal_payload, temporal_workflow_id, environment_id,
        definition_version, execution_plan)
     VALUES ($1, $2, 'ObjectTypeFunnelWorkflow.temporal', 'dispatch_pending',
             $3::jsonb, $4, $5, $6, $7::jsonb)
     ON CONFLICT (temporal_workflow_id)
       WHERE temporal_workflow_id IS NOT NULL
       DO NOTHING
     RETURNING run_id`,
    [
      ontologyId,
      objectTypeApiName,
      JSON.stringify(payload),
      temporalWorkflowId,
      identity.environmentId,
      plan.definitionVersion,
      JSON.stringify(plan),
    ],
  );
  let runId = insert.rows[0]?.run_id as string | undefined;
  if (!runId) {
    const existing = await query(
      `SELECT run_id FROM funnel_run WHERE temporal_workflow_id = $1`,
      [temporalWorkflowId],
    );
    runId = existing.rows[0]?.run_id as string | undefined;
  }
  return runId;
}

async function dispatchSignalToTemporal(
  ontologyId: string,
  objectTypeApiName: string,
  signal: { signal_id: string; signal_type: string; payload: Record<string, unknown> },
): Promise<boolean> {
  const identity = getEnvironmentIdentity();
  // 1. Stable OT identity — if the type is gone the signal is a no-op.
  const otRes = await query(
    `SELECT object_type_id FROM object_type
      WHERE ontology_id = $1 AND api_name = $2 LIMIT 1`,
    [ontologyId, objectTypeApiName],
  );
  const objectTypeRid = otRes.rows[0]?.object_type_id as string | undefined;
  if (!objectTypeRid) {
    console.warn(
      JSON.stringify({
        level: "warn",
        type: "funnel_dispatch_object_type_missing",
        ontologyId,
        objectTypeApiName,
        signalId: signal.signal_id,
        ...identityLogFields(identity),
      }),
    );
    return false;
  }

  // 2. Idempotent run-row pre-creation. temporal_workflow_id is the
  //    deterministic `<bareWfId>:<signalId>` key that
  //    projectStageToPostgres also upserts — the lifecycle converges on
  //    ONE funnel_run row per signal.
  const { funnelWorkflowId } = await import("./temporal/worker");
  const temporalWorkflowId = `${funnelWorkflowId(ontologyId, objectTypeRid)}:${signal.signal_id}`;
  const runId0 = await insertDispatchPendingRun(
    ontologyId,
    objectTypeApiName,
    temporalWorkflowId,
    { ...signal.payload, signalId: signal.signal_id },
  );
  if (!runId0) {
    console.warn(
      JSON.stringify({
        level: "warn",
        type: "funnel_dispatch_run_row_unavailable",
        objectTypeApiName,
        signalId: signal.signal_id,
      }),
    );
    return false;
  }
  const runId = runId0;

  // 3. Actual workflow start (idempotent signalWithStart).
  const { signalTemporalWorkflow } = await import("./temporal/worker");
  const ok = await signalTemporalWorkflow({
    ontologyId,
    objectTypeApiName,
    objectTypeRid,
    signalType: signal.signal_type as
      | "sourceTransactionCommitted"
      | "editBatchPending"
      | "schemaChanged"
      | "pipelineDeployCompleted",
    payload: { ...signal.payload, signalId: signal.signal_id, funnelRunId: runId },
  });
  if (!ok) {
    // Leave status='dispatch_pending' — reconciliation retries. Record
    // the reason for the operator run-details UI + metrics.
    await query(
      `UPDATE funnel_run SET error_message = $1 WHERE run_id = $2`,
      ["dispatch failed: Temporal worker unreachable or rejected start; will retry", runId],
    );
    return false;
  }

  // 4. Ack — CAS dispatch_pending → workflow_started (allowed transition).
  const cas = await query(
    `UPDATE funnel_run SET status = 'workflow_started'
      WHERE run_id = $1 AND status = 'dispatch_pending'
      RETURNING run_id`,
    [runId],
  );
  if (cas.rows.length === 0) {
    console.warn(
      JSON.stringify({
        level: "warn",
        type: "funnel_dispatch_cas_skipped",
        runId,
        objectTypeApiName,
        reason: "row no longer dispatch_pending (concurrent reconciler won or terminal flip)",
      }),
    );
  }
  await query(
    `UPDATE funnel_signal SET consumed_by_run_id = $1 WHERE signal_id = $2`,
    [runId, signal.signal_id],
  );

  // Flip the UI badge: CAS-anchored 'indexing' projection.
  await projectFunnelTerminalToState(ontologyId, objectTypeApiName, "indexing", {
    runId,
    environmentId: identity.environmentId,
    objectTypeRid,
    path: "pre_temporal",
  });
  console.log(
    JSON.stringify({
      level: "info",
      type: "funnel_dispatched",
      ontologyId,
      objectTypeApiName,
      objectTypeRid,
      signalId: signal.signal_id,
      funnelRunId: runId,
      ...identityLogFields(identity),
    }),
  );
  return true;
}

/**
 * Reconciliation loop (called from tick): retry every dispatch_pending /
 * workflow_started run older than the staleness threshold. Idempotent —
 * signalWithStart(USE_EXISTING) makes re-dispatch of an already-running
 * workflow a plain in-flight signal.
 */
export async function reconcileStaleDispatches(): Promise<number> {
  // dispatch_pending rows are retried aggressively (their workflow start
  // may never have happened). workflow_started rows are only re-dispatched
  // when the parent workflow is KNOWN-GONE — re-signaling a live workflow
  // every tick floods its (serial) signal queue with duplicate passes and
  // is itself a stuck-"Indexing" generator. Visibility check is done ONCE
  // per tick, not per row.
  const stale = await query(
    `SELECT run_id, ontology_id, object_type_api_name, signal_payload,
            environment_id, started_at, status
       FROM funnel_run
      WHERE status = 'dispatch_pending'
        AND started_at < now() - $1::interval
      UNION ALL
      SELECT run_id, ontology_id, object_type_api_name, signal_payload,
             environment_id, started_at, status
        FROM funnel_run
       WHERE status = 'workflow_started'
         AND started_at < now() - $2::interval`,
    [
      `${Math.ceil(DISPATCH_STALE_AFTER_MS / 1000)} seconds`,
      // workflow_started rows get a generous window: the long-lived parent
      // drains signals SERIALLY and a pass on a 746-row type legitimately
      // takes minutes. Default 10 min.
      `${Math.ceil(Number(process.env.FUNNEL_WORKFLOW_STARTED_STALE_MS ?? 600_000) / 1000)} seconds`,
    ],
  );
  if (stale.rows.length === 0) return 0;
  const identity = getEnvironmentIdentity();

  // One Temporal visibility pass for this tick: which parent workflows
  // are RUNNING right now?
  let aliveWorkflowIds: Set<string> | null = null;
  try {
    const { getTemporalClient, funnelWorkflowId } = await import("./temporal/worker");
    const client = getTemporalClient();
    if (client) {
      aliveWorkflowIds = new Set<string>();
      for await (const wf of client.workflow.list({
        query: "ExecutionStatus = 'Running'",
      })) {
        aliveWorkflowIds.add(wf.workflowId);
      }
      void funnelWorkflowId;
    }
  } catch {
    aliveWorkflowIds = null; // visibility unavailable — err on the side of no re-dispatch
  }

  let retried = 0;
  for (const row of stale.rows as Array<{
    run_id: string;
    ontology_id: string;
    object_type_api_name: string;
    signal_payload: Record<string, unknown> | null;
    environment_id: string | null;
    started_at: Date;
    status: string;
  }>) {
    const startedAtMs = new Date(row.started_at as unknown as string).getTime();
    const ageSeconds = (Date.now() - startedAtMs) / 1000;
    observeDispatchPendingAge(ageSeconds, {
      object_type: row.object_type_api_name,
    });
    if (row.environment_id && row.environment_id !== identity.environmentId) {
      // Row belongs to another environment (split-brain inheritance from a
      // legacy shared namespace). Do NOT dispatch into it from here.
      continue;
    }
    const signalId = row.signal_payload?.signalId as string | undefined;
    if (!signalId) continue;
    // workflow_started + live parent workflow → the signal is QUEUED on
    // the parent; do not re-dispatch (that would append duplicates).
    if (row.status === "workflow_started") {
      const { funnelWorkflowId } = await import("./temporal/worker");
      const ot = await query(
        `SELECT object_type_id FROM object_type
          WHERE ontology_id = $1 AND api_name = $2 LIMIT 1`,
        [row.ontology_id, row.object_type_api_name],
      );
      if (ot.rows[0] && aliveWorkflowIds?.has(funnelWorkflowId(row.ontology_id, ot.rows[0].object_type_id))) {
        continue;
      }
      if (aliveWorkflowIds === null) continue; // can't verify — don't dup
    }
    const otRes = await query(
      `SELECT object_type_id FROM object_type
        WHERE ontology_id = $1 AND api_name = $2 LIMIT 1`,
      [row.ontology_id, row.object_type_api_name],
    );
    if (!otRes.rows[0]) {
      recordRunStuck({ reason: "dispatch_reconcile_ot_deleted", object_type: row.object_type_api_name });
      await query(
        `UPDATE funnel_run SET status = 'cancelled', completed_at = now(),
                error_message = $1
          WHERE run_id = $2 AND status IN ('dispatch_pending', 'workflow_started')`,
        [`dispatch reconciled: object type '${row.object_type_api_name}' deleted`, row.run_id],
      );
      continue;
    }
    const { signalTemporalWorkflow } = await import("./temporal/worker");
    const ok = await signalTemporalWorkflow({
      ontologyId: row.ontology_id,
      objectTypeApiName: row.object_type_api_name,
      objectTypeRid: otRes.rows[0].object_type_id as string,
      signalType: (row.signal_payload?.signalType as never) ?? "editBatchPending",
      payload: { ...(row.signal_payload ?? {}), signalId, funnelRunId: row.run_id },
    });
    if (ok) {
      await query(
        `UPDATE funnel_run SET status = 'workflow_started', error_message = NULL
          WHERE run_id = $1 AND status = 'dispatch_pending'`,
        [row.run_id],
      );
      retried++;
      console.log(
        JSON.stringify({
          level: "info",
          type: "funnel_dispatch_reconciled",
          runId: row.run_id,
          objectType: row.object_type_api_name,
          ageSeconds: Math.round(ageSeconds),
        }),
      );
    }
  }
  return retried;
}

/**
 * Reconcile funnel_state rows stuck in 'indexing': count age for the
 * funnel_indexing_age_seconds metric. The badge itself can only be flipped
 * by the terminal projection (fail-closed) — reconciliation REPORTS but
 * never forces a green state.
 */
export async function reportStaleIndexingStates(): Promise<number> {
  const { findStaleIndexingStates } = await import("./funnelStateProjection");
  const { observeIndexingAge } = await import("./isolationMetrics");
  const rows = await findStaleIndexingStates(DISPATCH_STALE_AFTER_MS * 2);
  for (const row of rows) {
    observeIndexingAge(
      (Date.now() - new Date(row.updated_at as unknown as string).getTime()) / 1000,
      {
        object_type: row.api_name ?? "unknown",
      },
    );
  }
  return rows.length;
}

async function listObjectTypesWithSignals(): Promise<string[]> {
  try {
    const res = await query(
      `SELECT DISTINCT object_type_api_name
         FROM funnel_signal
        WHERE consumed_at IS NULL`
    );
    return res.rows.map((r: { object_type_api_name: string }) => r.object_type_api_name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// ObjectTypeFunnelWorkflow — the B3 parent workflow.
// ---------------------------------------------------------------------------

async function objectTypeFunnelWorkflow(
  ctx: WorkflowContext,
  _signalType: string,
  _payload: Record<string, unknown>
): Promise<void> {
  const changelogTable = await ensureFunnelTable(
    ctx.objectTypeApiName,
    "changelog",
    "default"
  );
  const mergedTable = await ensureFunnelTable(ctx.objectTypeApiName, "merged", "state");

  // Stage 1: Changelog ------------------------------------------------------
  await ctx.setCurrentStage("changelog");
  const changelogOut = await ctx.runActivity({
    name: `computeChangelog(${ctx.objectTypeApiName})`,
    stage: "changelog",
    input: { objectTypeApiName: ctx.objectTypeApiName },
    activity: async () => {
      // Optional dev/demo pacing — no-op in production (env default 0).
      writeStageReceipt("changelog");
        await sleepForStageDelay();
      // Two reader paths:
      //   (a) Source datasource has an Iceberg location registered AND
      //       DuckDB is available → use iceberg_scan incremental read
      //       over the snapshot range. This is the B4 production path.
      //   (b) No Iceberg source OR DuckDB missing → derive changelog from
      //       ontology_edit pending queue. Keeps the pipeline alive for
      //       dev + pure user-edit workflows.
      const datasource = await loadDatasourceForObjectType(ctx.objectTypeApiName);
      let reader: SnapshotDiffReader;
      if (datasource?.iceberg_location && /_pipeline[./]/.test(datasource.iceberg_location)) {
        // PB-B4 acceptance (d) — pipeline outputs live under the
        // `_pipeline.*` namespace. Route through the PyIceberg-backed
        // manifest-level scan_delta so the Funnel reads ONLY the rows
        // added between the last-seen snapshot and the current one.
        const { pipelineIcebergDiffReader } = await import(
          "../pipelines/icebergChangelogReader"
        );
        // The iceberg_location is stored as `<warehouse>:<namespace>.<table>`
        // by PB-B4 deploy; split it so the sidecar call site gets the
        // warehouse + fully-qualified table identifier.
        const [warehouse, nsTable] = datasource.iceberg_location.split(":");
        const parts = (nsTable ?? "").split(".");
        const table = parts.pop() ?? "output";
        const namespace = parts.join(".");
        reader = pipelineIcebergDiffReader({
          warehouse,
          namespace,
          table,
          primaryKeyColumn: datasource.primary_key_column ?? "primary_key",
        });
      } else if (datasource?.iceberg_location && isDuckDBAvailable()) {
        reader = duckdbIcebergDiffReader({
          tableLocation: datasource.iceberg_location,
          primaryKeyColumn: datasource.primary_key_column ?? "primary_key",
        });
      } else if (await hasParquetDatasource(ctx.objectTypeApiName)) {
        // PB-B3 — Parquet-backed pipeline output. Funnel reads the file
        // via DuckDB footer-driven scan and yields each row as an
        // INSERT change-log entry. Merge stage dedups by PK.
        const bd = await loadParquetBackingDatasource(ctx.objectTypeApiName);
        if (bd) {
          const { parquetSnapshotDiffReader } = await import(
            "../pipelines/parquetDiffReader"
          );
          reader = parquetSnapshotDiffReader({
            path: bd.file_path,
            primaryKeyColumn: bd.primary_key_column ?? "primary_key",
          });
        } else {
          reader = { async *read() { /* empty */ } };
        }
      } else {
        const pending = await getPendingMergeEdits(ctx.objectTypeApiName);
        const rows: SourceChangeRow[] = pending.map((e) => ({
          primary_key: e.primary_key,
          operation: e.operation === "delete" ? "DELETE" : e.operation === "create" ? "INSERT" : "UPDATE",
          properties: e.property_values ?? {},
          source_transaction_id: e.execution_id || e.edit_id,
          source_commit_timestamp: e.executed_at,
        }));
        reader = { async *read() { for (const r of rows) yield r; } };
      }
      return computeChangelog(
        {
          ontologyId: ctx.ontologyId,
          objectTypeApiName: ctx.objectTypeApiName,
          datasourceId: datasource?.id ?? zeroUuid(),
          sourceTableId: changelogTable.dataset_table_id,
          fromSnapshotId: datasource?.last_snapshot_id ?? null,
          toSnapshotId: changelogTable.latest_snapshot_id ?? zeroUuid(),
          changelogTableId: changelogTable.dataset_table_id,
          outputFileLocation: `${changelogTable.location}/data/${new Date().toISOString()}.parquet`,
        },
        reader
      );
    },
  });

  // Stage 2: Merge ---------------------------------------------------------
  await ctx.setCurrentStage("merge");
  const mergeOut = await ctx.runActivity({
    name: `mergeChanges(${ctx.objectTypeApiName})`,
    stage: "merge",
    input: { objectTypeApiName: ctx.objectTypeApiName, rowsFromChangelog: changelogOut.rowsEmitted },
    activity: async () => {
      writeStageReceipt("merge");
        await sleepForStageDelay();
      const pending = await getPendingMergeEdits(ctx.objectTypeApiName);
      // PASS-BY-REFERENCE (Option 2): re-read the committed changelog rows
      // from the snapshot (Parquet object in MinIO via parquet_ref) instead
      // of using the by-value array — rows never travel through the
      // activity boundary nor through a jsonb INSERT param at scale.
      const changelogRows = await loadChangelogRowsFromSnapshot(
        changelogOut.snapshotId,
      );
      const contributions: DatasourceContribution[] = [
        {
          datasource_id: zeroUuid(),
          owned_properties: changelogOut.ownedProperties,
          changelog_rows: changelogRows,
          markings: [],
        },
      ];
      // Scale path: routes to DuckDB SQL reduction when total changelog
      // rows exceed `duckDbThreshold` (default 500k). Smaller runs stay
      // in pure TypeScript where the overhead of spinning up DuckDB
      // doesn't pay off.
      return mergeChangesMaybeDuckDB({
        ontologyId: ctx.ontologyId,
        objectTypeApiName: ctx.objectTypeApiName,
        contributions,
        pendingEdits: pending,
        editStrategy: "user_edit_wins" satisfies EditStrategy,
        mergedTableId: mergedTable.dataset_table_id,
        mergedOutputFileLocation: `${mergedTable.location}/data/${new Date().toISOString()}.parquet`,
      });
    },
  });

  await ctx.incrementObjectsIndexed(mergeOut.upserts + mergeOut.deletes);

  // Stage 3: Indexing ------------------------------------------------------
  await ctx.setCurrentStage("indexing");
  const indexOut = await ctx.runActivity({
    name: `indexToQuickwit(${ctx.objectTypeApiName})`,
    stage: "indexing",
    input: { objectTypeApiName: ctx.objectTypeApiName, upserts: mergeOut.upserts },
    activity: async () => {
      writeStageReceipt("indexing");
        await sleepForStageDelay();
      // TRUTHFUL ACKNOWLEDGEMENT (OSv2 serving-index parity):
      //   applied_to_index_at is stamped ONLY after Quickwit has published
      //   the batch (runIndexingActivity waits for split publish past our
      //   high Kafka offset and throws on timeout). When Quickwit is
      //   unreachable or indexing fails we DO NOT stamp: the edits remain
      //   pending (applied_to_index_at IS NULL), the Redis write-back
      //   overlay is retained (the sweeper keys off applied_to_index_at),
      //   and the next funnel run retries with full coverage via the
      //   repair pass in buildFullIndexBatch (re-reads object_instances
      //   for edits merged by earlier runs). See indexingStage.ts.
      const pending = await getPendingIndexEdits(ctx.objectTypeApiName);
      const editIds = pending.map((e) => e.edit_id);

      if (editIds.length === 0) {
        updatePendingIndexGauges(ctx.objectTypeApiName, pending);
        return {
          editsIndexed: 0,
          rowsStreamed: 0,
          publishedSplits: 0,
          publishedSplitIds: [] as string[],
          quickwit: false,
          indexingDeferred: false,
        };
      }

      const quickwitOk = await isQuickwitReachable();
      if (!quickwitOk) {
        recordIndexingDeferred({
          objectTypeApiName: ctx.objectTypeApiName,
          pending,
          reason: "quickwit_unreachable",
        });
        return {
          editsIndexed: 0,
          rowsStreamed: 0,
          publishedSplits: 0,
          publishedSplitIds: [] as string[],
          quickwit: false,
          indexingDeferred: true,
        };
      }

      try {
        await ensureIndex({ objectTypeApiName: ctx.objectTypeApiName });
        const baseRows: MergedRow[] = mergeOut.mergedRows.map((r, i) => ({
          primary_key: r.primary_key,
          properties: r.properties,
          operation: r.operation === "delete" ? "DELETE" : "UPDATE",
          version: i + 1,
          source_transaction_id: r.source_transaction_id ?? undefined,
        }));
        const batch = await buildFullIndexBatch({
          ontologyId: ctx.ontologyId,
          objectTypeApiName: ctx.objectTypeApiName,
          baseRows,
          pending,
        });
        const reader = async function* () {
          yield { rows: batch.rows, editIds: batch.editIds };
        };
        const out = await runIndexingActivity({
          ontologyId: ctx.ontologyId,
          objectTypeApiName: ctx.objectTypeApiName,
          primaryKeyApiName: "primary_key",
          reader,
          publishTimeoutMs: 15_000,
          publishPollMs: 1_000,
        });
        await markEditsAppliedToIndex(batch.editIds);
        updatePendingIndexGauges(ctx.objectTypeApiName, []);
        return {
          editsIndexed: batch.editIds.length,
          rowsStreamed: out.rowsStreamed,
          publishedSplits: out.publishedSplitIds.length,
          publishedSplitIds: out.publishedSplitIds,
          quickwit: true,
          indexingDeferred: false,
        };
      } catch (err) {
        // Truthful failure: no stamp, no overlay retirement, retry next run.
        recordIndexingDeferred({
          objectTypeApiName: ctx.objectTypeApiName,
          pending,
          reason: "quickwit_indexing_failed",
          error: (err as Error).message,
        });
        return {
          editsIndexed: 0,
          rowsStreamed: 0,
          publishedSplits: 0,
          publishedSplitIds: [] as string[],
          quickwit: false,
          indexingDeferred: true,
        };
      }
    },
  });

  // Stage 4: Hydration ----------------------------------------------------
  await ctx.setCurrentStage("hydration");
  await ctx.runActivity({
    name: `hydrateSearchers(${ctx.objectTypeApiName})`,
    stage: "hydration",
    input: {
      objectTypeApiName: ctx.objectTypeApiName,
      publishedSplits: (indexOut.publishedSplitIds ?? []).length,
    },
    activity: async () => {
      await sleepForStageDelay();
      const splitIds = (indexOut.publishedSplitIds ?? []) as string[];
      if (splitIds.length === 0) {
        // No splits to warm — hydration is a no-op (still records stage
        // completion so the UI projection knows we ran).
        return { prefetched: 0, placements: [], mode: "live" as const };
      }
      try {
        const out = await runHydrationActivity({
          objectTypeApiName: ctx.objectTypeApiName,
          splitIds,
          mode: "live",
        });
        return {
          prefetched: out.prefetchedSplitCount,
          placements: out.perSearcherPlan,
          mode: out.mode,
        };
      } catch (err) {
        // Hydration is an optimisation; if prefetch fails queries still
        // land on a cold cache and range-GET via hotcache covers them.
        console.warn(
          `[funnel] hydration prefetch failed: ${(err as Error).message}`
        );
        return { prefetched: 0, placements: [], mode: "live" as const };
      }
    },
  });
}

async function ensureFunnelTable(
  objectTypeApiName: string,
  kind: "changelog" | "merged" | "index" | "hydration",
  tableName: string
): Promise<FunnelDatasetRow> {
  const ns = funnelNamespace(objectTypeApiName, kind);
  const existing = await getTable(ns, tableName);
  if (existing) return existing;
  return createTable({
    namespace: ns,
    tableName,
    schema: {},
    location: `s3://_funnel/${objectTypeApiName}/${kind}/${tableName}`,
  });
}

interface DatasourceMeta {
  id: string;
  iceberg_location: string | null;
  primary_key_column: string | null;
  last_snapshot_id: string | null;
}

async function loadDatasourceForObjectType(
  objectTypeApiName: string
): Promise<DatasourceMeta | null> {
  try {
    const res = await query(
      `SELECT bd.mapping_id,
              bd.iceberg_location,
              bd.primary_key_column,
              w.last_to_snapshot_id
         FROM backing_datasource bd
         JOIN object_type ot ON ot.object_type_id = bd.object_type_id
         LEFT JOIN funnel_changelog_watermark w
                ON w.source_datasource_id = bd.mapping_id
               AND w.object_type_api_name = ot.api_name
        WHERE ot.api_name = $1
        LIMIT 1`,
      [objectTypeApiName]
    );
    if (!res.rows[0]) return null;
    const row = res.rows[0];
    return {
      id: row.mapping_id,
      iceberg_location: row.iceberg_location ?? null,
      primary_key_column: row.primary_key_column ?? null,
      last_snapshot_id: row.last_to_snapshot_id ?? null,
    };
  } catch {
    return null;
  }
}

function zeroUuid(): string {
  return "00000000-0000-0000-0000-000000000000";
}

// PB-B3 — SnapshotDiffReader recognizes Parquet datasets via
// `foundry_datasets.format='parquet'` (spec literal). We LEFT JOIN
// `foundry_datasets` onto `backing_datasource` by foundry_dataset_id
// (preferred) or legacy dataset_id, and authoritatively key off
// `fd.format`. The legacy file_format / extension fallback is retained
// only for datasources registered before migration 027 added the
// foundry_dataset_id FK.
async function hasParquetDatasource(objectTypeApiName: string): Promise<boolean> {
  try {
    const res = await query(
      `SELECT 1
         FROM backing_datasource bd
         JOIN object_type ot ON ot.object_type_id = bd.object_type_id
         LEFT JOIN foundry_datasets fd
               ON fd.id = COALESCE(bd.foundry_dataset_id, bd.dataset_id)
        WHERE ot.api_name = $1
          AND (
               fd.format = 'parquet'
               OR bd.file_format = 'parquet'
               OR bd.file_path ILIKE '%.parquet%'
          )
        LIMIT 1`,
      [objectTypeApiName]
    );
    return res.rows.length > 0;
  } catch {
    return false;
  }
}

async function loadParquetBackingDatasource(
  objectTypeApiName: string,
): Promise<{ file_path: string; primary_key_column: string } | null> {
  try {
    const res = await query(
      `SELECT bd.file_path, bd.primary_key_column
         FROM backing_datasource bd
         JOIN object_type ot ON ot.object_type_id = bd.object_type_id
         LEFT JOIN foundry_datasets fd
               ON fd.id = COALESCE(bd.foundry_dataset_id, bd.dataset_id)
        WHERE ot.api_name = $1
          AND (
               fd.format = 'parquet'
               OR bd.file_format = 'parquet'
               OR bd.file_path ILIKE '%.parquet%'
          )
        LIMIT 1`,
      [objectTypeApiName]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      file_path: row.file_path,
      primary_key_column: row.primary_key_column,
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort Quickwit reachability probe. Returns true if the REST
 * endpoint responds to /api/v1/version within 2s. We cache a negative
 * result for 10s so a down Quickwit cluster doesn't spam the network.
 */
let lastQuickwitProbe = 0;
let lastQuickwitOk = false;
async function isQuickwitReachable(): Promise<boolean> {
  const now = Date.now();
  if (now - lastQuickwitProbe < 10_000) return lastQuickwitOk;
  lastQuickwitProbe = now;
  const base = process.env.QUICKWIT_URL ?? "http://localhost:7280";
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 2_000);
    const res = await fetch(`${base}/api/v1/version`, { signal: ctrl.signal });
    clearTimeout(tid);
    lastQuickwitOk = res.ok;
  } catch {
    lastQuickwitOk = false;
  }
  return lastQuickwitOk;
}
