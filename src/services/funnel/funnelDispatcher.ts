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
import { sleepForStageDelay } from "./stageDelay";
import { projectFunnelTerminalToState } from "./funnelStateProjection";
import {
  computeChangelog,
  SnapshotDiffReader,
  SourceChangeRow,
  ChangelogRow,
} from "./changelogStage";
import {
  DatasourceContribution,
  EditStrategy,
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
  const objectTypes = options.objectTypes ?? (await listObjectTypesWithSignals());
  let runsStarted = 0;
  for (const objectTypeApiName of objectTypes) {
    const signal = await claimNextSignal(objectTypeApiName, null);
    if (!signal) continue;

    if (temporalActive) {
      // Temporal owns execution — we just record the hand-off so the
      // UI projection can correlate this signal to its Temporal run
      // (the Temporal workflow projects back into funnel_run itself,
      // see services/funnel/temporal/activities.ts:projectStageToPostgres).
      await query(
        `INSERT INTO funnel_run
           (ontology_id, object_type_api_name, workflow_type, status,
            signal_payload, completed_at)
         VALUES ($1, $2, 'temporal_handoff', 'completed', $3::jsonb, now())
         RETURNING run_id`,
        [signal.ontology_id, objectTypeApiName, JSON.stringify(signal.payload)]
      );
      // Project that we've handed off to Temporal so the UI badge
      // flips to "Indexing" immediately. Temporal's own activities
      // are responsible for projecting the terminal state.
      await projectFunnelTerminalToState(
        signal.ontology_id,
        objectTypeApiName,
        "indexing"
      );
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
    await projectFunnelTerminalToState(
      signal.ontology_id,
      objectTypeApiName,
      "indexing"
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
        { runId: result.runId }
      );
    } else {
      await projectFunnelTerminalToState(
        signal.ontology_id,
        objectTypeApiName,
        "failed",
        { errorMessage: result.errorMessage ?? "Funnel pipeline failed" }
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
    input: { objectTypeApiName: ctx.objectTypeApiName, rowsFromChangelog: changelogOut.rows.length },
    activity: async () => {
      await sleepForStageDelay();
      const pending = await getPendingMergeEdits(ctx.objectTypeApiName);
      const contributions: DatasourceContribution[] = [
        {
          datasource_id: zeroUuid(),
          owned_properties: uniqueProps(changelogOut.rows),
          changelog_rows: changelogOut.rows,
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
      await sleepForStageDelay();
      // Two code paths:
      //   (a) Quickwit reachable — call runIndexingActivity to ensure the
      //       ot_<type> index exists, stream merged rows onto Kafka,
      //       and wait for splits to publish. This is the B6 hot path.
      //   (b) Quickwit unreachable — stamp applied_to_index_at directly
      //       so edits keep flowing; the overlay becomes the authority
      //       until the indexer catches up.
      const pending = await getPendingIndexEdits(ctx.objectTypeApiName);
      const editIds = pending.map((e) => e.edit_id);

      const quickwitOk = await isQuickwitReachable();
      if (quickwitOk && mergeOut.mergedRows.length > 0) {
        try {
          await ensureIndex({ objectTypeApiName: ctx.objectTypeApiName });
          const mergedRows: MergedRow[] = mergeOut.mergedRows.map((r, i) => ({
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
            ontologyId: ctx.ontologyId,
            objectTypeApiName: ctx.objectTypeApiName,
            primaryKeyApiName: "primary_key",
            reader,
            publishTimeoutMs: 15_000,
            publishPollMs: 1_000,
          });
          await markEditsAppliedToIndex(editIds);
          return {
            editsIndexed: editIds.length,
            rowsStreamed: out.rowsStreamed,
            publishedSplits: out.publishedSplitIds.length,
            publishedSplitIds: out.publishedSplitIds,
            quickwit: true,
          };
        } catch (err) {
          // Fall through to stamp-only — the edits are durable in PG
          // and the next run will retry.
          console.warn(
            `[funnel] Quickwit indexing failed, stamping edits and continuing: ${(err as Error).message}`
          );
        }
      }

      await markEditsAppliedToIndex(editIds);
      return {
        editsIndexed: editIds.length,
        rowsStreamed: 0,
        publishedSplitIds: [] as string[],
        quickwit: false,
      };
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

function uniqueProps(rows: ChangelogRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.properties)) set.add(k);
  return Array.from(set);
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
