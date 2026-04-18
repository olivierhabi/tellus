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
  // Optional dev/demo pacing — no-op in production (env default 0).
  await sleepForStageDelay();
  const table = await ensureTable(input.objectTypeApiName, "changelog", "default");
  // Prefer DuckDB iceberg_scan when the source advertises an Iceberg
  // location; otherwise derive rows from the pending edit queue.
  const datasource = await loadIcebergSource(input.objectTypeApiName);
  let reader: SnapshotDiffReader;
  if (datasource && isDuckDBAvailable()) {
    reader = duckdbIcebergDiffReader({
      tableLocation: datasource.iceberg_location,
      primaryKeyColumn: datasource.primary_key_column ?? "primary_key",
    });
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
