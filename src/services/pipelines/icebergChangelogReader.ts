// ---------------------------------------------------------------------------
// Iceberg changelog reader — PB-B4 (follow-4).
//
// Bridges Iceberg-backed pipeline outputs into the Funnel's existing
// `SnapshotDiffReader` abstraction. The Funnel's changelog stage reads
// rows between two snapshots for (ontology, object_type, datasource)
// triplets; for an Iceberg-backed pipeline output we read rows at the
// downstream snapshot id and advance `pipeline_changelog_watermark` per
// consumer so the next run picks up from there.
//
// True snapshot-delta reads (rows added BETWEEN snap-A and snap-B,
// honouring Iceberg's manifest inspection) need PyIceberg 0.12+ APIs
// that are not on this pod's pyiceberg (0.11). We expose the
// snapshot-at-a-point reader today + watermark advance, and leave the
// actual delta computation to the downstream consumer which already has
// primary-key semantics. PB-B4.follow-4.1 upgrades to manifest-level
// incremental scan once PyIceberg is bumped.
// ---------------------------------------------------------------------------

import type { Knex } from "knex";
import foundryDb from "../../config/foundryDb";
import { icebergScanAsOf, icebergScanDelta, icebergSnapshots } from "./icebergSidecar";
import type {
  SnapshotDiffReader,
  SourceChangeRow,
} from "../funnel/changelogStage";
import {
  pipelineNamespace,
  PIPELINE_LEAF_TABLE,
  slugForNamespace,
} from "./icebergNamespace";

export interface WatermarkRow {
  pipeline_id: string;
  consumer: string;
  /**
   * Snapshot IDs are int64 (frequently > 2^53) so we always carry them
   * as strings — matching the sidecar boundary. Postgres BIGINT <-> JS
   * string survives the driver cast.
   */
  last_from_snapshot_id: string | null;
  last_to_snapshot_id: string | null;
  last_rows_emitted: number;
}

export async function getPipelineWatermark(
  pipelineId: string,
  consumer: string,
  knex: Knex = foundryDb,
): Promise<WatermarkRow | null> {
  const row = await knex("pipeline_changelog_watermark")
    .where({ pipeline_id: pipelineId, consumer })
    .first();
  if (!row) return null;
  return {
    pipeline_id: row.pipeline_id,
    consumer: row.consumer,
    last_from_snapshot_id:
      row.last_from_snapshot_id == null ? null : String(row.last_from_snapshot_id),
    last_to_snapshot_id:
      row.last_to_snapshot_id == null ? null : String(row.last_to_snapshot_id),
    last_rows_emitted: Number(row.last_rows_emitted ?? 0),
  };
}

/** Upsert the watermark to advance a consumer across the (from,to) range. */
export async function advancePipelineWatermark(
  input: {
    pipelineId: string;
    consumer: string;
    fromSnapshotId: string | null;
    toSnapshotId: string;
    rowsEmitted: number;
  },
  knex: Knex = foundryDb,
): Promise<void> {
  await knex.raw(
    `INSERT INTO pipeline_changelog_watermark
       (pipeline_id, consumer, last_from_snapshot_id, last_to_snapshot_id,
        last_advanced_at, last_rows_emitted)
     VALUES (?, ?, ?, ?, NOW(), ?)
     ON CONFLICT (pipeline_id, consumer) DO UPDATE SET
       last_from_snapshot_id = EXCLUDED.last_from_snapshot_id,
       last_to_snapshot_id   = EXCLUDED.last_to_snapshot_id,
       last_advanced_at      = NOW(),
       last_rows_emitted     = pipeline_changelog_watermark.last_rows_emitted + EXCLUDED.last_rows_emitted`,
    [
      input.pipelineId,
      input.consumer,
      input.fromSnapshotId,
      input.toSnapshotId,
      input.rowsEmitted,
    ],
  );
}

export interface IcebergReadTargets {
  projectId: string;
  pipelineId: string;
  pipelineName: string;
  warehouse?: string;
}

/**
 * Resolve the Iceberg (warehouse, namespace, table) identifier for a
 * pipeline output. Kept here so Funnel consumers don't have to know the
 * slug + namespace convention.
 */
export function resolveOutputTable(targets: IcebergReadTargets) {
  const projectSlug = slugForNamespace(
    `proj_${targets.projectId.replace(/-/g, "").slice(0, 12)}`,
  );
  const pipelineSlug = slugForNamespace(
    `${targets.pipelineName}_${targets.pipelineId.replace(/-/g, "").slice(0, 8)}`,
  );
  return {
    warehouse:
      targets.warehouse ??
      process.env.LAKEKEEPER_PIPELINE_WAREHOUSE ??
      "tellus-pipeline",
    namespace: pipelineNamespace(projectSlug, pipelineSlug),
    table: PIPELINE_LEAF_TABLE,
  };
}

/**
 * Read the current snapshot's rows (optionally capped by `limit`) and
 * advance the consumer's watermark to the latest snapshot id. If the
 * watermark is already at the latest, returns {rows: [], advanced: false}
 * so the caller can no-op cheaply.
 */
/**
 * PB-B4 acceptance (d) — wire the Funnel's `SnapshotDiffReader` to the
 * PB-B4 manifest-level `scan_delta` path for Iceberg-backed pipeline
 * outputs. This is the "Funnel ingestion of an Iceberg-backed pipeline
 * output uses the changelog view and processes only changed rows"
 * integration point.
 *
 * Caller supplies the from/to Iceberg snapshot ids (typically sourced
 * from `pipeline_changelog_watermark` + the latest snapshot on the
 * _pipeline.* table). The reader yields `SourceChangeRow` tuples in
 * the shape the Funnel's `computeChangelog` expects.
 */
export function pipelineIcebergDiffReader(opts: {
  warehouse?: string;
  namespace: string;
  table: string;
  primaryKeyColumn: string;
  operationColumn?: string;
  sourceTxnColumn?: string;
  sourceTsColumn?: string;
}): SnapshotDiffReader {
  return {
    async *read({ fromSnapshotId, toSnapshotId }) {
      if (!toSnapshotId) return;
      const delta = await icebergScanDelta({
        warehouse: opts.warehouse,
        namespace: opts.namespace,
        table: opts.table,
        fromSnapshotId: fromSnapshotId ?? null,
        toSnapshotId: toSnapshotId,
      });
      if (delta.delta_requires_full_scan) {
        // Overwrite/delete in the range — fall back to a full read of
        // the target snapshot so downstream merge sees the authoritative
        // state.
        const full = await icebergScanAsOf({
          warehouse: opts.warehouse,
          namespace: opts.namespace,
          table: opts.table,
          snapshotId: toSnapshotId,
          limit: 1_000_000,
        });
        for (const r of full.rows) {
          yield toSourceChangeRow(r, opts);
        }
        return;
      }
      for (const r of delta.rows) {
        yield toSourceChangeRow(r, opts);
      }
    },
  };
}

function toSourceChangeRow(
  row: Record<string, unknown>,
  opts: {
    primaryKeyColumn: string;
    operationColumn?: string;
    sourceTxnColumn?: string;
    sourceTsColumn?: string;
  },
): SourceChangeRow {
  const op = String(row[opts.operationColumn ?? "operation"] ?? "INSERT").toUpperCase();
  const meta = new Set([
    opts.primaryKeyColumn,
    opts.operationColumn ?? "operation",
    opts.sourceTxnColumn ?? "source_transaction_id",
    opts.sourceTsColumn ?? "source_commit_timestamp",
  ]);
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!meta.has(k)) props[k] = v;
  return {
    primary_key: String(row[opts.primaryKeyColumn] ?? ""),
    operation:
      op === "DELETE" ? "DELETE" : op === "UPDATE" ? "UPDATE" : "INSERT",
    properties: props,
    source_transaction_id: String(row[opts.sourceTxnColumn ?? "source_transaction_id"] ?? ""),
    source_commit_timestamp: String(row[opts.sourceTsColumn ?? "source_commit_timestamp"] ?? ""),
  };
}

export async function readIcebergOutputAndAdvance(
  targets: IcebergReadTargets & { consumer: string; limit?: number },
  knex: Knex = foundryDb,
): Promise<{
  rows: Array<Record<string, unknown>>;
  columns: string[];
  fromSnapshotId: string | null;
  toSnapshotId: string | null;
  advanced: boolean;
}> {
  const ref = resolveOutputTable(targets);
  const { snapshots } = await icebergSnapshots(ref);
  if (snapshots.length === 0) {
    return { rows: [], columns: [], fromSnapshotId: null, toSnapshotId: null, advanced: false };
  }
  // PyIceberg sidecar returns snapshots in ancestor order; take the last.
  const latest = snapshots[snapshots.length - 1];
  const latestId = latest.snapshot_id;
  const watermark = await getPipelineWatermark(
    targets.pipelineId,
    targets.consumer,
    knex,
  );
  const fromId = watermark?.last_to_snapshot_id ?? null;
  if (fromId === latestId) {
    return {
      rows: [],
      columns: [],
      fromSnapshotId: fromId,
      toSnapshotId: latestId,
      advanced: false,
    };
  }
  // PB-B4 follow-4.1 — prefer the manifest-level delta reader so the
  // consumer sees only the rows added between the watermark and the
  // latest snapshot. On snapshot ranges that contain overwrites/deletes
  // the sidecar signals `delta_requires_full_scan=true` and we fall
  // back to scan_as_of (correctness-preserving).
  let scan: { columns: string[]; rows: Array<Record<string, unknown>>; row_count: number };
  const delta = await icebergScanDelta({
    ...ref,
    fromSnapshotId: fromId,
    toSnapshotId: latestId,
  });
  if (delta.delta_requires_full_scan) {
    scan = await icebergScanAsOf({
      ...ref,
      snapshotId: latestId,
      limit: targets.limit ?? 10_000,
    });
  } else {
    scan = delta;
  }
  await advancePipelineWatermark(
    {
      pipelineId: targets.pipelineId,
      consumer: targets.consumer,
      fromSnapshotId: fromId,
      toSnapshotId: latestId,
      rowsEmitted: scan.row_count,
    },
    knex,
  );
  return {
    rows: scan.rows,
    columns: scan.columns,
    fromSnapshotId: fromId,
    toSnapshotId: latestId,
    advanced: true,
  };
}
