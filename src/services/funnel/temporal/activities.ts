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
  ChangelogRow,
} from "../changelogStage";
import { DatasourceContribution } from "../mergeStage";
import {
  duckdbIcebergDiffReader,
  isDuckDBAvailable,
  mergeChangesMaybeDuckDB,
} from "../duckdbIceberg";
import { createTable, funnelNamespace, getTable } from "../icebergCatalog";
import {
  getPendingMergeEdits,
  getPendingIndexEdits,
  markEditsAppliedToIndex,
} from "../../../models/ontologyEdit";
import { runIndexingActivity } from "../../quickwit/indexingActivity";
import { ensureIndex } from "../../quickwit/indexManager";
import { MergedRow } from "../../quickwit/docBuilder";
import { runHydrationActivity } from "../../quickwit/hydrationActivity";
import { sleepForStageDelay } from "../stageDelay";
import {
  projectFunnelTerminalToState,
  type FunnelStateStatus,
} from "../funnelStateProjection";
import { getObjectBuffer } from "../../storageService";

// Heartbeat + stage-duration helper. Every long-running activity wraps
// its body in `withStageInstrumentation(stage, obj, async () => ...)`.
// The helper:
//   * records wall-clock duration into funnel_stage_duration_seconds
//   * starts a 5s heartbeat so Temporal knows the worker is alive (a
//     merge/indexing activity that quietly blocks without heartbeating
//     would otherwise stay in "running" until startToCloseTimeout hits —
//     precisely the "stuck on sync" symptom we saw in prod)
//   * counts errors per stage so on-call sees which stage is flaky
async function withStageInstrumentation<T>(
  stage: "changelog" | "merge" | "indexing" | "hydration",
  objectTypeApiName: string,
  fn: () => Promise<T>
): Promise<T> {
  const started = Date.now();
  const heartbeat = startHeartbeatLoop();
  try {
    const out = await fn();
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

function startHeartbeatLoop(): { stop: () => void } {
  let cancelled = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = () => {
    if (cancelled) return;
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
    timer = setTimeout(tick, 5000);
  };
  timer = setTimeout(tick, 5000);
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
}

// ---------------------------------------------------------------------------
// runChangelogActivity
// ---------------------------------------------------------------------------

export async function runChangelogActivity(
  input: ObjectTypeCtx
): Promise<{ snapshotId: string; rowsEmitted: number; rows: ChangelogRow[] }> {
  return withStageInstrumentation("changelog", input.objectTypeApiName, async () =>
    runChangelogActivityImpl(input)
  );
}

async function runChangelogActivityImpl(
  input: ObjectTypeCtx
): Promise<{ snapshotId: string; rowsEmitted: number; rows: ChangelogRow[] }> {
  // Optional dev/demo pacing — no-op in production (env default 0).
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
  const iceberg = await loadIcebergSource(input.objectTypeApiName);
  if (iceberg && isDuckDBAvailable()) {
    reader = duckdbIcebergDiffReader({
      tableLocation: iceberg.iceberg_location,
      primaryKeyColumn: iceberg.primary_key_column ?? "primary_key",
    });
  } else {
    const foundry = await loadFoundryBridgedDatasource(input.objectTypeApiName);
    if (foundry) {
      reader = await buildFoundryBridgedReader(foundry);
    } else {
      const pending = await getPendingMergeEdits(input.objectTypeApiName);
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
    },
    reader
  );
  return { snapshotId: result.snapshotId, rowsEmitted: result.rowsEmitted, rows: result.rows };
}

// ---------------------------------------------------------------------------
// runMergeActivity
// ---------------------------------------------------------------------------

export async function runMergeActivity(
  input: ObjectTypeCtx & { changelogRows: ChangelogRow[] }
): Promise<{
  snapshotId: string;
  upserts: number;
  deletes: number;
  editIds: string[];
  mergedRows: Array<{
    primary_key: string;
    properties: Record<string, unknown>;
    markings: string[];
    operation: "upsert" | "delete";
    source_transaction_id: string | null;
  }>;
}> {
  return withStageInstrumentation("merge", input.objectTypeApiName, async () =>
    runMergeActivityImpl(input)
  );
}

async function runMergeActivityImpl(
  input: ObjectTypeCtx & { changelogRows: ChangelogRow[] }
): Promise<{
  snapshotId: string;
  upserts: number;
  deletes: number;
  editIds: string[];
  mergedRows: Array<{
    primary_key: string;
    properties: Record<string, unknown>;
    markings: string[];
    operation: "upsert" | "delete";
    source_transaction_id: string | null;
  }>;
}> {
  await sleepForStageDelay();
  const mergedTable = await ensureTable(input.objectTypeApiName, "merged", "state");
  const pending = await getPendingMergeEdits(input.objectTypeApiName);
  const contributions: DatasourceContribution[] = [
    {
      datasource_id: ZERO_UUID,
      owned_properties: uniqueProps(input.changelogRows),
      changelog_rows: input.changelogRows,
      markings: [],
    },
  ];
  const out = await mergeChangesMaybeDuckDB({
    ontologyId: input.ontologyId,
    objectTypeApiName: input.objectTypeApiName,
    contributions,
    pendingEdits: pending,
    editStrategy: "user_edit_wins",
    mergedTableId: mergedTable.dataset_table_id,
    mergedOutputFileLocation: `${mergedTable.location}/data/${new Date().toISOString()}.parquet`,
  });
  return {
    snapshotId: out.snapshotId,
    upserts: out.upserts,
    deletes: out.deletes,
    editIds: pending.map((e) => e.edit_id),
    mergedRows: out.mergedRows.map((r) => ({
      primary_key: r.primary_key,
      properties: r.properties,
      markings: r.markings,
      operation: r.operation,
      source_transaction_id: r.source_transaction_id ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// runIndexingActivityProxy
// ---------------------------------------------------------------------------

export async function runIndexingActivityProxy(
  input: ObjectTypeCtx & {
    mergedRows: Array<{
      primary_key: string;
      properties: Record<string, unknown>;
      markings: string[];
      operation: "upsert" | "delete";
      source_transaction_id: string | null;
    }>;
    editIds: string[];
  }
): Promise<{ editsIndexed: number; publishedSplitIds: string[]; quickwit: boolean }> {
  return withStageInstrumentation("indexing", input.objectTypeApiName, async () =>
    runIndexingActivityProxyImpl(input)
  );
}

async function runIndexingActivityProxyImpl(
  input: ObjectTypeCtx & {
    mergedRows: Array<{
      primary_key: string;
      properties: Record<string, unknown>;
      markings: string[];
      operation: "upsert" | "delete";
      source_transaction_id: string | null;
    }>;
    editIds: string[];
  }
): Promise<{ editsIndexed: number; publishedSplitIds: string[]; quickwit: boolean }> {
  await sleepForStageDelay();
  const pending = await getPendingIndexEdits(input.objectTypeApiName);
  const editIds = pending.map((e) => e.edit_id);

  const reachable = await isQuickwitReachable();
  if (!reachable || input.mergedRows.length === 0) {
    await markEditsAppliedToIndex(editIds);
    return { editsIndexed: editIds.length, publishedSplitIds: [], quickwit: false };
  }

  try {
    await ensureIndex({ objectTypeApiName: input.objectTypeApiName });
    const mergedRows: MergedRow[] = input.mergedRows.map((r, i) => ({
      primary_key: r.primary_key,
      properties: r.properties,
      operation: r.operation === "delete" ? "DELETE" : "UPDATE",
      version: i + 1,
      source_transaction_id: r.source_transaction_id ?? undefined,
    }));
    const reader = (async function* () {
      yield { rows: mergedRows, editIds };
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
    return {
      editsIndexed: editIds.length,
      publishedSplitIds: out.publishedSplitIds,
      quickwit: true,
    };
  } catch (err) {
    console.warn(`[temporal/indexing] ${(err as Error).message}`);
    await markEditsAppliedToIndex(editIds);
    return { editsIndexed: editIds.length, publishedSplitIds: [], quickwit: false };
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
  currentStage: "changelog" | "merge" | "indexing" | "hydration" | null;
  objectsIndexed?: number;
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
    const workflowId = runKey ? `${baseWorkflowId}:${runKey}` : baseWorkflowId;

    if (currentStage === null) {
      const updated = await query(
        `INSERT INTO funnel_run
           (ontology_id, object_type_api_name, workflow_type, status,
            current_stage, objects_indexed, temporal_workflow_id, started_at, completed_at)
         VALUES ($1, $2, 'ObjectTypeFunnelWorkflow.temporal', 'completed',
                 NULL, COALESCE($3, 0), $4, now(), now())
         ON CONFLICT (temporal_workflow_id)
         WHERE temporal_workflow_id IS NOT NULL
         DO UPDATE SET status = 'completed',
                       current_stage = NULL,
                       objects_indexed = COALESCE(EXCLUDED.objects_indexed, funnel_run.objects_indexed),
                       completed_at = now()
         RETURNING run_id`,
        [ontologyId, objectTypeApiName, objectsIndexed ?? null, workflowId]
      );
      // Close the last open stage_run row.
      if (updated.rows[0]?.run_id && input.completedPrevious) {
        await query(
          `UPDATE funnel_stage_run
              SET status = 'succeeded', finished_at = now()
            WHERE run_id = $1 AND stage = $2 AND status = 'running'`,
          [updated.rows[0].run_id, input.completedPrevious]
        );
      }
      return;
    }
    const runRow = await query(
      `INSERT INTO funnel_run
         (ontology_id, object_type_api_name, workflow_type, status,
          current_stage, objects_indexed, temporal_workflow_id, started_at)
       VALUES ($1, $2, 'ObjectTypeFunnelWorkflow.temporal', 'running',
               $3, COALESCE($4, 0), $5, now())
       ON CONFLICT (temporal_workflow_id)
       WHERE temporal_workflow_id IS NOT NULL
       DO UPDATE SET current_stage = EXCLUDED.current_stage,
                     objects_indexed = COALESCE(EXCLUDED.objects_indexed, funnel_run.objects_indexed)
       RETURNING run_id`,
      [
        ontologyId,
        objectTypeApiName,
        currentStage,
        objectsIndexed ?? null,
        workflowId,
      ]
    );
    const runId = runRow.rows[0]?.run_id as string | undefined;
    if (runId) {
      // Close the previously-running stage (if any) + open a new one.
      if (input.completedPrevious) {
        await query(
          `UPDATE funnel_stage_run
              SET status = 'succeeded', finished_at = now()
            WHERE run_id = $1 AND stage = $2 AND status = 'running'`,
          [runId, input.completedPrevious]
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

function uniqueProps(rows: ChangelogRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.properties)) set.add(k);
  return Array.from(set);
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

interface FoundryBridgedDatasource {
  filePath: string;
  fileFormat: string;
  primaryKeyColumn: string | null;
}

async function loadFoundryBridgedDatasource(
  objectTypeApiName: string
): Promise<FoundryBridgedDatasource | null> {
  try {
    const res = await query(
      `SELECT bd.file_path, bd.file_format, bd.primary_key_column
         FROM backing_datasource bd
         JOIN object_type ot ON ot.object_type_id = bd.object_type_id
        WHERE ot.api_name = $1
          AND bd.file_path IS NOT NULL
        LIMIT 1`,
      [objectTypeApiName]
    );
    const row = res.rows[0];
    if (!row) return null;
    const filePath: string = row.file_path;
    if (!filePath) return null;
    // Restrict to foundry-bridged files (presence of the `#foundry-dataset:`
    // tag). Local-filesystem paths fall through to the pending-edit fallback
    // — the funnel's contract is that "real" backing data lives in MinIO.
    if (!filePath.includes("#foundry-dataset:")) return null;
    const explicitFormat = (row.file_format as string | null) ?? null;
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
      primaryKeyColumn: (row.primary_key_column as string | null) ?? null,
    };
  } catch {
    return null;
  }
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

async function buildFoundryBridgedReader(
  ds: FoundryBridgedDatasource
): Promise<SnapshotDiffReader> {
  const s3Key = stripFoundryTags(ds.filePath);
  if (!s3Key) {
    // Defensive: a `#foundry-dataset:` tag with no preceding key is corrupt.
    // Treat as "no source" so the changelog stage emits zero rows instead of
    // throwing — the projection activity will surface this as an empty run.
    return { async *read() { /* no rows */ } };
  }
  const buffer = await getObjectBuffer(s3Key);
  let content = buffer.toString("utf-8");
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

  // Parse once, eagerly, so we don't keep the MinIO buffer alive during
  // the (potentially long) stream-yield. The reader yields synchronously
  // from an in-memory array; for >100k-row datasources we should swap
  // this for a streaming parser, but the foundry CSV upload path already
  // caps at the multer max (50 MiB) so the eager path is bounded.
  const rows = await parseFoundryRows(content, ds.fileFormat, ds.filePath);
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

  // The funnel's `computeChangelog` rejects duplicate primary keys within
  // a single source transaction (see `seenInTxn` in changelogStage.ts).
  // De-dupe with last-wins semantics — matches the SNAPSHOT transaction
  // behaviour of `reindexService.ts` and avoids a "duplicate primary key"
  // error that would otherwise abort the entire funnel run on dirty CSVs.
  const dedup = new Map<string, SourceChangeRow>();
  for (const row of rows) {
    const pk = row[pkCol];
    if (pk == null || pk === "") continue; // skip null-PK rows, mirror reindexService
    const key = String(pk);
    dedup.set(key, {
      primary_key: key,
      operation: "INSERT",
      properties: row,
      source_transaction_id: txnId,
      source_commit_timestamp: ts,
    });
  }
  const out = Array.from(dedup.values());
  return {
    async *read() {
      for (const r of out) yield r;
    },
  };
}

async function parseFoundryRows(
  content: string,
  format: string,
  rawFilePath: string,
): Promise<Record<string, unknown>[]> {
  if (format === "csv" || format === "tsv") {
    const { parse } = await import("csv-parse/sync");
    const { sanitizeCsvHeader } = await import("../../../utils/csvHeader");
    const records: Record<string, string>[] = parse(content, {
      columns: (h: string[]) => sanitizeCsvHeader(h, { source: rawFilePath }),
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
      delimiter: format === "tsv" ? "\t" : ",",
    });
    for (const record of records) {
      for (const key of Object.keys(record)) {
        const v = (record as Record<string, unknown>)[key];
        if (typeof v === "string") {
          const n = v.trim().toLowerCase();
          if (n === "" || n === "null" || n === "na" || n === "n/a") {
            (record as Record<string, unknown>)[key] = null;
          }
        }
      }
    }
    return records;
  }
  if (format === "json" || format === "jsonl") {
    const trimmed = content.trim();
    if (trimmed.startsWith("[")) {
      return JSON.parse(trimmed) as Record<string, unknown>[];
    }
    return trimmed
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  throw new Error(`Unsupported foundry-bridge file format: '${format}'`);
}

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
  status: FunnelStateStatus;
  objectsIndexed?: number;
  errorMessage?: string;
}): Promise<void> {
  await projectFunnelTerminalToState(
    input.ontologyId,
    input.objectTypeApiName,
    input.status,
    {
      objectsIndexed: input.objectsIndexed,
      errorMessage: input.errorMessage,
      path: "post",
    },
  );
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
}): Promise<{
  indexName: string;
  indexCreated: boolean;
  rowsRead: number;
  rowsIndexed: number;
  durationMs: number;
}> {
  // Lazy import so the worker's bundle doesn't pull the opensearch
  // client during cold-start unless this activity actually runs.
  const { syncObjectInstancesToOpenSearch } = await import(
    "../../opensearch/syncFromInstances"
  );
  return syncObjectInstancesToOpenSearch(input.objectTypeApiName);
}
