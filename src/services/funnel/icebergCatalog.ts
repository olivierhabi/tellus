// ---------------------------------------------------------------------------
// iceberg Catalog — tasks-01.md §B2
//
// An Iceberg-compatible dataset abstraction. We model the Iceberg metadata
// layer (tables + snapshots + manifests) in Postgres and keep the data
// files (Parquet) in S3 under the table's `location`. Every write produces
// a NEW snapshot whose `parent_snapshot_id` points at the previous head;
// the head pointer in `funnel_dataset.latest_snapshot_id` advances
// atomically in the same transaction as the snapshot insert so callers
// always see a consistent view.
//
// This is deliberately a *thin* wrapper. It is not a full Iceberg runtime —
// we do not implement predicate pushdown, Z-order, or manifest rewriting.
// What we DO provide is:
//
//   1. Namespaced tables (`_funnel.<object_type>.changelog.<datasource>`,
//      `_funnel.<object_type>.merged`, etc. — invisible to end users).
//   2. Append-only snapshots with atomic head-pointer swaps.
//      Snapshots are the unit of Changelog diffing (B4).
//   3. Snapshot retention: the 100 most recent snapshots are always kept;
//      older ones are eligible for expiration by a sweeper job.
//   4. Time-travel reads via `readSnapshot(snapshotId)` — the stage
//      activities consume datasets at a specific snapshot so a mid-run
//      write from a concurrent producer cannot corrupt the merged output.
//
// We intentionally do NOT use the Iceberg Java/Python runtime here — the
// full REST catalog (Lakekeeper, Polaris) is the production target but is
// infrastructure, not application code. The interfaces below are shaped so
// that a Lakekeeper adapter can be dropped in without touching callers.
// ---------------------------------------------------------------------------

import { PoolClient } from "pg";
import { query, getClient } from "../../db";
import { getLakekeeperClient } from "./lakekeeperClient";
import { emitIcebergMetadataForSnapshot } from "./icebergMetadataEmitter";

export type WriteMode = "copy-on-write" | "merge-on-read";
export type SnapshotOperation = "append" | "overwrite" | "delete" | "replace";

export interface FunnelDatasetRow {
  dataset_table_id: string;
  namespace: string;
  table_name: string;
  format_version: number;
  write_mode: WriteMode;
  schema_json: Record<string, unknown>;
  partition_spec_json: unknown[];
  latest_snapshot_id: string | null;
  min_snapshots_to_keep: number;
  location: string;
  created_at: string;
}

export interface FunnelSnapshotRow {
  snapshot_id: string;
  dataset_table_id: string;
  parent_snapshot_id: string | null;
  operation: SnapshotOperation;
  manifest_json: ManifestEntry[];
  summary_json: Record<string, unknown>;
  added_rows: string; // bigint
  added_files: number;
  committed_at: string;
}

/** A file entry in a snapshot manifest. */
export interface ManifestEntry {
  file_path: string; // s3://bucket/_funnel/<namespace>/<table>/data/<uuid>.parquet
  file_size_bytes: number;
  row_count: number;
  operation: "added" | "deleted";
  partition?: Record<string, string>;
  lower_bounds?: Record<string, string>;
  upper_bounds?: Record<string, string>;
}

export interface CreateTableInput {
  namespace: string; // e.g. `_funnel.orders.changelog`
  tableName: string; // e.g. the source datasource_id
  schema: Record<string, unknown>;
  writeMode?: WriteMode;
  partitionSpec?: unknown[];
  location: string; // s3://... root for this table's data/
  minSnapshotsToKeep?: number;
}

export interface CommitSnapshotInput {
  tableId: string;
  operation: SnapshotOperation;
  manifest: ManifestEntry[];
  summary?: Record<string, unknown>;
  parentSnapshotId?: string | null; // optimistic concurrency
  /** Pre-generated snapshot id (uuid). When supplied, the row is inserted
   *  with this id explicitly — used by the Parquet by-reference path so the
   *  MinIO object can be keyed by the snapshot id BEFORE the row commits
   *  (write-parquet-first ordering). When omitted, Postgres generates the
   *  id via the column default. */
  snapshotId?: string;
}

/**
 * Build the Iceberg-style namespace under which every Funnel-internal
 * dataset for an Object Type lives. Consistently prefixed so they are
 * invisible to end users by default.
 */
export function funnelNamespace(objectTypeApiName: string, kind: "changelog" | "merged" | "index" | "hydration"): string {
  return `_funnel.${objectTypeApiName}.${kind}`;
}

/**
 * Register a new Iceberg-style table. Idempotent on (namespace, table_name).
 */
export async function createTable(
  input: CreateTableInput,
  client?: PoolClient
): Promise<FunnelDatasetRow> {
  const runner = client ?? null;
  const exec = async (sql: string, params: unknown[]) =>
    runner ? runner.query(sql, params) : query(sql, params);

  const existing = await exec(
    `SELECT * FROM funnel_dataset WHERE namespace = $1 AND table_name = $2`,
    [input.namespace, input.tableName]
  );
  if (existing.rows[0]) return existing.rows[0] as FunnelDatasetRow;

  const result = await exec(
    `INSERT INTO funnel_dataset
       (namespace, table_name, format_version, write_mode, schema_json,
        partition_spec_json, min_snapshots_to_keep, location)
     VALUES ($1, $2, 2, $3, $4::jsonb, $5::jsonb, $6, $7)
     RETURNING *`,
    [
      input.namespace,
      input.tableName,
      input.writeMode ?? "copy-on-write",
      JSON.stringify(input.schema),
      JSON.stringify(input.partitionSpec ?? []),
      input.minSnapshotsToKeep ?? 100,
      input.location,
    ]
  );

  // B2: register the table in Lakekeeper so `SELECT ... FOR VERSION AS
  // OF <snapshot_id>` from external clients (DuckDB, Spark, PyIceberg)
  // resolves correctly. Best-effort — if Lakekeeper is unreachable we
  // fall back to Postgres-only tracking; the B2 audit endpoint surfaces
  // the drift.
  const minSnapshots = input.minSnapshotsToKeep ?? 100;
  const writeMode: WriteMode = input.writeMode ?? "copy-on-write";
  void registerTableInLakekeeper(input, {
    "format-version": "2",
    "write.delete.mode": writeMode,
    "history.expire.min-snapshots-to-keep": String(minSnapshots),
  }).catch((err) => {
    console.warn(
      `[iceberg] lakekeeper register failed for ${input.namespace}.${input.tableName}: ${(err as Error).message}`
    );
  });
  return result.rows[0] as FunnelDatasetRow;
}

export async function getTable(
  namespace: string,
  tableName: string
): Promise<FunnelDatasetRow | null> {
  const result = await query(
    `SELECT * FROM funnel_dataset WHERE namespace = $1 AND table_name = $2`,
    [namespace, tableName]
  );
  return (result.rows[0] as FunnelDatasetRow | undefined) ?? null;
}

/**
 * Atomically commit a new snapshot and advance `latest_snapshot_id`.
 *
 * Optimistic concurrency: if the caller supplies `parentSnapshotId`, the
 * commit fails if the current head has already moved past that snapshot —
 * this is how two concurrent writers to the same table stay consistent.
 * The Funnel workers use this by reading the head at stage start and
 * passing it back at commit time.
 */
export async function commitSnapshot(
  input: CommitSnapshotInput
): Promise<FunnelSnapshotRow> {
  const client = await getClient();
  try {
    await client.query("BEGIN");

    // Lock the table row to serialize head advancement. `SELECT FOR UPDATE`
    // is cheap because the row is tiny and held for the duration of the
    // insert below only.
    const table = await client.query(
      `SELECT * FROM funnel_dataset WHERE dataset_table_id = $1 FOR UPDATE`,
      [input.tableId]
    );
    if (!table.rows[0]) {
      throw new Error(`funnel_dataset not found: ${input.tableId}`);
    }
    const currentHead = (table.rows[0].latest_snapshot_id as string | null) ?? null;
    if (input.parentSnapshotId !== undefined && input.parentSnapshotId !== currentHead) {
      throw new Error(
        `concurrent modification: expected head ${input.parentSnapshotId}, found ${currentHead}`
      );
    }

    const addedRows = input.manifest
      .filter((m) => m.operation === "added")
      .reduce((sum, m) => sum + m.row_count, 0);
    const addedFiles = input.manifest.filter((m) => m.operation === "added").length;

    const inserted = await client.query(
      `INSERT INTO funnel_snapshot
         (snapshot_id, dataset_table_id, parent_snapshot_id, operation,
          manifest_json, summary_json, added_rows, added_files)
       VALUES (
         COALESCE($8::uuid, gen_random_uuid()),
         $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       RETURNING *`,
      [
        input.tableId,
        currentHead,
        input.operation,
        JSON.stringify(input.manifest),
        JSON.stringify(input.summary ?? {}),
        addedRows,
        addedFiles,
        input.snapshotId ?? null,
      ]
    );

    await client.query(
      `UPDATE funnel_dataset SET latest_snapshot_id = $1 WHERE dataset_table_id = $2`,
      [inserted.rows[0].snapshot_id, input.tableId]
    );

    await client.query("COMMIT");
    const committedSnapshot = inserted.rows[0] as FunnelSnapshotRow;
    const tableRow = table.rows[0] as FunnelDatasetRow;

    // B2: write a real Iceberg v2 metadata.json to S3 so external readers
    // can resolve the table without consulting Postgres. Best-effort —
    // if S3 is unreachable the Postgres mirror remains authoritative and
    // the B2 audit endpoint surfaces the drift.
    void emitMetadataToS3BestEffort(tableRow.dataset_table_id, committedSnapshot.snapshot_id);

    return committedSnapshot;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Memoised result of "does funnel_snapshot have the retry-tracking
// columns?" Without this probe, every snapshot commit attempts the
// UPDATE blindly and the pg pool's own error logger spams the console
// with "column metadata_emitted_at does not exist" on pre-migration-016
// deployments — the JS `.catch(() => {})` catches the Promise rejection
// but only AFTER pg has already logged it. Re-checked every 5 min so
// applying the migration during server life activates tracking without
// a restart.
let metadataTrackingColumnsPresent: boolean | null = null;
let metadataTrackingCheckedAt = 0;
const METADATA_TRACKING_RECHECK_MS = 5 * 60 * 1000;

async function hasMetadataTrackingColumns(): Promise<boolean> {
  const now = Date.now();
  if (
    metadataTrackingColumnsPresent !== null &&
    now - metadataTrackingCheckedAt < METADATA_TRACKING_RECHECK_MS
  ) {
    return metadataTrackingColumnsPresent;
  }
  try {
    const res = await query(
      `SELECT COUNT(*)::int AS c
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'funnel_snapshot'
          AND column_name IN ('metadata_emitted_at',
                              'metadata_emit_attempts',
                              'metadata_last_error')`
    );
    metadataTrackingColumnsPresent = (res.rows[0]?.c ?? 0) >= 3;
  } catch {
    metadataTrackingColumnsPresent = false;
  }
  metadataTrackingCheckedAt = Date.now();
  return metadataTrackingColumnsPresent;
}

async function emitMetadataToS3BestEffort(
  tableId: string,
  headSnapshotId: string
): Promise<void> {
  const trackable = await hasMetadataTrackingColumns();
  try {
    const table = await getTableById(tableId);
    if (!table) return;
    const chain = await snapshotsBetween(tableId, null, headSnapshotId);
    const head = chain[chain.length - 1];
    if (!head) return;
    await emitIcebergMetadataForSnapshot(table, head, chain, chain.length);
    if (trackable) {
      await query(
        `UPDATE funnel_snapshot
            SET metadata_emitted_at = now(),
                metadata_last_error = NULL
          WHERE snapshot_id = $1`,
        [headSnapshotId]
      );
    }
  } catch (err) {
    const msg = (err as Error).message;
    console.warn(`[iceberg] metadata.json emission failed for ${tableId}: ${msg}`);
    if (trackable) {
      await query(
        `UPDATE funnel_snapshot
            SET metadata_emit_attempts = metadata_emit_attempts + 1,
                metadata_last_error    = $2
          WHERE snapshot_id = $1`,
        [headSnapshotId, msg.slice(0, 500)]
      ).catch(() => {
        /* race: column dropped between probe and write. */
      });
    }
    try {
      const metrics = require("./metrics") as typeof import("./metrics");
      metrics.incCounter("funnel_iceberg_metadata_emission_failures_total", {});
    } catch {
      /* metrics optional */
    }
  }
}

/** Force the next hasMetadataTrackingColumns() call to re-probe. */
export function __resetMetadataTrackingCacheForTesting(): void {
  metadataTrackingColumnsPresent = null;
  metadataTrackingCheckedAt = 0;
}

/**
 * Iceberg metadata emission sweeper. Runs every N minutes; retries
 * every funnel_snapshot whose metadata.json is still missing. Bounded
 * by `maxPerTick` so a large backlog doesn't flood S3.
 */
export async function retryPendingIcebergMetadata(
  maxPerTick: number = 100
): Promise<{ retried: number; succeeded: number }> {
  if (!(await hasMetadataTrackingColumns())) {
    return { retried: 0, succeeded: 0 };
  }
  try {
    const pending = await query(
      `SELECT s.snapshot_id, s.dataset_table_id
         FROM funnel_snapshot s
        WHERE s.metadata_emitted_at IS NULL
          AND s.metadata_emit_attempts < 10
        ORDER BY s.committed_at ASC
        LIMIT $1`,
      [maxPerTick]
    );
    let succeeded = 0;
    for (const row of pending.rows as Array<{
      snapshot_id: string;
      dataset_table_id: string;
    }>) {
      const before = await query(
        `SELECT metadata_emitted_at FROM funnel_snapshot WHERE snapshot_id = $1`,
        [row.snapshot_id]
      );
      await emitMetadataToS3BestEffort(row.dataset_table_id, row.snapshot_id);
      const after = await query(
        `SELECT metadata_emitted_at FROM funnel_snapshot WHERE snapshot_id = $1`,
        [row.snapshot_id]
      );
      if (
        before.rows[0]?.metadata_emitted_at == null &&
        after.rows[0]?.metadata_emitted_at != null
      ) {
        succeeded++;
      }
    }
    return { retried: pending.rowCount ?? 0, succeeded };
  } catch (err) {
    const msg = (err as Error).message;
    if (
      /relation .funnel_snapshot. does not exist/i.test(msg) ||
      /column .metadata_emitted_at. does not exist/i.test(msg)
    ) {
      return { retried: 0, succeeded: 0 };
    }
    throw err;
  }
}

/**
 * Return the current HEAD snapshot for a table, or null if the table has
 * never been written.
 */
export async function getLatestSnapshot(
  tableId: string
): Promise<FunnelSnapshotRow | null> {
  const result = await query(
    `SELECT s.* FROM funnel_snapshot s
       JOIN funnel_dataset d ON d.latest_snapshot_id = s.snapshot_id
      WHERE d.dataset_table_id = $1`,
    [tableId]
  );
  return (result.rows[0] as FunnelSnapshotRow | undefined) ?? null;
}

/**
 * Return every snapshot between `fromSnapshotId` (exclusive) and
 * `toSnapshotId` (inclusive) for a table, ordered oldest-first. This is
 * the incremental read Changelog (B4) uses to diff source datasources.
 * `fromSnapshotId=null` means "from the table's genesis".
 */
export async function snapshotsBetween(
  tableId: string,
  fromSnapshotId: string | null,
  toSnapshotId: string
): Promise<FunnelSnapshotRow[]> {
  // Walk parents backwards from toSnapshotId until we either hit
  // fromSnapshotId or run out of parents. Iceberg's native API is
  // `SnapshotScan` — this is the same idea, expressed in plain SQL.
  const walked: FunnelSnapshotRow[] = [];
  let cursor: string | null = toSnapshotId;
  while (cursor && cursor !== fromSnapshotId) {
    const row = await query(
      `SELECT * FROM funnel_snapshot WHERE snapshot_id = $1 AND dataset_table_id = $2`,
      [cursor, tableId]
    );
    if (!row.rows[0]) break;
    const snap = row.rows[0] as FunnelSnapshotRow;
    walked.push(snap);
    cursor = snap.parent_snapshot_id;
  }
  return walked.reverse();
}

/**
 * Return the manifest entries for a single snapshot — i.e. the data-file
 * list a reader would open to materialize the table as of that snapshot.
 */
export async function readSnapshotManifest(
  snapshotId: string
): Promise<ManifestEntry[]> {
  const result = await query(
    `SELECT manifest_json FROM funnel_snapshot WHERE snapshot_id = $1`,
    [snapshotId]
  );
  if (!result.rows[0]) return [];
  return result.rows[0].manifest_json as ManifestEntry[];
}

/**
 * Expire snapshots older than the N most recent. Called by a background
 * sweeper; tests exercise this directly. The most recent
 * `min_snapshots_to_keep` snapshots are always preserved so Changelog
 * can diff against old heads and time-travel queries work.
 */
export async function expireOldSnapshots(tableId: string): Promise<number> {
  const table = await getTableById(tableId);
  if (!table) return 0;
  const keep = table.min_snapshots_to_keep;
  const result = await query(
    `DELETE FROM funnel_snapshot
      WHERE snapshot_id IN (
        SELECT snapshot_id FROM funnel_snapshot
         WHERE dataset_table_id = $1
         ORDER BY committed_at DESC
         OFFSET $2
      )
      AND snapshot_id <> COALESCE(
        (SELECT latest_snapshot_id FROM funnel_dataset WHERE dataset_table_id = $1),
        '00000000-0000-0000-0000-000000000000'::uuid
      )`,
    [tableId, keep]
  );
  return result.rowCount ?? 0;
}

async function getTableById(tableId: string): Promise<FunnelDatasetRow | null> {
  const result = await query(
    `SELECT * FROM funnel_dataset WHERE dataset_table_id = $1`,
    [tableId]
  );
  return (result.rows[0] as FunnelDatasetRow | undefined) ?? null;
}

/**
 * Best-effort registration of a funnel_dataset in Lakekeeper. Runs
 * asynchronously (caller discards the Promise) — if Lakekeeper is
 * unreachable the Postgres-side state is still authoritative for
 * dispatcher operations.
 */
async function registerTableInLakekeeper(
  input: CreateTableInput,
  tableProperties: Record<string, string> = {}
): Promise<void> {
  const warehouse = process.env.LAKEKEEPER_WAREHOUSE ?? "tellus-funnel";
  const client = getLakekeeperClient();
  if (!(await client.isReachable())) return;
  // Namespace must exist before table create.
  await client.ensureNamespace(warehouse, input.namespace);
  // Minimal schema — callers drop their real field list into
  // `input.schema` as JSON, but Lakekeeper requires the Iceberg shape.
  // If the caller's schema is empty, register a single stringified
  // placeholder so the table exists for later ALTER-schema flows.
  const schemaFields = Object.entries(input.schema ?? {}).length > 0
    ? Object.entries(input.schema as Record<string, unknown>).map(([name], i) => ({
        id: i + 1,
        name,
        type: "string",
        required: false,
      }))
    : [{ id: 1, name: "primary_key", type: "string", required: true }];
  // Note: `location` is intentionally omitted — Lakekeeper v0.12 derives
  // the S3 path from the warehouse's storage-profile and rejects
  // explicit location overrides. The caller's `input.location` still
  // controls where WE write Parquet files; the catalog metadata stays
  // aligned via the warehouse storage-profile.
  const out = await client.createTable({
    warehouseName: warehouse,
    namespace: input.namespace,
    tableName: input.tableName,
    schemaFields,
    properties: tableProperties,
  });
  console.log(
    `[iceberg/lakekeeper] registered ${input.namespace}.${input.tableName}: created=${out.created}`
  );
}
