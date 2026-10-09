// ---------------------------------------------------------------------------
// Temporal activities — Task B3
//
// These are the I/O-side handlers the ObjectTypeFunnelWorkflow proxies
// into. Keeping them in their own module (not the workflow) means they
// can freely use pg, HTTP, Kafka, etc. without violating determinism.
//
// Each activity wraps the existing stage logic (changelogStage.ts,
// mergeStage.ts, indexingActivity.ts, hydrationActivity.ts) so the
// Temporal path and the Postgres-backed dispatcher share one
// implementation.
// ---------------------------------------------------------------------------

import { query } from "../../../db";
import { observeHistogram, incCounter } from "../metrics";
import {
  computeChangelog,
  SnapshotDiffReader,
  SourceChangeRow,
} from "../changelogStage";
import {
  duckdbIcebergDiffReader,
  isDuckDBAvailable,
} from "../duckdbIceberg";
import { createTable, funnelNamespace, getTable, ManifestEntry } from "../icebergCatalog";
import {
  mergeChangesFromSnapshots,
  streamMergedRowsFromSnapshot,
} from "../mergeStage";
import {
  getPendingMergeEdits,
  getPendingIndexEdits,
  markEditsAppliedToIndex,
} from "../../../models/ontologyEdit";
import {
  resolveLeaseObjectTypeId,
  reportIndexingProgress,
  touchLeaseHeartbeat,
} from "../indexingLease";
import { runIndexingActivity } from "../../quickwit/indexingActivity";
import { ensureIndex } from "../../quickwit/indexManager";
import {
  streamFullIndexBatches,
  recordIndexingDeferred,
  updatePendingIndexGauges,
} from "../indexingStage";
import { runHydrationActivity } from "../../quickwit/hydrationActivity";
import { sleepForStageDelay, writeStageReceipt } from "../stageDelay";
import { closeOpenStageRuns } from "../stageRunClosure";
import {
  projectFunnelTerminalToState,
  type FunnelStateStatus,
} from "../funnelStateProjection";
import {
  fenceExecutionContext,
  FunnelExecutionEnvironmentMismatch,
  FunnelObjectTypeMissing,
  FunnelStaleStateTransition,
} from "../environmentGuard";
import {
  recordMissingObjectType,
  recordMissingDatasource,
  recordTerminalProjectionFailed,
} from "../isolationMetrics";
import { ApplicationFailure } from "@temporalio/activity";
import { getObjectBuffer, getObjectStream, headObject } from "../../storageService";
import { parseCsvReadable } from "../../indexing/streamingCsv";
import {
  acquireConnection,
  queryAll,
  runAll,
  streamQuery,
  releaseConnection,
} from "../../duckdb/pool";
import type { FoundrySourceQuality } from "../changelogStage";
import {
  runWithStageProgress,
  reportStageProgress,
  shouldHeartbeat,
  type StageProgressState,
} from "./stageProgress";
import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import fs from "fs";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises";
import { assertFunnelReadablePath } from "../../datasourcePathValidation";

// Heartbeat + stage-duration helper. Every long-running activity wraps
// its body in `withStageInstrumentation(stage, obj, async () => ...)`.
// The helper:
//   * records wall-clock duration into funnel_stage_duration_seconds
//   * runs a PROGRESS-COUPLED heartbeat loop: it beats while the stage keeps
//     calling reportStageProgress(), and goes SILENT once the stage stops,
//     so Temporal's heartbeatTimeout can actually fail a stalled attempt.
//     The old loop beat on a bare timer, which proved only that the process
//     was alive — that is why the 2026-08-16 Redis deadlock sat "running"
//     for three days with a 56-second-old heartbeat and a 120s timeout.
//     See temporal/stageProgress.ts for the full incident write-up.
//   * counts errors per stage so on-call sees which stage is flaky
async function withStageInstrumentation<T>(
  stage: "changelog" | "merge" | "indexing" | "hydration",
  objectTypeApiName: string,
  fn: () => Promise<T>
): Promise<T> {
  const started = Date.now();
  let progress: StageProgressState | undefined;
  const heartbeat = startHeartbeatLoop(
    () => progress,
    `${stage}/${objectTypeApiName}`,
  );
  try {
    const out = await runWithStageProgress(fn, (state) => {
      progress = state;
    });
    observeHistogram("funnel_stage_duration_seconds", (Date.now() - started) / 1000, {
      stage,
      object_type: objectTypeApiName,
      result: "success",
    });
    return out;
  } catch (err) {
    observeHistogram("funnel_stage_duration_seconds", (Date.now() - started) / 1000, {
      stage,
      object_type: objectTypeApiName,
      result: "error",
    });
    incCounter("funnel_stage_errors_total", {
      stage,
      object_type: objectTypeApiName,
    });
    throw err;
  } finally {
    heartbeat.stop();
  }
}

/**
 * Progress-coupled heartbeat loop. `getProgress` returns the running stage's
 * progress state (undefined until runWithStageProgress installs it).
 *
 * The loop stops beating — deliberately — once an instrumented stage has been
 * silent for longer than the stall window, so Temporal's heartbeatTimeout
 * expires and the attempt is retried on a healthy worker. It logs once when it
 * makes that decision, so the operator sees WHY the attempt timed out rather
 * than an unexplained heartbeat timeout.
 */
function startHeartbeatLoop(
  getProgress: () => StageProgressState | undefined,
  label: string,
): { stop: () => void } {
  let cancelled = false;
  let timer: NodeJS.Timeout | null = null;
  let loggedStall = false;
  const tick = () => {
    if (cancelled) return;
    const progress = getProgress();
    const alive = !progress || shouldHeartbeat(progress, Date.now());
    if (alive) {
      loggedStall = false;
      try {
        // The @temporalio/activity Context is only available when the
        // activity runs inside a Temporal worker. When these functions
        // are invoked directly (from the PG dispatcher or a unit test),
        // `Context.current()` throws — treat that as a no-op heartbeat.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Context } = require("@temporalio/activity") as typeof import("@temporalio/activity");
        Context.current().heartbeat();
      } catch {
        /* not inside a Temporal activity — no heartbeat needed */
      }
    } else if (!loggedStall) {
      loggedStall = true;
      const stalledFor = Math.round((Date.now() - progress!.lastProgressAt) / 1000);
      console.warn(
        `[funnel] ${label} reported no progress for ${stalledFor}s (last step: ` +
          `${progress!.lastMarker || "unknown"}) — withholding heartbeats so ` +
          `Temporal's heartbeatTimeout fails this attempt`,
      );
      incCounter("funnel_stage_stall_detected_total", { stage: label });
    }
    timer = setTimeout(tick, 5000);
    timer.unref?.();
  };
  timer = setTimeout(tick, 5000);
  timer.unref?.();
  return {
    stop() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export interface ObjectTypeCtx {
  ontologyId: string;
  objectTypeApiName: string;
  /** FUNN-ISO — dispatch-stamped stable identity + environment. The fence
   *  verifies (env ↔ worker ↔ database seal) before ANY read or write. */
  objectTypeRid?: string;
  environmentId?: string;
}

/**
 * FUNN-ISO — execution-context fence. Called at the top of EVERY activity.
 * Guard errors are re-thrown as NON-RETRYABLE ApplicationFailures: a retry
 * can never repair a worker wired to the wrong environment, and converting
 * the mismatch into retries would repeat the 2026-07-31 silent-green
 * failure pattern at a slower cadence.
 */
async function fence(input: { environmentId?: string }): Promise<void> {
  try {
    await fenceExecutionContext({ environmentId: input.environmentId });
  } catch (err) {
    if (
      err instanceof FunnelExecutionEnvironmentMismatch ||
      err instanceof FunnelObjectTypeMissing ||
      err instanceof FunnelStaleStateTransition
    ) {
      throw ApplicationFailure.create({
        message: err.message,
        type: err.name,
        nonRetryable: true,
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// runChangelogActivity
// ---------------------------------------------------------------------------

export async function runChangelogActivity(
  input: ObjectTypeCtx
): Promise<{
  snapshotId: string;
  rowsEmitted: number;
  manifest: ManifestEntry[];
  /** Property names the Merge stage must overlay for this datasource
   *  (column-wise MDO). Carried in the small activity return instead of
   *  the full row array so the Temporal completion payload stays bounded. */
  ownedProperties: string[];
}> {
  return withStageInstrumentation("changelog", input.objectTypeApiName, async () => {
    const stop = await startLockHeartbeat(input);
    try {
      return await runChangelogActivityImpl(input);
    } finally {
      stop();
    }
  });
}

async function startLockHeartbeat(input: ObjectTypeCtx): Promise<() => void> {
  let objectTypeId: string | null = null;
  try {
    objectTypeId = input.objectTypeRid ?? (await resolveLeaseObjectTypeId(input.ontologyId, input.objectTypeApiName));
  } catch {
    return () => {};
  }
  if (!objectTypeId) return () => {};
  // Holder liveness ONLY: this timer proves the process is alive. It must
  // never move last_progress_at — a timer that did would blind the stall
  // watchdog to a hung native query. Movement is reported separately, only
  // where rows/bytes actually advance.
  const timer = setInterval(() => {
    void touchLeaseHeartbeat(objectTypeId).catch(() => {});
  }, 5_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** Best-effort movement report: rows/bytes actually advanced. Never throws. */
function bestEffortMovement(objectTypeId: string | null): void {
  if (!objectTypeId) return;
  void reportIndexingProgress(objectTypeId).catch(() => {});
}

async function runChangelogActivityImpl(
  input: ObjectTypeCtx
): Promise<{
  snapshotId: string;
  rowsEmitted: number;
  manifest: ManifestEntry[];
  ownedProperties: string[];
}> {
  await fence(input);
  // Optional dev/demo pacing — no-op in production (env default 0).
  writeStageReceipt("changelog");
  await sleepForStageDelay();
  const table = await ensureTable(input.objectTypeApiName, "changelog", "default");
  // Reader-selection precedence (most specific first):
  //   1. Iceberg-backed datasource (DuckDB iceberg_scan over snapshot range)
  //   2. Foundry-bridged file (CSV / TSV / JSON in MinIO — `#foundry-dataset:` tag)
  //   3. Fallback: derive from the pending edit queue (dev / pure user edits)
  //
  // The PG dispatcher historically had paths (1) + (2-parquet) + (3); the
  // Temporal pipeline was missing the foundry-bridged path entirely, which
  // is why an object type registered through the wizard (foundry CSV upload)
  // would complete the funnel with `objects_indexed = 0`. The fix below
  // mirrors the dispatcher's `loadParquetBackingDatasource` precedence
  // while also handling `.csv` / `.tsv` / `.json` so wizard-created OTs
  // index correctly on every save.
  let reader: SnapshotDiffReader;
  // Fail-closed zero-row gate (Blocker 4): true only when we positively
  // know the source file is non-empty. The pending-edit fallback keeps
  // sourceNonEmpty=false — a genuinely edit-less object type may
  // legitimately emit zero rows.
  let sourceNonEmpty = false;
  const iceberg = await loadIcebergSource(input.objectTypeApiName);
  if (iceberg && isDuckDBAvailable()) {
    reader = duckdbIcebergDiffReader({
      tableLocation: iceberg.iceberg_location,
      primaryKeyColumn: iceberg.primary_key_column ?? "primary_key",
    });
  } else {
    const foundry = await loadFoundryBridgedDatasource(input.objectTypeApiName);
    if (foundry) {
      // Option D — fail-fast circuit-breaker. HEAD the backing object BEFORE
      // attempting to stream it. Default ceiling is NONE (streaming has no
      // size ceiling — the old 512 MiB MAX_STRING_LENGTH wall is gone); a
      // configurable TELLUS_FOUNDRY_SOURCE_MAX_BYTES catches an oversized
      // source with a clear, actionable error instead of the generic
      // "Activity task failed" that masked the OO7 root cause. If the HEAD
      // itself fails (object missing / MinIO down), fail fast too — that's
      // "stream setup can't be established", surfaced as a real message.
      const guardKey = stripFoundryTags(foundry.filePath);
      assertFunnelReadablePath(guardKey);
      if (isIcebergBridgedPath(guardKey)) {
        // Foundry-bridged ICEBERG dataset — the "file" is a synthetic
        // `iceberg://<warehouse>/<ns>/<table>` URI, not a MinIO object, so
        // the S3 HEAD guard below can never succeed (it was failing the
        // changelog stage with "stream setup could not be established").
        // Read the table's current snapshot through the synced-dataset
        // reader instead — the same path the Dataset Preview page uses.
        reader = await buildIcebergBridgedReader(foundry);
      } else {
        let foundryHead: { contentLength: number } | null = null;
        try {
          foundryHead = await headObject(guardKey);
        } catch (headErr) {
          throw new Error(
            `foundry-bridged backing source '${guardKey}' is not reachable ` +
              `(HEAD failed — stream setup could not be established): ` +
              `${(headErr as Error).message}`,
          );
        }
        const maxBytes = Number(process.env.TELLUS_FOUNDRY_SOURCE_MAX_BYTES ?? "") || 0;
        if (maxBytes > 0 && foundryHead.contentLength > maxBytes) {
          throw new Error(
            `foundry-bridged backing source '${guardKey}' is ${foundryHead.contentLength} ` +
              `bytes which exceeds the configured ceiling ` +
              `TELLUS_FOUNDRY_SOURCE_MAX_BYTES=${maxBytes}. Re-upload in smaller ` +
              `parts or raise the ceiling.`,
          );
        }
        sourceNonEmpty = foundryHead.contentLength > 0;
        reader = await buildFoundryBridgedReader(foundry);
      }
    } else {
      const pending = await getPendingMergeEdits(input.objectTypeApiName);
      // FUNN-ISO-4 observability: a funnel pass with NO backing datasource
      // and NO edits is not an error per se (a legitimately empty OT does
      // this), but it is the exact signature of the cross-database failure
      // class — the OTHER environment's datasource is invisible here.
      // Count it loudly so dashboards can catch the anomaly; the fence
      // already guarantees the activity ran in the right environment.
      if (pending.length === 0) {
        recordMissingDatasource({
          object_type: input.objectTypeApiName,
          environment: input.environmentId ?? "unknown",
        });
      }
      const rows: SourceChangeRow[] = pending.map((e) => ({
        primary_key: e.primary_key,
        operation:
          e.operation === "delete" ? "DELETE" : e.operation === "create" ? "INSERT" : "UPDATE",
        properties: e.property_values ?? {},
        source_transaction_id: e.execution_id || e.edit_id,
        source_commit_timestamp: e.executed_at,
      }));
      reader = {
        async *read() {
          for (const r of rows) yield r;
        },
      };
    }
  }
  // Movement signal for the stall watchdog, resolved once up front. The
  // changelog stream reports real advancement every 5 000 rows; the 5 s
  // holder timer reports liveness only and never touches this signal.
  const leaseObjectTypeId = await resolveLeaseObjectTypeId(
    input.ontologyId,
    input.objectTypeApiName,
  ).catch(() => null);
  const result = await computeChangelog(
    {
      ontologyId: input.ontologyId,
      objectTypeApiName: input.objectTypeApiName,
      datasourceId: ZERO_UUID,
      sourceTableId: table.dataset_table_id,
      fromSnapshotId: null,
      toSnapshotId: table.latest_snapshot_id ?? ZERO_UUID,
      changelogTableId: table.dataset_table_id,
      outputFileLocation: `${table.location}/data/${new Date().toISOString()}.parquet`,
      onRowsAdvanced: (rowsStreamed) => {
        reportStageProgress(`changelog rows=${rowsStreamed}`);
        bestEffortMovement(leaseObjectTypeId);
      },
    },
    reader
  );
  assertChangelogNonEmpty({
    objectTypeApiName: input.objectTypeApiName,
    rowsEmitted: result.rowsEmitted,
    sourceNonEmpty,
  });
  // PASS-BY-REFERENCE (Option 2): the emitted rows are persisted as a
  // Parquet object in MinIO; the committed snapshot's `summary_json`
  // carries only a small `parquet_ref` (computeChangelog does the write).
  // Downstream re-reads via `loadChangelogRowsFromSnapshot(snapshotId)`.
  // We do NOT return the row array here — a ~42 MB Temporal completion
  // payload exceeds the activity-result limit (the original 83k "stuck at
  // changelog" symptom), and inlining rows into `summary_json` jsonb
  // crashed the Postgres backend at ~573 MB for 1M rows (the 1M incident).
  // `ownedProperties` is the small property-name set the Merge stage needs
  // for column-wise MDO; `computeChangelog` collects it during the stream.
  return {
    snapshotId: result.snapshotId,
    rowsEmitted: result.rowsEmitted,
    manifest: result.manifest,
    ownedProperties: result.ownedProperties,
  };
}

// ---------------------------------------------------------------------------
// runMergeActivity
// ---------------------------------------------------------------------------

export async function runMergeActivity(
  input: ObjectTypeCtx & {
    /** PASS-BY-REFERENCE: the changelog snapshot id (not the row array).
     *  The Merge stage re-resolves the snapshot's `parquet_ref` (NOT a row
     *  load) via `mergeChangesFromSnapshots` → `mergeChangesSQL` so the
     *  rows never cross the Temporal activity-boundary payload limit. */
    changelogSnapshotId: string;
    changelogOwnedProperties: string[];
    /** The driving signal's id — threads through to `mergeChangesSQL` as
     *  the Redis checkpoint key (`merge:progress:<runKey>`). Lets a retry
     *  that crashed AFTER the PG COMMIT skip the re-upsert of the merged
     *  tail (the committed rows are already in object_instances). */
    runKey?: string;
  }
): Promise<{
  mergedSnapshotId: string;
  upserts: number;
  deletes: number;
  editIds: string[];
  /** Count of rows in the merged snapshot. Carried instead of the
   *  full `mergedRows` array — the SQL merge path does NOT materialise
   *  mergedRows (they live in the merged parquet_ref); the Indexing stage
   *  re-reads them from the merged snapshot by `mergedSnapshotId` only
   *  when Quickwit is reachable. */
  mergedRowCount: number;
  /** Current materialized object cardinality after the merge. */
  objectsIndexed: number;
}> {
  return withStageInstrumentation("merge", input.objectTypeApiName, async () => {
    const stop = await startLockHeartbeat(input);
    try {
      return await runMergeActivityImpl(input);
    } finally {
      stop();
    }
  });
}

async function runMergeActivityImpl(
  input: ObjectTypeCtx & {
    changelogSnapshotId: string;
    changelogOwnedProperties: string[];
    runKey?: string;
  }
): Promise<{
  mergedSnapshotId: string;
  upserts: number;
  deletes: number;
  editIds: string[];
  mergedRowCount: number;
  objectsIndexed: number;
}> {
  await fence(input);
  writeStageReceipt("merge");
  await sleepForStageDelay();
  const mergedTable = await ensureTable(input.objectTypeApiName, "merged", "state");
  const pending = await getPendingMergeEdits(input.objectTypeApiName);
  // PASS-BY-REFERENCE: `mergeChangesFromSnapshots` resolves the changelog
  // snapshot's `parquet_ref` (a small PG read — NOT the full row array that
  // was the OO7 wall) and delegates to `mergeChangesSQL` (DuckDB SQL k-way
  // merge + COPY to parquet + stream to batched PG upserts/deletes). The
  // merged result rows are persisted as a parquet object on the freshly-
  // committed merged snapshot, so the Indexing stage re-reads them by
  // `mergedSnapshotId` without a by-value hop.
  const out = await mergeChangesFromSnapshots({
    ontologyId: input.ontologyId,
    objectTypeApiName: input.objectTypeApiName,
    changelogSnapshots: [
      {
        datasource_id: ZERO_UUID,
        snapshot_id: input.changelogSnapshotId,
        owned_properties: input.changelogOwnedProperties,
      },
    ],
    editsBatch: pending,
    editStrategy: "user_edit_wins",
    mergedTableId: mergedTable.dataset_table_id,
    mergedOutputFileLocation: `${mergedTable.location}/data/${new Date().toISOString()}.parquet`,
    runKey: input.runKey,
  });
  const objectCountResult = await query(
    `SELECT count(*)::int AS n
       FROM object_instances
      WHERE ontology_id = $1 AND object_type_api_name = $2`,
    [input.ontologyId, input.objectTypeApiName],
  );
  return {
    mergedSnapshotId: out.snapshotId,
    upserts: out.upserts,
    deletes: out.deletes,
    editIds: pending.map((e) => e.edit_id),
    // `upserts + deletes` is this run's mutation delta and can be zero for
    // an unchanged 746-row snapshot. Use persisted snapshot cardinality.
    mergedRowCount: out.parquetRef?.rowCount ?? out.mergedRows.length,
    // Terminal/UI state needs current cardinality, not mutation count.
    objectsIndexed: Number(objectCountResult.rows[0]?.n ?? 0),
  };
}

// ---------------------------------------------------------------------------
// runIndexingActivityProxy
// ---------------------------------------------------------------------------

export async function runIndexingActivityProxy(
  input: ObjectTypeCtx & {
    /** PASS-BY-REFERENCE: the merged snapshot id (not the row array).
     *  Merged rows are re-read from `funnel_snapshot.summary_json.inline_rows`
     *  via `loadMergedRowsFromSnapshot` ONLY when Quickwit is reachable
     *  — they never cross the Temporal activity-boundary payload limit. */
    mergedSnapshotId: string;
    mergedRowCount: number;
  }
): Promise<{ editsIndexed: number; publishedSplitIds: string[]; quickwit: boolean }> {
  return withStageInstrumentation("indexing", input.objectTypeApiName, async () =>
    runIndexingActivityProxyImpl(input)
  );
}

async function runIndexingActivityProxyImpl(
  input: ObjectTypeCtx & {
  mergedSnapshotId: string;
  mergedRowCount: number;
  }
): Promise<{ editsIndexed: number; publishedSplitIds: string[]; quickwit: boolean }> {
  await fence(input);
  writeStageReceipt("indexing");
  await sleepForStageDelay();
  const pending = await getPendingIndexEdits(input.objectTypeApiName);
  const editIds = pending.map((e) => e.edit_id);

  // TRUTHFUL ACKNOWLEDGEMENT (OSv2 serving-index parity): we stamp
  // applied_to_index_at ONLY after Quickwit confirms split publication.
  // When Quickwit is unreachable or any step fails we leave the edits
  // pending — the Redis overlay stays alive (the sweeper keys off
  // applied_to_index_at) and the retry covers repairs via
  // buildFullIndexBatch (re-reads object_instances for edits merged by
  // earlier runs). See indexingStage.ts for the invariant.
  if (editIds.length === 0) {
    updatePendingIndexGauges(input.objectTypeApiName, pending);
    return { editsIndexed: 0, publishedSplitIds: [], quickwit: false };
  }

  const reachable = await isQuickwitReachable();
  if (!reachable) {
    recordIndexingDeferred({
      objectTypeApiName: input.objectTypeApiName,
      pending,
      reason: "quickwit_unreachable",
    });
    return { editsIndexed: 0, publishedSplitIds: [], quickwit: false };
  }

  try {
    await ensureIndex({ objectTypeApiName: input.objectTypeApiName });
    // PASS-BY-REFERENCE: re-read the merged rows from the committed
    // merged snapshot by id (NOT from a Temporal activity return value).
    // Skipped entirely when this run merged nothing — the repair pass
    // covers everything from object_instances in that case.
    //
    // STREAMED, not materialised. The previous version called the array-
    // returning `loadMergedRowsFromSnapshot`, which goes through
    // `readParquetRows` — and that function THROWS above
    // TELLUS_PARQUET_READ_MAX_ROWS (2M) because building a multi-million-row
    // JS array is a genuine heap wall. The gate was right; this caller was
    // wrong. The consequence was inverted from what anyone would want: the
    // BIGGEST Object Types were exactly the ones that could never reach the
    // Quickwit serving index (OO7 sits at 4.65M rows, so every indexing
    // attempt for it died with "exceeds TELLUS_PARQUET_READ_MAX_ROWS" and the
    // catch below deferred it forever).
    //
    // `streamFullIndexBatches` yields fixed-size batches instead, and
    // `runIndexingActivity`'s reader contract already accepts many batches
    // (`for await (const batch of input.reader())`), so peak heap is now the
    // batch size rather than the snapshot size.
    //
    // editIds are collected up-front, unconditionally, exactly as the array
    // variant did — coverage never affected acknowledgement — and are still
    // stamped only after runIndexingActivity confirms split publication.
    const emptySource = (async function* () {})() as AsyncIterable<never>;
    const reader = () =>
      streamFullIndexBatches({
        ontologyId: input.ontologyId,
        objectTypeApiName: input.objectTypeApiName,
        baseRows:
          input.mergedRowCount > 0
            ? streamMergedRowsFromSnapshot(input.mergedSnapshotId)
            : emptySource,
        pending,
      });
    const out = await runIndexingActivity({
      ontologyId: input.ontologyId,
      objectTypeApiName: input.objectTypeApiName,
      primaryKeyApiName: "primary_key",
      reader,
      publishTimeoutMs: 15_000,
      publishPollMs: 1_000,
    });
    await markEditsAppliedToIndex(editIds);
    updatePendingIndexGauges(input.objectTypeApiName, []);
    return {
      editsIndexed: editIds.length,
      publishedSplitIds: out.publishedSplitIds,
      quickwit: true,
    };
  } catch (err) {
    console.warn(`[temporal/indexing] ${(err as Error).message}`);
    recordIndexingDeferred({
      objectTypeApiName: input.objectTypeApiName,
      pending,
      reason: "quickwit_indexing_failed",
      error: (err as Error).message,
    });
    return { editsIndexed: 0, publishedSplitIds: [], quickwit: false };
  }
}

// ---------------------------------------------------------------------------
// runHydrationActivityProxy
// ---------------------------------------------------------------------------

export async function runHydrationActivityProxy(
  input: ObjectTypeCtx & { publishedSplitIds: string[] }
): Promise<{ prefetched: number }> {
  return withStageInstrumentation("hydration", input.objectTypeApiName, async () =>
    runHydrationActivityProxyImpl(input)
  );
}

async function runHydrationActivityProxyImpl(
  input: ObjectTypeCtx & { publishedSplitIds: string[] }
): Promise<{ prefetched: number }> {
  await fence(input);
  writeStageReceipt("hydration");
  await sleepForStageDelay();
  if (input.publishedSplitIds.length === 0) return { prefetched: 0 };
  // Hydration errors must NOT be silently swallowed — the spec §B3
  // retry budget (10 attempts, exponential backoff) is what absorbs
  // transient Quickwit unavailability. Surfacing the exception lets
  // Temporal apply the per-activity retry policy defined in
  // workflows.ts; a workflow-level failure after 10 attempts is the
  // correct signal that the searcher fleet is truly unreachable.
  const out = await runHydrationActivity({
    objectTypeApiName: input.objectTypeApiName,
    splitIds: input.publishedSplitIds,
    mode: "live",
  });
  return { prefetched: out.prefetchedSplitCount };
}

// ---------------------------------------------------------------------------
// projectStageToPostgres — keeps funnel_run.current_stage in sync for the
// UI. Always runs; never fails the workflow on PG errors.
// ---------------------------------------------------------------------------

export async function projectStageToPostgres(input: {
  ontologyId: string;
  objectTypeApiName: string;
  /** FUNN-ISO — deployment identity carried by the workflow. The fence
   *  gates the write so a projection from another environment can never
   *  land in this database. */
  environmentId?: string;
  objectTypeRid?: string;
  currentStage: "changelog" | "merge" | "indexing" | "hydration" | null;
  objectsIndexed?: number;
  /** Per-stage evidence counts (rowsEmitted/upserts/deletes/…) merged
   *  into the stage row's output_json — the operator-facing record that
   *  distinguishes "valid empty source" from "stage executed nothing
   *  suspiciously" and feeds the terminal indexed-consistency checks. */
  stageOutput?: Record<string, unknown>;
  /** When true, the previous stage just completed and should be
   *  stamped `succeeded` in funnel_stage_run. The workflow calls
   *  projectStageToPostgres twice per stage transition: once on
   *  start (to flip current_stage) and once with
   *  `completedPrevious=true` to close the record. */
  completedPrevious?: "changelog" | "merge" | "indexing" | "hydration";
  /** Unique key per pipeline execution within a long-lived parent
   *  workflow. The parent `ObjectTypeFunnelWorkflow` runs forever and
   *  handles many signals across its lifetime — without this suffix,
   *  every signal collapses into the SAME `funnel_run` row via the
   *  `ON CONFLICT (temporal_workflow_id)` clause and the UI sees no
   *  distinction between saves. Pass the driving signal's `signalId`
   *  (or any monotonic per-drain token) so each save produces a
   *  fresh run_id. Backwards-compat: when omitted, the old
   *  workflow-scoped behaviour is preserved. */
  runKey?: string;
}): Promise<void> {
  try {
    // projectStageToPostgres is the best-effort PROGRESS marker (it must
    // never fail the workflow on a PG blip). Hard environment fencing
    // belongs to the stage activities + projectFunnelTerminalActivity. When
    // the caller DID stamp an environment, however, a mismatch with this
    // worker/DB is a split-brain symptom and is metricated loudly, while
    // legacy unstamped callers (e.g. the non-Temporal replay path in tests)
    // remain best-effort.
    if (input.environmentId) {
      await fence(input);
    }
    const { ontologyId, objectTypeApiName, currentStage, objectsIndexed, runKey } = input;
    // Temporal gives us a stable workflowId per workflow instance. For
    // long-lived parent workflows we further scope with `runKey` (the
    // driving signal id) so each save → its own funnel_run row.
    //
    // The `@temporalio/activity` context is only available when this
    // activity is invoked by Temporal; outside Temporal (e.g. when the
    // PG dispatcher imports these helpers for tests) we fall back to a
    // content-addressed workflow id keyed on (object_type, stage,
    // minute) which keeps inserts idempotent without conflating runs.
    let baseWorkflowId: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const activityMod = require("@temporalio/activity") as {
        Context: { current(): { info: { workflowExecution: { workflowId: string } } } };
      };
      baseWorkflowId = activityMod.Context.current().info.workflowExecution.workflowId;
    } catch {
      baseWorkflowId = `non-temporal-${objectTypeApiName}`;
    }
    // NOTE: the value stored in funnel_run.temporal_workflow_id is a
    // PER-SAVE UPSERT key (`<bareWorkflowId>:<runKey>`), NOT the Temporal
    // workflow id. The `:runKey` suffix is load-bearing: without it, the
    // `ON CONFLICT (temporal_workflow_id)` upsert collapses every save
    // for an Object Type into a single funnel_run row and the UI loses
    // per-save distinction. The actual Temporal workflow id is the bare
    // `baseWorkflowId` (== funnelWorkflowId(objectTypeApiName) — see
    // temporal/worker.ts); reconcilers recover it from
    // object_type_api_name, NOT from this stored column. (See the
    // PASS-BY-REFERENCE notes + durableWorkflow.sweepViaTemporalVisibility.)
    const workflowId = runKey ? `${baseWorkflowId}:${runKey}` : baseWorkflowId;
    // FUNN-ISO-4: stamp the immutable execution-plan snapshot on creation —
    // ON CONFLICT keeps the pre-existing run's original snapshot intact.
    const { currentDefinition: funnelCurrentDefinition } = await import("../../funnel/executionPlan");
    const defPlan = funnelCurrentDefinition();

    if (currentStage === null) {
      const updated = await query(
        `INSERT INTO funnel_run
           (ontology_id, object_type_api_name, workflow_type, status,
            current_stage, objects_indexed, temporal_workflow_id, started_at, completed_at,
            environment_id, definition_version, execution_plan)
         VALUES ($1, $2, 'ObjectTypeFunnelWorkflow.temporal', 'completed',
                 NULL, COALESCE($3, 0), $4, now(), now(), $5, $6, $7::jsonb)
         ON CONFLICT (temporal_workflow_id)
         WHERE temporal_workflow_id IS NOT NULL
         DO UPDATE SET status = 'completed',
                       current_stage = NULL,
                       objects_indexed = COALESCE(EXCLUDED.objects_indexed, funnel_run.objects_indexed),
                       completed_at = now()
         RETURNING run_id`,
        [ontologyId, objectTypeApiName, objectsIndexed ?? null, workflowId, input.environmentId ?? null,
         defPlan.definitionVersion, JSON.stringify(defPlan)]
      );
      // Close the last open stage_run row (with evidence counts merged).
      if (updated.rows[0]?.run_id && input.completedPrevious) {
        await query(
          `UPDATE funnel_stage_run
              SET status = 'succeeded', finished_at = now(),
                  output_json = COALESCE($3::jsonb, output_json)
            WHERE run_id = $1 AND stage = $2 AND status = 'running'`,
          [
            updated.rows[0].run_id,
            input.completedPrevious,
            input.stageOutput ? JSON.stringify(input.stageOutput) : null,
          ]
        );
      }
      // The run is now 'completed', so ANY other stage row still at
      // pending/running is a leak, not a state — and the FE renders such a row
      // as a perpetual spinner regardless of the run's status. The update
      // above closes only `completedPrevious`; an earlier stage whose own
      // projection was lost (this whole function is best-effort and swallows
      // its errors) would otherwise stay open forever, unreachable by the boot
      // sweeps, which only select runs still at 'running'. See stageRunClosure.
      if (updated.rows[0]?.run_id) {
        const stranded = await closeOpenStageRuns(
          updated.rows[0].run_id,
          "run completed with this stage still open (stage projection was lost)"
        );
        if (stranded > 0) {
          console.warn(JSON.stringify({
            level: "warn",
            type: "funnel_stage_run_open_on_completed_run",
            runId: updated.rows[0].run_id,
            objectTypeApiName,
            closed: stranded,
          }));
        }
      }
      return;
    }
    const runRow = await query(
      `INSERT INTO funnel_run
         (ontology_id, object_type_api_name, workflow_type, status,
          current_stage, objects_indexed, temporal_workflow_id, started_at,
          environment_id, definition_version, execution_plan)
       VALUES ($1, $2, 'ObjectTypeFunnelWorkflow.temporal', 'running',
               $3, COALESCE($4, 0), $5, now(), $6, $7, $8::jsonb)
       ON CONFLICT (temporal_workflow_id)
       WHERE temporal_workflow_id IS NOT NULL
       DO UPDATE SET current_stage = EXCLUDED.current_stage,
                     objects_indexed = COALESCE(EXCLUDED.objects_indexed, funnel_run.objects_indexed),
                     -- CAS: dispatch_pending / workflow_started rows move to
                     -- 'running' only when execution actually begins — a
                     -- completed/cancelled row is NEVER regressed.
                     status = CASE
                       WHEN funnel_run.status IN ('dispatch_pending', 'workflow_started', 'running')
                         THEN 'running'
                       ELSE funnel_run.status
                     END
       RETURNING run_id`,
      [
        ontologyId,
        objectTypeApiName,
        currentStage,
        objectsIndexed ?? null,
        workflowId,
        input.environmentId ?? null,
        defPlan.definitionVersion,
        JSON.stringify(defPlan),
      ]
    );
    // NOTE: re-dispatch of the SAME signal id onto a terminal run row is
    // rejected by the CASE-guard above (status is preserved, never
    // regressed); the environment fence is the primary cross-env block.
    const runId = runRow.rows[0]?.run_id as string | undefined;
    if (runId) {
      // Close the previously-running stage (if any) + open a new one.
      if (input.completedPrevious) {
        await query(
          `UPDATE funnel_stage_run
              SET status = 'succeeded', finished_at = now(),
                  output_json = COALESCE($3::jsonb, output_json)
            WHERE run_id = $1 AND stage = $2 AND status = 'running'`,
          [
            runId,
            input.completedPrevious,
            input.stageOutput ? JSON.stringify(input.stageOutput) : null,
          ]
        );
      }
      await query(
        `INSERT INTO funnel_stage_run
           (run_id, stage, status, attempt, input_json, started_at)
         VALUES ($1, $2, 'running', 1, '{}'::jsonb, now())
         ON CONFLICT (run_id, stage, attempt) DO NOTHING`,
        [runId, currentStage]
      );
    }
  } catch {
    /* projection is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

async function ensureTable(
  objectTypeApiName: string,
  kind: "changelog" | "merged" | "index" | "hydration",
  tableName: string
): Promise<NonNullable<Awaited<ReturnType<typeof getTable>>>> {
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

async function loadIcebergSource(
  objectTypeApiName: string
): Promise<{ iceberg_location: string; primary_key_column: string | null } | null> {
  try {
    const res = await query(
      `SELECT iceberg_location, primary_key_column
         FROM backing_datasource bd
         JOIN object_type ot ON ot.object_type_id = bd.object_type_id
        WHERE ot.api_name = $1 AND bd.iceberg_location IS NOT NULL
        LIMIT 1`,
      [objectTypeApiName]
    );
    if (!res.rows[0]) return null;
    return res.rows[0];
  } catch {
    return null;
  }
}

let lastProbe = 0;
let lastOk = false;
async function isQuickwitReachable(): Promise<boolean> {
  const now = Date.now();
  if (now - lastProbe < 10_000) return lastOk;
  lastProbe = now;
  const base = process.env.QUICKWIT_URL ?? "http://localhost:7280";
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 2_000);
    const res = await fetch(`${base}/api/v1/version`, { signal: ctrl.signal });
    clearTimeout(tid);
    lastOk = res.ok;
  } catch {
    lastOk = false;
  }
  return lastOk;
}

// ---------------------------------------------------------------------------
// Foundry-bridged datasource reader
//
// Wizard-created Object Types register their `backing_datasource.file_path`
// as a synthetic string of the form
//   `<s3-key>#foundry-dataset:<uuid>#object-type:<uuid>`
// where the pre-tag prefix is the MinIO object key (uploaded via
// `storageService.uploadObject`). The legacy `reindexService.ts` already
// knows how to read these — the funnel pipeline historically did NOT,
// which is why a wizard-created OT would complete the Temporal funnel with
// 0 objects indexed (the changelog stage couldn't see any rows).
//
// This helper mirrors `reindexService.readFoundryBridgedFile` but adapts
// the output to the funnel's `SnapshotDiffReader` contract: each parsed
// row becomes an INSERT change keyed on the OT's primary-key column.
// ---------------------------------------------------------------------------

export interface FoundryBridgedDatasource {
  filePath: string;
  fileFormat: string;
  primaryKeyColumn: string | null;
}

/**
 * Strict parse of the synthetic backing_datasource locator
 * `<s3-key>#foundry-dataset:<uuid>#object-type:<uuid>`. Throws a clear,
 * actionable error on any malformed marker — a corrupt locator must fail
 * the changelog loudly, never stream zero rows silently.
 */
export function parseFoundryMarker(filePath: string): {
  s3Key: string;
  foundryDatasetUuid: string;
  objectTypeUuid: string;
} {
  const m = filePath.match(
    /^(.+)#foundry-dataset:([0-9a-f-]{36})#object-type:([0-9a-f-]{36})$/i,
  );
  if (!m) {
    throw new Error(
      `foundry-bridged backing source '${filePath}' has a missing or ` +
        `malformed marker — expected ` +
        `'<s3-key>#foundry-dataset:<uuid>#object-type:<uuid>'. ` +
        `Re-register the datasource; refusing to emit zero rows silently.`,
    );
  }
  return {
    s3Key: m[1],
    foundryDatasetUuid: m[2],
    objectTypeUuid: m[3],
  };
}

/**
 * Fail-closed gate: a changelog that emitted zero rows for a source that
 * is NOT empty is a wiring bug, not an empty object type. Throws — the
 * run fails loudly instead of completing with objects_indexed = 0.
 */
export function assertChangelogNonEmpty(args: {
  objectTypeApiName: string;
  rowsEmitted: number;
  sourceNonEmpty: boolean;
}): void {
  if (args.rowsEmitted === 0 && args.sourceNonEmpty) {
    throw new Error(
      `changelog for object type '${args.objectTypeApiName}' emitted 0 ` +
        `rows for a non-empty source — refusing to index an empty snapshot. ` +
        `Check the backing datasource locator and reader selection.`,
    );
  }
}

/**
 * Resolve the foundry-bridged backing datasource for an object type.
 *
 * Fail-closed contract (§4.1): a row registered through the foundry bridge
 * (non-null foundry_dataset_id, or a `#foundry-dataset:` tag in file_path)
 * MUST carry a well-formed marker. A malformed marker THROWS out of this
 * function — it must never be swallowed into `null`, because the caller
 * treats `null` as "no foundry source" and falls through to the pending-edit
 * fallback with sourceNonEmpty=false, which disarms the zero-row gate and
 * completes the run with zero rows silently.
 *
 * Only the catalog read itself is best-effort (unchanged behaviour): a
 * failing lookup still resolves to `null`. Exported for unit tests.
 */
export async function loadFoundryBridgedDatasource(
  objectTypeApiName: string
): Promise<FoundryBridgedDatasource | null> {
  let row:
    | {
        file_path: string | null;
        file_format: string | null;
        primary_key_column: string | null;
        foundry_dataset_id: string | null;
      }
    | undefined;
  try {
    const res = await query(
      `SELECT bd.file_path, bd.file_format, bd.primary_key_column,
              bd.foundry_dataset_id
         FROM backing_datasource bd
         JOIN object_type ot ON ot.object_type_id = bd.object_type_id
        WHERE ot.api_name = $1
          AND bd.file_path IS NOT NULL
        LIMIT 1`,
      [objectTypeApiName]
    );
    row = res.rows[0];
  } catch {
    return null;
  }
  if (!row) return null;
  const filePath: string = row.file_path ?? "";
  if (!filePath) return null;
  const bridgedById = row.foundry_dataset_id != null;
  // A row registered through the foundry bridge MUST carry a well-formed
  // marker. Missing/malformed => throw here (OUTSIDE the lookup try/catch),
  // never fall through to the pending-edit fallback (which would emit a
  // silent zero-row changelog).
  if (bridgedById || filePath.includes("#foundry-dataset:")) {
    parseFoundryMarker(filePath);
  } else {
    // Legacy local-filesystem path — not a foundry-bridged source; the
    // pending-edit fallback below owns it.
    return null;
  }
  const explicitFormat = row.file_format ?? null;
  let fileFormat = explicitFormat;
  if (!fileFormat) {
    const cleanPath = filePath.slice(0, filePath.indexOf("#"));
    const ext = cleanPath.toLowerCase();
    if (ext.endsWith(".json") || ext.endsWith(".jsonl")) fileFormat = "json";
    else if (ext.endsWith(".tsv")) fileFormat = "tsv";
    else fileFormat = "csv";
  }
  return {
    filePath,
    fileFormat,
    primaryKeyColumn: row.primary_key_column ?? null,
  };
}

function stripFoundryTags(filePath: string): string {
  const idx = filePath.indexOf("#foundry-dataset:");
  return idx >= 0 ? filePath.slice(0, idx) : filePath;
}

/**
 * Pull the `<uuid>` out of `#foundry-dataset:<uuid>` for use as
 * `source_transaction_id` (column type `uuid`, NOT free-form text).
 * Returns `null` when the tag is absent — the caller falls back to
 * `ZERO_UUID` so the insert still satisfies the column type.
 */
function extractFoundryDatasetUuid(filePath: string): string | null {
  const m = filePath.match(/#foundry-dataset:([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

/** True when the stripped path is a synthetic `iceberg://` URI — a
 *  foundry-bridged dataset whose bytes live in a local Iceberg table,
 *  NOT a MinIO object. The S3 HEAD guard can never succeed for these. */
function isIcebergBridgedPath(strippedPath: string): boolean {
  return strippedPath.startsWith("iceberg://");
}

/**
 * Resolve the read config + tenant for a foundry-bridged Iceberg dataset.
 * Prefers the producing `table_imports` row (authoritative schema/table);
 * falls back to parsing `iceberg://<warehouse>/<namespace>/<table>` so the
 * funnel keeps working even if the import record was deleted.
 */
async function loadIcebergBridgedConfig(
  foundryDatasetUuid: string
): Promise<{ config: { schema: string; table: string; warehouseRoot?: string }; tenant: string } | null> {
  try {
    const imp = await query(
      `SELECT ti.config AS import_config, COALESCE(c.tenant, 'default') AS tenant
         FROM table_imports ti
         LEFT JOIN connectivity_connections c ON c.rid = ti.connection_rid
        WHERE ti.dataset_rid = $1 AND ti.deleted_at IS NULL
        ORDER BY ti.created_at DESC
        LIMIT 1`,
      [`ri.foundry.main.dataset.${foundryDatasetUuid}`]
    );
    const cfg = imp.rows[0]?.import_config;
    if (cfg && cfg.schema && (cfg.targetTable ?? cfg.table)) {
      return {
        config: {
          schema: String(cfg.schema),
          table: String(cfg.targetTable ?? cfg.table),
          warehouseRoot: cfg.warehouseRoot ? String(cfg.warehouseRoot) : undefined,
        },
        tenant: imp.rows[0].tenant ?? "default",
      };
    }
    return null;
  } catch {
    return null;
  }
}

function parseIcebergUri(
  uri: string
): { config: { schema: string; table: string; warehouseRoot?: string }; tenant: string } | null {
  const rest = uri.replace(/^iceberg:\/\//, "").replace(/\/+$/, "");
  const parts = rest.split("/").filter(Boolean);
  // `<warehouse>/<namespace>/<table>` — namespace may be dotted but stays one segment.
  if (parts.length >= 3) {
    return {
      config: { schema: parts[parts.length - 2], table: parts[parts.length - 1] },
      tenant: parts[0],
    };
  }
  return null;
}

/**
 * SnapshotDiffReader over a foundry-bridged ICEBERG datasource. Streams every
 * row of the table's current snapshot (via `iterSyncedSnapshotRows`) as INSERT
 * changes keyed on the OT's primary-key column — mirroring the contract of
 * `buildFoundryBridgedReader` for CSV uploads.
 */
async function buildIcebergBridgedReader(
  ds: FoundryBridgedDatasource
): Promise<SnapshotDiffReader> {
  const stripped = stripFoundryTags(ds.filePath);
  const uuid = extractFoundryDatasetUuid(ds.filePath);
  const pkCol = ds.primaryKeyColumn ?? "primary_key";
  const txnId = uuid ?? ZERO_UUID;
  const ts = new Date().toISOString();
  const resolved =
    (uuid ? await loadIcebergBridgedConfig(uuid) : null) ??
    parseIcebergUri(stripped);
  if (!resolved) {
    throw new Error(
      `foundry-bridged iceberg source '${stripped}' could not be resolved to a ` +
        `(warehouse, namespace, table) identity — no producing sync found`
    );
  }
  const { iterSyncedSnapshotRows } = await import("../../datasets/synced-dataset-reader");
  return {
    async *read() {
      // Synced tables routinely contain repeated PKs (re-uploads / appends),
        // and computeChangelog rejects duplicate keys within one transaction.
        // Reuse the same disk-spilled last-wins dedup as the CSV reader.
      yield* dedupFoundryRows(
        iterSyncedSnapshotRows(resolved.config, resolved.tenant),
        pkCol,
        txnId,
        ts,
      );
    },
  };
}

/** Exported for the streaming-dedup unit test (scripts/test-foundry-dedup.ts);
 *  not called outside this module in production. */
export async function buildFoundryBridgedReader(
  ds: FoundryBridgedDatasource
): Promise<SnapshotDiffReader> {
  const s3Key = stripFoundryTags(ds.filePath);
  if (!s3Key) {
    // A `#foundry-dataset:` tag with no preceding key is corrupt. Fail
    // loudly — emitting zero rows here once masked a broken locator as a
    // successful empty run.
    throw new Error(
      `foundry-bridged backing source '${ds.filePath}' has an empty object ` +
        `key before '#foundry-dataset:' — refusing to emit zero rows silently.`,
    );
  }
  const pkCol = ds.primaryKeyColumn ?? "primary_key";
  // `source_transaction_id` lands in `object_instances.source_transaction_id`
  // which is a `uuid` column — passing a path-string here trips
  // PG error 22P02 ("invalid input syntax for type uuid"). Extract the
  // stable `foundry-dataset:<uuid>` tag baked into the synthetic file path
  // by `datasetDatasourceService.registerWithFoundryDataset` and use that
  // as the transaction id. The tag is invariant across runs of the same
  // file so the funnel's idempotency keys collapse correctly.
  const txnId = extractFoundryDatasetUuid(ds.filePath) ?? ZERO_UUID;
  const ts = new Date().toISOString();

  // STREAMING + DuckDB dedup (Option B). This replaces the old eager
  // `getObjectBuffer` + `buffer.toString("utf-8")` + sync `parseFoundryRows`
  // + in-memory `Map<string, SourceChangeRow>` dedup, which:
  //   (A) threw Node's Buffer.toString MAX_STRING_LENGTH (0x1fffffe8 =
  //       512 MiB) on ANY foundry-bridged CSV > 512 MiB — OO7's 895 MiB /
  //       5.6M-row test04.csv, with 949,181 duplicate order_ids — failing
  //       the changelog activity with the generic "Activity task failed"
  //       and leaving funnel_run stuck at "changelog".
  //   (B) materialised ALL rows into one JS array (~8-11 GiB at 5.6M),
  //   (C) held a `Map` of ALL deduped rows (~1.6-3.4 GiB).
  // The new path streams the S3 object through `parseCsvReadable` (csv-parse,
  // native backpressure, flat memory) into a DuckDB TEMP table staged in
  // BATCH=500, then dedups with `SELECT DISTINCT ON (primary_key) ... ORDER
  // BY primary_key, __seq DESC` (last-wins by file order — Q1 proved ON
  // CONFLICT is first-wins within a multi-row INSERT, unusable for last-wins;
  // DISTINCT ON over the disk-spilled temp table is the reliable path). The
  // deduped rows stream back out via `streamQuery` (one row at a time). The
  // full row set NEVER materialises in Node heap; the DuckDB TEMP table
  // spills to `/tmp/duckdb_spill` past the memory_limit. `readerKind:
  // "foundry-bridged"` lets computeChangelog skip its own `seenInTxn` O(N)
  // Map (redundant + would re-introduce the heap wall). Iceberg + pending-
  // edit readers keep the hard-throw (they don't pre-dedupe).
  // Phase 1 of docs/adr/2026-10-09-funnel-duplicate-primary-keys.md: the
  // CSV path still dedups last-wins, but it now MEASURES what it collapsed
  // (Palantir fails indexing on duplicate PKs within one transaction) so
  // the count lands in the changelog snapshot summary as `source_quality`.
  let quality: FoundrySourceQuality | null = null;
  return {
    readerKind: "foundry-bridged",
    sourceQuality: () => quality,
    async *read() {
      // CSV/TSV (the large-foundry-CSV case — OO7's 895 MiB / 5.6M-row
      // test04.csv) take the FAST path: DuckDB reads the file natively +
      // dedups in SQL (no per-row JS, no 11k multi-row INSERT statements).
      // JSONL/JSON stay on the general INSERT path (smaller volumes;
      // read_csv_auto is CSV-only).
      if (ds.fileFormat === "csv" || ds.fileFormat === "tsv") {
        yield* dedupFoundryCsvViaDuckDB(ds, s3Key, pkCol, txnId, ts, (q) => {
          quality = q;
        });
      } else {
        yield* dedupFoundryRows(streamFoundryRows(ds, s3Key), pkCol, txnId, ts);
      }
    },
  };
}

/**
 * FAST path for CSV/TSV foundry sources: stream the S3 object to a local
 * temp file, then let DuckDB read + dedup it NATIVELY (read_csv_auto +
 * DISTINCT ON). This replaces the per-row JS of `dedupFoundryRows`
 * (JSON.stringify + sqlStr + ~11k multi-row INSERTs) that made OO7's 5.6M-
 * row changelog take ~22 min on Attempt 1. DuckDB's vectorized CSV reader +
 * in-engine DISTINCT ON do the same work in ~seconds.
 *
 * `all_varchar=true` forces string types — matches parseCsvReadable (csv-parse
 * returns strings) and avoids BigInt type-inference that would break the
 * `JSON.stringify(r.properties)` in computeChangelog's rowIterable. `PARALLEL=
 * false` makes `row_number() OVER ()` deterministic file order so DISTINCT ON
 * (pk) ... ORDER BY pk, rn DESC is genuine last-wins-by-file-order (proven by
 * scripts/duckdb-all-varchar-test.js + scripts/duckdb-csv-order-test.js).
 */
async function* dedupFoundryCsvViaDuckDB(
  ds: FoundryBridgedDatasource,
  s3Key: string,
  pkCol: string,
  txnId: string,
  ts: string,
  onQuality?: (q: FoundrySourceQuality) => void,
): AsyncGenerator<SourceChangeRow> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-csv-"));
  const localPath = path.join(dir, "source.csv");
  const conn = await acquireConnection({ skipHttpfs: true });
  try {
    // Stream S3 → local file (disk, bounded; getObjectStream backpressure
    // keeps memory flat during the download — the 895 MiB object never
    // materialises as a JS Buffer/string, unlike the old getObjectBuffer path).
    const stream = await getObjectStream(s3Key);
    await pipeline(stream, fs.createWriteStream(localPath));

    const pkQ = `"${pkCol.replace(/"/g, '""')}"`;
    const lp = localPath.replace(/'/g, "''");
    // Explicit delim matches the old parseFoundryRows/parseCsvReadable behavior
    // (CSV ',', TSV literal tab).
    const delim = ds.fileFormat === "tsv" ? "\t" : ",";
    const src = `read_csv_auto('${lp}', delim='${delim}', PARALLEL=false, all_varchar=true)`;
    if (onQuality) {
      // One aggregate scan (DuckDB's vectorised CSV reader: seconds at 5M
      // rows). Duplicate count = rows with a usable PK minus distinct PKs.
      const agg = await queryAll<{ total: unknown; null_pk: unknown; distinct_pk: unknown }>(
        conn,
        `SELECT count(*) AS total, ` +
          `count(*) FILTER (WHERE ${pkQ} IS NULL OR ${pkQ} = '') AS null_pk, ` +
          `count(DISTINCT ${pkQ}) FILTER (WHERE ${pkQ} IS NOT NULL AND ${pkQ} <> '') AS distinct_pk ` +
          `FROM ${src}`,
      );
      const total = Number(agg[0]?.total ?? 0);
      const nullPk = Number(agg[0]?.null_pk ?? 0);
      const distinctPk = Number(agg[0]?.distinct_pk ?? 0);
      const duplicatePkRows = Math.max(0, total - nullPk - distinctPk);
      let samples: string[] = [];
      if (duplicatePkRows > 0) {
        const s = await queryAll<{ pk: unknown }>(
          conn,
          `SELECT ${pkQ} AS pk FROM ${src} WHERE ${pkQ} IS NOT NULL AND ${pkQ} <> '' ` +
            `GROUP BY 1 HAVING count(*) > 1 ORDER BY 1 LIMIT 5`,
        );
        samples = s.map((r) => String(r.pk));
        console.warn(
          `[funnel] foundry CSV '${s3Key}' has ${duplicatePkRows} duplicate-PK row(s) on '${pkCol}' ` +
            `(collapsed last-wins; Palantir would fail this transaction). samples=${JSON.stringify(samples)}`,
        );
      }
      onQuality({
        sourceRows: total,
        distinctPrimaryKeys: distinctPk,
        duplicatePkRows,
        nullOrEmptyPkRows: nullPk,
        duplicatePkSamples: samples,
      });
    }
    const sql =
      `SELECT DISTINCT ON (${pkQ}) * FROM (` +
      `SELECT *, row_number() OVER () AS rn FROM read_csv_auto('${lp}', delim='${delim}', PARALLEL=false, all_varchar=true)` +
      `) ORDER BY ${pkQ}, rn DESC`;
    for await (const row of streamQuery<Record<string, unknown> & { rn?: unknown }>(conn, sql)) {
      const pkVal = row[pkCol];
      if (pkVal == null || pkVal === "") continue; // skip null-PK rows, mirror reindexService
      // properties = all columns EXCEPT the internal `rn` tiebreaker.
      const { rn: _rn, ...properties } = row;
      void _rn;
      yield {
        primary_key: String(pkVal),
        operation: "INSERT" as SourceChangeRow["operation"],
        properties: properties as Record<string, unknown>,
        source_transaction_id: txnId,
        source_commit_timestamp: ts,
      };
    }
  } finally {
    releaseConnection(conn);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Lazily stream raw (un-deduped) source rows from the foundry-bridged MinIO
 * object. CSV/TSV stream through `parseCsvReadable` (the SAME helper
 * reindexService/dataPreview use — no second CSV parser, BOM + header
 * sanitization + null-norm handled in its columns callback); JSONL streams
 * line-by-line through `readline` + per-line `JSON.parse`; top-level bracket
 * -array JSON is the ONE bounded path (`getObjectBuffer` + `JSON.parse`)
 * and is only safe for small objects — a >512 MiB bracket JSON throws at
 * `buffer.toString` (the same MAX_STRING_LENGTH wall). That bracket-JSON
 * case is a known, flagged limitation; OO7 is CSV.
 */
async function* streamFoundryRows(
  ds: FoundryBridgedDatasource,
  s3Key: string,
): AsyncGenerator<Record<string, unknown>> {
  const fmt = ds.fileFormat;
  if (fmt === "csv" || fmt === "tsv") {
    const stream = await getObjectStream(s3Key);
    const delimiter = fmt === "tsv" ? "\t" : ",";
    const { rows } = await parseCsvReadable(stream, {
      delimiter,
      normalizeNulls: true,
      source: ds.filePath,
    });
    for await (const r of rows) yield r as Record<string, unknown>;
    return;
  }
  if (fmt === "jsonl") {
    const stream = await getObjectStream(s3Key);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const t = line.trim();
        if (!t) continue;
        yield JSON.parse(t) as Record<string, unknown>;
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    return;
  }
  if (fmt === "json") {
    // Bounded path — small top-level bracket-array JSON only. parseCsvReadable
    // is CSV-only; a streaming bracket-JSON parser would need a new dep. The
    // Option D guard's configurable ceiling (TELLUS_FOUNDRY_SOURCE_MAX_BYTES)
    // catches the >512 MiB case before this read; otherwise a giant bracket
    // JSON throws at buffer.toString (known limitation — flagged in writeup).
    const buffer = await getObjectBuffer(s3Key);
    const trimmed = buffer.toString("utf-8").trim();
    const parsed = trimmed.startsWith("[")
      ? (JSON.parse(trimmed) as unknown[])
      : [JSON.parse(trimmed)];
    for (const r of parsed) yield r as Record<string, unknown>;
    return;
  }
  throw new Error(`Unsupported foundry-bridge file format: '${fmt}'`);
}

/**
 * De-duplicate a stream of raw source rows by `pkCol` with LAST-WINS-by-file
 * -order, yielding `SourceChangeRow`s, in O(1) JS heap via a disk-spilled
 * DuckDB TEMP table. See `buildFoundryBridgedReader` for the O(N) walls this
 * replaces (the old `Map<string, SourceChangeRow>`).
 */
async function* dedupFoundryRows(
  rows: AsyncIterable<Record<string, unknown>>,
  pkCol: string,
  txnId: string,
  ts: string,
): AsyncGenerator<SourceChangeRow> {
  const conn = await acquireConnection({ skipHttpfs: true });
  const tempTable = `fb_dedup_${randomUUID().replace(/-/g, "_")}`;
  try {
    await runAll(
      conn,
      `CREATE TEMP TABLE ${tempTable} (` +
        `primary_key VARCHAR, operation VARCHAR, properties VARCHAR, ` +
        `source_transaction_id VARCHAR, source_commit_timestamp VARCHAR, ` +
        `__seq BIGINT)`,
    );
    let seq = 0;
    const BATCH = 500;
    let batch: string[] = [];
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      await runAll(conn, `INSERT INTO ${tempTable} VALUES ${batch.join(", ")}`);
      batch = [];
    };
    for await (const row of rows) {
      const pk = row[pkCol];
      if (pk == null || pk === "") continue; // skip null-PK rows, mirror reindexService
      const key = String(pk);
      // `properties` is stored as a JSON string in the temp table and
      // JSON.parsed back to an object on the deduped read-out (computeChangelog
      // re-stringifies it for the parquet). sqlStr doubles single quotes so a
      // value like "O'Brien" stays a valid DuckDB string literal.
      const propsJson = sqlStr(JSON.stringify(row));
      batch.push(
        `(${sqlStr(key)},'INSERT',${propsJson},${sqlStr(txnId)},${sqlStr(ts)},${seq})`,
      );
      seq++;
      if (batch.length >= BATCH) {
        await flush();
        // Liveness evidence for the heartbeat loop (temporal/stageProgress.ts).
        // A stalled S3 read or a wedged DuckDB insert now stops the heartbeats
        // instead of being masked by a free-running timer.
        reportStageProgress(`changelog dedup insert seq=${seq}`);
      }
    }
    await flush(); // final partial batch
    if (seq === 0) return; // empty source — Parquet cannot represent zero rows

    // DISTINCT ON last-wins by file order (__seq DESC). Q1 proved ON CONFLICT
    // is first-wins within a multi-row INSERT — unusable here. DISTINCT ON
    // over the disk-spilled TEMP table (temp_directory=/tmp/duckdb_spill)
    // sorts + dedups in O(N log N) on disk, never in JS heap.
    const dedupSql =
      `SELECT DISTINCT ON (primary_key) primary_key, operation, properties, ` +
      `source_transaction_id, source_commit_timestamp FROM ${tempTable} ` +
      `ORDER BY primary_key, __seq DESC`;
    let emitted = 0;
    for await (const r of streamQuery<{
      primary_key: string;
      operation: string;
      properties: string;
      source_transaction_id: string;
      source_commit_timestamp: string;
    }>(conn, dedupSql)) {
      let properties: Record<string, unknown> = {};
      if (r.properties) {
        try {
          const p = JSON.parse(r.properties);
          if (p && typeof p === "object" && !Array.isArray(p)) {
            properties = p as Record<string, unknown>;
          }
        } catch {
          /* keep {} — shouldn't happen (we JSON.stringify'd on insert) */
        }
      }
      emitted++;
      if (emitted % 5000 === 0) reportStageProgress(`changelog dedup read=${emitted}`);
      yield {
        primary_key: r.primary_key,
        operation: r.operation as SourceChangeRow["operation"],
        properties,
        source_transaction_id: r.source_transaction_id,
        source_commit_timestamp: r.source_commit_timestamp,
      };
    }
  } finally {
    try {
      await runAll(conn, `DROP TABLE IF EXISTS ${tempTable}`);
    } catch {
      /* ignore — connection is released anyway */
    }
    releaseConnection(conn);
  }
}

/** SQL string literal: single-quote-doubling (DuckDB standard SQL strings). */
function sqlStr(s: string): string {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// NOTE: the old eager `parseFoundryRows(content, format, path)` (csv-parse
// SYNC over a whole-file string + a JSON whole-doc parse) was removed when
// `buildFoundryBridgedReader` switched to streaming. CSV/TSV now stream
// through `parseCsvReadable` (csv-parse stream-mode) and JSONL through
// `readline`; only the small bracket-array JSON path still does a bounded
// `getObjectBuffer` + `JSON.parse` (see `streamFoundryRows`). The whole-file
// `buffer.toString("utf-8")` that threw Node's 512 MiB MAX_STRING_LENGTH is
// gone for every streaming format.

// ---------------------------------------------------------------------------
// projectFunnelTerminalActivity
//
// Final stage of the Temporal pipeline: write the run's terminal status
// back into `funnel_state` so the UI badge flips from "Indexing" to
// "Indexed" / "Failed" and the object count surfaces in the OT overview.
//
// Before this activity existed the workflow only updated `funnel_run` +
// `funnel_pipeline_state` — `funnel_state.status` was left at whatever the
// dispatcher's `pre_temporal` hand-off set it to (always 'indexing'),
// which is why object types appeared stuck on "Indexing" indefinitely
// after the pipeline completed successfully. See `funnelStateProjection.ts`
// for the shared SQL + WebSocket emission shared with the PG dispatcher.
// ---------------------------------------------------------------------------

export async function projectFunnelTerminalActivity(input: {
  ontologyId: string;
  objectTypeApiName: string;
  /** FUNN-ISO — stamped dispatch identity (fence + CAS inputs). */
  objectTypeRid?: string;
  environmentId?: string;
  status: FunnelStateStatus;
  objectsIndexed?: number;
  errorMessage?: string;
  /** The driving signal's id — passed through so the failed path can mark
   *  `funnel_run` failed by `temporal_workflow_id` (not just `funnel_state`),
   *  closing the bookkeeping divergence that left `funnel_run` stuck at
   *  "changelog" while Temporal was terminal FAILED. */
  runKey?: string;
  /** The pre-created dispatch run (FUNN-ISO-6) — CAS anchor. */
  funnelRunId?: string;
  /** Permit the explicit object_type_deleted terminal marking. */
  allowObjectTypeDeletedMarking?: boolean;
}): Promise<void> {
  await fence(input);
  try {
    await projectFunnelTerminalToState(
      input.ontologyId,
      input.objectTypeApiName,
      input.status,
      {
      objectsIndexed: input.objectsIndexed,
      errorMessage: input.errorMessage,
      runKey: input.runKey,
      runId: input.funnelRunId,
      environmentId: input.environmentId,
      objectTypeRid: input.objectTypeRid,
        allowObjectTypeDeletedMarking: input.allowObjectTypeDeletedMarking,
        path: "post",
      },
    );
  } catch (err) {
    recordTerminalProjectionFailed({
      object_type: input.objectTypeApiName,
      status: input.status,
      environment: input.environmentId ?? "unknown",
      error_class: err instanceof Error ? err.constructor.name : "unknown",
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// syncOpenSearchActivity
//
// Pushes every `object_instances` row for the Object Type into the
// canonical OpenSearch index that the FE search panel reads from. This
// closes the gap where the Temporal pipeline only wrote Postgres +
// Quickwit splits, leaving `ontology-<apiname>` non-existent in
// OpenSearch — so the right-rail "CURRENT VALUE" card showed
// "500 objects pending index | Rows exist but aren't searchable yet"
// even though `funnel_state.status='indexed'` and `objects_indexed=500`.
//
// Runs immediately after `runMergeActivity` so OpenSearch reflects the
// freshly-merged truth before Quickwit indexing / hydration kick in.
// Retry-safe: index is created on demand, bulkIndex uses the "index"
// action keyed by `__pk` (insert-or-replace).
// ---------------------------------------------------------------------------

export async function syncOpenSearchActivity(input: {
  ontologyId: string;
  objectTypeApiName: string;
  objectTypeRid?: string;
  environmentId?: string;
}): Promise<{
  indexName: string;
  indexCreated: boolean;
  rowsRead: number;
  rowsIndexed: number;
  durationMs: number;
}> {
  await fence(input);
  // The Object Type may have been deleted while its funnel workflow was still
  // alive — durable `ObjectTypeFunnelWorkflow` instances outlive the type they
  // index. Syncing a now-missing type throws "not found in metadata store"
  // (indexMappingGenerator), which fails the activity on every retry and the
  // whole workflow with it. Treat a deleted type as a no-op so the workflow
  // completes cleanly instead of error-looping.
  const rid = (input as { objectTypeRid?: string }).objectTypeRid;
  const exists = await query(
    `SELECT object_type_id
       FROM object_type
      WHERE ontology_id = $1 AND api_name = $2
      LIMIT 1`,
    [input.ontologyId, input.objectTypeApiName]
  );
  if (
    exists.rows.length === 0 ||
    (rid && exists.rows[0].object_type_id !== rid)
  ) {
    // FAIL-CLOSED (FUNN-ISO-4): the workflow expected this type. A missing
    // type means mid-run deletion (legitimate) or cross-environment
    // execution (the 2026-07-31 bug). Throw a typed error — the workflow
    // converts it to the explicit `object_type_deleted` terminal state;
    // never a silent green no-op.
    recordMissingObjectType({
      object_type: input.objectTypeApiName,
      status: "sync_opensearch",
      environment: (input as { environmentId?: string }).environmentId ?? "unknown",
    });
    throw ApplicationFailure.create({
      message: `object type '${input.objectTypeApiName}' (rid=${rid ?? "?"}) not found in this database — refusing OpenSearch sync`,
      type: "FunnelObjectTypeMissing",
      nonRetryable: true,
    });
  }

  // Lazy import so the worker's bundle doesn't pull the opensearch
  // client during cold-start unless this activity actually runs.
  const { syncObjectInstancesToOpenSearch } = await import(
    "../../opensearch/syncFromInstances"
  );
  return syncObjectInstancesToOpenSearch(
    input.objectTypeApiName,
    input.ontologyId,
  );
}
